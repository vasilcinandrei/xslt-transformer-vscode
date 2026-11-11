import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { extractAttachments, sniffMime } from '../preview/attachments';
import { JavaHelper, checkJava, MIN_JAVA_VERSION } from '../utils/javaRunner';

const root = path.resolve(__dirname, '..', '..');
const fixture = path.join(root, 'src', 'test', 'fixtures', 'invoice-with-attachments.xml');

test('finds embedded attachments and external references, with checks', () => {
    const { attachments, external } = extractAttachments(fs.readFileSync(fixture, 'utf8'));
    assert.equal(attachments.length, 2);
    const [pdf, png] = attachments;
    assert.deepEqual([pdf.filename, pdf.mimeCode, pdf.detectedMime, pdf.referenceId], ['INV-1001.pdf', 'application/pdf', 'application/pdf', 'INV-1001-PDF']);
    assert.deepEqual(pdf.problems, []);
    assert.ok(pdf.data!.subarray(0, 5).toString() === '%PDF-');
    assert.ok(png.problems.some(p => /Missing filename/.test(p)));
    assert.ok(png.problems.some(p => /looks like image\/png/.test(p)));
    assert.equal(fs.readFileSync(fixture, 'utf8').split('\n')[png.line - 1].includes('EmbeddedDocumentBinaryObject'), true);
    assert.deepEqual(external.map(e => e.uri), ['https://example.com/contracts/4711.pdf']);
});

test('flags bad base64, disallowed types and missing attributes', () => {
    const xml = (attrs: string, content: string) =>
        `<x:AdditionalDocumentReference xmlns:x="a"><x:ID>1</x:ID><x:Attachment><x:EmbeddedDocumentBinaryObject ${attrs}>${content}</x:EmbeddedDocumentBinaryObject></x:Attachment></x:AdditionalDocumentReference>`;
    assert.match(extractAttachments(xml('mimeCode="application/pdf" filename="a.pdf"', 'not base64!!')).attachments[0].problems[0], /not valid base64/);
    assert.match(extractAttachments(xml('mimeCode="application/zip" filename="a.zip"', 'UEsDBAo=')).attachments[0].warnings[0], /not allowed in Peppol/);
    assert.match(extractAttachments(xml('filename="a.txt"', Buffer.from('a,b\n1,2').toString('base64'))).attachments[0].problems[0], /Missing mimeCode/);
});

test('detects file types from content', () => {
    assert.equal(sniffMime(Buffer.from('%PDF-1.7')), 'application/pdf');
    assert.equal(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
    assert.equal(sniffMime(Buffer.from('id;amount\n1;2')), 'text/csv');
    assert.equal(sniffMime(Buffer.from('<?xml version="1.0"?><a/>')), 'application/xml');
});

let helper: JavaHelper;
let javaOk = false;
before(async () => {
    const s = await checkJava('java');
    javaOk = s.available && s.version >= MIN_JAVA_VERSION && fs.existsSync(path.join(root, 'lib', 'classes', 'UblHelper.class'));
    helper = new JavaHelper(root, () => 'java');
});
after(() => helper?.dispose());

test('renders a readable invoice from UBL', async (t) => {
    if (!javaOk) {
        return t.skip('Java 11+ or compiled helper not available');
    }
    const xsl = path.join(root, 'media', 'preview', 'ubl-preview.xsl');
    const { output } = await helper.transform(xsl, fixture, true, { sandboxRoots: [path.dirname(xsl)] });
    const text = output.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    for (const expected of ['Commercial invoice', 'INV-1001', 'Seller BV', 'Widget', 'Standard rate', 'Credit transfer', 'Amount due', '157.30 EUR', 'Invoice as PDF']) {
        assert.ok(text.includes(expected), `missing "${expected}"`);
    }
    // Base64 content is never rendered into the page
    assert.ok(!output.includes('JVBERi0'));
    assert.ok(!/<script/i.test(output));
});
