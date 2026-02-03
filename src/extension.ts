import * as vscode from 'vscode';
import { createTransformCommand } from './commands/transformCommand';
import { createValidateCommand } from './commands/validateCommand';
import { MissingElementCodeActionProvider } from './analysis/codeActionProvider';
import { checkJavaAvailable } from './utils/javaRunner';

let diagnosticCollection: vscode.DiagnosticCollection;

export function activate(context: vscode.ExtensionContext) {
    console.log('XSLT Transformer extension is now active');

    diagnosticCollection = vscode.languages.createDiagnosticCollection('ubl-validation');
    context.subscriptions.push(diagnosticCollection);

    context.subscriptions.push(
        vscode.commands.registerCommand('xslt-transformer.transform', createTransformCommand(context))
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'xslt-transformer.validateUbl',
            createValidateCommand(context, 'full')
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'xslt-transformer.validateUblXsd',
            createValidateCommand(context, 'xsd-only')
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'xslt-transformer.validateUblBusinessRules',
            createValidateCommand(context, 'business-rules-only')
        )
    );

    // Code action provider for missing element Quick Fix suggestions
    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider(
            { language: 'xml', scheme: '*' },
            new MissingElementCodeActionProvider(),
            { providedCodeActionKinds: MissingElementCodeActionProvider.providedCodeActionKinds }
        )
    );

    // Non-blocking Java availability check on activation
    checkJavaAvailable().then(available => {
        if (!available) {
            vscode.window.showWarningMessage(
                'Java is not installed or not in PATH. XSLT transformation and Schematron validation require Java. ' +
                '[Install Java](https://adoptium.net/)',
                'Dismiss'
            );
        }
    });
}

export function getDiagnosticCollection(): vscode.DiagnosticCollection {
    return diagnosticCollection;
}

export function deactivate() {}
