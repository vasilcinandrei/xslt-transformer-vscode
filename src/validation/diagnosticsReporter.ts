import * as vscode from 'vscode';
import { ValidationIssue, ValidationResult } from './types';
import { TracedIssue } from '../tracing/errorTraceMapper';
import { getOutputChannel } from '../services';

// Store traced issues per URI so the AI agent can retrieve full trace data from a diagnostic
const tracedIssueStore = new Map<string, TracedIssue[]>();

export function getTracedIssue(uri: vscode.Uri, diagnostic: vscode.Diagnostic): TracedIssue | undefined {
    const issues = tracedIssueStore.get(uri.toString());
    if (!issues) {
        return undefined;
    }
    const line = diagnostic.range.start.line + 1; // Convert back to 1-indexed
    return issues.find(i =>
        i.line === line && i.message === diagnostic.message
    );
}

export function getTracedIssues(uri: vscode.Uri): TracedIssue[] | undefined {
    return tracedIssueStore.get(uri.toString());
}

export function clearTracedIssues(uri: vscode.Uri): void {
    tracedIssueStore.delete(uri.toString());
}

export function toDiagnostic(issue: ValidationIssue | TracedIssue, line = issue.line): vscode.Diagnostic {
    const l = Math.max(0, line - 1); // VS Code is 0-indexed
    const range = new vscode.Range(l, issue.column, l, Number.MAX_SAFE_INTEGER);
    const diagnostic = new vscode.Diagnostic(range, issue.message, issue.severity);
    diagnostic.source = `ubl-${issue.source}`;
    if (issue.ruleId) {
        diagnostic.code = issue.ruleId;
    }
    return diagnostic;
}

/**
 * Reports issues on a document. Issues with an XSLT trace get related
 * information linking to the stylesheet line that produced the element, and
 * are stored so the AI fix commands can find them again.
 */
export function reportDiagnostics(
    collection: vscode.DiagnosticCollection,
    uri: vscode.Uri,
    issues: (ValidationIssue | TracedIssue)[]
): void {
    const diagnostics = issues.map(issue => {
        const diagnostic = toDiagnostic(issue);
        const traced = issue as TracedIssue;
        if (traced.xsltSourceFile && traced.xsltSourceLine) {
            const xsltLine = Math.max(0, traced.xsltSourceLine - 1);
            const elementInfo = traced.xsltElementName ? `<${traced.xsltElementName}>` : 'element';
            diagnostic.relatedInformation = [
                new vscode.DiagnosticRelatedInformation(
                    new vscode.Location(
                        vscode.Uri.file(traced.xsltSourceFile),
                        new vscode.Range(xsltLine, 0, xsltLine, Number.MAX_SAFE_INTEGER)
                    ),
                    `Produced by ${elementInfo} in XSLT at line ${traced.xsltSourceLine}`
                ),
            ];
        }
        return diagnostic;
    });

    collection.set(uri, diagnostics);
    tracedIssueStore.set(uri.toString(), issues as TracedIssue[]);
}

export function countBySeverity(issues: ValidationIssue[]): { errors: number; warnings: number } {
    return {
        errors: issues.filter(i => i.severity === vscode.DiagnosticSeverity.Error).length,
        warnings: issues.filter(i => i.severity === vscode.DiagnosticSeverity.Warning).length,
    };
}

export function summarize(result: ValidationResult): string {
    const { errors, warnings } = countBySeverity(result.issues);
    if (errors === 0 && warnings === 0) {
        const ran = result.checks.filter(c => c.passed !== null).map(c => c.label);
        return `UBL validation passed${ran.length ? ` (${ran.join(', ')})` : ''}.`;
    }
    const parts: string[] = [];
    if (errors > 0) {
        parts.push(`${errors} error${errors !== 1 ? 's' : ''}`);
    }
    if (warnings > 0) {
        parts.push(`${warnings} warning${warnings !== 1 ? 's' : ''}`);
    }
    const failed = result.checks.filter(c => c.passed === false).map(c => c.label);
    return `UBL validation: ${parts.join(', ')} found.${failed.length ? ` Failed: ${failed.join(', ')}.` : ''}`;
}

export function showToolErrors(result: ValidationResult): void {
    for (const e of result.toolErrors) {
        vscode.window.showErrorMessage(e);
    }
    logRuleNotes(result);
}

/** Writes which rules ran (and any selection notes) to the output channel. */
export function logRuleNotes(result: ValidationResult): void {
    const out = getOutputChannel();
    const rules = result.checks.filter(c => c.id !== 'xsd');
    if (rules.length === 0 && result.notes.length === 0) {
        return;
    }
    out.appendLine(`[${new Date().toLocaleTimeString()}] ${result.documentInfo?.rootElement ?? 'Document'} validated with: ` +
        (rules.map(c => `${c.label}${c.reason ? ` (${c.reason})` : ''}`).join(', ') || 'no business rules'));
    for (const n of result.notes) {
        out.appendLine(`  Note: ${n}`);
    }
}

export function showSummaryNotification(result: ValidationResult): void {
    showToolErrors(result);
    const { errors, warnings } = countBySeverity(result.issues);
    const message = summarize(result) + (result.notes.length > 0 ? ' See the UBL Validator output for rule notes.' : '');
    if (errors > 0) {
        vscode.window.showErrorMessage(message, 'Show Problems').then(choice => {
            if (choice) {
                vscode.commands.executeCommand('workbench.actions.view.problems');
            }
        });
    } else if (warnings > 0) {
        vscode.window.showWarningMessage(message);
    } else if (result.toolErrors.length === 0) {
        vscode.window.showInformationMessage(message);
    }
}
