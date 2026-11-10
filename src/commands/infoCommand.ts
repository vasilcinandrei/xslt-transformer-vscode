import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getSettings } from '../config/settings';
import { getBundledArtifactsPath, getHelper, getOutputChannel, getRuleStore } from '../services';
import { detectUblDocumentFromContent } from '../validation/documentDetector';
import { extractFacts } from '../rules/facts';
import { selectPacks } from '../rules/selector';
import { MatchRule } from '../rules/types';
import { UpdateResult } from '../rules/ruleStore';

function stamp(): string {
    return `[${new Date().toLocaleTimeString()}]`;
}

/** Writes Java/Saxon versions and active settings to the output channel. */
export async function showValidatorInfo(): Promise<void> {
    const out = getOutputChannel();
    const settings = getSettings();
    const lines: string[] = ['UBL Validator — environment'];

    try {
        const { output } = await getHelper().ping();
        for (const l of output.split('\n')) {
            const [k, v] = l.split('=');
            lines.push(`  ${k === 'java' ? 'Java' : 'Saxon-HE'}: ${v}`);
        }
    } catch (e: any) {
        lines.push(`  Java helper: not available — ${e.message}`);
    }

    lines.push('', 'Business rules:');
    lines.push(`  Source: ${settings.rules.source === 'latest' ? 'latest from official publishers' : 'bundled only'}`);
    lines.push(`  Auto update: ${settings.rules.autoUpdate ? 'daily' : 'off'}`);
    lines.push(`  Catalog: ${settings.rules.catalogUrl || 'bundled only'}`);
    if (settings.rules.disabled.length > 0) {
        lines.push(`  Disabled: ${settings.rules.disabled.join(', ')}`);
    }
    for (const p of settings.customSchematron) {
        lines.push(`  Custom: ${p}${fs.existsSync(p) ? '' : ' (file not found)'}`);
    }
    const bundled = readVersions(getBundledArtifactsPath());
    for (const v of Object.values(bundled ?? {})) {
        lines.push(`  Bundled offline copy: ${v.label} ${v.version}`);
    }
    if (settings.artifactsPath) {
        lines.push(`  Artifacts override folder: ${settings.artifactsPath}`);
    }
    lines.push(`  Validate on save: ${settings.validateOnSave ? 'on' : 'off'}`);

    out.appendLine(lines.join('\n'));
    out.appendLine('');
    out.show();
}

function readVersions(root: string): Record<string, { label: string; version: string }> | undefined {
    try {
        return JSON.parse(fs.readFileSync(path.join(root, 'versions.json'), 'utf8'));
    } catch {
        return undefined;
    }
}

function describeRule(rule: MatchRule): string {
    const parts: string[] = [];
    const str = (name: string, m: NonNullable<MatchRule['customizationId']>) => {
        if (m.equals) { parts.push(`${name} = ${m.equals}`); }
        if (m.startsWith) { parts.push(`${name} starts with ${m.startsWith}`); }
        if (m.contains) { parts.push(`${name} contains ${m.contains}`); }
        if (m.regex) { parts.push(`${name} matches /${m.regex}/`); }
    };
    if (rule.customizationId) { str('CustomizationID', rule.customizationId); }
    if (rule.profileId) { str('ProfileID', rule.profileId); }
    if (rule.sellerCountry) { parts.push(`seller in ${rule.sellerCountry.join('/')}`); }
    if (rule.buyerCountry) { parts.push(`buyer in ${rule.buyerCountry.join('/')}`); }
    return parts.join(' AND ');
}

/**
 * Explains which rule packs apply to the active document and why, then lists
 * the whole catalog with installed versions.
 */
