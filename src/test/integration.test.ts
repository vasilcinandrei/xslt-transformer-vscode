import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JavaHelper, checkJava, MIN_JAVA_VERSION } from '../utils/javaRunner';
import { transformAndValidate } from '../pipeline/transformAndValidate';
import { ValidationContext } from '../validation/validator';
import { RuleStore } from '../rules/ruleStore';
import { pathToFileURL } from 'url';

// Runs the real Java helper against examples/ubl. Skipped without Java 11+.
const root = path.resolve(__dirname, '..', '..');
const example = (f: string) => path.join(root, 'examples', 'ubl', f);
let helper: JavaHelper;
let ctx: ValidationContext;
let javaOk = false;
let tmp: string;

before(async () => {
    const status = await checkJava('java');
    javaOk = status.available && status.version >= MIN_JAVA_VERSION &&
        fs.existsSync(path.join(root, 'lib', 'classes', 'UblHelper.class'));
    helper = new JavaHelper(root, () => 'java');
    ctx = {
        helper,
        bundledArtifactsPath: path.join(root, 'validation-artifacts'),
        artifactsOverridePath: '',
        // Bundled rules only: no downloads in tests
        rules: new RuleStore({
            storageDir: '',
            extensionPath: root,
            helper,
            bundledArtifactsPath: path.join(root, 'validation-artifacts'),
            getSettings: () => ({ source: 'bundled', disabled: [], autoUpdate: false, catalogUrl: '', allowedHosts: [], timeoutMs: 60000 }),
        }),
        customSchematron: [],
    };
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ubl-it-'));
});

