import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { extractFix, parseFixResponse, spliceLines } from '../ai/fixParser';
import { findEnclosingTemplate } from '../ai/contextBuilder';
import { extractMissingElement } from '../analysis/codeActionProvider';

const ORIGINAL = [
    '<xsl:stylesheet version="2.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">',
    '  <xsl:template match="/">',
    '    <a/>',
    '  </xsl:template>',
    '</xsl:stylesheet>',
].join('\n');

test('extracts fixes with either quote style and strips code fences', () => {
    const fix = extractFix("<fix explanation='Add b'>\n```xml\n<b/>\n```\n</fix>");
    assert.deepEqual(fix, { explanation: 'Add b', body: '<b/>' });
    assert.equal(extractFix('no fix here'), null);
});

test('full mode requires a complete stylesheet', () => {
    const proposed = ORIGINAL.replace('<a/>', '<b/>');
    assert.equal(parseFixResponse(`<fix explanation="x">${proposed}</fix>`, ORIGINAL)?.proposedContent, proposed);
    assert.equal(parseFixResponse('<fix explanation="x"><b/></fix>', ORIGINAL), null);
    assert.equal(parseFixResponse(`<fix>${ORIGINAL}</fix>`, ORIGINAL), null, 'unchanged content is not a fix');
});

test('section mode patches only the given lines', () => {
    const section = findEnclosingTemplate(ORIGINAL, 3);
    assert.deepEqual([section.startLine, section.endLine], [2, 4]);
    const reply = '<fix explanation="x">  <xsl:template match="/">\n    <b/>\n  </xsl:template></fix>';
    const proposal = parseFixResponse(reply, ORIGINAL, 'section', section);
    assert.equal(proposal?.proposedContent, ORIGINAL.replace('<a/>', '<b/>'));
    assert.equal(spliceLines('1\n2\n3', { startLine: 2, endLine: 2, text: '2' }, 'x\ny'), '1\nx\ny\n3');
});

test('finds the missing element in Xerces and libxml2 messages', () => {
    assert.equal(extractMissingElement("One of '{cbc:IssueDate, cbc:Note}' is expected."), 'cbc:IssueDate');
    assert.equal(
        extractMissingElement("One of '{\"urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2\":Party}' is expected."),
        'cac:Party'
    );
    assert.equal(extractMissingElement('no element here'), null);
});

test('section mode near the top of the file splices even if the reply contains the root', () => {
    const section = { startLine: 1, endLine: 3, text: ORIGINAL.split('\n').slice(0, 3).join('\n') };
    const reply = '<fix explanation="x"><xsl:stylesheet version="2.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">\n  <xsl:template match="/">\n    <b/></fix>';
    const proposal = parseFixResponse(reply, ORIGINAL, 'section', section);
    assert.equal(proposal?.proposedContent, ORIGINAL.replace('<a/>', '<b/>'));
});
