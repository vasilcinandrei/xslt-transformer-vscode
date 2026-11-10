import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractFacts } from '../rules/facts';
import { mergeCatalogs, selectPacks, validateCatalog } from '../rules/selector';
import { compareVersions, findLinks } from '../rules/sources';
import { resolveGlob } from '../rules/ruleStore';
import { parseXPathSegments } from '../validation/svrlParser';
import { DocumentFacts, RuleCatalog } from '../rules/types';

const root = path.resolve(__dirname, '..', '..');
const catalog = validateCatalog(JSON.parse(fs.readFileSync(path.join(root, 'rules', 'catalog.json'), 'utf8')));
const CEN = 'urn:cen.eu:en16931:2017';

function ids(facts: Partial<DocumentFacts>, disabled: string[] = []): string[] {
    return selectPacks(catalog, { rootElement: 'Invoice', ...facts }, new Set(disabled)).packs.map(p => p.id);
}

test('extracts CustomizationID, ProfileID and party countries', () => {
    const xml = `<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cbc="b" xmlns:cac="a">
      <cbc:CustomizationID> ${CEN}#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0 </cbc:CustomizationID>
      <cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>
      <cac:AccountingSupplierParty><cac:Party>
        <cac:PostalAddress><cbc:CityName>Berlin</cbc:CityName><cac:Country><cbc:IdentificationCode>de</cbc:IdentificationCode></cac:Country></cac:PostalAddress>
      </cac:Party></cac:AccountingSupplierParty>
      <cac:AccountingCustomerParty><cac:Party>
        <cac:PartyTaxScheme><cbc:CompanyID>EL123456789</cbc:CompanyID></cac:PartyTaxScheme>
      </cac:Party></cac:AccountingCustomerParty>
    </Invoice>`;
    assert.deepEqual(extractFacts(xml, 'Invoice'), {
        rootElement: 'Invoice',
        customizationId: `${CEN}#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0`,
        profileId: 'urn:fdc:peppol.eu:2017:poacc:billing:01:1.0',
        sellerCountry: 'DE',
        buyerCountry: 'GR', // from the EL VAT prefix
    });
});

test('selects rule packs by specification and country', () => {
    const peppol = `${CEN}#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0`;
    assert.deepEqual(ids({ customizationId: peppol }), ['peppol-bis']);
    // A Peppol ProfileID alone does not make a document Peppol
    assert.deepEqual(ids({ customizationId: `${CEN}#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0`, profileId: 'urn:fdc:peppol.eu:2017:poacc:billing:01:1.0' }), ['en16931', 'xrechnung']);
    assert.deepEqual(ids({ customizationId: `${CEN}#compliant#urn:efactura.mfinante.ro:CIUS-RO:1.0.1` }), ['ro-cius']);
    assert.deepEqual(ids({ customizationId: `${CEN}#compliant#urn:fdc:nen.nl:nlcius:v1.0` }), ['nlcius']);
    assert.deepEqual(ids({ customizationId: `${CEN}#compliant#urn:fdc:nen.nl:nlcius:v1.0#conformant#urn:fdc:nen.nl:gaccount:v1.0` }), ['nlcius-gaccount']);
    assert.deepEqual(ids({ customizationId: `${CEN}#compliant#urn:mfin.gov.hr:cius-2025:1.0#conformant#urn:mfin.gov.hr:ext-2025:1.0` }), ['en16931', 'hr-cius']);
    assert.deepEqual(ids({ customizationId: 'urn:peppol:pint:billing-1@aunz-1' }), ['pint-aunz']);
    assert.deepEqual(ids({ customizationId: 'urn:peppol:pint:billing-1' }), ['pint']);
});

test('French rules apply to French profiles and to domestic FR invoices', () => {
    assert.deepEqual(ids({ customizationId: CEN, profileId: 'S1' }), ['en16931', 'fr-ctc']);
    assert.deepEqual(ids({ customizationId: CEN, sellerCountry: 'FR', buyerCountry: 'FR' }), ['en16931', 'fr-ctc']);
    assert.deepEqual(ids({ customizationId: CEN, sellerCountry: 'FR', buyerCountry: 'DE' }), ['en16931']);
    assert.deepEqual(ids({ customizationId: `${CEN}#conformant#urn.cpro.gouv.fr:1p0:extended-ctc-fr`, profileId: 'S8' }), ['fr-ctc-extended']);
    // French Peppol invoice: Peppol brings its own CEN copy, the French rules are added
    assert.deepEqual(ids({ customizationId: `${CEN}#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0`, profileId: 'urn:peppol:france:billing:regulated' }).sort(), ['fr-ctc', 'peppol-bis']);
});

