import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { extractPeppolDocument } from '../peppol/participants';
import {
    documentTypeMatches, lookupParticipant, parseNaptrRegexp, parseServiceGroup, parseServiceMetadata, smlHostname,
} from '../peppol/lookup';
import { detectUblDocumentFromContent } from '../validation/documentDetector';

const fixtures = path.resolve(__dirname, '..', '..', 'src', 'test', 'fixtures');
const INVOICE_DT = 'busdox-docid-qns::urn:oasis:names:specification:ubl:schema:xsd:Invoice-2::Invoice##urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0::2.1';
const BILLING_PROCESS = 'cenbii-procid-ubl::urn:fdc:peppol.eu:2017:poacc:billing:01:1.0';

test('reads sender, receiver, document type and process from an invoice', () => {
    const xml = `<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cbc="b" xmlns:cac="a">
      <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0</cbc:CustomizationID>
      <cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>
      <cac:AccountingSupplierParty><cac:Party><cbc:EndpointID schemeID="0106">12345678</cbc:EndpointID>
        <cac:PartyName><cbc:Name>Seller BV</cbc:Name></cac:PartyName>
        <cac:PostalAddress><cac:Country><cbc:IdentificationCode>NL</cbc:IdentificationCode></cac:Country></cac:PostalAddress></cac:Party></cac:AccountingSupplierParty>
      <cac:AccountingCustomerParty><cac:Party><cbc:EndpointID schemeID="GLN">5790000435975</cbc:EndpointID>
        <cac:PartyLegalEntity><cbc:RegistrationName>Buyer A/S</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingCustomerParty>
    </Invoice>`;
    const doc = extractPeppolDocument(xml, detectUblDocumentFromContent(xml)!);
    assert.equal(doc.documentTypeId, INVOICE_DT);
    assert.equal(doc.processId, BILLING_PROCESS);
    assert.deepEqual(
        [doc.sender.participantId, doc.sender.name, doc.sender.country, doc.sender.problem],
        ['0106:12345678', 'Seller BV', 'NL', undefined]
    );
    assert.equal(doc.receiver.name, 'Buyer A/S');
    assert.equal(doc.receiver.participantId, undefined);
    assert.match(doc.receiver.problem!, /not a Peppol EAS code/);
});

test('uses the right parties for other document types', () => {
    const order = `<Order xmlns="urn:oasis:names:specification:ubl:schema:xsd:Order-2" xmlns:cbc="b" xmlns:cac="a">
      <cac:BuyerCustomerParty><cac:Party><cbc:EndpointID schemeID="0088">111</cbc:EndpointID></cac:Party></cac:BuyerCustomerParty>
      <cac:SellerSupplierParty><cac:Party></cac:Party></cac:SellerSupplierParty></Order>`;
    const doc = extractPeppolDocument(order, detectUblDocumentFromContent(order)!);
    assert.equal(doc.sender.participantId, '0088:111');
    assert.match(doc.receiver.problem!, /No cbc:EndpointID/);
    assert.equal(doc.documentTypeId, undefined, 'no CustomizationID → no document type');
});

test('computes SML hostnames and reads NAPTR records', () => {
    // Matches the live Peppol SML (checked against participant.sml.prod.tech.peppol.org)
    assert.equal(
        smlHostname('9930:DE121386819', 'production'),
        'weao7aonjun6bnz5xzq2xrnqfcooiuhrisaehz56fmsikfb37usq.iso6523-actorid-upis.participant.sml.prod.tech.peppol.org'
    );
    assert.ok(smlHostname('9915:test', 'test').endsWith('.iso6523-actorid-upis.participant.sml.test.tech.peppol.org'));
    assert.equal(parseNaptrRegexp('!.*!https://smp.billit.be/!'), 'https://smp.billit.be');
    assert.equal(parseNaptrRegexp('!.*!ftp://x!'), undefined);
});

test('parses SMP service groups and service metadata', () => {
    const types = parseServiceGroup(fs.readFileSync(path.join(fixtures, 'smp-servicegroup.xml'), 'utf8'));
    assert.equal(types.length, 6);
    assert.ok(types.includes(INVOICE_DT));
    // Percent-encoded hrefs are decoded too
    const encoded = parseServiceGroup(`<ServiceMetadataReference href="https://smp.x/iso6523-actorid-upis%3A%3A9930%3Ade1/services/${encodeURIComponent(INVOICE_DT)}"/>`);
    assert.deepEqual(encoded, [INVOICE_DT]);

    const meta = parseServiceMetadata(fs.readFileSync(path.join(fixtures, 'smp-servicemetadata.xml'), 'utf8'));
    assert.equal(meta.processes.length, 1);
    assert.equal(meta.processes[0].processId, BILLING_PROCESS);
    const ep = meta.processes[0].endpoints[0];
    assert.equal(ep.transportProfile, 'peppol-transport-as4-v2_0');
    assert.equal(ep.url, 'https://peppol.billit.be/as4');
    assert.match(ep.certificate!.issuer, /PEPPOL ACCESS POINT CA/);
    assert.equal(ep.certificate!.testCertificate, false);
});

test('matches exact and wildcard document types', () => {
    assert.ok(documentTypeMatches(INVOICE_DT, INVOICE_DT));
    const pint = 'busdox-docid-qns::urn:oasis:names:specification:ubl:schema:xsd:Invoice-2::Invoice##urn:peppol:pint:billing-1@aunz-1::2.1';
    assert.ok(documentTypeMatches('peppol-doctype-wildcard::urn:oasis:names:specification:ubl:schema:xsd:Invoice-2::Invoice##urn:peppol:pint:billing-1*', pint));
    assert.ok(!documentTypeMatches('peppol-doctype-wildcard::urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2::CreditNote##urn:peppol:pint:billing-1*', pint));
    assert.ok(!documentTypeMatches(INVOICE_DT.replace('Invoice-2::Invoice', 'CreditNote-2::CreditNote'), INVOICE_DT));
});

test('live lookup on the Peppol networks', { skip: !process.env.UBL_NETWORK_TESTS && 'set UBL_NETWORK_TESTS=1 to run' }, async () => {
    const prod = await lookupParticipant('0208:1035904075', 'production', INVOICE_DT, BILLING_PROCESS);
    assert.equal(prod.registered, true);
    assert.equal(prod.acceptsDocument, true);
    const test = await lookupParticipant('9915:test', 'test');
    assert.equal(test.registered, true);
    const missing = await lookupParticipant('9915:test', 'production');
    assert.equal(missing.registered, false);
});
