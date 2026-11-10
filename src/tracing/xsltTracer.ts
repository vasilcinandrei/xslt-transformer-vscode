import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { scanStartTags, getAttribute, escapeAttribute, XmlStartTag } from './xmlTokenizer';
import { JavaHelper, JavaToolError, RequestOptions } from '../utils/javaRunner';

export interface TraceEntry {
    outputLine: number;
    sourceFile: string;
    sourceLine: number;
    /** The element name for context */
    elementName: string;
}

export const XSLT_NS = 'http://www.w3.org/1999/XSL/Transform';
export const TRACE_NS = 'urn:x-ubl-validator:trace';
const TRACE_PREFIX = 'ublvtrace';

/**
 * Adds a trace attribute (ublvtrace:t="fileIndex:line") to every literal
 * result element inside templates, functions and other instructions.
 *
 * An attribute is used rather than an injected comment node so that element
 * sequences keep their type (e.g. as="element()*" variables and template
 * results), string values are unchanged, and no lines are added — Saxon error
 * line numbers keep matching the user's file.
 *
 * `xml:base` on the root keeps relative URIs (xsl:include, document(),
 * unparsed-text()) resolving against the original location even though the
 * instrumented copy lives in a temp folder. `rewriteHref` lets the caller
 * point xsl:include/xsl:import at instrumented copies of included modules.
 */
export function instrumentStylesheetText(
    content: string,
    fileIndex: number,
    originalPath: string,
    rewriteHref?: (href: string) => string | undefined
): string {
    const tags = scanStartTags(content);
    const root = tags.find(t => t.ancestors.length === 0);
    if (!root || root.namespace !== XSLT_NS || (root.localName !== 'stylesheet' && root.localName !== 'transform')) {
        // Simplified stylesheet (literal result element as root) — run uninstrumented
        return addRootBase(content, root, originalPath, false);
    }

    const edits: { offset: number; end: number; text: string }[] = [];

    for (const tag of tags) {
        if (tag === root) {
            continue;
        }
        if (tag.namespace === XSLT_NS) {
            if ((tag.localName === 'include' || tag.localName === 'import') && rewriteHref) {
                const href = getAttribute(tag, 'href');
                const replacement = href ? rewriteHref(href.value) : undefined;
                if (href && replacement) {
                    edits.push({ offset: href.valueStart, end: href.valueEnd, text: escapeAttribute(replacement) });
                }
            }
            continue;
        }
        if (isInsideInstructions(tag)) {
            edits.push({
                offset: tag.closeOffset,
                end: tag.closeOffset,
                text: ` ${TRACE_PREFIX}:t="${fileIndex}:${tag.line}"`,
            });
        }
    }

    let result = content;
    for (const e of edits.sort((a, b) => b.offset - a.offset)) {
        result = result.slice(0, e.offset) + e.text + result.slice(e.end);
    }
    return addRootBase(result, scanStartTags(result).find(t => t.ancestors.length === 0), originalPath, true);
}

/** True when the literal element sits under an XSLT declaration (not top-level user data). */
function isInsideInstructions(tag: XmlStartTag): boolean {
    const topLevel = tag.ancestors[1];
    return topLevel !== undefined && topLevel.namespace === XSLT_NS;
}

function addRootBase(content: string, root: XmlStartTag | undefined, originalPath: string, addTraceNs: boolean): string {
    if (!root) {
        return content;
    }
    const originalUri = pathToFileURL(originalPath).toString();
    const attrs: string[] = [];
    const existingBase = getAttribute(root, 'xml:base');
    let result = content;
    if (existingBase) {
        const resolved = new URL(existingBase.value, originalUri).toString();
        result = result.slice(0, existingBase.valueStart) + escapeAttribute(resolved) + result.slice(existingBase.valueEnd);
    } else {
        attrs.push(`xml:base="${escapeAttribute(originalUri)}"`);
    }
    if (addTraceNs) {
        attrs.push(`xmlns:${TRACE_PREFIX}="${TRACE_NS}"`);
    }
    if (attrs.length === 0) {
        return result;
    }
    // Insert right after the root element name; offsets before it are unchanged
    const insertAt = root.start + 1 + root.name.length;
    return result.slice(0, insertAt) + ' ' + attrs.join(' ') + result.slice(insertAt);
}

export interface InstrumentedStylesheets {
    mainPath: string;
    /** Original file paths, indexed by the file index used in trace attributes */
    files: string[];
    tempDir: string;
    cleanup: () => void;
    /** Rewrites temp paths in tool messages back to the original paths */
    mapMessage: (message: string) => string;
}

/**
 * Instruments the main stylesheet and every locally resolvable
 * xsl:include/xsl:import into a temp folder.
 */
export function instrumentStylesheets(mainXsltPath: string): InstrumentedStylesheets {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubl-trace-'));
    const files: string[] = [];
    const tempByOriginal = new Map<string, string>();

    const instrument = (originalPath: string): string => {
        const key = path.resolve(originalPath);
        const existing = tempByOriginal.get(key);
        if (existing) {
            return existing;
        }
        const index = files.length;
        files.push(key);
        const tempPath = path.join(tempDir, `${index}-${path.basename(key)}`);
        tempByOriginal.set(key, tempPath);

        const content = fs.readFileSync(key, 'utf8');
        const instrumented = instrumentStylesheetText(content, index, key, href => {
            const target = resolveLocalHref(href, key);
            return target ? pathToFileURL(instrument(target)).toString() : undefined;
        });
        fs.writeFileSync(tempPath, instrumented, 'utf8');
        return tempPath;
    };

    const mainPath = instrument(mainXsltPath);

    const replacements: [string, string][] = [];
    for (const [original, temp] of tempByOriginal) {
        for (const variant of pathVariants(temp)) {
            replacements.push([variant, original]);
        }
    }
    // Longest first so file: URIs are replaced before bare paths
    replacements.sort((a, b) => b[0].length - a[0].length);

    return {
        mainPath,
        files,
        tempDir,
        cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
        mapMessage: (message: string) => {
            let out = message;
            for (const [from, to] of replacements) {
                out = out.split(from).join(to);
            }
            return out;
        },
    };
}

