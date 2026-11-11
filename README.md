# UBL Validator — XSLT Transformer & UBL 2.1 Validation

Transform XML with XSLT 1.0, 2.0 or 3.0 and validate UBL 2.1 documents against the OASIS XSD and the **latest official business rules for the document's country and specification**: EN16931, Peppol BIS, XRechnung, NLCIUS, France CTC, RO_CIUS, HR CIUS, Peppol PINT and more. Every error is traced back to the XSLT line that produced it. Java 11+ is the only thing you need to install.

[![Ko-fi](https://img.shields.io/badge/Support%20on-Ko--fi-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/andreivasilcin)

## Features

### XSLT transformation with automatic validation
- **Saxon-HE 12** for every transform: XSLT 1.0, 2.0 and 3.0 behave the same on macOS, Linux and Windows.
- **Transform from the stylesheet you're editing**: with an `.xsl` file open, click the transform button. The input XML you used last time with that stylesheet is offered first.
- **Automatic UBL validation**: if the output is a UBL document, XSD, EN16931 and Peppol checks run straight away.
- **Errors traced to your XSLT**: each problem in the output links (in the Problems panel, under *Related Information*) to the stylesheet line that created the element. This includes stylesheets pulled in with `xsl:include` / `xsl:import`.
- **Watch mode**: *XSLT: Start Watch Mode* re-runs everything when you save the stylesheet, any of its includes, or the input XML, and shows the problems right on the XSLT lines.
- **Mapping view**: *XSLT: Show XSLT-to-Output Mapping* puts the stylesheet and output side by side. Click a line to see what produced it; double-click to jump to it in the editor.
- **Compile errors with real line numbers**: stylesheet errors point at your file and line, and `xsl:message` output goes to the *UBL Validator* output channel.

### UBL 2.1 validation
- **XSD** for all 65+ UBL 2.1 document types (Invoice, CreditNote, Order, DespatchAdvice, ...).
- **The right business rules, picked from the document itself**: the extension reads `cbc:CustomizationID`, `cbc:ProfileID` and the seller/buyer countries, then runs the matching rule sets. See [Business rules by country](#business-rules-by-country).
- **Always the latest rules**: rule sets are downloaded from their official publishers the first time they're needed, cached, and checked for updates daily. The bundled EN16931 and Peppol rules are used when you're offline.
- **Your own rules**: add compiled Schematron files with `ublValidator.rules.customSchematron`.
- **Validate on save**: UBL documents are checked whenever you save them, and the result shows in the status bar. Other XML files are ignored.
- **Unsaved and untitled documents** are validated as they are in the editor.

### UBL Preview
Click the preview button in the title bar of a UBL file (or run **UBL: Open Preview**). A panel opens beside the editor and follows the active document as you type, so it also works on transform output.
- **Document:** the invoice or credit note as a readable document: parties with addresses and IDs, references, lines, allowances and charges, the VAT breakdown, payment details (IBAN, payment reference, mandate) and totals. Codes are spelled out (380 → Commercial invoice, S → Standard rate, 58 → SEPA credit transfer). Other UBL types show their header, parties and lines.
- **Attachments:** every embedded file (`cbc:EmbeddedDocumentBinaryObject`). PDFs are rendered inside VS Code; images and text are shown inline; any file can be saved or opened in its default app. Each attachment is checked for a missing `mimeCode` or `filename`, types Peppol doesn't allow, content that doesn't match the declared type, invalid base64 and very large files. External references are listed too.

### Peppol Network panel
Click the **UBL Validator** icon in the Activity Bar while a UBL document is open. The panel reads the sender and receiver from their `cbc:EndpointID`s and checks them on the Peppol **production** and **test** networks:
- **Registered?** Looked up in the Peppol SML; the panel also shows which SMP holds the participant.
- **Can the receiver accept this document?** The receiver's SMP must list the document's type (from `cbc:CustomizationID`) and process (from `cbc:ProfileID`). If it doesn't, the panel lists what the receiver does accept.
- **Access point:** transport profile and URL, and the certificate's issuer and expiry. Expired certificates, and production endpoints with test certificates, are flagged.
- **Directory name:** the name registered in the Peppol Directory, flagged when it doesn't match the document.

It also flags missing or malformed `EndpointID`s (the scheme must be a four-digit EAS code). Lookups only run while the panel is visible and are cached for 10 minutes. Set `ublValidator.peppol.lookup` to `manual` or `off` if participant IDs shouldn't be sent to the Peppol infrastructure.

### AI fix agent (optional)
- **Fix with AI** appears in the Quick Fix menu (`Cmd+.` / `Ctrl+.`) on traced errors; **UBL: Fix All Errors with AI** works through all of them.
- Every fix is shown as a **diff for you to accept or reject**, applied through the editor (so **Undo works**), then the transform is re-run to confirm the error is gone. Fixes that don't work are reverted, and the model gets the remaining errors before retrying.
- Providers: Google Gemini, Groq, Anthropic Claude, OpenAI. API keys are stored in VS Code's secret storage.
- **Privacy**: before anything is sent, you're asked once per provider. Turn off `ublValidator.ai.includeInputXml` to keep the input XML (often real invoice data) on your machine.

## Quick start

### 1. Install Java 11 or newer

| Platform | Command |
|---|---|
| macOS | `brew install openjdk` |
| Ubuntu / Debian | `sudo apt install openjdk-17-jre` |
| Fedora / RHEL | `sudo dnf install java-17-openjdk` |
| Windows | `winget install EclipseAdoptium.Temurin.21.JRE` or [adoptium.net](https://adoptium.net/) |

Check with `java -version`. If the Java on your `PATH` is older, point `ublValidator.javaPath` at a newer one.

### 2. Install the extension
Search for **"UBL Validator"** in the Extensions view and click Install.

### 3. Try it
- **Validate**: open a UBL XML file and press `Cmd+Shift+V` / `Ctrl+Shift+V`, or just save it.
- **Transform**: open an `.xsl` file and click the transform button in the editor title bar (or run **XSLT: Transform XML**).
- The extension's GitHub repository has a working example in `examples/ubl/`: an order XML, an XSLT 2.0 mapping with an `xsl:include`, and the Peppol invoice it produces.

## Business rules by country

| Document says (CustomizationID / ProfileID / countries) | Rules run | Published by |
|---|---|---|
| `…#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0` | Peppol BIS Billing 3.0, with its own CEN rules and the national rules for **NO, SE, DK, IT, NL, DE, GR, IS, SK**, which switch on from the seller's country | OpenPeppol |
| `…urn:xeinkauf.de:kosit:xrechnung_3.0` (Germany) | EN16931 + XRechnung 3.0 | KoSIT |
| `…urn:fdc:nen.nl:nlcius:v1.0` (Netherlands) | NLCIUS / SI-UBL 2.0 (+ G-account extension) | Simplerinvoicing / Peppol Authority NL |
| France profiles (`S1`…`M9`, `urn:peppol:france:billing…`) or FR seller **and** FR buyer | EN16931 + BR-FR (AFNOR XP Z12-012); EXTENDED-CTC-FR for `…extended-ctc-fr` | FNFE-MPE |
| `…urn:efactura.mfinante.ro:CIUS-RO` (Romania) | RO_CIUS | ANAF / Ministry of Finance |
| `…urn:mfin.gov.hr:cius-2025…` (Croatia) | EN16931 + HR CIUS 2025 + extension | Porezna uprava |
| `urn:peppol:pint:billing-1@aunz-1` / `@jp-1` / `@sg-1` / `@my-1` / `@ae-1` (+ self-billing) | Peppol PINT for Australia/New Zealand, Japan, Singapore, Malaysia, UAE | OpenPeppol |
| `urn:fdc:peppol.eu:poacc:trns:…:3` | Peppol BIS Order, Despatch Advice, Catalogue, Order Response, Order Change/Cancellation, Order Agreement, Invoice Response, MLR, Punch Out | OpenPeppol |
| any other `urn:cen.eu:en16931:2017…` | EN16931, with a note that no country-specific rules are known | CEN |

- **Covered through EN16931 and Peppol, with no national UBL rules of their own:** Belgium, Luxembourg, Austria, Slovakia, Ireland, Latvia, Lithuania and Finland.
- **Not UBL, so they can't be validated as UBL:** Poland (KSeF), Hungary, Czechia (ISDOC), Slovenia (e-SLOG), Italian invoices (FatturaPA), Spain (Facturae) and Estonia. Serbia uses UBL but publishes no official rules.

**UBL: Show Business Rules** shows what the open document contains, which rules apply and why, and every rule set with its installed version. **UBL: Update Business Rules** checks for updates now. **UBL: Download All Business Rules** fetches everything for offline use.

The list of rule sets comes from [`rules/catalog.json`](rules/catalog.json), which is refreshed daily from this repository. New countries and moved downloads therefore reach users without an extension update.

**Safety:**
- **Where rules come from:** downloads only come over https from the publishers' hosts (GitHub, docs.peppol.eu, mfinante.gov.ro, porezna.gov.hr).
- **What the remote list can change:** the daily-refreshed catalog can only use GitHub repositories that are already in the bundled catalog, unless you allow more with `ublValidator.rules.allowedRepos`.
- **What rules can do:** downloaded and custom rules run sandboxed. They can't write files, use the network, read outside their own folder or see environment variables, and they have a time limit.
- **Settings a project can't override:** settings that run code or choose download sources can only be set in your user settings, not by a project's `.vscode/settings.json`.

## Commands

| Command | What it does |
|---|---|
| XSLT: Transform XML | Transform, show the output, validate it if it's UBL |
| XSLT: Start Watch Mode / Stop Watch Mode | Re-run transform + validation on every save |
| XSLT: Show XSLT-to-Output Mapping | Side-by-side stylesheet ↔ output view |
| XSLT: Create Project Config | Write a `.ublproject.json` with input/stylesheet profiles |
| UBL: Validate Document | XSD + business rules (`Cmd+Shift+V` / `Ctrl+Shift+V` in XML files) |
| UBL: Validate XSD Only / Business Rules Only | One part of the validation |
| UBL: Fix All Errors with AI | Work through all traced errors with the AI agent |
| UBL: Select AI Provider / Set AI API Key | Configure the AI agent |
| UBL: Open Preview | Readable document view plus embedded attachments |
| UBL: Check Peppol Participants | Open the Peppol Network panel and re-check the open document |
| UBL: Show Business Rules | Which rules apply to the open document and why; all rule sets and versions |
| UBL: Update Business Rules | Check every downloaded rule set for a new version now |
| UBL: Download All Business Rules | Fetch every rule set for offline use |
| UBL: Show Validator Info | Java and Saxon versions, active settings |

## Settings

| Setting | Default | Description |
|---|---|---|
| `ublValidator.validateOnSave` | `true` | Validate UBL documents when saved |
| `ublValidator.rules.source` | `latest` | `latest`: download current official rules; `bundled`: offline, EN16931 + Peppol only |
| `ublValidator.rules.disabled` | `[]` | Rule set ids never to run (e.g. `peppol-bis`, `fr-ctc`) |
| `ublValidator.rules.autoUpdate` | `true` | Check downloaded rule sets for updates daily |
| `ublValidator.rules.catalogUrl` | this repo's `rules/catalog.json` | Where the list of rule sets is refreshed from (empty = bundled list only) |
| `ublValidator.rules.allowedHosts` | `[]` | Extra hosts rule sets may be downloaded from |
| `ublValidator.rules.allowedRepos` | `[]` | Extra GitHub repos (`owner/name`) the remote catalog may use |
| `ublValidator.rules.customSchematron` | `[]` | Extra compiled Schematron (XSLT → SVRL) files |
| `ublValidator.artifactsPath` | `""` | Folder with replacement UBL XSD schemas (same layout as the bundled `validation-artifacts`) |
| `ublValidator.transformTimeoutSeconds` | `120` | Stop a transform or validation that runs longer |
| `ublValidator.peppol.lookup` | `auto` | Peppol Network panel: `auto` (while visible), `manual`, or `off` |
| `ublValidator.peppol.networks` | both | Which Peppol networks to check: `production`, `test` |
| `ublValidator.javaPath` | `""` | Java executable to use (Java 11+) |
| `ublValidator.ai.provider` | `gemini` | `gemini`, `groq`, `anthropic` or `openai` |
| `ublValidator.ai.model` | `""` | Override the provider's default model |
| `ublValidator.ai.maxRetries` | `3` | Attempts per error |
| `ublValidator.ai.timeoutSeconds` | `180` | Timeout per AI request |
| `ublValidator.ai.includeInputXml` | `true` | Send the input XML for context |
| `ublValidator.ai.maxInputXmlChars` | `50000` | Cap on input XML characters sent |

### Project profiles (`.ublproject.json`)
When the active editor isn't a stylesheet, the transform, watch and mapping commands use the profiles in `.ublproject.json`. Create one with **XSLT: Create Project Config**. The file is schema-checked as you edit it.

```json
{
  "version": 1,
  "defaultProfile": "invoice",
  "profiles": [
    { "name": "invoice", "sourceXml": "input/order.xml", "xsltStylesheet": "mappings/to-invoice.xsl", "validationScope": "full" }
  ]
}
```

## Bundled offline rules

Used when a rule set can't be downloaded, or with `ublValidator.rules.source` set to `bundled`:

| Rule set | Version |
|---|---|
| OASIS UBL XSD | 2.1 |
| CEN EN16931 UBL Schematron | 1.3.17 (2026-10-12) |
| Peppol BIS Billing 3.0 Schematron | 3.0.22 (2026-11-04) |

## Requirements
- VS Code 1.90 or newer
- Java 11 or newer

Everything else is bundled: Saxon-HE 12.10 (MPL-2.0) with xmlresolver (Apache-2.0), SchXslt2 (MIT) for compiling Schematron, the UBL 2.1 schemas, and offline copies of the EN16931 and Peppol rules. Other rule sets are downloaded on first use; this needs internet access once per rule set and version.

## Release notes
See [CHANGELOG.md](CHANGELOG.md).

## Support
If you find this extension useful, consider [supporting development on Ko-fi](https://ko-fi.com/andreivasilcin).

## Contributing
Issues and pull requests are welcome on [GitHub](https://github.com/vasilcinandrei/xslt-transformer-vscode). See [QUICKSTART.md](QUICKSTART.md) for the development setup.

## License
MIT License - Copyright (c) 2025 Andrei Vasilcin

Bundled components have their own licenses:
- UBL 2.1 XSD: OASIS IPR Policy
- EN16931: EUPL-1.2
- Peppol BIS 3.0: MPL-2.0
- Saxon-HE 12.10: MPL-2.0
- xmlresolver: Apache-2.0
- SchXslt2: MIT
- pdf.js: Apache-2.0
- Downloaded rule sets keep their publishers' licenses (listed in **UBL: Show Business Rules** and `rules/catalog.json`).

See `validation-artifacts/README.md` for details.
