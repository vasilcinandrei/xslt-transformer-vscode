import * as path from 'path';
import * as vscode from 'vscode';
import { TracedIssue } from '../tracing/errorTraceMapper';
import { AiConfig, FixProposal, FixSession } from './types';
import { buildFixContext, buildMessages } from './contextBuilder';
import { callLlm, LlmCancelledError } from './llmClient';
import { parseFixResponse } from './fixParser';
import { transformAndValidate, PipelineOptions, TransformResult } from '../pipeline/transformAndValidate';
import { ValidationContext } from '../validation/validator';
import { ValidationIssue } from '../validation/types';

// Content provider for the AI fix diff view
const fixContents = new Map<string, string>();

export class AiFixContentProvider implements vscode.TextDocumentContentProvider {
    provideTextDocumentContent(uri: vscode.Uri): string {
        return fixContents.get(uri.toString()) ?? '';
    }
}

export interface FixRunOptions {
    config: AiConfig;
    apiKey: string;
    pipeline: PipelineOptions;
    validation: ValidationContext;
    /** Output of the transform the issue was found in */
    output: string;
    /** All issues of that transform, to detect fixes that add new errors */
    previousIssues: ValidationIssue[];
    token?: vscode.CancellationToken;
    progress?: vscode.Progress<{ message?: string }>;
}

export interface FixOutcome {
    resolved: boolean;
    cancelled?: boolean;
    /** Fresh pipeline result after an applied fix */
    latest?: TransformResult;
}

export function issueKey(i: ValidationIssue): string {
    return i.ruleId ? `${i.source}|${i.ruleId}` : `${i.source}|${i.message}`;
}

/**
 * Asks the LLM for a stylesheet fix, shows it as a diff, applies it through
 * the editor (undoable) and re-runs the pipeline to confirm the error is gone.
 * Unsuccessful fixes are reverted and fed back to the model as context.
 */
export async function fixSingleIssue(issue: TracedIssue, opts: FixRunOptions): Promise<FixOutcome> {
    if (!issue.xsltSourceFile) {
        vscode.window.showWarningMessage('Cannot fix this error: no XSLT source trace available. Run a transform first.');
        return { resolved: false };
    }

    const doc = await openForEdit(issue.xsltSourceFile);
    if (!doc) {
        return { resolved: false, cancelled: true };
    }
    const originalXslt = doc.getText();
    const session: FixSession = { issue, attempts: [] };
    const label = issue.ruleId || issue.message.substring(0, 50);

    for (let attempt = 0; attempt < opts.config.maxRetries; attempt++) {
        if (opts.token?.isCancellationRequested) {
            return { resolved: false, cancelled: true };
        }

        const context = buildFixContext(issue, originalXslt, opts.output, opts.pipeline.sourceXml, opts.config);
        const messages = buildMessages(context, session);

        opts.progress?.report({ message: `${label}: asking AI (attempt ${attempt + 1}/${opts.config.maxRetries})...` });
        let response: string;
        const abort = new AbortController();
        const cancelSub = opts.token?.onCancellationRequested(() => abort.abort());
        try {
            const result = await callLlm({
                provider: opts.config.provider,
                model: opts.config.model,
                apiKey: opts.apiKey,
                messages,
                timeoutMs: opts.config.timeoutSeconds * 1000,
                signal: abort.signal,
            });
            response = result.content;
        } catch (err: any) {
            if (err instanceof LlmCancelledError) {
                return { resolved: false, cancelled: true };
            }
            vscode.window.showErrorMessage(`AI request failed: ${err.message}`);
            return { resolved: false };
        } finally {
            cancelSub?.dispose();
        }

        const proposal = parseFixResponse(response, originalXslt, context.mode, context.section);
        if (!proposal) {
            session.attempts.push({ rawResponse: response, succeeded: false });
            if (!(await askRetry('The AI response did not contain a usable stylesheet fix.', attempt, opts.config.maxRetries))) {
                return { resolved: false };
            }
            continue;
        }

        const accepted = await showDiffAndConfirm(issue.xsltSourceFile, originalXslt, proposal);
        if (!accepted) {
            return { resolved: false };
        }

        if (doc.getText() !== originalXslt) {
            vscode.window.showWarningMessage(`${path.basename(issue.xsltSourceFile)} changed while the fix was being reviewed; the fix was not applied.`);
            return { resolved: false };
        }
        opts.progress?.report({ message: `${label}: verifying fix...` });
        await replaceDocumentContent(doc, proposal.proposedContent);
        const verification = await verify(issue, opts);

        if (verification.resolved) {
            // The fixed issue itself is gone; it only lowers the baseline if it was an error
            const baseline = countErrors(opts.previousIssues) - (issue.severity === vscode.DiagnosticSeverity.Error ? 1 : 0);
            const introduced = verification.errorCount - baseline;
            if (introduced > 0) {
                const keep = await vscode.window.showWarningMessage(
                    `The fix resolved "${label}" but the output now has ${introduced} more error${introduced !== 1 ? 's' : ''}. Keep it?`,
                    'Keep', 'Revert'
                );
                if (keep !== 'Keep') {
                    await revert(doc, proposal.proposedContent, originalXslt);
                    return { resolved: false };
                }
            } else {
                vscode.window.setStatusBarMessage(`$(pass) AI fix applied — "${label}" resolved`, 6000);
            }
            return { resolved: true, latest: verification.latest };
        }

        // Didn't work — revert and give the model the feedback
        if (!(await revert(doc, proposal.proposedContent, originalXslt))) {
            return { resolved: false };
        }
        session.attempts.push({ proposal, succeeded: false, newErrors: verification.remainingErrors });

        const remaining = verification.remainingErrors?.length ?? 0;
        if (!(await askRetry(`Fix did not resolve the error (${remaining} error${remaining !== 1 ? 's' : ''} remain); it was reverted.`, attempt, opts.config.maxRetries))) {
            return { resolved: false };
        }
    }

    vscode.window.showWarningMessage(`Could not resolve "${label}" after ${opts.config.maxRetries} attempts.`);
    return { resolved: false };
}

