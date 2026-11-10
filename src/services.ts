import * as path from 'path';
import * as vscode from 'vscode';
import { JavaHelper, JavaToolError, clearJavaStatusCache } from './utils/javaRunner';
import { ValidationContext } from './validation/validator';
import { getSettings } from './config/settings';
import { PipelineOptions } from './pipeline/transformAndValidate';
import { TracedIssue } from './tracing/errorTraceMapper';
import { RuleStore } from './rules/ruleStore';

let extensionPath = '';
let helper: JavaHelper | undefined;
let diagnostics: vscode.DiagnosticCollection;
let output: vscode.OutputChannel;
let ruleStore: RuleStore;

export function initServices(context: vscode.ExtensionContext): void {
    extensionPath = context.extensionPath;
    helper = new JavaHelper(extensionPath, () => getSettings().javaPath);
    diagnostics = vscode.languages.createDiagnosticCollection('ubl-validation');
    output = vscode.window.createOutputChannel('UBL Validator');
    ruleStore = new RuleStore({
        storageDir: path.join(context.globalStorageUri.fsPath, 'rules'),
        extensionPath,
        helper,
        getSettings: () => getSettings().rules,
        bundledArtifactsPath: getBundledArtifactsPath(),
        log: message => output.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`),
        onUpdated: results => {
            const list = results.map(r => `${r.label} ${r.to}`).join(', ');
            vscode.window.setStatusBarMessage(`$(cloud-download) Business rules updated: ${list}`, 8000);
        },
    });

    context.subscriptions.push(
        diagnostics,
        output,
        { dispose: () => helper?.dispose() },
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('ublValidator.javaPath')) {
                clearJavaStatusCache();
                helper?.dispose();
            }
        })
    );
}

export function getHelper(): JavaHelper {
    if (!helper) {
        throw new Error('UBL Validator is not initialised');
    }
    return helper;
}

export function getBundledArtifactsPath(): string {
    return path.join(extensionPath, 'validation-artifacts');
}

export function getValidationContext(): ValidationContext {
    const s = getSettings();
    return {
        helper: getHelper(),
        bundledArtifactsPath: getBundledArtifactsPath(),
        artifactsOverridePath: s.artifactsPath,
        rules: ruleStore,
        customSchematron: s.customSchematron,
        timeoutMs: s.timeoutMs,
    };
}

export function getRuleStore(): RuleStore {
    return ruleStore;
}

export function getDiagnosticCollection(): vscode.DiagnosticCollection {
    return diagnostics;
}

export function getOutputChannel(): vscode.OutputChannel {
    return output;
}

/** Logs xsl:message output and warnings from a transform, if any. */
export function logTransformMessages(messages: string): void {
    const relevant = messages.split('\n').filter(l => l.trim()).join('\n');
    if (relevant) {
        output.appendLine(`[${new Date().toLocaleTimeString()}] Transform messages:`);
        output.appendLine(relevant);
    }
}

/**
 * Shows an error; for Java/Saxon errors the full details go to the output
 * channel with a button to open it.
 */
export function showError(prefix: string, error: unknown): void {
    const e = error as Error;
    if (e instanceof JavaToolError && e.details) {
        output.appendLine(`[${new Date().toLocaleTimeString()}] ${prefix}: ${e.message}`);
        output.show(true);
        const firstDetail = e.details.split('\n')[0];
        vscode.window.showErrorMessage(`${prefix}: ${firstDetail}`, 'Show Details').then(choice => {
            if (choice) {
                output.show();
            }
        });
        return;
    }
    vscode.window.showErrorMessage(`${prefix}: ${e?.message ?? String(error)}`);
}

// ─── Last transform (used by the AI fix commands) ─────────────────────

export interface TransformSession {
    options: PipelineOptions;
    output: string;
    outputUri: vscode.Uri;
    tracedIssues: TracedIssue[];
}

let lastSession: TransformSession | undefined;

export function setTransformSession(session: TransformSession | undefined): void {
    lastSession = session;
}

export function getTransformSession(): TransformSession | undefined {
    return lastSession;
}
