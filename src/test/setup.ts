/**
 * Lets the pure modules be tested with node:test outside VS Code by
 * answering `require('vscode')` with a minimal stub.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require('module');

const vscodeStub = {
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    CodeActionKind: { QuickFix: 'quickfix' },
    workspace: {
        getConfiguration: () => ({ get: (_key: string, def: unknown) => def }),
        workspaceFolders: undefined,
    },
};

const originalLoad = Module._load;
Module._load = function (request: string, ...rest: unknown[]) {
    if (request === 'vscode') {
        return vscodeStub;
    }
    return originalLoad.call(this, request, ...rest);
};
