import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

// The examples/ubl invoice (valid) with cbc:IssueDate removed
const INVOICE_MISSING_ISSUE_DATE = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
   <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0</cbc:CustomizationID>
   <cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>
   <cbc:ID>INV-1001</cbc:ID>
   <cbc:DueDate>2026-12-01</cbc:DueDate>
   <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
   <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
   <cbc:BuyerReference>PO-77</cbc:BuyerReference>
   <cac:AccountingSupplierParty>
      <cac:Party>
         <cbc:EndpointID schemeID="0106">12345678</cbc:EndpointID>
         <cac:PartyName>
            <cbc:Name>Seller BV</cbc:Name>
         </cac:PartyName>
         <cac:PostalAddress>
            <cbc:StreetName>Hoofdstraat 1</cbc:StreetName>
            <cbc:CityName>Amsterdam</cbc:CityName>
            <cbc:PostalZone>1011AA</cbc:PostalZone>
            <cac:Country>
               <cbc:IdentificationCode>NL</cbc:IdentificationCode>
            </cac:Country>
         </cac:PostalAddress>
         <cac:PartyTaxScheme>
            <cbc:CompanyID>NL123456789B01</cbc:CompanyID>
            <cac:TaxScheme>
               <cbc:ID>VAT</cbc:ID>
            </cac:TaxScheme>
         </cac:PartyTaxScheme>
         <cac:PartyLegalEntity>
            <cbc:RegistrationName>Seller BV</cbc:RegistrationName>
            <cbc:CompanyID schemeID="0106">12345678</cbc:CompanyID>
         </cac:PartyLegalEntity>
      </cac:Party>
   </cac:AccountingSupplierParty>
   <cac:AccountingCustomerParty>
      <cac:Party>
         <cbc:EndpointID schemeID="9930">DE123456789</cbc:EndpointID>
         <cac:PartyName>
            <cbc:Name>Buyer GmbH</cbc:Name>
         </cac:PartyName>
         <cac:PostalAddress>
            <cbc:StreetName>Hauptstrasse 5</cbc:StreetName>
            <cbc:CityName>Berlin</cbc:CityName>
            <cbc:PostalZone>10115</cbc:PostalZone>
            <cac:Country>
               <cbc:IdentificationCode>DE</cbc:IdentificationCode>
            </cac:Country>
         </cac:PostalAddress>
         <cac:PartyLegalEntity>
            <cbc:RegistrationName>Buyer GmbH</cbc:RegistrationName>
         </cac:PartyLegalEntity>
      </cac:Party>
   </cac:AccountingCustomerParty>
   <cac:PaymentMeans>
      <cbc:PaymentMeansCode>30</cbc:PaymentMeansCode>
      <cac:PayeeFinancialAccount>
         <cbc:ID>NL91ABNA0417164300</cbc:ID>
      </cac:PayeeFinancialAccount>
   </cac:PaymentMeans>
   <cac:TaxTotal>
      <cbc:TaxAmount currencyID="EUR">27.30</cbc:TaxAmount>
      <cac:TaxSubtotal>
         <cbc:TaxableAmount currencyID="EUR">130.00</cbc:TaxableAmount>
         <cbc:TaxAmount currencyID="EUR">27.30</cbc:TaxAmount>
         <cac:TaxCategory>
            <cbc:ID>S</cbc:ID>
            <cbc:Percent>21</cbc:Percent>
            <cac:TaxScheme>
               <cbc:ID>VAT</cbc:ID>
            </cac:TaxScheme>
         </cac:TaxCategory>
      </cac:TaxSubtotal>
   </cac:TaxTotal>
   <cac:LegalMonetaryTotal>
      <cbc:LineExtensionAmount currencyID="EUR">130.00</cbc:LineExtensionAmount>
      <cbc:TaxExclusiveAmount currencyID="EUR">130.00</cbc:TaxExclusiveAmount>
      <cbc:TaxInclusiveAmount currencyID="EUR">157.30</cbc:TaxInclusiveAmount>
      <cbc:PayableAmount currencyID="EUR">157.30</cbc:PayableAmount>
   </cac:LegalMonetaryTotal>
   <cac:InvoiceLine>
      <cbc:ID>1</cbc:ID>
      <cbc:InvoicedQuantity unitCode="C62">2</cbc:InvoicedQuantity>
      <cbc:LineExtensionAmount currencyID="EUR">100.00</cbc:LineExtensionAmount>
      <cac:Item>
         <cbc:Name>Widget</cbc:Name>
         <cac:ClassifiedTaxCategory>
            <cbc:ID>S</cbc:ID>
            <cbc:Percent>21</cbc:Percent>
            <cac:TaxScheme>
               <cbc:ID>VAT</cbc:ID>
            </cac:TaxScheme>
         </cac:ClassifiedTaxCategory>
      </cac:Item>
      <cac:Price>
         <cbc:PriceAmount currencyID="EUR">50.00</cbc:PriceAmount>
      </cac:Price>
   </cac:InvoiceLine>
   <cac:InvoiceLine>
      <cbc:ID>2</cbc:ID>
      <cbc:InvoicedQuantity unitCode="C62">1</cbc:InvoicedQuantity>
      <cbc:LineExtensionAmount currencyID="EUR">30.00</cbc:LineExtensionAmount>
      <cac:Item>
         <cbc:Name>Gadget</cbc:Name>
         <cac:ClassifiedTaxCategory>
            <cbc:ID>S</cbc:ID>
            <cbc:Percent>21</cbc:Percent>
            <cac:TaxScheme>
               <cbc:ID>VAT</cbc:ID>
            </cac:TaxScheme>
         </cac:ClassifiedTaxCategory>
      </cac:Item>
      <cac:Price>
         <cbc:PriceAmount currencyID="EUR">30.00</cbc:PriceAmount>
      </cac:Price>
   </cac:InvoiceLine>