export async function showBusinessRules(): Promise<void> {
    const out = getOutputChannel();
    const store = getRuleStore();
    const catalog = store.catalog;
    const disabled = new Set(getSettings().rules.disabled);
    const lines: string[] = [];

    const doc = vscode.window.activeTextEditor?.document;
    const docInfo = doc && detectUblDocumentFromContent(doc.getText());
    if (doc && docInfo) {
        const facts = extractFacts(doc.getText(), docInfo.rootElement);
        const selection = selectPacks(catalog, facts, disabled);
        lines.push(`Rules for ${path.basename(doc.uri.fsPath || doc.uri.path)}`);
        lines.push(`  Document:        ${facts.rootElement}`);
        lines.push(`  CustomizationID: ${facts.customizationId ?? '(none)'}`);
        lines.push(`  ProfileID:       ${facts.profileId ?? '(none)'}`);
        lines.push(`  Seller country:  ${facts.sellerCountry ?? '(unknown)'}`);
        lines.push(`  Buyer country:   ${facts.buyerCountry ?? '(unknown)'}`);
        lines.push('  Applies:');
        if (selection.packs.length === 0) {
            lines.push('    (no business rules for this document type)');
        }
        for (const p of selection.packs) {
            const installed = store.installed(p.id);
            lines.push(`    ${p.label} [${p.id}] — ${selection.reasons.get(p.id)}${installed ? ` — ${installed.version}` : ' — not downloaded yet'}`);
        }
        for (const n of selection.notes) {
            lines.push(`  Note: ${n}`);
        }
        lines.push('');
    }

    lines.push(`Rules catalog (${catalog.packs.length} packs${catalog.updated ? `, updated ${catalog.updated}` : ''})`);
    for (const p of [...catalog.packs].sort((a, b) => (a.country ?? '').localeCompare(b.country ?? '') || a.label.localeCompare(b.label))) {
        const installed = store.installed(p.id);
        const state = disabled.has(p.id) ? 'disabled' : installed ? `installed ${installed.version}` : 'downloaded on first use';
        lines.push(`  ${(p.country ?? '').padEnd(7)} ${p.label} [${p.id}] — ${state}`);
        lines.push(`          for ${p.documentTypes.join(', ')} when ${p.match.map(describeRule).join('  OR  ')}`);
    }
    lines.push('', 'Countries without UBL rules of their own are covered by EN16931/Peppol (BE, LU, AT, SK, IE, LV, LT, FI, ...).');
    lines.push('National non-UBL formats (PL KSeF, HU, CZ ISDOC, SI e-SLOG, IT FatturaPA, ES Facturae) cannot be validated as UBL.');

    out.appendLine(lines.join('\n'));
    out.appendLine('');
    out.show();
}

function reportUpdates(results: UpdateResult[], verb: string): void {
    const out = getOutputChannel();
    const changed = results.filter(r => r.to && r.from !== r.to);
    const failed = results.filter(r => r.error);
    for (const r of results) {
        out.appendLine(`${stamp()} ${r.label}: ${r.error ? `failed — ${r.error}` : r.from && r.from !== r.to ? `${r.from} → ${r.to}` : `${r.to} (current)`}`);
    }
    const summary = `${verb}: ${changed.length} updated, ${results.length - changed.length - failed.length} already current` +
        (failed.length ? `, ${failed.length} failed` : '') + '.';
    if (failed.length > 0) {
        vscode.window.showWarningMessage(summary, 'Show Details').then(c => c && out.show());
    } else {
        vscode.window.showInformationMessage(summary);
    }
}

export async function updateBusinessRules(): Promise<void> {
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Checking for business rule updates...',
    }, async () => {
        try {
            const results = await getRuleStore().checkForUpdates();
            if (results.length === 0) {
                vscode.window.showInformationMessage('No rule packs downloaded yet. They are fetched automatically the first time a matching document is validated.');
                return;
            }
            reportUpdates(results, 'Business rules');
        } catch (e: any) {
            vscode.window.showErrorMessage(e.message);
        }
    });
}

export async function downloadAllBusinessRules(): Promise<void> {
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Downloading business rules',
    }, async (progress) => {
        try {
            const results = await getRuleStore().installAll(label => progress.report({ message: label }));
            reportUpdates(results, 'Download');
        } catch (e: any) {
            vscode.window.showErrorMessage(e.message);
        }
    });
}
