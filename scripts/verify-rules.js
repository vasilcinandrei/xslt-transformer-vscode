// Downloads and compiles every pack in rules/catalog.json from the live
// sources, so changes in upstream layouts are caught early.
// Usage: npm run compile && node scripts/verify-rules.js [packId ...]
require('../out/test/setup.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.join(__dirname, '..');
const { JavaHelper } = require('../out/utils/javaRunner');
const { RuleStore } = require('../out/rules/ruleStore');

(async () => {
    const storageDir = process.env.RULES_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ubl-rules-'));
    const helper = new JavaHelper(root, () => 'java');
    const store = new RuleStore({
        storageDir,
        extensionPath: root,
        helper,
        bundledArtifactsPath: path.join(root, 'validation-artifacts'),
        getSettings: () => ({ source: 'latest', disabled: [], autoUpdate: false, catalogUrl: '', allowedHosts: [], timeoutMs: 300000 }),
    });
    const only = process.argv.slice(2);
    let failed = 0;
    for (const pack of store.catalog.packs.filter(p => only.length === 0 || only.includes(p.id))) {
        const t = Date.now();
        try {
            const installed = await store.install(pack);
            // Compile every rule file once to prove it runs on Saxon-HE
            for (const xslt of new Set(Object.values(installed.files))) {
                await helper.transform(xslt, path.join(root, 'examples', 'ubl', 'order.xml'), true, { sandboxRoots: [installed.dir], timeoutMs: 300000 });
            }
            console.log(`ok    ${pack.id.padEnd(32)} ${installed.version}  (${Date.now() - t} ms)`);
        } catch (e) {
            failed++;
            console.log(`FAIL  ${pack.id.padEnd(32)} ${e.message.split('\n')[0]}`);
        }
    }
    helper.dispose();
    console.log(`\n${failed} failed. Rules in ${storageDir}`);
    process.exit(failed ? 1 : 0);
})();
