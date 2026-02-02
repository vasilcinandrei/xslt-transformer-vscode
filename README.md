# XSLT Transformer & UBL Validator

A powerful VS Code extension for XML transformation and UBL 2.1 document validation with comprehensive business rules support.

[![Ko-fi](https://img.shields.io/badge/Support%20on-Ko--fi-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/andreivasilcin)

## Features

### XSLT Transformation
- **One-Click Transformation**: Click the transform button in the editor title bar
- **Easy File Selection**: Popup dialogs to select your XML and XSLT files
- **Flexible Output**: View results in editor or save to file
- **XSLT 1.0 Support**: Uses system `xsltproc` (pre-installed on macOS/Linux)

### UBL 2.1 Document Validation
- **XSD Schema Validation**: Validates against official OASIS UBL 2.1 schemas for all 65+ document types (Invoice, CreditNote, Order, etc.)
- **EN16931 Business Rules**: European e-invoicing standard compliance (for Invoice and CreditNote)
- **Peppol BIS 3.0 Rules**: OpenPEPPOL billing specification validation
- **Inline Diagnostics**: Errors and warnings appear directly on the problematic lines in VS Code's Problems panel
- **Smart XPath Resolution**: Precise line number mapping from Schematron validation results

## Usage

### XSLT Transformation
1. Click the transform button (⚙️) in the editor title bar
2. Select your input XML file
3. Select your XSLT stylesheet
4. Choose to view result in editor or save to file

Or use Command Palette (`Cmd+Shift+P`): **"XSLT: Transform XML"**

### UBL Validation
1. Open a UBL 2.1 XML document (Invoice, CreditNote, Order, etc.)
2. Click the validate button (✓) in the editor title bar or press `Cmd+Shift+V` (Mac) / `Ctrl+Shift+V` (Windows/Linux)
3. View validation results in the Problems panel

**Commands:**
- **UBL: Validate Document** - Full validation (XSD + EN16931 + Peppol)
- **UBL: Validate XSD Only** - Schema validation only
- **UBL: Validate Business Rules Only** - EN16931 + Peppol rules only

## Requirements

### System Dependencies
- **VS Code**: 1.74.0 or higher
- **xmllint**: For XSD validation (pre-installed on macOS/Linux)
- **Java**: For Schematron validation (EN16931/Peppol business rules)
- **Saxon-HE**: XSLT 2.0 processor for Schematron
  - Install via Homebrew: `brew install saxon`
  - Or download from [Saxonica](https://www.saxonica.com/download/java.xml)

### Validation Artifacts
The extension bundles:
- **UBL 2.1 XSD schemas** (OASIS) - All 65+ document types
- **EN16931 validation rules** (European Commission, EUPL-1.2)
- **Peppol BIS 3.0 rules** (OpenPEPPOL, MPL-2.0)

## Supported UBL Document Types

The extension validates all UBL 2.1 document types including:
- Invoice, CreditNote, DebitNote
- Order, OrderResponse, OrderChange, OrderCancellation
- DespatchAdvice, ReceiptAdvice
- Catalogue, CatalogueRequest, CataloguePricingUpdate
- Quotation, RequestForQuotation
- ApplicationResponse, Statement, RemittanceAdvice
- And 50+ more...

## Examples

### Valid UBL Invoice
```xml
<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2">
  <cbc:ID>INV-2025-001</cbc:ID>
  <cbc:IssueDate>2025-02-01</cbc:IssueDate>
  <!-- Full UBL structure -->
</Invoice>
```

✅ Validation passes with no errors

### Validation Results
- **Errors** appear as red squiggles on the specific line
- **Warnings** appear as yellow squiggles
- **Rule IDs** shown in brackets: `[BR-01] Invoice must contain supplier name`
- Click any issue to jump to the line

## Release Notes

### 1.1.0
- ✨ **NEW**: Full UBL 2.1 validation support
- ✨ XSD schema validation for all 65+ UBL document types
- ✨ EN16931 European e-invoicing standard validation
- ✨ Peppol BIS 3.0 business rules
- ✨ Inline diagnostics with precise line numbers
- ✨ Keyboard shortcut: `Cmd+Shift+V` / `Ctrl+Shift+V`

### 1.0.0
- Initial XSLT transformation functionality

## Support

If you find this extension useful, consider [supporting development on Ko-fi](https://ko-fi.com/andreivasilcin) ☕

## Contributing

Issues and pull requests welcome at [GitHub](https://github.com/vasilcinandrei/xslt-transformer-vscode)

## License

MIT License - Copyright (c) 2025 Andrei Vasilcin

Bundled validation artifacts have their own licenses:
- UBL 2.1 XSD: OASIS IPR Policy
- EN16931: EUPL-1.2
- Peppol BIS 3.0: MPL-2.0

See `validation-artifacts/README.md` for details.
