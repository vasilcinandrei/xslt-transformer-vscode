/** MIME codes Peppol BIS Billing 3.0 allows for embedded attachments */
export const PEPPOL_MIME_CODES = [
    'application/pdf',
    'image/png',
    'image/jpeg',
    'text/csv',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.oasis.opendocument.spreadsheet',
];

export interface Attachment {
    index: number;
    /** cac:AdditionalDocumentReference/cbc:ID */
    referenceId?: string;
    description?: string;
    documentTypeCode?: string;
    mimeCode?: string;
    filename?: string;
    /** 1-based line of the EmbeddedDocumentBinaryObject element */
    line: number;
    /** Decoded content (undefined when the base64 doesn't decode) */
    data?: Buffer;
    /** Type detected from the content's first bytes */
    detectedMime?: string;
    problems: string[];
    warnings: string[];
}

export interface ExternalReference {
    referenceId?: string;
    description?: string;
    uri: string;
}

function decodeEntities(s: string): string {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function attr(attrs: string, name: string): string | undefined {
    const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(["'])([^"']*)\\1`));
    return m ? decodeEntities(m[2]).trim() : undefined;
}

function childText(xml: string, name: string): string | undefined {
    const m = xml.match(new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*>([^<]*)</`));
    const v = m && decodeEntities(m[1]).trim();
    return v || undefined;
}

/** Detects common file types from their signature bytes. */
export function sniffMime(data: Buffer): string | undefined {
    const startsWith = (...bytes: number[]) => bytes.every((b, i) => data[i] === b);
    if (startsWith(0x25, 0x50, 0x44, 0x46)) {
        return 'application/pdf';
    }
    if (startsWith(0x89, 0x50, 0x4e, 0x47)) {
        return 'image/png';
    }
    if (startsWith(0xff, 0xd8, 0xff)) {
        return 'image/jpeg';
    }
    if (startsWith(0x47, 0x49, 0x46, 0x38)) {
        return 'image/gif';
    }
    if (startsWith(0x50, 0x4b, 0x03, 0x04)) {
        // Office Open XML and OpenDocument are zip files; look for their markers
        const head = data.subarray(0, 2048).toString('latin1');
        if (head.includes('mimetypeapplication/vnd.oasis.opendocument.spreadsheet')) {
            return 'application/vnd.oasis.opendocument.spreadsheet';
        }
        if (head.includes('xl/') || head.includes('[Content_Types].xml')) {
            return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        }
        return 'application/zip';
    }
    const text = data.subarray(0, 512).toString('utf8');
    if (/^﻿?\s*<\?xml|^﻿?\s*<[A-Za-z]/.test(text)) {
        return 'application/xml';
    }
    // Text: no NUL bytes in the first 512 bytes
    if (!data.subarray(0, 512).includes(0)) {
        return text.includes(',') || text.includes(';') ? 'text/csv' : 'text/plain';
    }
    return undefined;
}

function decodeBase64(raw: string): Buffer | undefined {
    const clean = raw.replace(/\s+/g, '');
    if (clean.length === 0 || clean.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) {
        return undefined;
    }
    return Buffer.from(clean, 'base64');
}

function lineOf(content: string, offset: number): number {
    let line = 1;
    for (let i = 0; i < offset; i++) {
        if (content.charCodeAt(i) === 10) {
            line++;
        }
    }
    return line;
}

const MIME_FAMILY = (m: string) => m.replace(/^text\/(plain|csv)$/, 'text');

/**
 * Finds embedded attachments (cbc:EmbeddedDocumentBinaryObject) and external
 * references (cac:ExternalReference/cbc:URI) in a UBL document.
 */
export function extractAttachments(content: string): { attachments: Attachment[]; external: ExternalReference[] } {
    const attachments: Attachment[] = [];
    const external: ExternalReference[] = [];
    const refRe = /<((?:[\w.-]+:)?\w*DocumentReference)\b[^>]*>([\s\S]*?)<\/\1>/g;
    let ref: RegExpExecArray | null;
    while ((ref = refRe.exec(content)) !== null) {
        const body = ref[2];
        const referenceId = childText(body, 'ID');
        const description = childText(body, 'DocumentDescription');
        const documentTypeCode = childText(body, 'DocumentTypeCode');

        const objRe = /<(?:[\w.-]+:)?EmbeddedDocumentBinaryObject\b([^>]*)>([^<]*)</g;
        let obj: RegExpExecArray | null;
        while ((obj = objRe.exec(body)) !== null) {
            const line = lineOf(content, ref.index + ref[0].indexOf(ref[2]) + obj.index);
            const a: Attachment = {
                index: attachments.length,
                referenceId, description, documentTypeCode,
                mimeCode: attr(obj[1], 'mimeCode'),
                filename: attr(obj[1], 'filename'),
                line,
                problems: [],
                warnings: [],
            };
            a.data = decodeBase64(obj[2]);
            if (!a.data) {
                a.problems.push(obj[2].trim() ? 'The content is not valid base64.' : 'The attachment is empty.');
            } else {
                a.detectedMime = sniffMime(a.data);
            }
            if (!a.mimeCode) {
                a.problems.push('Missing mimeCode attribute.');
            } else if (!PEPPOL_MIME_CODES.includes(a.mimeCode)) {
                a.warnings.push(`mimeCode "${a.mimeCode}" is not allowed in Peppol BIS (allowed: PDF, PNG, JPEG, CSV, XLSX, ODS).`);
            }
            if (!a.filename) {
                a.problems.push('Missing filename attribute.');
            }
            if (a.mimeCode && a.detectedMime && MIME_FAMILY(a.mimeCode) !== MIME_FAMILY(a.detectedMime)) {
                a.problems.push(`Declared as ${a.mimeCode}, but the content looks like ${a.detectedMime}.`);
            }
            if (a.data && a.data.length > 10 * 1024 * 1024) {
                a.warnings.push(`Large attachment (${(a.data.length / 1024 / 1024).toFixed(1)} MB); many access points limit message size.`);
            }
            attachments.push(a);
        }

        const uri = childText(body, 'URI');
        if (uri && /ExternalReference/.test(body)) {
            external.push({ referenceId, description, uri });
        }
    }
    return { attachments, external };
}
