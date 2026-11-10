import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { RuleSettings } from '../rules/ruleStore';

export const DEFAULT_CATALOG_URL =
    'https://raw.githubusercontent.com/vasilcinandrei/xslt-transformer-vscode/main/rules/catalog.json';

export interface ValidatorSettings {
    javaPath: string;
    /** Per-request limit for transforms and validations, in ms */
    timeoutMs: number;
    validateOnSave: boolean;
    rules: RuleSettings;
    /** Absolute paths of extra compiled Schematron (XSLT) files */
    customSchematron: string[];
    /** Folder with replacement artifacts ('' = bundled only) */
    artifactsPath: string;
}

export function getSettings(): ValidatorSettings {
    const cfg = vscode.workspace.getConfiguration('ublValidator');
    return {
        javaPath: cfg.get<string>('javaPath', '').trim() || 'java',
        timeoutMs: Math.max(5, cfg.get<number>('transformTimeoutSeconds', 120)) * 1000,
        validateOnSave: cfg.get<boolean>('validateOnSave', true),
        rules: getRuleSettings(cfg),
        customSchematron: cfg.get<string[]>('rules.customSchematron', []).map(resolveWorkspacePath),
        artifactsPath: resolveWorkspacePath(cfg.get<string>('artifactsPath', '').trim()),
    };
}

function getRuleSettings(cfg: vscode.WorkspaceConfiguration): RuleSettings {
    const disabled = new Set(cfg.get<string[]>('rules.disabled', []));
    // Older on/off switches
    if (cfg.get<boolean>('rules.en16931') === false) {
        disabled.add('en16931');
    }
    if (cfg.get<boolean>('rules.peppol') === false) {
        disabled.add('peppol-bis');
    }
    return {
        source: cfg.get<'latest' | 'bundled'>('rules.source', 'latest'),
        disabled: [...disabled],
        autoUpdate: cfg.get<boolean>('rules.autoUpdate', true),
        catalogUrl: cfg.get<string>('rules.catalogUrl', DEFAULT_CATALOG_URL).trim(),
        allowedHosts: cfg.get<string[]>('rules.allowedHosts', []),
        allowedRepos: cfg.get<string[]>('rules.allowedRepos', []),
        timeoutMs: Math.max(5, cfg.get<number>('transformTimeoutSeconds', 120)) * 1000,
    };
}

/** Resolves a setting path relative to the first workspace folder; supports ~. */
export function resolveWorkspacePath(p: string): string {
    if (!p) {
        return '';
    }
    if (p.startsWith('~')) {
        p = path.join(process.env.HOME || process.env.USERPROFILE || '', p.slice(1));
    }
    if (path.isAbsolute(p)) {
        return p;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? path.join(folder.uri.fsPath, p) : path.resolve(p);
}

/**
 * Returns the artifact path, preferring the user's artifacts folder when it
 * contains the file and falling back to the bundled copy.
 */
export function resolveArtifact(bundledRoot: string, overrideRoot: string, relative: string): string {
    if (overrideRoot) {
        const candidate = path.join(overrideRoot, relative);
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return path.join(bundledRoot, relative);
}
