import * as vscode from 'vscode';

/** 'xsd', 'custom' or the id of a business-rule pack (e.g. 'en16931', 'xrechnung') */
export type IssueSource = string;

export interface ValidationIssue {
    line: number;
    column: number;
    message: string;
    severity: vscode.DiagnosticSeverity;
    ruleId?: string;
    source: IssueSource;
}

export interface UblDocumentInfo {
    rootElement: string;
    namespace: string;
    documentType: string;
    isInvoiceOrCreditNote: boolean;
}

export interface ValidationCheck {
    /** e.g. 'xsd', 'en16931', 'peppol' or the custom file path */
    id: string;
    label: string;
    /** null when the check could not run */
    passed: boolean | null;
    /** Why this rule set was chosen for the document */
    reason?: string;
}

export interface ValidationResult {
    issues: ValidationIssue[];
    documentInfo: UblDocumentInfo | null;
    checks: ValidationCheck[];
    /** Problems running a check (missing files, Java errors) */
    toolErrors: string[];
    /** Information about rule selection (e.g. unknown CustomizationID, offline fallback) */
    notes: string[];
}

export type ValidationScope = 'full' | 'xsd-only' | 'business-rules-only';
