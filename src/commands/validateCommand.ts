import * as vscode from 'vscode';
import { detectUblDocumentFromContent } from '../validation/documentDetector';
import { validateContent } from '../validation/validator';
import { reportDiagnostics, showSummaryNotification } from '../validation/diagnosticsReporter';
import { ValidationResult, ValidationScope } from '../validation/types';
import { getDiagnosticCollection, getValidationContext, showError } from '../services';
import { isXsltDocument } from './inputPicker';

export type ValidationListener = (doc: vscode.TextDocument, result: ValidationResult) => void;

/**
 * Validates the editor buffer (unsaved and untitled documents included), so
 * diagnostics always line up with what the user sees.
 */
export async function validateDocument(
    document: vscode.TextDocument,
    scope: ValidationScope,
    onProgress?: (message: string) => void
): Promise<ValidationResult | undefined> {
    const content = document.getText();
    const docInfo = detectUblDocumentFromContent(content);
    if (!docInfo) {
        return undefined;
    }
    const result = await validateContent(content, docInfo, scope, getValidationContext(), onProgress);
    reportDiagnostics(getDiagnosticCollection(), document.uri, result.issues);
    return result;
}

export function createValidateCommand(scope: ValidationScope, onValidated?: ValidationListener): () => Promise<void> {
    return async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No active editor. Open a UBL XML file first.');
            return;
        }
        const document = editor.document;
        // On a stylesheet, "validate" means: transform it and validate the output
        if (isXsltDocument(document)) {
            await vscode.commands.executeCommand('xslt-transformer.transform');
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'UBL',
            cancellable: false,
        }, async (progress) => {
            try {
                const result = await validateDocument(document, scope, message => progress.report({ message }));
                if (!result) {
                    vscode.window.showWarningMessage(
                        'Not a recognized UBL 2.1 document: the root element must be a UBL document type in its UBL namespace ' +
                        '(e.g. <Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2">).'
                    );
                    return;
                }
                onValidated?.(document, result);
                showSummaryNotification(result);
            } catch (error) {
                showError('Validation failed', error);
            }
        });
    };
}
