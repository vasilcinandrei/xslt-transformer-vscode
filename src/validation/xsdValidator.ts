import * as vscode from 'vscode';
import { ValidationIssue } from './types';

/**
 * Parses the issue lines produced by the Java helper's "xsd" command:
 * "line \t column \t severity \t message".
 */
export function parseXsdIssues(messages: string): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    for (const raw of messages.split(/\r?\n/)) {
        const parts = raw.split('\t');
        if (parts.length < 4) {
            continue;
        }
        const [lineStr, , severity, ...rest] = parts;
        issues.push({
            line: Math.max(1, parseInt(lineStr, 10) || 1),
            column: 0,
            message: simplifyXsdMessage(rest.join(' ')),
            severity: severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error,
            source: 'xsd',
        });
    }
    return issues;
}

const UBL_NS_PREFIXES: Record<string, string> = {
    'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2': 'cbc',
    'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2': 'cac',
    'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2': 'ext',
};

/**
 * Xerces lists expected elements as {"urn:...CommonBasicComponents-2":IssueDate};
 * shorten those to the familiar cbc:IssueDate form.
 */
export function simplifyXsdMessage(message: string): string {
    return message.replace(/"([^"]+)":([A-Za-z][\w.-]*)/g, (whole, ns: string, name: string) => {
        const prefix = UBL_NS_PREFIXES[ns];
        return prefix ? `${prefix}:${name}` : whole;
    });
}
