import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { detectUblDocumentFromContent } from '../validation/documentDetector';
import { parseXsdIssues } from '../validation/xsdValidator';
import { parseSvrlOutputFromContent } from '../validation/svrlParser';
import { parseJavaMajorVersion } from '../utils/javaRunner';

const INV_NS = 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2';

test('detects UBL documents by root element and namespace', () => {
    assert.equal(detectUblDocumentFromContent(`<?xml version="1.0"?>\n<!-- c -->\n<Invoice xmlns="${INV_NS}"/>`)?.rootElement, 'Invoice');
    assert.equal(detectUblDocumentFromContent(`<ubl:CreditNote xmlns:ubl="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2">`)?.isInvoiceOrCreditNote, true);
    assert.equal(detectUblDocumentFromContent('<Invoice>'), null, 'no namespace');
    assert.equal(detectUblDocumentFromContent('<Order xmlns="urn:something-else">'), null, 'wrong namespace');
    assert.equal(detectUblDocumentFromContent('<catalog/>'), null);
});

test('parses XSD issue lines and shortens UBL namespaces', () => {
    const issues = parseXsdIssues([
        "12\t9\terror\tcvc-complex-type.2.4.a: Invalid content was found starting with element 'cbc:Note'. One of '{\"urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2\":IssueDate}' is expected.",
        '3\t1\twarning\tsomething',
        'garbage',
    ].join('\n'));
    assert.equal(issues.length, 2);
    assert.equal(issues[0].line, 12);
    assert.match(issues[0].message, /One of '\{cbc:IssueDate\}' is expected/);
    assert.equal(issues[1].severity, 1);
});

test('maps SVRL failed asserts to source lines via the XPath location', () => {
    const source = [
        `<Invoice xmlns="${INV_NS}" xmlns:cac="c" xmlns:cbc="b">`,
        '  <cac:InvoiceLine>',
        '    <cbc:ID>1</cbc:ID>',
        '  </cac:InvoiceLine>',
        '  <cac:InvoiceLine>',
        '    <cbc:ID>2</cbc:ID>',
        '  </cac:InvoiceLine>',
        '</Invoice>',
    ].join('\n');
    const svrl = `<svrl:schematron-output xmlns:svrl="http://purl.oclc.org/dsdl/svrl">
      <svrl:failed-assert id="BR-21" flag="fatal" location="/*:Invoice[1]/*:InvoiceLine[2]/*:ID[1]">
        <svrl:text>[BR-21]-Each Invoice line shall have an Invoice line identifier.</svrl:text>
      </svrl:failed-assert>
      <svrl:failed-assert id="W-1" flag="warning" location="/*:Invoice[1]"><svrl:text>warn</svrl:text></svrl:failed-assert>
    </svrl:schematron-output>`;
    const issues = parseSvrlOutputFromContent(svrl, source, 'en16931');
    assert.equal(issues.length, 2);
    assert.equal(issues[0].line, 6);
    assert.equal(issues[0].ruleId, 'BR-21');
    assert.equal(issues[0].severity, 0);
    assert.equal(issues[1].severity, 1);
});

test('parses Java major versions', () => {
    assert.equal(parseJavaMajorVersion('java version "1.8.0_352"'), 8);
    assert.equal(parseJavaMajorVersion('openjdk version "17.0.9" 2023-10-17'), 17);
    assert.equal(parseJavaMajorVersion('openjdk version "21" 2023-09-19'), 21);
    assert.equal(parseJavaMajorVersion('nonsense'), 0);
});

test('declares UTF-8 for content written to temp files', async () => {
    const { declareUtf8 } = await import('../validation/validator');
    assert.equal(declareUtf8('<?xml version="1.0" encoding="ISO-8859-1"?>\n<a/>'), '<?xml version="1.0" encoding="UTF-8"?>\n<a/>');
    assert.equal(declareUtf8("<?xml version='1.0' encoding='windows-1252'?><a/>"), "<?xml version='1.0' encoding='UTF-8'?><a/>");
    assert.equal(declareUtf8('<a/>'), '<a/>');
});
