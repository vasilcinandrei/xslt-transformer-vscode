import * as vscode from 'vscode';
import { createTransformCommand, presentTransformResult } from './commands/transformCommand';
import { createValidateCommand } from './commands/validateCommand';
import { createShowMappingCommand } from './commands/showMappingCommand';
import { initConfigCommand } from './commands/initConfigCommand';
import { showValidatorInfo, showBusinessRules, updateBusinessRules, downloadAllBusinessRules } from './commands/infoCommand';
import { MissingElementCodeActionProvider } from './analysis/codeActionProvider';
import { AiFixCodeActionProvider } from './ai/aiCodeActionProvider';
import { AiFixContentProvider, fixSingleIssue, issueKey } from './ai/fixAgent';
import {
    getAiConfig, ensureApiKey, ensureAiConsent, pickProvider, promptForApiKey, setProvider, PROVIDERS,
} from './ai/settingsManager';
import { getTracedIssue } from './validation/diagnosticsReporter';
import { AutoValidator } from './validation/autoValidator';
import { WatchManager } from './watch/watchManager';
import { AiConfig } from './ai/types';
import { TracedIssue } from './tracing/errorTraceMapper';
import { TransformResult } from './pipeline/transformAndValidate';
import { checkJava, javaRequirementError } from './utils/javaRunner';
import { getSettings } from './config/settings';
import {
    initServices, getTransformSession, getValidationContext, TransformSession, showError,
} from './services';

async function prepareAi(context: vscode.ExtensionContext): Promise<{ config: AiConfig; apiKey: string } | undefined> {
    const config = getAiConfig();
    if (!(await ensureAiConsent(context.globalState, config.provider, config))) {
        return undefined;
    }
    const apiKey = await ensureApiKey(context.secrets, config.provider);
    return apiKey ? { config, apiKey } : undefined;
}

function requireSession(): TransformSession | undefined {
    const session = getTransformSession();
    if (!session) {
        vscode.window.showWarningMessage(
            'No transform context available. Run "XSLT: Transform XML" first, then use AI fix on the validation errors.'
        );
    }
    return session;
}

