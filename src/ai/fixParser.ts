import { scanStartTags } from '../tracing/xmlTokenizer';
import { XSLT_NS } from '../tracing/xsltTracer';
import { FixProposal, FixSection } from './types';

/** Extracts the explanation and body of the first <fix>...</fix> block. */
export function extractFix(response: string): { explanation: string; body: string } | null {
    const match = response.match(/<fix\b([^>]*)>([\s\S]*?)<\/fix>/);
    if (!match) {
        return null;
    }
    const attr = match[1].match(/explanation\s*=\s*(?:"([^"]*)"|'([^']*)')/);
    let body = match[2];
    // Models sometimes wrap the content in a markdown code fence
    const fenced = body.match(/^\s*```[\w-]*\s*\n([\s\S]*?)\n\s*```\s*$/);
    if (fenced) {
        body = fenced[1];
    }
    return {
        explanation: (attr?.[1] ?? attr?.[2] ?? '').trim() || 'AI-proposed fix',
        body: body.replace(/^\s*\n/, '').replace(/\s+$/, ''),
    };
}

/** True if the content's root element is xsl:stylesheet or xsl:transform. */
export function isXsltStylesheet(content: string): boolean {
    const root = scanStartTags(content.slice(0, 64 * 1024))[0];
    return !!root && root.namespace === XSLT_NS && (root.localName === 'stylesheet' || root.localName === 'transform');
}

/** Replaces lines startLine..endLine (1-based, inclusive) with `replacement`. */
export function spliceLines(content: string, section: FixSection, replacement: string): string {
    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    const lines = content.split(/\r?\n/);
    const replacementLines = replacement.split(/\r?\n/);
    lines.splice(section.startLine - 1, section.endLine - section.startLine + 1, ...replacementLines);
    return lines.join(eol);
}

/**
 * Turns a model response into a proposal. In 'section' mode the response
 * holds only the replacement for `section`, which is patched into the file.
 */
export function parseFixResponse(
    response: string,
    originalXslt: string,
    mode: 'full' | 'section' = 'full',
    section?: FixSection
): FixProposal | null {
    const fix = extractFix(response);
    if (!fix || !fix.body.trim()) {
        return null;
    }

    let proposedContent = fix.body;
    if (mode === 'section' && section) {
        // A full stylesheet in the reply only replaces the file when the section
        // itself didn't contain the root element (it can, near the top of the file)
        const replyIsWholeFile = isXsltStylesheet(fix.body) && !isXsltStylesheet(section.text);
        if (!replyIsWholeFile) {
            proposedContent = spliceLines(originalXslt, section, fix.body);
        }
    }

    if (!isXsltStylesheet(proposedContent) || proposedContent === originalXslt) {
        return null;
    }
    return { originalContent: originalXslt, proposedContent, explanation: fix.explanation, rawFix: fix.body };
}
