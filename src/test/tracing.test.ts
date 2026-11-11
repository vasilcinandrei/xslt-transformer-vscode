import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { instrumentStylesheetText, instrumentStylesheets, parseTracedOutput, TRACE_NS } from '../tracing/xsltTracer';
import { scanStartTags } from '../tracing/xmlTokenizer';

const XSL = `<?xml version="1.0"?>
<!-- <not:atag> -->
<xsl:stylesheet version="2.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
    xmlns:cbc="urn:cbc" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xsl:include href="common.xsl"/>
  <data:lookup xmlns:data="urn:data"><data:row/></data:lookup>
  <xsl:template match="/">
    <xsl:variable name="ids" as="element()*"><cbc:ID>1</cbc:ID><cbc:ID>2</cbc:ID></xsl:variable>
    <Root attr="a > b">
      <xsl:choose><xsl:when test="true()"><cbc:Note/></xsl:when></xsl:choose>
      <xsl:copy-of select="$ids"/>
    </Root>
  </xsl:template>
</xsl:stylesheet>`;

test('instrumentation adds trace attributes without adding lines', () => {
    const mainPath = path.resolve('/proj/main.xsl');
    const out = instrumentStylesheetText(XSL, 3, mainPath);
    assert.equal(out.split('\n').length, XSL.split('\n').length);
    assert.match(out, /<cbc:ID ublvtrace:t="3:8">1<\/cbc:ID><cbc:ID ublvtrace:t="3:8">2/);
    assert.match(out, /<Root attr="a > b" ublvtrace:t="3:9">/);
    assert.match(out, /<cbc:Note ublvtrace:t="3:10"\/>/);
    // Top-level user data and comments are left alone
    assert.match(out, /<data:lookup xmlns:data="urn:data"><data:row\/><\/data:lookup>/);
    assert.match(out, /<!-- <not:atag> -->/);
    // Root gets xml:base (relative URIs keep resolving) and the trace namespace
    assert.ok(out.includes(`<xsl:stylesheet xml:base="${pathToFileURL(mainPath)}" xmlns:ublvtrace="urn:x-ubl-validator:trace" version`));
});

test('simplified stylesheets are not instrumented', () => {
    const lre = '<Invoice xsl:version="2.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform"><a/></Invoice>';
    const out = instrumentStylesheetText(lre, 0, '/p/s.xsl');
    assert.doesNotMatch(out, /ublvtrace/);
});

test('includes are instrumented recursively and errors map back to original paths', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-test-'));
    try {
        fs.writeFileSync(path.join(dir, 'main.xsl'), XSL);
        fs.writeFileSync(path.join(dir, 'common.xsl'),
            '<xsl:stylesheet version="2.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform"><xsl:template name="t"><x/></xsl:template></xsl:stylesheet>');
        const inst = instrumentStylesheets(path.join(dir, 'main.xsl'));
        try {
            assert.equal(inst.files.length, 2);
            const main = fs.readFileSync(inst.mainPath, 'utf8');
            const includeHref = scanStartTags(main).find(t => t.localName === 'include')!.attributes[0].value;
            assert.ok(includeHref.startsWith('file:') && includeHref.includes(inst.tempDir.split(path.sep).pop()!));
            const included = fs.readFileSync(new URL(includeHref), 'utf8');
            assert.match(included, /<x ublvtrace:t="1:1"\/>/);
            const msg = inst.mapMessage(`error: ${pathToFileURL(inst.mainPath)}:7: boom`);
            assert.equal(msg, `error: ${path.join(dir, 'main.xsl')}:7: boom`);
            // Saxon cites the original through xml:base, in Java's file:/ form
            const viaBase = inst.mapMessage(`error: file:${pathToFileURL(path.join(dir, 'main.xsl')).pathname}:3: x`);
            assert.equal(viaBase, `error: ${path.join(dir, 'main.xsl')}:3: x`);
        } finally {
            inst.cleanup();
        }
        assert.ok(!fs.existsSync(inst.tempDir));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('parseTracedOutput joins start tags that Saxon wrapped', () => {
    const raw = [
        `<Invoice xmlns="urn:inv"`,
        `         xmlns:t="${TRACE_NS}"`,
        '         t:t="0:5">',
        '   <cbc:EndpointID schemeID="0106"',
        '                   t:t="0:9">1</cbc:EndpointID>',
        '</Invoice>',
    ].join('\n');
    const { cleanOutput, traceEntries } = parseTracedOutput(raw, ['/a.xsl']);
    assert.equal(cleanOutput, '<Invoice xmlns="urn:inv">\n   <cbc:EndpointID schemeID="0106">1</cbc:EndpointID>\n</Invoice>');
    assert.deepEqual(traceEntries.map(e => [e.outputLine, e.sourceLine, e.elementName]), [[1, 5, 'Invoice'], [2, 9, 'cbc:EndpointID']]);
});

test('parseTracedOutput strips trace attributes and records element lines', () => {
    const raw = [
        '<?xml version="1.0"?>',
        `<Invoice xmlns="urn:inv" xmlns:t="${TRACE_NS}" t:t="0:5">`,
        '   <cbc:ID t:t="1:12">A</cbc:ID>',
        '</Invoice>',
    ].join('\n');
    const { cleanOutput, traceEntries } = parseTracedOutput(raw, ['/a.xsl', '/b.xsl']);
    assert.equal(cleanOutput, '<?xml version="1.0"?>\n<Invoice xmlns="urn:inv">\n   <cbc:ID>A</cbc:ID>\n</Invoice>');
    assert.deepEqual(traceEntries, [
        { outputLine: 2, sourceFile: '/a.xsl', sourceLine: 5, elementName: 'Invoice' },
        { outputLine: 3, sourceFile: '/b.xsl', sourceLine: 12, elementName: 'cbc:ID' },
    ]);
});
