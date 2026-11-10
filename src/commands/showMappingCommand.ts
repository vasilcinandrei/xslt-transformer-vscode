import * as vscode from 'vscode';
import { transformAndValidate } from '../pipeline/transformAndValidate';
import { MappingPanel } from '../webview/mappingPanel';
import { getValidationContext, logTransformMessages, showError } from '../services';
import { pickTransformInputs } from './inputPicker';

export function createShowMappingCommand(context: vscode.ExtensionContext): () => Promise<void> {
    return async () => {
        const inputs = await pickTransformInputs(context);
        if (!inputs) {
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Building XSLT → output mapping',
            cancellable: true,
        }, async (progress, token) => {
            const abort = new AbortController();
            token.onCancellationRequested(() => abort.abort());
            try {
                const result = await transformAndValidate({
                    ...inputs,
                    enableTracing: true,
                    onProgress: (message) => progress.report({ message }),
                    signal: abort.signal,
                }, getValidationContext());
                logTransformMessages(result.messages);

                MappingPanel.createOrShow({
                    stylesheetFiles: result.stylesheetFiles ?? [inputs.xsltStylesheet],
                    outputXml: result.output,
                    traceEntries: result.traceEntries ?? [],
                    validationIssues: result.tracedIssues ?? result.validationResult?.issues ?? [],
                });
            } catch (error) {
                if (abort.signal.aborted) {
                    return;
                }
                showError('Mapping view failed', error);
            }
        });
    };
}