function countErrors(issues: ValidationIssue[]): number {
    return issues.filter(i => i.severity === vscode.DiagnosticSeverity.Error).length;
}

async function askRetry(message: string, attempt: number, maxRetries: number): Promise<boolean> {
    if (attempt >= maxRetries - 1) {
        return false;
    }
    const retry = await vscode.window.showWarningMessage(
        `${message} Retry (${attempt + 2}/${maxRetries})?`,
        'Retry', 'Cancel'
    );
    return retry === 'Retry';
}

/** Opens the stylesheet for editing; unsaved changes must be saved first. */
async function openForEdit(filePath: string): Promise<vscode.TextDocument | undefined> {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    if (doc.isDirty) {
        const choice = await vscode.window.showWarningMessage(
            `${path.basename(filePath)} has unsaved changes. Save it before applying AI fixes?`,
            { modal: true },
            'Save and Continue'
        );
        if (choice !== 'Save and Continue') {
            return undefined;
        }
        await doc.save();
    }
    return doc;
}

/**
 * Restores the original stylesheet, unless the user edited it after the fix
 * was applied — their edits win and they're told to undo manually.
 */
async function revert(doc: vscode.TextDocument, applied: string, original: string): Promise<boolean> {
    if (doc.getText() !== applied) {
        vscode.window.showWarningMessage(
            `${path.basename(doc.uri.fsPath)} was edited during verification, so the AI fix was not reverted automatically. Use Undo to remove it.`
        );
        return false;
    }
    await replaceDocumentContent(doc, original);
    return true;
}

/** Replaces the document text through the editor (so Undo works) and saves. */
async function replaceDocumentContent(doc: vscode.TextDocument, content: string): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), content);
    await vscode.workspace.applyEdit(edit);
    await doc.save();
}

async function showDiffAndConfirm(xsltFilePath: string, originalContent: string, proposal: FixProposal): Promise<boolean> {
    const stamp = Date.now();
    const originalUri = vscode.Uri.parse(`ai-fix:original/${encodeURIComponent(xsltFilePath)}?${stamp}`);
    const proposedUri = vscode.Uri.parse(`ai-fix:proposed/${encodeURIComponent(xsltFilePath)}?${stamp}`);
    fixContents.set(originalUri.toString(), originalContent);
    fixContents.set(proposedUri.toString(), proposal.proposedContent);

    await vscode.commands.executeCommand(
        'vscode.diff',
        originalUri,
        proposedUri,
        `AI Fix: ${path.basename(xsltFilePath)} — ${proposal.explanation}`,
        { preview: true }
    );

    const choice = await vscode.window.showInformationMessage(
        `AI Fix: ${proposal.explanation}`,
        'Accept', 'Reject'
    );

    // Close exactly the diff tab we opened, wherever it is now
    const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs).filter(t =>
        t.input instanceof vscode.TabInputTextDiff && t.input.modified.toString() === proposedUri.toString()
    );
    if (tabs.length > 0) {
        await vscode.window.tabGroups.close(tabs);
    }
    fixContents.delete(originalUri.toString());
    fixContents.delete(proposedUri.toString());

    return choice === 'Accept';
}

interface VerificationResult {
    resolved: boolean;
    remainingErrors?: string[];
    latest?: TransformResult;
    errorCount: number;
}

async function verify(issue: TracedIssue, opts: FixRunOptions): Promise<VerificationResult> {
    try {
        const latest = await transformAndValidate({ ...opts.pipeline, enableTracing: true }, opts.validation);
        if (!latest.validationResult) {
            return {
                resolved: false,
                remainingErrors: ['The output is no longer recognized as a UBL document'],
                errorCount: 0,
            };
        }
        const issues = latest.validationResult.issues;
        if (latest.validationResult.toolErrors.length > 0) {
            // A check that could not run proves nothing about the error
            return { resolved: false, remainingErrors: latest.validationResult.toolErrors, errorCount: countErrors(issues) };
        }
        const key = issueKey(issue);
        const stillPresent = issues.some(i => issueKey(i) === key);
        const errors = countErrors(issues);
        if (!stillPresent) {
            return { resolved: true, latest, errorCount: errors };
        }
        return {
            resolved: false,
            remainingErrors: issues.map(i => `[${i.source}${i.ruleId ? '/' + i.ruleId : ''}] ${i.message}`),
            errorCount: errors,
        };
    } catch (err: any) {
        return {
            resolved: false,
            remainingErrors: [`Transform failed: ${err.message}`],
            errorCount: 0,
        };
    }
}