</Invoice>
`;

async function waitFor<T>(fn: () => T | undefined, what: string, timeoutMs = 60000): Promise<T> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const v = fn();
        if (v) {
            return v;
        }
        await new Promise(r => setTimeout(r, 250));
    }
    throw new Error(`Timed out waiting for ${what}`);
}

async function check(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        console.log(`  ✔ ${name}`);
    } catch (e) {
        console.log(`  ✖ ${name}`);
        throw e;
    }
}

export async function run(): Promise<void> {
    const ext = vscode.extensions.getExtension('AndreiVasilcin.xslt-transformer');
    assert.ok(ext, 'extension not found');

    await check('activates and registers every contributed command', async () => {
        await ext!.activate();
        const contributed: string[] = ext!.packageJSON.contributes.commands.map((c: { command: string }) => c.command);
        const registered = new Set(await vscode.commands.getCommands(true));
        for (const id of [...contributed, 'xslt-transformer.aiFixSingle']) {
            assert.ok(registered.has(id), `command not registered: ${id}`);
        }
    });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubl-e2e-'));
    const file = path.join(dir, 'invoice.xml');
    fs.writeFileSync(file, INVOICE_MISSING_ISSUE_DATE);
    const doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);

    await check('UBL: Validate Document reports XSD and business-rule problems', async () => {
        await vscode.commands.executeCommand('xslt-transformer.validateUbl');
        const diags = await waitFor(() => {
            const d = vscode.languages.getDiagnostics(doc.uri);
            return d.length > 0 ? d : undefined;
        }, 'diagnostics');
        const xsd = diags.find(d => d.source === 'ubl-xsd');
        assert.ok(xsd, 'expected an XSD diagnostic');
        assert.match(xsd!.message, /IssueDate/);
        // Business rules for this Peppol invoice are downloaded on first use
        assert.ok(diags.some(d => d.source === 'ubl-peppol-bis' && d.code === 'BR-03'), 'expected the Peppol/CEN rule BR-03 (missing issue date)');
    });

    await check('validate-on-save re-validates the edited buffer', async () => {
        const editor = vscode.window.activeTextEditor!;
        const idLine = doc.getText().split('\n').findIndex(l => l.includes('<cbc:ID>INV-1001'));
        await editor.edit(b => b.insert(new vscode.Position(idLine + 1, 0), '   <cbc:IssueDate>2026-11-01</cbc:IssueDate>\n'));
        await doc.save();
        await waitFor(() => {
            const d = vscode.languages.getDiagnostics(doc.uri);
            return d.length === 0 ? true : undefined;
        }, 'all problems to disappear');
    });

    await check('non-UBL XML is left alone on save', async () => {
        const other = path.join(dir, 'other.xml');
        fs.writeFileSync(other, '<catalog/>');
        const otherDoc = await vscode.workspace.openTextDocument(other);
        await vscode.window.showTextDocument(otherDoc);
        await otherDoc.save();
        await new Promise(r => setTimeout(r, 1000));
        assert.equal(vscode.languages.getDiagnostics(otherDoc.uri).length, 0);
    });

    fs.rmSync(dir, { recursive: true, force: true });
}
