import * as vscode from 'vscode';
import { transformCommand } from './commands/transformCommand';
import { createValidateCommand } from './commands/validateCommand';

let diagnosticCollection: vscode.DiagnosticCollection;

export function activate(context: vscode.ExtensionContext) {
    console.log('XSLT Transformer extension is now active');

    diagnosticCollection = vscode.languages.createDiagnosticCollection('ubl-validation');
    context.subscriptions.push(diagnosticCollection);

    context.subscriptions.push(
        vscode.commands.registerCommand('xslt-transformer.transform', transformCommand)
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
}

export function getDiagnosticCollection(): vscode.DiagnosticCollection {
    return diagnosticCollection;
}

export function deactivate() {}
