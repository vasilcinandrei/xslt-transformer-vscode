import { randomBytes } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { detectUblDocumentFromContent } from '../validation/documentDetector';
import { extractPeppolDocument, PeppolDocument } from './participants';
import { DIRECTORY_URLS, lookupParticipantCached, ParticipantLookup, PeppolNetwork } from './lookup';

type LookupMode = 'auto' | 'manual' | 'off';

interface ViewState {
    kind: 'empty' | 'document';
    message?: string;
    fileName?: string;
    doc?: PeppolDocument;
    networks: PeppolNetwork[];
    mode: LookupMode;
    /** "<role>|<network>" → result, or 'loading' */
    results: Record<string, ParticipantLookup | 'loading'>;
}

function settings(): { mode: LookupMode; networks: PeppolNetwork[] } {
    const cfg = vscode.workspace.getConfiguration('ublValidator.peppol');
    const networks = cfg.get<PeppolNetwork[]>('networks', ['production', 'test']).filter(n => n === 'production' || n === 'test');
    return { mode: cfg.get<LookupMode>('lookup', 'auto'), networks: networks.length ? networks : ['production', 'test'] };
}

/**
 * "Peppol Network" side panel: for the active UBL document, shows whether the
 * sender and receiver are registered on the Peppol production/test networks and
 * whether the receiver accepts this document type and process.
 */