test('falls back to EN16931 with a note when nothing specific matches', () => {
    const unknown = selectPacks(catalog, { rootElement: 'Invoice', customizationId: `${CEN}#compliant#urn:example:x` });
    assert.deepEqual(unknown.packs.map(p => p.id), ['en16931']);
    assert.match(unknown.notes[0], /No country-specific rules/);
    const none = selectPacks(catalog, { rootElement: 'CreditNote' });
    assert.deepEqual(none.packs.map(p => p.id), ['en16931']);
    assert.match(none.notes[0], /no cbc:CustomizationID/);
    assert.deepEqual(ids({ customizationId: `${CEN}#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0` }, ['en16931']), ['xrechnung']);
});

test('Peppol post-award documents get their transaction rules', () => {
    const order = selectPacks(catalog, { rootElement: 'Order', customizationId: 'urn:fdc:peppol.eu:poacc:trns:order:3' });
    assert.deepEqual(order.packs.map(p => p.id), ['peppol-order']);
    const despatch = selectPacks(catalog, { rootElement: 'DespatchAdvice', customizationId: 'urn:fdc:peppol.eu:poacc:trns:despatch_advice:3' });
    assert.deepEqual(despatch.packs.map(p => p.id), ['peppol-despatch-advice']);
    assert.deepEqual(selectPacks(catalog, { rootElement: 'Order' }).packs, []);
});

test('the bundled catalog is consistent', () => {
    const ids = new Set(catalog.packs.map(p => p.id));
    for (const p of catalog.packs) {
        for (const ref of [...(p.requires ?? []), ...(p.replaces ?? [])]) {
            assert.ok(ids.has(ref), `${p.id} refers to unknown pack ${ref}`);
        }
        for (const docType of p.documentTypes) {
            assert.ok(p.entries[docType] ?? p.entries['*'], `${p.id} has no rules for ${docType}`);
        }
        for (const files of Object.values(p.bundled ?? {})) {
            for (const f of files) {
                assert.ok(fs.existsSync(path.join(root, 'validation-artifacts', f)), `${p.id}: bundled file missing: ${f}`);
            }
        }
    }
    assert.throws(() => validateCatalog({ version: 1, packs: [{ id: 'Bad Id' }] }), /invalid pack id/);
    assert.throws(() => validateCatalog({ version: 1, packs: [{ ...catalog.packs[0], entries: { '*': [{ path: '../x', format: 'xslt' }] } }] }), /invalid entry/);
});

test('a remote catalog overrides and extends the bundled one', () => {
    const remote: RuleCatalog = {
        version: 1,
        packs: [
            { ...catalog.packs.find(p => p.id === 'xrechnung')!, label: 'XRechnung 3.1' },
            { id: 'rs-srbdt', label: 'Serbia', documentTypes: ['Invoice'], match: [{ customizationId: { contains: 'srbdt' } }], source: { type: 'url', url: 'https://example.org/x.zip' }, entries: { '*': [{ path: 'a.xslt', format: 'xslt' }] } },
        ],
    };
    const merged = mergeCatalogs(catalog, remote);
    assert.equal(merged.packs.find(p => p.id === 'xrechnung')!.label, 'XRechnung 3.1');
    assert.ok(merged.packs.some(p => p.id === 'rs-srbdt'));
    assert.equal(merged.packs.find(p => p.id === 'en16931')!.bundled !== undefined, true);
});

