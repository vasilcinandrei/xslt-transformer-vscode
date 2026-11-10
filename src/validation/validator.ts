import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { UblDocumentInfo, ValidationCheck, ValidationIssue, ValidationResult, ValidationScope } from './types';
import { RuleResolver } from '../rules/ruleStore';
import { parseXsdIssues } from './xsdValidator';
import { parseSvrlOutputFromContent } from './svrlParser';
import { writeTempFile } from '../utils/tempFile';
import { JavaHelper } from '../utils/javaRunner';
import { resolveArtifact } from '../config/settings';

export interface ValidationContext {
    helper: JavaHelper;
    bundledArtifactsPath: string;
    /** Replacement artifacts folder for the XSD schemas ('' for none) */
    artifactsOverridePath: string;
    /** Chooses (and downloads) the business rules for each document */
    rules: RuleResolver;
    /** User-supplied compiled Schematron files, run on every UBL document */
    customSchematron: string[];
    /** Per-request limit for the Java helper (0 = none) */
    timeoutMs?: number;
}

/**
 * Runs XSD and Schematron validation on document content. Tool failures are
 * collected in `toolErrors` rather than thrown so one broken check doesn't
 * hide the results of the others.
 */
export async function validateContent(
    content: string,
    docInfo: UblDocumentInfo,
    scope: ValidationScope,
    ctx: ValidationContext,
    onProgress?: (message: string) => void,
    signal?: AbortSignal
): Promise<ValidationResult> {
    const requestOptions = { timeoutMs: ctx.timeoutMs, signal };
    const issues: ValidationIssue[] = [];
    const checks: ValidationCheck[] = [];
    const toolErrors: string[] = [];
    const notes: string[] = [];
    // The text is written as UTF-8, so its declaration must say so (lines are unchanged)
    const tmp = writeTempFile(declareUtf8(content), '.xml');

    try {
        if (scope === 'full' || scope === 'xsd-only') {
            onProgress?.('Running XSD validation...');
            const xsdFile = resolveArtifact(
                ctx.bundledArtifactsPath, ctx.artifactsOverridePath,
                path.join('xsd', 'ubl-2.1', 'maindoc', `UBL-${docInfo.rootElement}-2.1.xsd`)
            );
            try {
                if (!fs.existsSync(xsdFile)) {
                    throw new Error(`Schema not found: ${xsdFile}`);
                }
                const { messages } = await ctx.helper.validateXsd(xsdFile, tmp.filePath, requestOptions);
                const xsdIssues = parseXsdIssues(messages);
                issues.push(...xsdIssues);
                checks.push({ id: 'xsd', label: 'XSD', passed: !xsdIssues.some(isError) });
            } catch (e: any) {
                toolErrors.push(`XSD validation failed: ${e.message}`);
                checks.push({ id: 'xsd', label: 'XSD', passed: null });
            }
        }

        if (scope === 'full' || scope === 'business-rules-only') {
            onProgress?.('Selecting business rules...');
            const plan = await ctx.rules.plan(content, docInfo, onProgress);
            notes.push(...plan.notes);
            toolErrors.push(...plan.errors);
            const custom = ctx.customSchematron.map(p => ({
                id: 'custom', label: path.basename(p).replace(/\.(xslt?|sef\.json)$/i, ''),
                version: undefined as string | undefined, reason: 'ublValidator.rules.customSchematron',
                xsltPaths: [p], sandboxRoots: [path.dirname(p)],
            }));

            for (const check of [...plan.checks, ...custom]) {
                onProgress?.(`Checking ${check.label} rules...`);
                const label = check.version ? `${check.label} ${check.version}` : check.label;
                try {
                    const ruleIssues: ValidationIssue[] = [];
                    for (const xslt of check.xsltPaths) {
                        if (!fs.existsSync(xslt)) {
                            throw new Error(`Rules file not found: ${xslt}`);
                        }
                        const { output } = await ctx.helper.transform(xslt, tmp.filePath, true, {
                            ...requestOptions,
                            // Rules never write files and only read their own folder
                            sandboxRoots: check.sandboxRoots,
                        });
                        ruleIssues.push(...parseSvrlOutputFromContent(output, content, check.id));
                    }
                    issues.push(...ruleIssues);
                    checks.push({ id: check.id, label, passed: !ruleIssues.some(isError), reason: check.reason });
                } catch (e: any) {
                    toolErrors.push(`${label} validation failed: ${e.message}`);
                    checks.push({ id: check.id, label, passed: null, reason: check.reason });
                }
            }
        }
    } finally {
        tmp.cleanup();
    }

    return { issues, documentInfo: docInfo, checks, toolErrors, notes };
}

/** Rewrites the encoding in the XML declaration to UTF-8. */
export function declareUtf8(content: string): string {
    return content.replace(/^(\uFEFF?\s*<\?xml[^>]*?\bencoding\s*=\s*)(["'])[^"']*\2/, '$1$2UTF-8$2');
}

function isError(i: ValidationIssue): boolean {
    return i.severity === vscode.DiagnosticSeverity.Error;
}
