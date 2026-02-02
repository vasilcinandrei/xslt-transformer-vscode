import * as path from 'path';
import * as vscode from 'vscode';
import { ValidationIssue, UblDocumentInfo } from './types';
import { execAsync, checkToolAvailable, getInstallInstructions } from '../utils/execAsync';

export async function validateXsd(
    filePath: string,
    docInfo: UblDocumentInfo,
    artifactsPath: string
): Promise<ValidationIssue[]> {
    const available = await checkToolAvailable('xmllint');
    if (!available) {
        throw new Error(
            `"xmllint" is not installed or not in your PATH. ` +
            getInstallInstructions('xmllint')
        );
    }

    const xsdFile = path.join(
        artifactsPath, 'xsd', 'ubl-2.1', 'maindoc',
        `UBL-${docInfo.rootElement}-2.1.xsd`
    );

    try {
        await execAsync('xmllint', ['--noout', '--schema', xsdFile, filePath]);
        return [];
    } catch (error: any) {
        const stderr: string = error.stderr || '';
        return parseXmllintErrors(stderr, filePath);
    }
}

function parseXmllintErrors(stderr: string, filePath: string): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const lines = stderr.split('\n');

    for (const line of lines) {
        // xmllint error format: file.xml:line: element foo: Schemas validity error : ...
        // or: file.xml:line: parser error : ...
        const match = line.match(/:(\d+):\s*(.*?)(?:Schemas validity error\s*:\s*|parser error\s*:\s*)(.*)/);
        if (match) {
            issues.push({
                line: parseInt(match[1], 10),
                column: 0,
                message: match[3].trim(),
                severity: vscode.DiagnosticSeverity.Error,
                source: 'xsd',
            });
            continue;
        }

        // Simpler format: file.xml:line: ...error...
        const simpleMatch = line.match(/:(\d+):\s*(.*error.*)/i);
        if (simpleMatch) {
            issues.push({
                line: parseInt(simpleMatch[1], 10),
                column: 0,
                message: simpleMatch[2].trim(),
                severity: vscode.DiagnosticSeverity.Error,
                source: 'xsd',
            });
        }
    }

    // Filter out the final "fails to validate" summary line if it matched
    return issues.filter(i => !i.message.includes('fails to validate'));
}
