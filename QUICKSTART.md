# Development guide

## Setup

Requires Node.js 20+ and a JDK 11+.

```bash
npm install
npm run compile:java   # builds lib/classes/UblHelper*.class against the bundled Saxon-HE
npm run bundle         # esbuild → dist/extension.js
```

Press `F5` in VS Code to start an Extension Development Host. The default build task bundles first.

## Layout

| Path | Purpose |
|---|---|
| `java/UblHelper.java` | Long-lived Java helper: Saxon transforms and XSD validation over a stdin/stdout line protocol |
| `src/utils/javaRunner.ts` | Starts and talks to the helper |
| `src/tracing/` | Stylesheet instrumentation (trace attributes), output parsing, error → XSLT mapping |
| `src/validation/` | UBL detection, XSD/Schematron validation, diagnostics, validate-on-save |
| `src/pipeline/transformAndValidate.ts` | Transform + validate, shared by all commands |
| `src/ai/` | AI fix agent (prompting, LLM clients, diff/apply/verify loop) |
| `src/watch/`, `src/webview/` | Watch mode and the mapping view |
| `validation-artifacts/` | Bundled UBL XSD and compiled EN16931/Peppol Schematron |
| `examples/ubl/` | XSLT 2.0 mapping with an include that produces a valid Peppol invoice |

## Checks

```bash
npm run lint
npm test           # unit tests + integration tests against the real Java helper
npm run test:e2e   # downloads VS Code into .vscode-test/ and runs the extension in it
```

## Business rule catalog

`rules/catalog.json` lists every rule set: how to recognise documents it applies to (`match`), where to download the latest version (`source`), and which files to run (`entries`). Installed extensions refresh this file daily from the `main` branch, so a merged change reaches users without a release. The schema is in `schemas/rules-catalog.schema.json`.

After editing the catalog, check that every source still downloads and compiles:

```bash
npm run verify:rules            # all packs
npm run verify:rules -- xrechnung ro-cius
```

The *Check business rule sources* workflow does the same every Monday.

## Updating validation artifacts

`scripts/download-artifacts.sh` downloads the UBL schemas, EN16931 and Peppol rules (and Saxon, with checksum verification). Update `validation-artifacts/versions.json` and the table in the README when the rule versions change.

## Packaging

```bash
npm run package    # runs vscode:prepublish (Java + minified bundle), then vsce package
```
