import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { findConfigFile, loadConfig, pickProfile, resolveProfilePaths } from '../config/projectConfig';
import { ValidationScope } from '../validation/types';

const LAST_INPUT_KEY = 'ublValidator.lastInputByStylesheet';

export interface TransformInputs {
    sourceXml: string;
    xsltStylesheet: string;
    validationScope: ValidationScope;
}

export function isXsltDocument(doc: vscode.TextDocument): boolean {
    return doc.uri.scheme === 'file' && (doc.languageId === 'xsl' || /\.(xsl|xslt)$/i.test(doc.uri.fsPath));
}

/**
 * Resolves the stylesheet and input XML for a transform:
 * 1. the XSLT in the active editor, else
 * 2. a profile from .ublproject.json, else
 * 3. a file picker.
 * The input XML defaults to the one last used with that stylesheet.
 */
export async function pickTransformInputs(context: vscode.ExtensionContext): Promise<TransformInputs | undefined> {
    const active = vscode.window.activeTextEditor?.document;
    if (active && isXsltDocument(active)) {
        if (active.isDirty) {
            await active.save();
        }
        const sourceXml = await pickInputXml(context, active.uri.fsPath);
        return sourceXml ? { sourceXml, xsltStylesheet: active.uri.fsPath, validationScope: 'full' } : undefined;
    }

    const configPath = findConfigFile();
    if (configPath) {
        try {
            const profile = await pickProfile(loadConfig(configPath));
            if (!profile) {
                return undefined;
            }
            const resolved = resolveProfilePaths(profile, path.dirname(configPath));
            return { ...resolved, validationScope: profile.validationScope || 'full' };
        } catch (error: any) {
            vscode.window.showErrorMessage(`Error loading .ublproject.json: ${error.message}`);
            return undefined;
        }
    }

    const xslFiles = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Select XSL/XSLT Stylesheet',
        filters: { 'XSL Files': ['xsl', 'xslt'], 'All Files': ['*'] },
    });
    if (!xslFiles || xslFiles.length === 0) {
        return undefined;
    }
    const xsltStylesheet = xslFiles[0].fsPath;
    const sourceXml = await pickInputXml(context, xsltStylesheet);
    return sourceXml ? { sourceXml, xsltStylesheet, validationScope: 'full' } : undefined;
}

async function pickInputXml(context: vscode.ExtensionContext, xsltPath: string): Promise<string | undefined> {
    const remembered = context.workspaceState.get<Record<string, string>>(LAST_INPUT_KEY, {});
    const last = remembered[xsltPath];

    type Item = vscode.QuickPickItem & { filePath?: string };
    const items: Item[] = [];
    if (last && fs.existsSync(last)) {
        items.push({ label: `$(history) ${path.basename(last)}`, description: 'last used', detail: last, filePath: last });
    }
    for (const doc of vscode.workspace.textDocuments) {
        if (doc.uri.scheme === 'file' && doc.languageId === 'xml' && doc.uri.fsPath !== last) {
            items.push({ label: `$(file) ${path.basename(doc.uri.fsPath)}`, description: 'open', detail: doc.uri.fsPath, filePath: doc.uri.fsPath });
        }
    }

    let chosen: string | undefined;
    if (items.length > 0) {
        items.push({ label: '$(folder-opened) Browse...' });
        const pick = await vscode.window.showQuickPick(items, {
            placeHolder: `Input XML for ${path.basename(xsltPath)}`,
        });
        if (!pick) {
            return undefined;
        }
        chosen = pick.filePath;
    }

    if (!chosen) {
        const xmlFiles = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: 'Select XML Input File',
            filters: { 'XML Files': ['xml'], 'All Files': ['*'] },
        });
        if (!xmlFiles || xmlFiles.length === 0) {
            return undefined;
        }
        chosen = xmlFiles[0].fsPath;
    }

    // Unsaved edits to the input would otherwise be ignored by the transform
    const openDoc = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && d.uri.fsPath === chosen);
    if (openDoc?.isDirty) {
        await openDoc.save();
    }

    await context.workspaceState.update(LAST_INPUT_KEY, { ...remembered, [xsltPath]: chosen });
    return chosen;
}