after(() => {
    helper?.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('example XSLT 2.0 mapping produces a valid Peppol invoice', async (t) => {
    if (!javaOk) {
        return t.skip('Java 11+ or compiled helper not available');
    }
    const result = await transformAndValidate(
        { sourceXml: example('order.xml'), xsltStylesheet: example('order-to-invoice.xsl'), enableTracing: true },
        ctx
    );
    assert.equal(result.isUbl, true);
    assert.deepEqual(result.validationResult!.issues, []);
    assert.deepEqual(result.validationResult!.checks.map(c => [c.id, c.passed]), [['xsd', true], ['peppol-bis', true]]);
    assert.doesNotMatch(result.output, /ublvtrace/);
    // Elements produced by the included module are traced to it
    assert.ok(result.traceEntries!.some(e => e.sourceFile === example('common.xsl') && e.elementName === 'cac:PostalAddress'));
});

test('errors are traced to the XSLT line, including included modules', async (t) => {
    if (!javaOk) {
        return t.skip('Java 11+ or compiled helper not available');
    }
    // Copy the example and break it: drop the buyer reference, misorder an element
    for (const f of ['order.xml', 'common.xsl']) {
        fs.copyFileSync(example(f), path.join(tmp, f));
    }
    const lines = fs.readFileSync(example('order-to-invoice.xsl'), 'utf8').split('\n');
    const dueIdx = lines.findIndex(l => l.includes('<cbc:DueDate>'));
    const typeIdx = lines.findIndex(l => l.includes('<cbc:InvoiceTypeCode>'));
    [lines[dueIdx], lines[typeIdx]] = [lines[typeIdx], lines[dueIdx]];
    fs.writeFileSync(path.join(tmp, 'broken.xsl'), lines.join('\n'));

    const result = await transformAndValidate(
        { sourceXml: path.join(tmp, 'order.xml'), xsltStylesheet: path.join(tmp, 'broken.xsl'), enableTracing: true },
        ctx
    );
    const xsd = result.tracedIssues!.find(i => i.source === 'xsd');
    assert.ok(xsd, 'expected an XSD error');
    assert.equal(xsd!.xsltSourceFile, path.join(tmp, 'broken.xsl'));
    // cbc:DueDate now sits on the line InvoiceTypeCode used to occupy
    assert.equal(xsd!.xsltSourceLine, typeIdx + 1);
});

test('stylesheet compile errors are reported with original paths', async (t) => {
    if (!javaOk) {
        return t.skip('Java 11+ or compiled helper not available');
    }
    const bad = path.join(tmp, 'bad.xsl');
    fs.writeFileSync(bad, '<xsl:stylesheet version="2.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">\n<xsl:template match="/"><xsl:value-of select="(("/></xsl:template>\n</xsl:stylesheet>');
    await assert.rejects(
        transformAndValidate({ sourceXml: example('order.xml'), xsltStylesheet: bad, enableTracing: true }, ctx),
        (e: Error) => e.message.includes(bad) && !e.message.includes('ubl-trace-')
    );
});

test('external entities in documents are not resolved (XXE)', async (t) => {
    if (!javaOk) {
        return t.skip('Java 11+ or compiled helper not available');
    }
    const secret = path.join(tmp, 'secret.txt');
    fs.writeFileSync(secret, 'TOP-SECRET');
    const doc = path.join(tmp, 'xxe.xml');
    fs.writeFileSync(doc, `<?xml version="1.0"?>\n<!DOCTYPE order [<!ENTITY s SYSTEM "file://${secret}">]>\n<order><number>&s;</number></order>`);
    const copy = `<xsl:stylesheet version="2.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform"><xsl:template match="/"><out><xsl:value-of select="."/></out></xsl:template></xsl:stylesheet>`;
    const xsl = path.join(tmp, 'copy.xsl');
    fs.writeFileSync(xsl, copy);
    let output = '';
    try {
        output = (await helper.transform(xsl, doc)).output;
    } catch {
        // Rejecting the document is fine too
    }
    assert.doesNotMatch(output, /TOP-SECRET/);
});

test('a runaway stylesheet times out and the helper recovers', async (t) => {
    if (!javaOk) {
        return t.skip('Java 11+ or compiled helper not available');
    }
    const loop = path.join(tmp, 'loop.xsl');
    fs.writeFileSync(loop, '<xsl:stylesheet version="3.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform" xmlns:f="urn:f" xmlns:xs="http://www.w3.org/2001/XMLSchema">' +
        // Tail recursion: Saxon turns this into a loop that never ends
        '<xsl:function name="f:spin" as="xs:integer"><xsl:param name="n" as="xs:integer"/><xsl:sequence select="f:spin($n + 1)"/></xsl:function>' +
        '<xsl:template match="/"><out><xsl:value-of select="f:spin(1)"/></out></xsl:template></xsl:stylesheet>');
    await assert.rejects(helper.transform(loop, example('order.xml'), false, { timeoutMs: 1500 }), /Timed out/);
    const ok = await helper.transform(example('order-to-invoice.xsl'), example('order.xml'));
    assert.match(ok.output, /<Invoice/);
});

test('concurrent first requests share a single helper process', async (t) => {
    if (!javaOk) {
        return t.skip('Java 11+ or compiled helper not available');
    }
    const fresh = new JavaHelper(root, () => 'java');
    try {
        const results = await Promise.all([1, 2, 3].map(() => fresh.transform(example('order-to-invoice.xsl'), example('order.xml'))));
        assert.ok(results.every(r => r.output.includes('<Invoice')));
    } finally {
        fresh.dispose();
    }
});

test('dispose rejects in-flight requests instead of hanging', async (t) => {
    if (!javaOk) {
        return t.skip('Java 11+ or compiled helper not available');
    }
    const fresh = new JavaHelper(root, () => 'java');
    const pending = fresh.transform(path.join(tmp, 'loop.xsl'), example('order.xml'));
    await new Promise(r => setTimeout(r, 1500));
    fresh.dispose();
    await assert.rejects(pending, /restarted/);
});

test('sandboxed rules cannot read environment variables, files outside their folder, or write files', async (t) => {
    if (!javaOk) {
        return t.skip('Java 11+ or compiled helper not available');
    }
    const rules = path.join(tmp, 'rules');
    fs.mkdirSync(rules, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'outside.txt'), 'OUTSIDE');
    const run = (name: string, body: string) => {
        const f = path.join(rules, name);
        fs.writeFileSync(f, `<xsl:stylesheet version="3.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform"><xsl:template match="/">${body}</xsl:template></xsl:stylesheet>`);
        return helper.transform(f, example('order.xml'), true, { sandboxRoots: [rules] });
    };
    const env = await run('env.xsl', `<out n="{count(available-environment-variables())}" h="{environment-variable('HOME')}{environment-variable('PATH')}"/>`);
    assert.match(env.output, /<out n="0" h=""\/>/);
    await assert.rejects(run('read.xsl', `<out><xsl:value-of select="unparsed-text('../outside.txt')"/></out>`), /Access denied/);
    await assert.rejects(run('net.xsl', `<out><xsl:copy-of select="doc('https://example.com/')"/></out>`), /Access denied/);
    const target = path.join(tmp, 'written.txt');
    await assert.rejects(run('write.xsl', `<xsl:result-document href="${pathToFileURL(target)}">x</xsl:result-document><ok/>`), /not allowed/);
    assert.ok(!fs.existsSync(target));
    await assert.rejects(helper.transform(path.join(tmp, 'loop.xsl'), example('order.xml'), true, { sandboxRoots: [rules] }), /outside the sandbox/);
});
