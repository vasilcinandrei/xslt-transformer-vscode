import * as vscode from 'vscode';

const UBL_NS_PREFIX: Record<string, string> = {
    'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2': 'cbc',
    'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2': 'cac',
    'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2': 'ext',
};

/**
 * Quick Fixes for missing-element diagnostics: jump to the XSLT that produces
 * the section, or insert a stub element into the output for experimentation.
 */
export class MissingElementCodeActionProvider implements vscode.CodeActionProvider {
    public static readonly providedCodeActionKinds = [
        vscode.CodeActionKind.QuickFix,
    ];

    provideCodeActions(
        document: vscode.TextDocument,
        _range: vscode.Range,
        context: vscode.CodeActionContext,
    ): vscode.CodeAction[] {
        const actions: vscode.CodeAction[] = [];

        for (const diagnostic of context.diagnostics) {
            if (!diagnostic.source?.startsWith('ubl-') || !isMissingElementDiagnostic(diagnostic)) {
                continue;
            }

            if (diagnostic.relatedInformation && diagnostic.relatedInformation.length > 0) {
                const related = diagnostic.relatedInformation[0];
                const goToAction = new vscode.CodeAction(
                    'Go to XSLT template that produces this section',
                    vscode.CodeActionKind.QuickFix
                );
                goToAction.command = {
                    command: 'vscode.open',
                    title: 'Open XSLT Template',
                    arguments: [related.location.uri, { selection: related.location.range }],
                };
                goToAction.diagnostics = [diagnostic];
                goToAction.isPreferred = true;
                actions.push(goToAction);
            }

            const missing = extractMissingElement(diagnostic.message);
            if (!missing) {
                continue;
            }
            const addAction = new vscode.CodeAction(
                `Add <${missing}> element (stub)`,
                vscode.CodeActionKind.QuickFix
            );
            addAction.diagnostics = [diagnostic];
            const line = document.lineAt(Math.min(diagnostic.range.start.line, document.lineCount - 1));
            const indent = line.text.match(/^\s*/)?.[0] ?? '';
            addAction.edit = new vscode.WorkspaceEdit();
            addAction.edit.insert(
                document.uri,
                new vscode.Position(line.lineNumber + 1, 0),
                `${indent}    <${missing}>TODO</${missing}>\n`
            );
            actions.push(addAction);
        }

        return actions;
    }
}

export function isMissingElementDiagnostic(diagnostic: vscode.Diagnostic): boolean {
    const msg = diagnostic.message.toLowerCase();
    return (
        msg.includes('missing child element') ||
        msg.includes('is not complete') ||
        msg.includes('is expected') ||
        msg.includes('must exist') ||
        msg.includes('is mandatory') ||
        msg.includes('shall exist') ||
        (msg.includes('missing') && (msg.includes('element') || msg.includes('cbc:') || msg.includes('cac:')))
    );
}

/** Returns the prefixed name (e.g. "cbc:IssueDate") of the first expected/missing element. */
export function extractMissingElement(message: string): string | null {
    // Xerces: One of '{"urn:...CommonBasicComponents-2":IssueDate, ...}' is expected.
    const xerces = message.match(/One of '\{\s*"([^"]+)":(\w+)/);
    if (xerces) {
        return `${UBL_NS_PREFIX[xerces[1]] ?? 'cbc'}:${xerces[2]}`;
    }
    // Simplified Xerces form: One of '{cbc:IssueDate, ...}' is expected.
    const simplified = message.match(/One of '\{\s*((?:cbc|cac|ext):\w+)/);
    if (simplified) {
        return simplified[1];
    }
    // libxml2: Expected is ( {ns}Name )
    const libxml = message.match(/Expected.*?\{([^}]*)\}(\w+)/i);
    if (libxml) {
        return `${UBL_NS_PREFIX[libxml[1]] ?? 'cbc'}:${libxml[2]}`;
    }
    const prefixed = message.match(/missing.*?((?:cbc|cac):\w+)/i);
    return prefixed ? prefixed[1] : null;
}
