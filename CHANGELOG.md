# Changelog

## 2.1.2

### Fixed
- The transform and validate buttons are back in the editor title bar on both XML and XSLT files (2.1.0 showed transform only on stylesheets and validate only on XML).
- Transforming from an XML file uses it as the input and only asks for the stylesheet, offering the one you used last with that file.
- Validate on a stylesheet runs the transform and validates its output.

## 2.1.1

### Fixed
- Stylesheet error messages showed temporary file paths or `file:` URIs instead of your file's path on Windows and for folders with accented letters (e.g. `Facturé`). Watch mode can now place these errors on the right line.

## 2.1.0

**Requires Java 11 or newer** (previously Java 8) and VS Code 1.90 or newer.

### Fixed
- XSLT 2.0/3.0 stylesheets failed or produced wrong output on macOS/Linux, because the system `xsltproc` (XSLT 1.0 only) was preferred over Saxon. All transforms now use the bundled Saxon-HE.
- A failed transform no longer returns its partial output as if it had succeeded.
- `xsl:include`, `xsl:import`, `document()` and `unparsed-text()` with relative paths broke when error tracing was on.
- Error tracing could change the stylesheet's behaviour (comments injected into `as="element()*"` variables, typed templates, `xsl:choose`) and broke on paths containing `--` or `|`. Tracing now uses a trace attribute on literal result elements, covers included stylesheets, and keeps stylesheet line numbers unchanged.
- "Fix All Errors with AI" worked from stale line numbers and output after the first fix. Each fix now re-traces before the next error.
- AI fixes wrote straight to disk, bypassing unsaved editor changes and Undo. They now go through the editor and can be undone.
- AI fixes for stylesheets over 5000 lines never worked. Large stylesheets are now fixed one template at a time.
- `Cmd+Shift+V` no longer replaces Markdown preview outside XML files, and the editor title buttons only appear on XML/XSLT files.
- The default AI provider was inconsistent (`gemini` in settings, `anthropic` in code), and the configured provider was ignored.
- Watch mode put output-line numbers onto the XSLT file. Problems now appear on the stylesheet lines that produced them.
- The mapping view highlighted lines in the input XML using stylesheet line numbers. It now shows the stylesheet.
- UBL detection now checks the root element's namespace.
- Schematron error locations with a repeated element (e.g. the second invoice line) pointed at the first occurrence.

### Security & privacy
- XSD validation and transforms no longer resolve external entities or DTDs in documents (XXE).
- AI fixes ask for consent once per provider before sending data; input XML can be excluded or capped.
- AI requests have a timeout and can be cancelled.

### Added
- **Country-specific business rules, picked automatically and always current.** The extension reads the document's CustomizationID, ProfileID and seller/buyer countries and runs the matching official rules. These are downloaded from the publishers on first use, cached, and checked daily for updates:
  - EN16931
  - Peppol BIS Billing 3.0 (with its national rules for NO, SE, DK, IT, NL, DE, GR, IS, SK)
  - XRechnung (DE)
  - NLCIUS / SI-UBL 2.0 (NL)
  - France CTC BR-FR / EXTENDED-CTC-FR
  - RO_CIUS (RO)
  - HR CIUS 2025 (HR)
  - Peppol PINT (AU/NZ, JP, SG, MY, AE)
  - Peppol BIS post-award transactions (Order, Despatch Advice, Catalogue, ...)
- Rule sets that are only published as Schematron are compiled locally with the bundled SchXslt2.
- The list of rule sets (`rules/catalog.json`) is refreshed from the repository, so new countries don't need an extension update.
- Downloaded rules run sandboxed (no file writes, no network, no reads outside their folder) and only come from allowlisted hosts.
- **UBL: Show Business Rules**, **UBL: Update Business Rules** and **UBL: Download All Business Rules** commands.
- Bundled offline rules updated to EN16931 1.3.17 and Peppol BIS 3.0.22.
- Validate on save for UBL documents, with the result in the status bar.
- Validation of unsaved and untitled documents.
- Settings to disable individual rule sets, add custom Schematron rules, replace the XSD schemas, and choose the Java executable.
- Watch mode, mapping view and `.ublproject.json` profiles (with schema validation) are now available as commands.
- The transform remembers the last input XML per stylesheet and reuses the output tab.
- **UBL: Select AI Provider** and **UBL: Show Validator Info** commands.
- AI fixes that resolve the error but add new ones ask whether to keep them.
- Updated default AI models; Anthropic calls use the official SDK.

### Performance
- One long-lived Java process serves all transforms and validations, and the EN16931/Peppol rules are compiled once per session instead of on every run.

### Development
- Saxon-HE 12.10, esbuild bundle, ESLint config, unit, integration and VS Code end-to-end tests, and GitHub Actions CI on Linux, macOS and Windows.

## 2.0.1
- Increased the transform output buffer to 1 GB; fixed the icon.

## 2.0.0
- AI fix agent for UBL validation errors; streamlined transform.

## 1.3.0
- Bundled Saxon-HE 10.9 and a Java XSD validator; Java became the only required dependency.

## 1.2.0
- Automatic validation after an XSLT transform, with errors traced back to the XSLT line.
- Missing-element Quick Fixes; Windows path and CRLF fixes.

## 1.1.0
- UBL 2.1 validation: XSD for all document types, EN16931 and Peppol BIS 3.0 rules.

## 1.0.0
- Initial XSLT transformation.
