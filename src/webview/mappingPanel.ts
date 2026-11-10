import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { TraceEntry } from '../tracing/xsltTracer';
import { ValidationIssue } from '../validation/types';

export interface MappingData {
    /** Main stylesheet first, then local includes/imports */
    stylesheetFiles: string[];
    outputXml: string;
    traceEntries: TraceEntry[];
    validationIssues: ValidationIssue[];
}

/**
 * Side-by-side view: stylesheet on the left, transform output on the right.
 * Clicking an output line highlights the XSLT line that produced it and vice
 * versa; double-clicking opens the location in the editor.
 */
export class MappingPanel {
    public static readonly viewType = 'xsltMapping';
    private static currentPanel: MappingPanel | undefined;

    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];

    static createOrShow(data: MappingData): MappingPanel {
        const column = vscode.ViewColumn.Beside;
        if (MappingPanel.currentPanel) {
            MappingPanel.currentPanel.update(data);
            MappingPanel.currentPanel.panel.reveal(column);
            return MappingPanel.currentPanel;
        }
        const panel = vscode.window.createWebviewPanel(
            MappingPanel.viewType,
            'XSLT → Output Mapping',
            column,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] }
        );
        MappingPanel.currentPanel = new MappingPanel(panel, data);
        return MappingPanel.currentPanel;
    }

    private constructor(panel: vscode.WebviewPanel, data: MappingData) {
        this.panel = panel;
        this.update(data);
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(msg => this.onMessage(msg), null, this.disposables);
    }

    update(data: MappingData): void {
        this.panel.webview.html = this.getHtml(data);
    }

    private async onMessage(msg: { type: string; file?: string; line?: number }): Promise<void> {
        if (msg.type === 'open' && msg.file && typeof msg.line === 'number') {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(msg.file));
            const pos = new vscode.Position(Math.max(0, msg.line - 1), 0);
            await vscode.window.showTextDocument(doc, {
                viewColumn: vscode.ViewColumn.One,
                selection: new vscode.Range(pos, pos),
            });
        }
    }

    dispose(): void {
        MappingPanel.currentPanel = undefined;
        this.panel.dispose();
        for (const d of this.disposables) {
            d.dispose();
        }
        this.disposables = [];
    }

    private getHtml(data: MappingData): string {
        const nonce = randomBytes(16).toString('base64');
        const errorLines = new Set(
            data.validationIssues
                .filter(i => i.severity === vscode.DiagnosticSeverity.Error)
                .map(i => i.line)
        );

        const filePanes = data.stylesheetFiles.map((file, idx) => {
            let content = '';
            try {
                content = fs.readFileSync(file, 'utf8');
            } catch {
                content = `(cannot read ${file})`;
            }
            const lines = escapeHtml(content).split(/\r?\n/).map((line, i) =>
                `<div class="line" data-line="${i + 1}"><span class="line-num">${i + 1}</span>${line || '&nbsp;'}</div>`
            ).join('\n');
            return `<div class="file" data-file="${idx}"${idx === 0 ? '' : ' hidden'}>${lines}</div>`;
        }).join('\n');

        const fileOptions = data.stylesheetFiles.map((file, idx) =>
            `<option value="${idx}">${escapeHtml(path.basename(file))}</option>`
        ).join('');

        const outputHtml = escapeHtml(data.outputXml).split(/\r?\n/).map((line, i) => {
            const lineNum = i + 1;
            const errorClass = errorLines.has(lineNum) ? ' error-line' : '';
            return `<div class="line${errorClass}" data-line="${lineNum}"><span class="line-num">${lineNum}</span>${line || '&nbsp;'}</div>`;
        }).join('\n');

        const fileIndex = new Map(data.stylesheetFiles.map((f, i) => [f, i]));
        const connections = data.traceEntries
            .filter(e => fileIndex.has(e.sourceFile))
            .map(e => ({ o: e.outputLine, f: fileIndex.get(e.sourceFile), s: e.sourceLine }));
        const payload = JSON.stringify({ connections, files: data.stylesheetFiles }).replace(/</g, '\\u003c');

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    height: 100vh;
}
.container { display: flex; width: 100%; height: 100%; }
.pane { flex: 1; overflow: auto; border-right: 1px solid var(--vscode-panel-border); }
.pane:last-of-type { border-right: none; }
.pane-header {
    display: flex; gap: 8px; align-items: center;
    font-family: var(--vscode-font-family); font-weight: 600;
    padding: 4px 8px;
    background: var(--vscode-sideBarSectionHeader-background, var(--vscode-editor-background));
    border-bottom: 1px solid var(--vscode-panel-border);
    position: sticky; top: 0; z-index: 10;
}
.pane-header .hint { font-weight: normal; opacity: 0.7; font-size: 0.9em; }
select {
    background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border); font: inherit;
}
.line { white-space: pre; padding: 0 4px; line-height: 1.5; cursor: pointer; }
.line:hover { background: var(--vscode-list-hoverBackground); }
.line.highlight { background: var(--vscode-editor-findMatchHighlightBackground); }
.line.error-line { border-left: 3px solid var(--vscode-editorError-foreground); }
.line-num {
    display: inline-block; width: 44px; text-align: right; margin-right: 12px;
    color: var(--vscode-editorLineNumber-foreground); user-select: none;
}
</style>
</head>
<body>
<div class="container">
    <div class="pane" id="xslt-pane">
        <div class="pane-header">Stylesheet <select id="file-select">${fileOptions}</select></div>
        ${filePanes}
    </div>
    <div class="pane" id="output-pane">
        <div class="pane-header">Transform output <span class="hint">click to map · double-click to open</span></div>
        <div id="output-content">${outputHtml}</div>
    </div>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const { connections, files } = JSON.parse(${JSON.stringify(payload)});
