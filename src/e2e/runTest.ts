import * as path from 'path';
import { runTests } from '@vscode/test-electron';

// Launches a real VS Code with the bundled extension and runs ./suite.
async function main(): Promise<void> {
    const root = path.resolve(__dirname, '..', '..');
    await runTests({
        extensionDevelopmentPath: root,
        extensionTestsPath: path.join(__dirname, 'suite'),
        launchArgs: [path.join(root, 'examples', 'ubl'), '--disable-extensions'],
    });
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
