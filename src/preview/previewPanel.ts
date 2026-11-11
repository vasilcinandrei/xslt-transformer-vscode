import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { detectUblDocumentFromContent } from '../validation/documentDetector';
import { declareUtf8 } from '../validation/validator';
import { writeTempFile } from '../utils/tempFile';
import { getHelper } from '../services';
import { Attachment, extractAttachments } from './attachments';

const TEXT_PREVIEW_LIMIT = 200_000;

/**
 * "UBL Preview" panel beside the editor: a readable rendering of the active UBL
 * document plus its embedded attachments (PDFs drawn with pdf.js, images and
 * text inline). Follows the active UBL editor and updates while you type.
 */
export class UblPreview implements vscode.Disposable {
    private panel: vscode.WebviewPanel | undefined;
    private documentUri: vscode.Uri | undefined;
    private attachments: Attachment[] = [];
    private timer: NodeJS.Timeout | undefined;
    private generation = 0;
    private readonly disposables: vscode.Disposable[] = [];
    /** Text the webview last rendered (used by the end-to-end tests) */
    lastRenderedText = '';

    constructor(private readonly extensionUri: vscode.Uri) {
        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor(editor => {
                if (this.panel && editor && this.isUbl(editor.document)) {
                    this.documentUri = editor.document.uri;
                    this.schedule(0);
                }
            }),
            vscode.workspace.onDidChangeTextDocument(e => {
                if (this.panel && e.document.uri.toString() === this.documentUri?.toString()) {
                    this.schedule(500);
                }
            })
        );
    }

    private isUbl(doc: vscode.TextDocument): boolean {
        return (doc.languageId === 'xml' || /\.xml$/i.test(doc.uri.path)) && !!detectUblDocumentFromContent(doc.getText());
    }

    /** Opens (or reveals) the preview for the active editor's document. */
    show(): void {
        const doc = vscode.window.activeTextEditor?.document;
        if (!doc || !this.isUbl(doc)) {
            vscode.window.showInformationMessage('Open a UBL document (Invoice, CreditNote, Order, ...) to preview it.');
            return;
        }
        this.documentUri = doc.uri;
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Beside, true);
        } else {
            const pdfjsRoot = vscode.Uri.joinPath(this.extensionUri, 'media', 'pdfjs');
            this.panel = vscode.window.createWebviewPanel('ublPreview', 'UBL Preview', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [pdfjsRoot],
            });
            this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'ubl-validator.svg');
            this.panel.webview.html = this.html(this.panel.webview);
            this.panel.webview.onDidReceiveMessage(msg => this.onMessage(msg), null, this.disposables);
            this.panel.onDidDispose(() => {
                this.panel = undefined;
            }, null, this.disposables);
        }
        this.schedule(0);
    }

    private schedule(delay: number): void {
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => void this.render(), delay);
    }

    private findDocument(): vscode.TextDocument | undefined {
        return vscode.workspace.textDocuments.find(d => d.uri.toString() === this.documentUri?.toString());
    }

    private async render(): Promise<void> {
        const doc = this.findDocument();
        if (!this.panel || !doc) {
            return;
        }
        const generation = ++this.generation;
        const content = doc.getText();
        const name = path.basename(doc.uri.fsPath || doc.uri.path);
        this.panel.title = `Preview ${name}`;

        const { attachments, external } = extractAttachments(content);
        this.attachments = attachments;
        const attachmentInfo = attachments.map(a => ({
            index: a.index, referenceId: a.referenceId, description: a.description, documentTypeCode: a.documentTypeCode,
            mimeCode: a.mimeCode, filename: a.filename, line: a.line, size: a.data?.length,
            detectedMime: a.detectedMime, problems: a.problems, warnings: a.warnings,
        }));

        let html = '';
        let error: string | undefined;
        const tmp = writeTempFile(declareUtf8(content), '.xml');
        try {
            const xsl = vscode.Uri.joinPath(this.extensionUri, 'media', 'preview', 'ubl-preview.xsl').fsPath;
            const result = await getHelper().transform(xsl, tmp.filePath, true, {
                sandboxRoots: [path.dirname(xsl)],
                timeoutMs: 30_000,
            });
            html = result.output;
        } catch (e: any) {
            error = e.message.split('\n')[0];
        } finally {
            tmp.cleanup();
        }
        if (generation !== this.generation || !this.panel) {
            return;
        }
        void this.panel.webview.postMessage({ type: 'document', name, html, error, attachments: attachmentInfo, external });
    }

    private async onMessage(msg: { type: string; index?: number; line?: number; text?: string }): Promise<void> {
        const a = msg.index !== undefined ? this.attachments[msg.index] : undefined;
        switch (msg.type) {
            case 'rendered':
                this.lastRenderedText = msg.text ?? '';
                break;
            case 'loadAttachment':
                if (a?.data && this.panel) {
                    const kind = this.kindOf(a);
                    void this.panel.webview.postMessage({
                        type: 'attachmentData',
                        index: a.index,
                        kind,
                        mime: a.detectedMime ?? a.mimeCode,
                        base64: kind === 'pdf' || kind === 'image' ? a.data.toString('base64') : undefined,
                        text: kind === 'text' ? a.data.subarray(0, TEXT_PREVIEW_LIMIT).toString('utf8') : undefined,
                        truncated: kind === 'text' && a.data.length > TEXT_PREVIEW_LIMIT,
                    });
                }
                break;
            case 'saveAttachment':
                if (a?.data) {
                    const target = await vscode.window.showSaveDialog({
                        defaultUri: vscode.Uri.file(path.join(os.homedir(), safeFileName(a))),
                        saveLabel: 'Save Attachment',
                    });
                    if (target) {
                        await vscode.workspace.fs.writeFile(target, a.data);
                        vscode.window.setStatusBarMessage(`Saved ${path.basename(target.fsPath)}`, 4000);
                    }
                }
                break;
            case 'openAttachment':
                if (a?.data) {
                    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubl-attachment-'));
                    const file = path.join(dir, safeFileName(a));
                    fs.writeFileSync(file, a.data);
                    await vscode.env.openExternal(vscode.Uri.file(file));
                }
                break;
            case 'reveal': {
                const doc = this.findDocument();
                if (doc && msg.line) {
                    const pos = new vscode.Position(msg.line - 1, 0);
                    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, selection: new vscode.Range(pos, pos) });
                }
                break;
            }
        }
    }

    private kindOf(a: Attachment): 'pdf' | 'image' | 'text' | 'binary' {
        const mime = a.detectedMime ?? a.mimeCode ?? '';
        if (mime === 'application/pdf') {
            return 'pdf';
        }
        if (/^image\/(png|jpeg|gif)$/.test(mime)) {
            return 'image';
        }
        if (/^text\/|xml$/.test(mime)) {
            return 'text';
        }
        return 'binary';
    }

    private html(webview: vscode.Webview): string {
        const nonce = randomBytes(16).toString('base64');
        const pdfjs = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'pdfjs', 'pdf.min.mjs'));
        const worker = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'pdfjs', 'pdf.worker.min.mjs'));
        const csp = [
            "default-src 'none'",
            `img-src ${webview.cspSource} data: blob:`,
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `script-src 'nonce-${nonce}' ${webview.cspSource}`,
            'worker-src blob:',
            `connect-src ${webview.cspSource}`,
            `font-src ${webview.cspSource} data:`,
        ].join('; ');
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 0 16px 24px; }
.tabs { position: sticky; top: 0; z-index: 2; display: flex; gap: 2px; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border); padding-top: 8px; }
.tab { padding: 6px 12px; cursor: pointer; border: none; background: none; color: var(--vscode-descriptionForeground); border-bottom: 2px solid transparent; font: inherit; }
.tab.active { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder); }
.badge { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 8px; padding: 0 6px; font-size: 11px; margin-left: 4px; }
.muted { color: var(--vscode-descriptionForeground); }
.small { font-size: 0.92em; }
.mono { font-family: var(--vscode-editor-font-family); }
.error { color: var(--vscode-errorForeground); }
.warn { color: var(--vscode-editorWarning-foreground); }
.ok { color: var(--vscode-testing-iconPassed, #3fb950); }
/* Invoice */
.ubl-doc h1 { font-size: 1.5em; margin: 16px 0 4px; font-weight: 600; }
.ubl-doc h2 { font-size: 1.05em; margin: 22px 0 8px; font-weight: 600; }
.ubl-doc h3 { font-size: 0.85em; text-transform: uppercase; letter-spacing: .05em; margin: 0 0 6px; color: var(--vscode-descriptionForeground); }
.docid { font-family: var(--vscode-editor-font-family); }
.title { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 16px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 12px; }
.facts td { padding: 1px 8px 1px 0; vertical-align: top; }
.parties { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 12px; margin-top: 14px; }
.party { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 10px; }
.party .name { font-weight: 600; }
.addr { margin: 4px 0; }
.ids td { padding: 1px 8px 1px 0; vertical-align: top; }
.ids td:first-child { color: var(--vscode-descriptionForeground); white-space: nowrap; }
.notes p { margin: 6px 0; padding: 6px 10px; border-left: 3px solid var(--vscode-textBlockQuote-border); background: var(--vscode-textBlockQuote-background); }
table.grid { width: 100%; border-collapse: collapse; }
table.grid th { text-align: left; font-weight: 600; border-bottom: 1px solid var(--vscode-panel-border); padding: 4px 6px; }
table.grid td { border-bottom: 1px solid var(--vscode-panel-border); padding: 5px 6px; vertical-align: top; }
.num { text-align: right; white-space: nowrap; }
.bottom { display: grid; grid-template-columns: minmax(0, 3fr) minmax(220px, 2fr); gap: 24px; }
table.sum { width: 100%; border-collapse: collapse; }
table.sum td { padding: 3px 0; }
table.sum tr.due td { font-weight: 700; font-size: 1.1em; border-top: 2px solid var(--vscode-foreground); padding-top: 6px; }
.pay { margin-bottom: 8px; }
.pay .name { font-weight: 600; }
/* Attachments */
.att { border: 1px solid var(--vscode-panel-border); border-radius: 4px; margin: 14px 0; }
.att-head { display: flex; justify-content: space-between; gap: 10px; padding: 8px 10px; flex-wrap: wrap; border-bottom: 1px solid var(--vscode-panel-border); }
.att-head .fname { font-weight: 600; }
.att-body { padding: 10px; }
.att ul { margin: 6px 0 0; padding-left: 18px; }
.pages canvas { display: block; max-width: 100%; margin: 0 auto 12px; box-shadow: 0 1px 4px rgba(0,0,0,.35); background: white; }
.att-body img { max-width: 100%; background: white; }
pre.text { white-space: pre-wrap; max-height: 600px; overflow: auto; background: var(--vscode-textCodeBlock-background); padding: 8px; }
button.act { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 3px 9px; border-radius: 2px; cursor: pointer; font: inherit; }
button.act:hover { background: var(--vscode-button-secondaryHoverBackground); }
a { color: var(--vscode-textLink-foreground); cursor: pointer; }
</style>
</head>
<body>
<div class="tabs">
  <button class="tab active" data-tab="doc">Document</button>
  <button class="tab" data-tab="att">Attachments<span class="badge" id="att-count">0</span></button>
</div>
<div id="doc"><p class="muted">Rendering…</p></div>
<div id="att" hidden></div>
<script nonce="${nonce}">
window.PDFJS_URL = ${JSON.stringify(pdfjs.toString())};
window.PDFJS_WORKER_URL = ${JSON.stringify(worker.toString())};
</script>
<script nonce="${nonce}" type="module">
const vscode = acquireVsCodeApi();
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const docEl = document.getElementById('doc');
const attEl = document.getElementById('att');
let pdfjsLib;
const loaded = new Set();

async function pdfjs() {
  if (!pdfjsLib) {
    pdfjsLib = await import(window.PDFJS_URL);
    // Workers can't be loaded cross-origin from webview resources: load the code into a blob URL
    const code = await (await fetch(window.PDFJS_WORKER_URL)).text();
    pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  }
  return pdfjsLib;
}

function report() {
  vscode.postMessage({ type: 'rendered', text: (docEl.hidden ? '' : docEl.innerText) + '\\n' + attEl.innerText });
}

document.querySelector('.tabs').addEventListener('click', ev => {
  const t = ev.target.closest('.tab');
  if (!t) return;
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
  docEl.hidden = t.dataset.tab !== 'doc';
  attEl.hidden = t.dataset.tab !== 'att';
  if (!attEl.hidden) loadVisible();
  report();
});

function kb(n) { return n === undefined ? '' : n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }

function renderAttachments(list, external) {
  document.getElementById('att-count').textContent = list.length;
  if (!list.length && !external.length) { attEl.innerHTML = '<p class="muted">No embedded attachments or external references.</p>'; return; }
  attEl.innerHTML = list.map(a => {
    const issues = [...a.problems.map(p => '<li class="error">✗ ' + esc(p) + '</li>'), ...a.warnings.map(w => '<li class="warn">⚠ ' + esc(w) + '</li>')];
    if (!a.problems.length && !a.warnings.length) issues.push('<li class="ok">✓ mimeCode, filename and content look right</li>');
    return '<div class="att" data-index="' + a.index + '">' +
      '<div class="att-head"><div><span class="fname">' + esc(a.filename || '(no filename)') + '</span> ' +
      '<span class="muted">' + esc(a.mimeCode || '?') + ' · ' + kb(a.size) + (a.referenceId ? ' · ref ' + esc(a.referenceId) : '') + '</span>' +
      (a.description ? '<div class="muted small">' + esc(a.description) + '</div>' : '') + '</div>' +
      '<div><button class="act" data-act="reveal" data-line="' + a.line + '">Line ' + a.line + '</button> ' +
      (a.size ? '<button class="act" data-act="save">Save…</button> <button class="act" data-act="open">Open externally</button>' : '') + '</div></div>' +
      '<div class="att-body"><ul>' + issues.join('') + '</ul><div class="content"></div></div></div>';
  }).join('') + (external.length ? '<h3>External references</h3><ul>' + external.map(e =>
      '<li><span class="mono">' + esc(e.uri) + '</span>' + (e.description ? ' <span class="muted">— ' + esc(e.description) + '</span>' : '') + '</li>').join('') + '</ul>' : '');
  loaded.clear();
  // Load right away so switching tabs is instant
  loadVisible();
}

function loadVisible() {
  attEl.querySelectorAll('.att').forEach(el => {
    const i = Number(el.dataset.index);
    if (!loaded.has(i)) { loaded.add(i); vscode.postMessage({ type: 'loadAttachment', index: i }); }
  });
}

attEl.addEventListener('click', ev => {
  const b = ev.target.closest('[data-act]');
  if (!b) return;
  const index = Number(b.closest('.att').dataset.index);
  const line = Number(b.dataset.line || 0);
  vscode.postMessage({ type: { reveal: 'reveal', save: 'saveAttachment', open: 'openAttachment' }[b.dataset.act], index, line });
});

async function showAttachment(msg) {
  const box = attEl.querySelector('.att[data-index="' + msg.index + '"] .content');
  if (!box) return;
  try {
    if (msg.kind === 'image') {
      const mime = /^image\\/(png|jpeg|gif)$/.test(msg.mime) ? msg.mime : 'image/png';
      box.innerHTML = '<img alt="attachment" src="data:' + mime + ';base64,' + msg.base64 + '">';
    } else if (msg.kind === 'text') {
      box.innerHTML = '<pre class="text">' + esc(msg.text) + (msg.truncated ? '\\n… (truncated)' : '') + '</pre>';
    } else if (msg.kind === 'pdf') {
      box.innerHTML = '<p class="muted">Rendering PDF…</p>';
      const lib = await pdfjs();
      const bytes = Uint8Array.from(atob(msg.base64), c => c.charCodeAt(0));
      const pdf = await lib.getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: true }).promise;
      const pages = document.createElement('div');
      pages.className = 'pages';
      const width = Math.max(300, box.clientWidth || 700);
      for (let n = 1; n <= Math.min(pdf.numPages, 50); n++) {
        const page = await pdf.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(2.5, width / base.width) * (window.devicePixelRatio || 1);
        const vp = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = vp.width; canvas.height = vp.height;
        canvas.style.width = (vp.width / (window.devicePixelRatio || 1)) + 'px';
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, canvas }).promise;
        pages.appendChild(canvas);
      }
      box.innerHTML = '<p class="muted small">' + pdf.numPages + ' page(s)' + (pdf.numPages > 50 ? ' — showing the first 50' : '') + '</p>';
      box.appendChild(pages);
    } else {
      box.innerHTML = '<p class="muted">No inline preview for this type — use Save… or Open externally.</p>';
    }
  } catch (e) {
    box.innerHTML = '<p class="error">Could not display this attachment: ' + esc(e.message || e) + '</p>';
  }
  report();
}

window.addEventListener('message', ev => {
  const msg = ev.data;
  if (msg.type === 'document') {
    docEl.innerHTML = msg.error ? '<p class="error">Could not render the document: ' + esc(msg.error) + '</p>' : msg.html;
    renderAttachments(msg.attachments, msg.external);
    report();
  } else if (msg.type === 'attachmentData') {
    showAttachment(msg);
  }
});
</script>
</body>
</html>`;
    }

    dispose(): void {
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.panel?.dispose();
        for (const d of this.disposables) {
            d.dispose();
        }
    }
}

function safeFileName(a: Attachment): string {
    const ext = a.mimeCode === 'application/pdf' ? '.pdf' : a.mimeCode === 'image/png' ? '.png' : a.mimeCode === 'image/jpeg' ? '.jpg' : '';
    const base = (a.filename || a.referenceId || `attachment-${a.index + 1}`).replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').slice(0, 120);
    return /\.[A-Za-z0-9]{1,5}$/.test(base) ? base : base + ext;
}
