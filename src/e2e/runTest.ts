import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { runTests } from '@vscode/test-electron';

/**
 * macOS registers every downloaded VS Code copy as an app that can open files
 * (same bundle id as the real VS Code), so double-clicked files may go to the
 * test copy. Unregister the copies once the tests are done.
 */
function unregisterTestCopies(root: string): void {
    if (process.platform !== 'darwin') {
        return;
    }
    const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
    const cache = path.join(root, '.vscode-test');
    for (const dir of fs.existsSync(cache) ? fs.readdirSync(cache) : []) {
        const app = path.join(cache, dir, 'Visual Studio Code.app');
        if (fs.existsSync(app)) {
            try {
                execFileSync(lsregister, ['-u', app]);
            } catch {
                // best effort
            }
        }
    }
}

// Launches a real VS Code with the bundled extension and runs ./suite.
async function main(): Promise<void> {
    const root = path.resolve(__dirname, '..', '..');
    try {
        await runTests({
            extensionDevelopmentPath: root,
            extensionTestsPath: path.join(__dirname, 'suite'),
            launchArgs: [path.join(root, 'examples', 'ubl'), '--disable-extensions'],
        });
    } finally {
        unregisterTestCopies(root);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
