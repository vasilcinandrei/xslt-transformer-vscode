// Copies the pdf.js build used by the UBL Preview panel into media/pdfjs.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'node_modules', 'pdfjs-dist');
const dest = path.join(root, 'media', 'pdfjs');
fs.mkdirSync(dest, { recursive: true });
for (const f of ['build/pdf.min.mjs', 'build/pdf.worker.min.mjs', 'LICENSE']) {
    fs.copyFileSync(path.join(src, f), path.join(dest, path.basename(f)));
}
