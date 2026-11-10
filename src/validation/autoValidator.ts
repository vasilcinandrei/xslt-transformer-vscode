import * as vscode from 'vscode';
import { getSettings } from '../config/settings';
import { validateDocument } from '../commands/validateCommand';
import { clearTracedIssues, countBySeverity, showToolErrors } from './diagnosticsReporter';
import { ValidationResult } from './types';
import { getDiagnosticCollection } from '../services';

/**
 * Validates UBL documents on save (ublValidator.validateOnSave) and shows the
 * result for the active document in the status bar.
 */
export class AutoValidator implements vscode.Disposable {
    private readonly statusItem: vscode.StatusBarItem;
    private readonly results = new Map<string, ValidationResult>();
    private readonly running = new Set<string>();
    private readonly rerun = new Set<string>();
    private readonly disposables: vscode.Disposable[] = [];

    constructor() {
        this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
        this.statusItem.command = 'workbench.actions.view.problems';
        this.disposables.push(
            this.statusItem,
            vscode.workspace.onDidSaveTextDocument(doc => this.onSave(doc)),
            vscode.workspace.onDidCloseTextDocument(doc => this.onClose(doc)),
            vscode.window.onDidChangeActiveTextEditor(() => this.updateStatus())
        );
        this.updateStatus();
    }

    /** Records a result from a manual validation so the status bar reflects it. */
    record(doc: vscode.TextDocument, result: ValidationResult): void {
        this.results.set(doc.uri.toString(), result);
        this.updateStatus();
    }

    private async onSave(doc: vscode.TextDocument): Promise<void> {
        if (doc.languageId !== 'xml' || !getSettings().validateOnSave) {
            return;
        }
        const key = doc.uri.toString();
        if (this.running.has(key)) {
            this.rerun.add(key);
            return;
        }
        this.running.add(key);
        if (vscode.window.activeTextEditor?.document === doc) {
            this.statusItem.text = '$(sync~spin) UBL: validating...';
            this.statusItem.show();
        }
        try {
            const result = await validateDocument(doc, 'full');
            if (result) {
                showToolErrors(result);
                this.results.set(key, result);
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(`UBL validation failed: ${e.message}`);
        } finally {
            this.running.delete(key);
            this.updateStatus();
        }
        if (this.rerun.delete(key)) {
            await this.onSave(doc);
        }
    }

    private onClose(doc: vscode.TextDocument): void {
        this.results.delete(doc.uri.toString());
        // Untitled transform outputs disappear for good; drop their problems
        if (doc.uri.scheme === 'untitled') {
            getDiagnosticCollection().delete(doc.uri);
            clearTracedIssues(doc.uri);
        }
    }

    private updateStatus(): void {
        const doc = vscode.window.activeTextEditor?.document;
        const result = doc && this.results.get(doc.uri.toString());
        if (!result) {
            this.statusItem.hide();
            return;
        }
        const { errors, warnings } = countBySeverity(result.issues);
        if (errors > 0) {
            this.statusItem.text = `$(error) UBL: ${errors} error${errors !== 1 ? 's' : ''}`;
        } else if (warnings > 0) {
            this.statusItem.text = `$(warning) UBL: ${warnings} warning${warnings !== 1 ? 's' : ''}`;
        } else {
            this.statusItem.text = '$(pass) UBL: valid';
        }
        this.statusItem.tooltip = result.checks
            .map(c => `${c.label}: ${c.passed === null ? 'not run' : c.passed ? 'passed' : 'failed'}`)
            .join('\n');
        this.statusItem.show();
    }

    dispose(): void {
        for (const d of this.disposables) {
            d.dispose();
        }
    }
}