const select = document.getElementById('file-select');

function showFile(idx) {
    select.value = String(idx);
    document.querySelectorAll('.file').forEach(el => { el.hidden = el.dataset.file !== String(idx); });
}
function clearHighlights() {
    document.querySelectorAll('.highlight').forEach(el => el.classList.remove('highlight'));
}
function nearestConnection(outputLine) {
    let best = null;
    for (const c of connections) {
        if (c.o <= outputLine && (!best || c.o >= best.o)) { best = c; }
    }
    return best;
}

select.addEventListener('change', () => showFile(select.value));

document.querySelectorAll('#output-pane .line').forEach(el => {
    el.addEventListener('click', () => {
        clearHighlights();
        el.classList.add('highlight');
        const best = nearestConnection(parseInt(el.dataset.line, 10));
        if (!best) { return; }
        showFile(best.f);
        const target = document.querySelector('.file[data-file="' + best.f + '"] .line[data-line="' + best.s + '"]');
        if (target) {
            target.classList.add('highlight');
            target.scrollIntoView({ block: 'center' });
        }
    });
    el.addEventListener('dblclick', () => {
        const best = nearestConnection(parseInt(el.dataset.line, 10));
        if (best) { vscode.postMessage({ type: 'open', file: files[best.f], line: best.s }); }
    });
});

document.querySelectorAll('.file').forEach(fileEl => {
    const f = parseInt(fileEl.dataset.file, 10);
    fileEl.querySelectorAll('.line').forEach(el => {
        const line = parseInt(el.dataset.line, 10);
        el.addEventListener('click', () => {
            clearHighlights();
            el.classList.add('highlight');
            let first = true;
            for (const c of connections) {
                if (c.f === f && c.s === line) {
                    const out = document.querySelector('#output-pane .line[data-line="' + c.o + '"]');
                    if (out) {
                        out.classList.add('highlight');
                        if (first) { out.scrollIntoView({ block: 'center' }); first = false; }
                    }
                }
            }
        });
        el.addEventListener('dblclick', () => vscode.postMessage({ type: 'open', file: files[f], line }));
    });
});
</script>
</body>
</html>`;
    }
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
