import * as vscode from 'vscode';
import { ValidationIssue, ValidationResult } from './types';

export function reportDiagnostics(
    collection: vscode.DiagnosticCollection,
    uri: vscode.Uri,
    issues: ValidationIssue[]
): void {
    const diagnostics: vscode.Diagnostic[] = issues.map(issue => {
        const line = Math.max(0, issue.line - 1); // VS Code is 0-indexed
        const range = new vscode.Range(line, issue.column, line, Number.MAX_SAFE_INTEGER);

        const diagnostic = new vscode.Diagnostic(range, issue.message, issue.severity);
        diagnostic.source = `ubl-${issue.source}`;
        if (issue.ruleId) {
            diagnostic.code = issue.ruleId;
        }

        return diagnostic;
    });

    collection.set(uri, diagnostics);
}

export function showSummaryNotification(result: ValidationResult): void {
    const errors = result.issues.filter(
        i => i.severity === vscode.DiagnosticSeverity.Error
    ).length;
    const warnings = result.issues.filter(
        i => i.severity === vscode.DiagnosticSeverity.Warning
    ).length;

    if (errors === 0 && warnings === 0) {
        vscode.window.showInformationMessage(
            'UBL Validation passed - no errors or warnings found.'
        );
        return;
    }

    const parts: string[] = [];
    if (errors > 0) {
        parts.push(`${errors} error${errors !== 1 ? 's' : ''}`);
    }
    if (warnings > 0) {
        parts.push(`${warnings} warning${warnings !== 1 ? 's' : ''}`);
    }

    const summary = `UBL Validation: ${parts.join(', ')} found.`;
    const details: string[] = [];

    if (!result.xsdPassed) {
        details.push('XSD');
    }
    if (result.en16931Passed === false) {
        details.push('EN16931');
    }
    if (result.peppolPassed === false) {
        details.push('Peppol');
    }

    const failedSources = details.length > 0
        ? ` Failed: ${details.join(', ')}.`
        : '';

    if (errors > 0) {
        vscode.window.showErrorMessage(`${summary}${failedSources}`);
    } else {
        vscode.window.showWarningMessage(`${summary}${failedSources}`);
    }
}