export function activate(context: vscode.ExtensionContext) {
    initServices(context);

    const autoValidator = new AutoValidator();
    const watchManager = new WatchManager(context);
    context.subscriptions.push(autoValidator, watchManager);

    const register = (id: string, fn: (...args: any[]) => unknown) =>
        context.subscriptions.push(vscode.commands.registerCommand(id, fn));
    const onValidated = autoValidator.record.bind(autoValidator);

    register('xslt-transformer.transform', createTransformCommand(context));
    register('xslt-transformer.validateUbl', createValidateCommand('full', onValidated));
    register('xslt-transformer.validateUblXsd', createValidateCommand('xsd-only', onValidated));
    register('xslt-transformer.validateUblBusinessRules', createValidateCommand('business-rules-only', onValidated));
    register('xslt-transformer.startWatch', () => watchManager.start());
    register('xslt-transformer.stopWatch', () => watchManager.stop());
    register('xslt-transformer.showMapping', createShowMappingCommand(context));
    register('xslt-transformer.initConfig', initConfigCommand);
    register('xslt-transformer.showInfo', showValidatorInfo);
    register('xslt-transformer.showRules', showBusinessRules);
    register('xslt-transformer.updateRules', updateBusinessRules);
    register('xslt-transformer.downloadAllRules', downloadAllBusinessRules);

    const xmlSelector: vscode.DocumentSelector = [{ language: 'xml' }];
    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider(
            xmlSelector,
            new MissingElementCodeActionProvider(),
            { providedCodeActionKinds: MissingElementCodeActionProvider.providedCodeActionKinds }
        ),
        vscode.languages.registerCodeActionsProvider(
            xmlSelector,
            new AiFixCodeActionProvider(),
            { providedCodeActionKinds: AiFixCodeActionProvider.providedCodeActionKinds }
        ),
        vscode.workspace.registerTextDocumentContentProvider('ai-fix', new AiFixContentProvider())
    );

    // Fix a single error with AI (from the Quick Fix menu)
    register('xslt-transformer.aiFixSingle', async (diagnostic: vscode.Diagnostic) => {
        const session = requireSession();
        if (!session) {
            return;
        }
        const tracedIssue = getTracedIssue(session.outputUri, diagnostic);
        if (!tracedIssue) {
            vscode.window.showWarningMessage('Cannot find trace data for this error. Run the transform again.');
            return;
        }
        const ai = await prepareAi(context);
        if (!ai) {
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'AI Fix',
            cancellable: true,
        }, async (progress, token) => {
            try {
                const outcome = await fixSingleIssue(tracedIssue, {
                    ...ai,
                    pipeline: session.options,
                    validation: getValidationContext(),
                    output: session.output,
                    previousIssues: session.tracedIssues,
                    token,
                    progress,
                });
                if (outcome.resolved && outcome.latest) {
                    await presentTransformResult(outcome.latest, session.options, false);
                }
            } catch (error) {
                showError('AI fix failed', error);
            }
        });
    });

    // Fix all traced errors with AI, re-tracing after every applied fix
    register('xslt-transformer.aiFixAll', async () => {
        const session = requireSession();
        if (!session) {
            return;
        }
        const fixable = session.tracedIssues.filter(i => i.xsltSourceFile);
        if (session.tracedIssues.length === 0) {
            vscode.window.showInformationMessage('No validation errors to fix.');
            return;
        }
        if (fixable.length === 0) {
            vscode.window.showWarningMessage('None of the errors could be traced to an XSLT line.');
            return;
        }
        const ai = await prepareAi(context);
        if (!ai) {
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'AI Fix',
            cancellable: true,
        }, async (progress, token) => {
            // Work from fresh trace data: earlier fixes shift lines and output
            let current = { output: session.output, issues: session.tracedIssues };
            let latest: TransformResult | undefined;
            const keys = [...new Set(fixable.map(issueKey))];
            let fixed = 0;
            let alreadyGone = 0;

            try {
                for (let i = 0; i < keys.length; i++) {
                    if (token.isCancellationRequested) {
                        break;
                    }
                    const issue: TracedIssue | undefined = current.issues.find(x => issueKey(x) === keys[i] && x.xsltSourceFile);
                    if (!issue) {
                        alreadyGone++;
                        continue;
                    }
                    progress.report({ message: `Error ${i + 1}/${keys.length}: ${issue.ruleId || issue.message.substring(0, 40)}` });

                    const outcome = await fixSingleIssue(issue, {
                        ...ai,
                        pipeline: session.options,
                        validation: getValidationContext(),
                        output: current.output,
                        previousIssues: current.issues,
                        token,
                        progress,
                    });
                    if (outcome.cancelled) {
                        break;
                    }
                    if (outcome.resolved && outcome.latest) {
                        fixed++;
                        latest = outcome.latest;
                        current = {
                            output: outcome.latest.output,
                            issues: outcome.latest.tracedIssues ?? outcome.latest.validationResult?.issues ?? [],
                        };
                    }
                }
            } catch (error) {
                showError('AI fix failed', error);
            }

            if (latest) {
                await presentTransformResult(latest, session.options, false);
            }
            const extra = alreadyGone > 0 ? ` ${alreadyGone} disappeared as a side effect of earlier fixes.` : '';
            vscode.window.showInformationMessage(`AI Fix complete: ${fixed}/${keys.length} errors resolved.${extra}`);
        });
    });

    register('xslt-transformer.aiSetApiKey', async () => {
        const provider = await pickProvider('Select the AI provider to store a key for');
        if (!provider) {
            return;
        }
        if (await promptForApiKey(context.secrets, provider)) {
            if (provider !== getAiConfig().provider) {
                const use = await vscode.window.showInformationMessage(
                    `${PROVIDERS[provider].name} API key saved. Use ${PROVIDERS[provider].name} for AI fixes?`,
                    'Use It'
                );
                if (use) {
                    await setProvider(provider);
                }
            } else {
                vscode.window.showInformationMessage(`${PROVIDERS[provider].name} API key saved.`);
            }
        }
    });

    register('xslt-transformer.aiSelectProvider', async () => {
        const provider = await pickProvider('Select the AI provider for fix suggestions');
        if (!provider) {
            return;
        }
        await setProvider(provider);
        await ensureApiKey(context.secrets, provider);
        vscode.window.setStatusBarMessage(`AI fixes will use ${PROVIDERS[provider].name}`, 4000);
    });

    // Non-blocking Java check on activation
    const javaPath = getSettings().javaPath;
    checkJava(javaPath).then(status => {
        const problem = javaRequirementError(javaPath, status);
        if (!problem) {
            return;
        }
        vscode.window.showWarningMessage(problem, 'Install Java', 'Set Java Path').then(choice => {
            if (choice === 'Install Java') {
                vscode.env.openExternal(vscode.Uri.parse('https://adoptium.net/'));
            } else if (choice === 'Set Java Path') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'ublValidator.javaPath');
            }
        });
    });
}

export function deactivate() {}
