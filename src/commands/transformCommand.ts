import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execAsync, checkToolAvailable, getInstallInstructions } from '../utils/execAsync';

export async function transformCommand(): Promise<void> {
    try {
        const available = await checkToolAvailable('xsltproc');
        if (!available) {
            vscode.window.showErrorMessage(
                `"xsltproc" is not installed or not in your PATH. ` +
                getInstallInstructions('xsltproc')
            );
            return;
        }

        const xmlFiles = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: 'Select XML Input File',
            filters: {
                'XML Files': ['xml'],
                'All Files': ['*']
            }
        });

        if (!xmlFiles || xmlFiles.length === 0) {
            vscode.window.showInformationMessage('No XML file selected');
            return;
        }

        const xmlPath = xmlFiles[0].fsPath;

        const xslFiles = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: 'Select XSL/XSLT File',
            filters: {
                'XSL Files': ['xsl', 'xslt'],
                'All Files': ['*']
            }
        });

        if (!xslFiles || xslFiles.length === 0) {
            vscode.window.showInformationMessage('No XSL file selected');
            return;
        }

        const xslPath = xslFiles[0].fsPath;

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Transforming XML...',
            cancellable: false
        }, async (progress) => {
            progress.report({ increment: 0 });

            try {
                progress.report({ increment: 30, message: 'Processing transformation...' });

                const { stdout, stderr } = await execAsync('xsltproc', [xslPath, xmlPath]);

                if (stderr) {
                    console.warn('xsltproc warnings:', stderr);
                }

                const output = stdout;

                progress.report({ increment: 70, message: 'Creating output...' });

                const action = await vscode.window.showQuickPick(
                    ['Show in Editor', 'Save to File'],
                    { placeHolder: 'What would you like to do with the result?' }
                );

                if (action === 'Show in Editor') {
                    const doc = await vscode.workspace.openTextDocument({
                        content: output,
                        language: 'xml'
                    });
                    await vscode.window.showTextDocument(doc);
                } else if (action === 'Save to File') {
                    const saveUri = await vscode.window.showSaveDialog({
                        defaultUri: vscode.Uri.file(path.join(
                            path.dirname(xmlPath),
                            path.basename(xmlPath, '.xml') + '_transformed.xml'
                        )),
                        filters: {
                            'XML Files': ['xml'],
                            'HTML Files': ['html'],
                            'Text Files': ['txt'],
                            'All Files': ['*']
                        }
                    });

                    if (saveUri) {
                        fs.writeFileSync(saveUri.fsPath, output, 'utf8');
                        vscode.window.showInformationMessage(`Transformation saved to ${saveUri.fsPath}`);

                        const openFile = await vscode.window.showQuickPick(
                            ['Yes', 'No'],
                            { placeHolder: 'Open the saved file?' }
                        );
                        if (openFile === 'Yes') {
                            const doc = await vscode.workspace.openTextDocument(saveUri);
                            await vscode.window.showTextDocument(doc);
                        }
                    }
                }

                progress.report({ increment: 100 });
            } catch (error: any) {
                vscode.window.showErrorMessage(`Transformation failed: ${error.message}`);
                console.error('XSLT Transformation Error:', error);
            }
        });

    } catch (error: any) {
        vscode.window.showErrorMessage(`Error: ${error.message}`);
        console.error('Extension Error:', error);
    }
}