export class PeppolViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewId = 'ublValidator.peppolView';
    private view: vscode.WebviewView | undefined;
    private currentUri: vscode.Uri | undefined;
    private state: ViewState = { kind: 'empty', networks: [], mode: 'auto', results: {} };
    private generation = 0;
    private timer: NodeJS.Timeout | undefined;
    private readonly disposables: vscode.Disposable[] = [];
    /** Text the webview last rendered (used by the end-to-end tests) */
    lastRenderedText = '';

    constructor() {
        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor(() => this.schedule()),
            vscode.workspace.onDidSaveTextDocument(doc => {
                if (doc.uri.toString() === this.currentUri?.toString()) {
                    this.schedule();
                }
            }),
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('ublValidator.peppol')) {
                    this.schedule();
                }
            })
        );
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = { enableScripts: true, localResourceRoots: [] };
        view.webview.html = this.html();
        view.webview.onDidReceiveMessage(msg => this.onMessage(msg), null, this.disposables);
        view.onDidChangeVisibility(() => {
            if (view.visible) {
                this.schedule();
            }
        }, null, this.disposables);
        view.onDidDispose(() => {
            this.view = undefined;
        }, null, this.disposables);
        this.schedule();
    }

    /** Re-checks the active document, bypassing the lookup cache. */
    refresh(): void {
        void this.update(true);
    }

    private schedule(): void {
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => void this.update(false), 300);
    }

    private async onMessage(msg: { type: string; url?: string; text?: string }): Promise<void> {
        if (msg.type === 'refresh' || msg.type === 'check') {
            await this.update(true, msg.type === 'check');
        } else if (msg.type === 'open' && msg.url && /^https:\/\//.test(msg.url)) {
            await vscode.env.openExternal(vscode.Uri.parse(msg.url));
        } else if (msg.type === 'copy' && msg.text) {
            await vscode.env.clipboard.writeText(msg.text);
            vscode.window.setStatusBarMessage('Copied', 2000);
        } else if (msg.type === 'rendered' && msg.text !== undefined) {
            this.lastRenderedText = msg.text;
        } else if (msg.type === 'settings') {
            await vscode.commands.executeCommand('workbench.action.openSettings', 'ublValidator.peppol');
        }
    }

    private async update(force: boolean, runManual = false): Promise<void> {
        if (!this.view?.visible) {
            return;
        }
        const editor = vscode.window.activeTextEditor;
        // Focus in a panel or output view: keep showing the last document
        let document = editor?.document;
        if (!document && this.currentUri) {
            document = vscode.workspace.textDocuments.find(d => d.uri.toString() === this.currentUri!.toString());
        }
        const { mode, networks } = settings();
        const generation = ++this.generation;

        const docInfo = document && detectUblDocumentFromContent(document.getText());
        if (!document || !docInfo) {
            if (!editor && this.state.kind === 'document') {
                return;
            }
            this.currentUri = undefined;
            this.post({ kind: 'empty', networks, mode, results: {}, message: 'Open a UBL document to check its sender and receiver on the Peppol network.' });
            return;
        }

        this.currentUri = document.uri;
        const doc = extractPeppolDocument(document.getText(), docInfo);
        const results: ViewState['results'] = {};
        const runLookups = mode === 'auto' || (mode === 'manual' && runManual);
        const jobs: Promise<void>[] = [];
        if (runLookups) {
            for (const party of [doc.sender, doc.receiver]) {
                if (!party.participantId) {
                    continue;
                }
                for (const network of networks) {
                    const key = `${party.role}|${network}`;
                    results[key] = 'loading';
                    // The receiver must accept this document; for the sender we only check registration
                    const docType = party.role === 'receiver' ? doc.documentTypeId : undefined;
                    const process = party.role === 'receiver' ? doc.processId : undefined;
                    jobs.push(lookupParticipantCached(party.participantId, network, docType, process, force).then(r => {
                        if (generation === this.generation) {
                            this.state.results[key] = r;
                            this.post(this.state);
                        }
                    }));
                }
            }
        }
        this.post({
            kind: 'document',
            fileName: path.basename(document.uri.fsPath || document.uri.path),
            doc, networks, mode, results,
        });
        await Promise.allSettled(jobs);
    }

    private post(state: ViewState): void {
        this.state = state;
        void this.view?.webview.postMessage({ type: 'state', state, directory: DIRECTORY_URLS });
    }

    private html(): string {
        const nonce = randomBytes(16).toString('base64');
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 0 10px 12px; }
h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; margin: 14px 0 6px; color: var(--vscode-descriptionForeground); }
.doc { color: var(--vscode-descriptionForeground); margin: 8px 0; word-break: break-all; }
.party { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 8px; margin-bottom: 10px; }
.party .title { display: flex; justify-content: space-between; gap: 6px; font-weight: 600; }
.pid { font-family: var(--vscode-editor-font-family); cursor: pointer; }
.pid:hover { text-decoration: underline; }
.muted { color: var(--vscode-descriptionForeground); }
.net { margin-top: 8px; padding-top: 6px; border-top: 1px dashed var(--vscode-panel-border); }
.net .head { display: flex; justify-content: space-between; }
.ok { color: var(--vscode-testing-iconPassed, #3fb950); }
.bad { color: var(--vscode-errorForeground); }
.warn { color: var(--vscode-editorWarning-foreground); }
ul { margin: 4px 0 0; padding-left: 18px; }
li { margin: 2px 0; word-break: break-word; }
a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
a:hover { text-decoration: underline; }
button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 10px; border-radius: 2px; cursor: pointer; }
button:hover { background: var(--vscode-button-hoverBackground); }
.toolbar { display: flex; gap: 8px; align-items: center; margin-top: 10px; }
details summary { cursor: pointer; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<div id="root"><p class="muted">Loading…</p></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const root = document.getElementById('root');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const label = { production: 'Production', test: 'Test' };
let directory = {};

function shortDocType(id) {
  const m = String(id).match(/::([A-Za-z]+)##(.+)::[\\d.]+$/);
  return m ? m[1] + ' · ' + m[2] : id;
}

function namesDiffer(a, b) {
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return a && b && !norm(a).includes(norm(b)) && !norm(b).includes(norm(a));
}

function renderLookup(party, network, r, doc) {
  if (r === 'loading') return '<div class="net"><div class="head"><span>' + label[network] + '</span><span class="muted">checking…</span></div></div>';
  if (!r) return '';
  let head, items = [];
  if (r.error && !r.registered) {
    head = '<span class="warn">⚠ lookup failed</span>';
    items.push(esc(r.error));
  } else if (!r.registered) {
    head = party.role === 'receiver' ? '<span class="bad">✗ not registered</span>' : '<span class="muted">○ not registered</span>';
    if (party.role === 'receiver') items.push('Documents cannot be delivered to this participant on the ' + label[network].toLowerCase() + ' network.');
    else items.push('Senders don\\'t have to be registered, but then they cannot receive responses on this network.');
  } else {
    head = '<span class="ok">✓ registered</span>';
    items.push('SMP: ' + esc(new URL(r.smpUrl).host));
    if (r.directory && r.directory.name) {
      const differ = namesDiffer(r.directory.name, party.name);
      items.push('Directory: ' + esc(r.directory.name) + (r.directory.country ? ' (' + esc(r.directory.country) + ')' : '') +
        (differ ? ' <span class="warn">— differs from the name in the document</span>' : ''));
    }
    if (party.role === 'receiver' && doc.documentTypeId) {
      if (r.acceptsDocument) {
        items.push('<span class="ok">✓ accepts this document type</span>');
        if (doc.processId) items.push(r.acceptsProcess ? '<span class="ok">✓ accepts this process</span>' : '<span class="bad">✗ does not list this process (' + esc(doc.profileId) + ')</span>');
        for (const p of r.processes || []) for (const e of p.endpoints) {
          let line = esc(e.transportProfile) + (e.url ? ' → ' + esc(e.url) : '');
          if (e.certificate) {
            const c = e.certificate;
            const mismatch = (network === 'production') === c.testCertificate;
            line += '<br><span class="' + (c.expired || mismatch ? 'bad' : 'muted') + '">Certificate: ' + esc(c.issuer) + ', valid to ' + esc(c.validTo) +
              (c.expired ? ' — expired' : '') + (mismatch ? ' — wrong CA for this network' : '') + '</span>';
          }
          if (e.expiration && Date.parse(e.expiration) < Date.now()) line += '<br><span class="bad">Service expired ' + esc(e.expiration) + '</span>';
          items.push(line);
        }
      } else if (r.documentTypes.length) {
        items.push('<span class="bad">✗ does not accept this document type</span>');
        items.push('<details><summary>Accepts ' + r.documentTypes.length + ' document type(s)</summary><ul>' +
          r.documentTypes.map(d => '<li>' + esc(shortDocType(d)) + '</li>').join('') + '</ul></details>');
      } else {
        items.push('<span class="warn">⚠ registered in the SML, but the SMP lists no document types</span>');
      }
    } else if (r.documentTypes.length) {
      items.push('Accepts ' + r.documentTypes.length + ' document type(s)');
    }
    if (r.error) items.push('<span class="warn">⚠ ' + esc(r.error) + '</span>');
    items.push('<a data-open="' + esc(directory[network] + '/participant/iso6523-actorid-upis::' + encodeURIComponent(party.participantId)) + '">Open in Peppol Directory</a>');
  }
  return '<div class="net"><div class="head"><span>' + label[network] + '</span>' + head + '</div><ul>' + items.map(i => '<li>' + i + '</li>').join('') + '</ul></div>';
}

function renderParty(party, state) {
  const title = party.role === 'sender' ? 'Sender' : 'Receiver';
  let html = '<div class="party"><div class="title"><span>' + title + '</span>' +
    (party.participantId ? '<span class="pid" title="Click to copy" data-copy="' + esc(party.participantId) + '">' + esc(party.participantId) + '</span>' : '') + '</div>';
  html += '<div class="muted">' + esc(party.name || '(no name)') + (party.country ? ' · ' + esc(party.country) : '') + (party.element ? ' · ' + esc(party.element) : '') + '</div>';
  if (party.problem) html += '<div class="bad">✗ ' + esc(party.problem) + '</div>';
  if (party.participantId) {
    if (state.mode === 'off') html += '<div class="muted">Network lookups are off.</div>';
    for (const n of state.networks) html += renderLookup(party, n, state.results[party.role + '|' + n], state.doc);
  }
  return html + '</div>';
}

function render(state) {
  if (state.kind === 'empty') { root.innerHTML = '<p class="muted">' + esc(state.message) + '</p>'; return; }
  const d = state.doc;
  let html = '<div class="doc"><b>' + esc(state.fileName) + '</b><br>' + esc(d.rootElement) +
    (d.customizationId ? ' · ' + esc(d.customizationId) : ' · <span class="warn">no CustomizationID</span>') + '</div>';
  if (!d.documentTypeId) html += '<p class="warn">⚠ Without a cbc:CustomizationID the Peppol document type cannot be determined.</p>';
  html += renderParty(d.receiver, state) + renderParty(d.sender, state);
  html += '<div class="toolbar">' +
    (state.mode === 'manual' ? '<button data-cmd="check">Check now</button>' : '<button data-cmd="refresh">Refresh</button>') +
    '<a data-cmd="settings">Settings</a></div>';
  html += '<p class="muted">Looks up the participants in the Peppol SML, their SMP and the Peppol Directory. Results are cached for 10 minutes.</p>';
  root.innerHTML = html;
}

root.addEventListener('click', ev => {
  const t = ev.target.closest('[data-cmd],[data-open],[data-copy]');
  if (!t) return;
  if (t.dataset.cmd) vscode.postMessage({ type: t.dataset.cmd });
  else if (t.dataset.open) vscode.postMessage({ type: 'open', url: t.dataset.open });
  else if (t.dataset.copy) vscode.postMessage({ type: 'copy', text: t.dataset.copy });
});
window.addEventListener('message', ev => {
  if (ev.data.type === 'state') {
    directory = ev.data.directory;
    render(ev.data.state);
    vscode.postMessage({ type: 'rendered', text: root.innerText });
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
        for (const d of this.disposables) {
            d.dispose();
        }
    }
}
