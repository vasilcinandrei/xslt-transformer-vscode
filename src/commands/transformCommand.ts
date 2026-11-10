import * as vscode from 'vscode';
import { transformAndValidate, PipelineOptions, TransformResult } from '../pipeline/transformAndValidate';
import { reportDiagnostics, showSummaryNotification, clearTracedIssues } from '../validation/diagnosticsReporter';
import {
    getDiagnosticCollection, getTransformSession, getValidationContext, logTransformMessages,
    setTransformSession, showError,
} from '../services';
import { pickTransformInputs } from './inputPicker';

/**
 * Shows transform output, reusing the previous output tab when it is still
 * open instead of piling up untitled documents.
 */
export async function showTransformOutput(content: string): Promise<vscode.TextDocument> {
    const previous = getTransformSession()?.outputUri;
    const existing = previous && vscode.workspace.textDocuments.find(
        d => d.uri.toString() === previous.toString() && !d.isClosed
    );
    if (existing) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(existing.uri, new vscode.Range(existing.positionAt(0), existing.positionAt(existing.getText().length)), content);
        await vscode.workspace.applyEdit(edit);
        await vscode.window.showTextDocument(existing, { preview: false });
        return existing;
    }
    const doc = await vscode.workspace.openTextDocument({ content, language: 'xml' });
    await vscode.window.showTextDocument(doc, { preview: false });
    return doc;
}

/** Displays a traced pipeline result and records it for the AI fix commands. */
export async function presentTransformResult(
    result: TransformResult,
    options: PipelineOptions,
    notify = true
): Promise<vscode.TextDocument> {
    logTransformMessages(result.messages);
    const outputDoc = await showTransformOutput(result.output);
    const collection = getDiagnosticCollection();

    if (!result.isUbl || !result.validationResult) {
        collection.delete(outputDoc.uri);
        clearTracedIssues(outputDoc.uri);
        setTransformSession(undefined);
        if (notify) {
            vscode.window.setStatusBarMessage('$(check) Transform complete — output is not a UBL document, validation skipped', 5000);
        }
        return outputDoc;
    }

    const tracedIssues = result.tracedIssues ?? result.validationResult.issues;
    reportDiagnostics(collection, outputDoc.uri, tracedIssues);
    setTransformSession({ options, output: result.output, outputUri: outputDoc.uri, tracedIssues });
    if (notify) {
        showSummaryNotification(result.validationResult);
    }
    return outputDoc;
}

export function createTransformCommand(context: vscode.ExtensionContext): () => Promise<void> {
    return async () => {
        const inputs = await pickTransformInputs(context);
        if (!inputs) {
            return;
        }

        const options: PipelineOptions = {
            sourceXml: inputs.sourceXml,
            xsltStylesheet: inputs.xsltStylesheet,
            validationScope: inputs.validationScope,
            enableTracing: true,
        };

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'XSLT',
            cancellable: true,
        }, async (progress, token) => {
            const abort = new AbortController();
            token.onCancellationRequested(() => abort.abort());
            try {
                const result = await transformAndValidate(
                    { ...options, onProgress: message => progress.report({ message }), signal: abort.signal },
                    getValidationContext()
                );
                await presentTransformResult(result, options);
            } catch (error) {
                if (abort.signal.aborted) {
                    return;
                }
                showError('Transformation failed', error);
            }
        });
    };
}