test('resolves * and ** in archive paths', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glob-'));
    try {
        fs.mkdirSync(path.join(dir, 'repo-abc123', 'rules', 'sch'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'repo-abc123', 'rules', 'sch', 'A.sch'), '');
        fs.mkdirSync(path.join(dir, 'x', 'y', 'z'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'x', 'y', 'z', 'B.sch'), '');
        assert.equal(resolveGlob(dir, '*/rules/sch/A.sch'), path.join(dir, 'repo-abc123', 'rules', 'sch', 'A.sch'));
        assert.equal(resolveGlob(dir, '**/B.sch'), path.join(dir, 'x', 'y', 'z', 'B.sch'));
        assert.equal(resolveGlob(dir, '**/missing.sch'), undefined);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('compares versions and scrapes download links', () => {
    assert.ok(compareVersions('1.0.10', '1.0.9') > 0);
    assert.ok(compareVersions('v2.6.0', 'v2.10.0') < 0);
    const html = '<a href="/static/ro16931-ubl-1.0.8.zip">old</a><a href="/static/ro16931-ubl-1.0.10.zip">new</a>';
    const links = findLinks(html, 'href="(?<url>[^"]*ro16931-ubl-(?<version>[0-9.]+)\\.zip)"');
    assert.deepEqual(links.map(l => l.version), ['1.0.8', '1.0.10']);
});

test('parses SVRL locations from both Schematron compilers', () => {
    assert.deepEqual(
        parseXPathSegments("/*:Invoice[namespace-uri()='urn:oasis:names:specification:ubl:schema:xsd:Invoice-2'][1]/*:InvoiceLine[namespace-uri()='urn:x'][2]/*:ID[namespace-uri()='urn:y'][1]"),
        [{ elementName: 'Invoice', index: 1 }, { elementName: 'InvoiceLine', index: 2 }, { elementName: 'ID', index: 1 }]
    );
    assert.deepEqual(
        parseXPathSegments('/Q{urn:oasis:names:specification:ubl:schema:xsd:Invoice-2}Invoice[1]/Q{http://example.org/a/b}Party[3]/@schemeID'),
        [{ elementName: 'Invoice', index: 1 }, { elementName: 'Party', index: 3 }]
    );
});

test('remote catalogs may only use trusted sources and safe regexes', async () => {
    const { trustRemoteCatalog, isSafeRegex } = await import('../rules/selector');
    const { DEFAULT_ALLOWED_HOSTS } = await import('../rules/sources');
    const xr = catalog.packs.find(p => p.id === 'xrechnung')!;
    const pack = (id: string, source: any, match: any[] = xr.match) => ({ ...xr, id, source, match });
    const remote: RuleCatalog = {
        version: 1,
        packs: [
            pack('ok-known-repo', { type: 'github-release-asset', repo: 'itplr-kosit/xrechnung-schematron', asset: '^x.*\\.zip$' }),
            pack('evil-repo', { type: 'github-release-archive', repo: 'attacker/rules' }),
            pack('evil-raw', { type: 'url', url: 'https://raw.githubusercontent.com/attacker/rules/main/x.zip' }),
            pack('ok-raw', { type: 'url', url: 'https://raw.githubusercontent.com/OpenPEPPOL/peppol-bis-invoice-3/main/x.zip' }),
            pack('evil-host', { type: 'url', url: 'https://evil.example/x.zip' }),
            pack('redos', xr.source, [{ customizationId: { regex: '(a+)+$' } }]),
            pack('ok-peppol-docs', { type: 'url', url: 'https://docs.peppol.eu/poac/sg/pint-sg/resources.zip' }),
        ],
    };
    const { catalog: kept, rejected } = trustRemoteCatalog(remote, catalog, DEFAULT_ALLOWED_HOSTS);
    assert.deepEqual(kept.packs.map(p => p.id), ['ok-known-repo', 'ok-raw', 'ok-peppol-docs']);
    assert.deepEqual(rejected, ['evil-repo', 'evil-raw', 'evil-host', 'redos']);
    // Repos can be allowed explicitly
    assert.ok(!trustRemoteCatalog(remote, catalog, DEFAULT_ALLOWED_HOSTS, ['attacker/rules']).rejected.includes('evil-repo'));

    assert.equal(isSafeRegex('(a+)+$'), false);
    assert.equal(isSafeRegex('(\\w*x)*'), false);
    assert.equal(isSafeRegex('(a)\\1'), false);
    // Every pattern in the bundled catalog passes
    for (const p of catalog.packs) {
        const patterns = [
            ...p.match.flatMap(m => [m.customizationId?.regex, m.profileId?.regex]),
            p.source.type === 'html-link' ? p.source.link : undefined,
            p.source.type === 'github-release-asset' ? p.source.asset : undefined,
        ].filter((r): r is string => !!r);
        for (const r of patterns) {
            assert.ok(isSafeRegex(r), `${p.id}: ${r}`);
        }
    }
});

test('catalog paths cannot escape their folders', () => {
    const base = catalog.packs[0];
    for (const bad of ['../../etc/x.xsl', '/etc/x.xsl', 'C:/x.xsl', 'a\\..\\b.xsl']) {
        assert.throws(() => validateCatalog({ version: 1, packs: [{ ...base, bundled: { '*': [bad] } }] }), /invalid bundled path/, bad);
        assert.throws(() => validateCatalog({ version: 1, packs: [{ ...base, entries: { '*': [{ path: bad, format: 'xslt' }] } }] }), /invalid entry/, bad);
    }
});