function pathVariants(p: string): string[] {
    const variants = new Set<string>();
    const add = (q: string) => {
        variants.add(pathToFileURL(q).toString());           // file:///tmp/x
        variants.add('file:' + pathToFileURL(q).pathname);    // file:/tmp/x (Java style)
        variants.add(q);
    };
    add(p);
    try {
        add(fs.realpathSync(p));
    } catch {
        // ignore
    }
    return [...variants];
}

function resolveLocalHref(href: string, fromFile: string): string | undefined {
    try {
        const url = new URL(href, pathToFileURL(fromFile));
        if (url.protocol !== 'file:') {
            return undefined;
        }
        const p = fileURLToPath(url);
        return fs.existsSync(p) ? p : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Extracts trace attributes from the transform output and returns the output
 * with every trace artefact removed.
 *
 * Saxon wraps long start tags over several lines; a traced start tag is joined
 * back onto one line so the element's line is unambiguous (validators report
 * the line of the closing '>' of a start tag).
 */
export function parseTracedOutput(raw: string, files: string[]): { cleanOutput: string; traceEntries: TraceEntry[] } {
    const nsMatch = raw.match(new RegExp(`xmlns:([\\w.-]+)="${escapeRegex(TRACE_NS)}"`));
    if (!nsMatch) {
        return { cleanOutput: raw, traceEntries: [] };
    }
    const prefix = escapeRegex(nsMatch[1]);
    const artefactRegex = new RegExp(
        `\\s+${prefix}:t="(\\d+):(\\d+)"|\\s+xmlns:${prefix}="${escapeRegex(TRACE_NS)}"`, 'g'
    );

    // Pass 1: strip artefacts, remember where each traced start tag begins
    const traced: { start: number; file: number; line: number }[] = [];
    let clean = '';
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = artefactRegex.exec(raw)) !== null) {
        clean += raw.slice(last, m.index);
        last = m.index + m[0].length;
        if (m[1] !== undefined) {
            traced.push({ start: clean.lastIndexOf('<'), file: parseInt(m[1], 10), line: parseInt(m[2], 10) });
        }
    }
    clean += raw.slice(last);

    // Pass 2: join wrapped traced start tags onto one line, fixing up later offsets
    const parts: string[] = [];
    let copied = 0;
    let shift = 0;
    for (const t of traced) {
        const end = findTagEnd(clean, t.start);
        const tag = clean.slice(t.start, end);
        parts.push(clean.slice(copied, t.start));
        const joined = tag.includes('\n') ? tag.replace(/\s*\r?\n\s*/g, ' ') : tag;
        parts.push(joined);
        copied = end;
        t.start -= shift;
        shift += tag.length - joined.length;
    }
    parts.push(clean.slice(copied));
    clean = parts.join('');

    // Pass 3: line numbers and element names
    const traceEntries: TraceEntry[] = [];
    let line = 1;
    let pos = 0;
    for (const t of traced) {
        for (; pos < t.start; pos++) {
            if (clean.charCodeAt(pos) === 10) {
                line++;
            }
        }
        const nameMatch = clean.slice(t.start + 1, t.start + 200).match(/^[^\s/>]+/);
        traceEntries.push({
            outputLine: line,
            sourceFile: files[t.file] ?? '',
            sourceLine: t.line,
            elementName: nameMatch ? nameMatch[0] : '',
        });
    }

    return { cleanOutput: clean, traceEntries };
}

/** Offset just past the '>' that ends the start tag at `start`, respecting quoted values. */
function findTagEnd(s: string, start: number): number {
    let quote = '';
    for (let i = start + 1; i < s.length; i++) {
        const c = s[i];
        if (quote) {
            if (c === quote) {
                quote = '';
            }
        } else if (c === '"' || c === "'") {
            quote = c;
        } else if (c === '>') {
            return i + 1;
        }
    }
    return s.length;
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Runs the transform with instrumented stylesheets and returns the clean
 * output plus trace entries. Errors reference the original file paths.
 */
export async function runInstrumentedTransform(
    helper: JavaHelper,
    sourceXml: string,
    xsltPath: string,
    options?: RequestOptions
): Promise<{ cleanOutput: string; traceEntries: TraceEntry[]; messages: string; stylesheetFiles: string[] }> {
    const inst = instrumentStylesheets(xsltPath);
    try {
        const { output, messages } = await helper.transform(inst.mainPath, sourceXml, false, options);
        const parsed = parseTracedOutput(output, inst.files);
        return { ...parsed, messages: inst.mapMessage(messages), stylesheetFiles: inst.files };
    } catch (e: any) {
        if (e instanceof JavaToolError) {
            throw new JavaToolError(inst.mapMessage(e.message.split('\n')[0]), inst.mapMessage(e.details));
        }
        throw e;
    } finally {
        inst.cleanup();
    }
}
