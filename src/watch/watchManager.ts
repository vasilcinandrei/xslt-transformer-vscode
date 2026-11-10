import * as path from 'path';
import * as vscode from 'vscode';
import { transformAndValidate } from '../pipeline/transformAndValidate';
import { toDiagnostic, countBySeverity } from '../validation/diagnosticsReporter';
import { getValidationContext, logTransformMessages } from '../services';
import { pickTransformInputs, TransformInputs } from '../commands/inputPicker';
import { JavaToolError } from '../utils/javaRunner';
import { presentTransformResult } from '../commands/transformCommand';

const DEBOUNCE_MS = 400;

/**
 * Re-runs transform + validation whenever the stylesheet (or any of its
 * includes) or the input XML is saved, and reports problems directly on the
 * XSLT lines that produced the offending output.
 */
export class WatchManager implements vscode.Disposable {
    private readonly diagnostics = vscode.languages.createDiagnosticCollection('ubl-watch');
    private readonly statusBarItem: vscode.StatusBarItem;
    private listeners: vscode.Disposable[] = [];
    private debounceTimer: NodeJS.Timeout | undefined;
    private running = false;
    private pendingRun = false;
    private inputs: TransformInputs | undefined;
    private watchedFiles = new Set<string>();

    constructor(private readonly context: vscode.ExtensionContext) {
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.statusBarItem.command = 'xslt-transformer.stopWatch';
    }

    get isWatching(): boolean {
        return this.inputs !== undefined;
    }

    async start(): Promise<void> {
        if (this.inputs) {
            vscode.window.showInformationMessage('Watch mode is already active.');
            return;
        }
        const inputs = await pickTransformInputs(this.context);
        if (!inputs) {
            return;
        }
        this.inputs = inputs;
        this.watchedFiles = new Set([path.resolve(inputs.sourceXml), path.resolve(inputs.xsltStylesheet)]);

        const watcher = vscode.workspace.createFileSystemWatcher('**/*.{xsl,xslt,xml}');
        this.listeners = [
            watcher,
            watcher.onDidChange(uri => this.onFileChanged(uri)),
            watcher.onDidCreate(uri => this.onFileChanged(uri)),
            vscode.workspace.onDidSaveTextDocument(doc => this.onFileChanged(doc.uri)),
        ];

        this.statusBarItem.text = '$(eye) XSLT Watch';
        this.statusBarItem.tooltip = `Watching ${path.basename(inputs.xsltStylesheet)} → ${path.basename(inputs.sourceXml)}. Click to stop.`;
        this.statusBarItem.show();
        vscode.window.setStatusBarMessage('XSLT watch started — save the stylesheet or input to re-validate', 4000);

        await this.runPipeline(true);
    }

    stop(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = undefined;
        }
        for (const l of this.listeners) {
            l.dispose();
        }
        this.listeners = [];
        this.diagnostics.clear();
        this.statusBarItem.hide();
        if (this.inputs) {
            this.inputs = undefined;
            vscode.window.setStatusBarMessage('XSLT watch stopped', 3000);
        }
    }

    dispose(): void {
        this.stop();
        this.diagnostics.dispose();
        this.statusBarItem.dispose();
    }

    private onFileChanged(uri: vscode.Uri): void {
        if (!this.watchedFiles.has(path.resolve(uri.fsPath))) {
            return;
        }
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => this.runPipeline(false), DEBOUNCE_MS);
    }

    private async runPipeline(showOutput: boolean): Promise<void> {
        const inputs = this.inputs;
        if (!inputs) {
            return;
        }
        if (this.running) {
            this.pendingRun = true;
            return;
        }
        this.running = true;
        this.statusBarItem.text = '$(sync~spin) XSLT Watch';

        try {
            const options = { ...inputs, enableTracing: true };
            const result = await transformAndValidate(options, getValidationContext());
            logTransformMessages(result.messages);
            for (const f of result.stylesheetFiles ?? []) {
                this.watchedFiles.add(path.resolve(f));
            }
            if (showOutput) {
                await presentTransformResult(result, options, false);
            }

            this.diagnostics.clear();
            if (!result.isUbl || !result.validationResult) {
                this.statusBarItem.text = '$(eye) XSLT Watch (not UBL)';
                return;
            }

            // Group problems by the stylesheet file that produced the element
            const byFile = new Map<string, vscode.Diagnostic[]>();
            for (const issue of result.tracedIssues ?? []) {
                const file = issue.xsltSourceFile ?? inputs.xsltStylesheet;
                const line = issue.xsltSourceFile ? issue.xsltSourceLine ?? 1 : 1;
                const diagnostic = toDiagnostic({ ...issue, message: `${issue.message} (output line ${issue.line})` }, line);
                const list = byFile.get(file) ?? [];
                list.push(diagnostic);
                byFile.set(file, list);
            }
            for (const [file, list] of byFile) {
                this.diagnostics.set(vscode.Uri.file(file), list);
            }

            const { errors, warnings } = countBySeverity(result.validationResult.issues);
            this.statusBarItem.text = errors === 0 && warnings === 0
                ? '$(pass) XSLT Watch: valid'
                : `$(alert) XSLT Watch: ${errors}E ${warnings}W`;
        } catch (error: any) {
            this.diagnostics.clear();
            this.statusBarItem.text = '$(error) XSLT Watch: transform failed';
            const firstDetail = error instanceof JavaToolError && error.details ? error.details.split('\n')[0] : error.message;
            this.statusBarItem.tooltip = firstDetail;
            this.reportTransformError(firstDetail, inputs.xsltStylesheet);
        } finally {
            this.running = false;
        }
        if (this.pendingRun) {
            this.pendingRun = false;
            await this.runPipeline(false);
        }
    }

    /** Shows a stylesheet compile/runtime error as a problem on the reported line. */
    private reportTransformError(detail: string, fallbackFile: string): void {
        const m = detail.match(/(?:error: )?(\/[^:]+|[A-Za-z]:\\[^:]+):(\d+): (.*)/);
        const file = m ? m[1] : fallbackFile;
        const line = m ? Math.max(0, parseInt(m[2], 10) - 1) : 0;
        const diagnostic = new vscode.Diagnostic(
            new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER),
            m ? m[3] : detail,
            vscode.DiagnosticSeverity.Error
        );
        diagnostic.source = 'xslt';
        this.diagnostics.set(vscode.Uri.file(file), [diagnostic]);
    }
}
