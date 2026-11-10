/**
 * Minimal XML tag scanner. It is not a validating parser — it only finds
 * start/end tags with their offsets, attributes and namespace scope, skipping
 * comments, CDATA, processing instructions and DOCTYPE declarations. That is
 * enough to instrument stylesheets without touching anything else in the file.
 */

export interface XmlAttribute {
    name: string;
    value: string;
    /** Offset of the first character of the value (inside the quotes) */
    valueStart: number;
    valueEnd: number;
}

export interface XmlStartTag {
    name: string;
    /** Namespace URI resolved from the in-scope declarations ('' for none) */
    namespace: string;
    localName: string;
    attributes: XmlAttribute[];
    /** Offset of '<' */
    start: number;
    /** Offset of the '>' or '/>' that closes the tag */
    closeOffset: number;
    selfClosing: boolean;
    /** 1-based line of '<' */
    line: number;
    /** Start tags of the ancestors, outermost first */
    ancestors: XmlStartTag[];
}

export function scanStartTags(content: string): XmlStartTag[] {
    const result: XmlStartTag[] = [];
    const stack: { tag: XmlStartTag; scope: Map<string, string> }[] = [];
    const rootScope = new Map<string, string>([['xml', 'http://www.w3.org/XML/1998/namespace']]);

    let i = 0;
    let line = 1;
    let lineCountedTo = 0;
    const lineAt = (offset: number): number => {
        for (let k = lineCountedTo; k < offset; k++) {
            if (content.charCodeAt(k) === 10) {
                line++;
            }
        }
        lineCountedTo = offset;
        return line;
    };

    const skipPast = (marker: string, from: number): number => {
        const idx = content.indexOf(marker, from);
        return idx < 0 ? content.length : idx + marker.length;
    };

    while (i < content.length) {
        const lt = content.indexOf('<', i);
        if (lt < 0) {
            break;
        }
        if (content.startsWith('<!--', lt)) {
            i = skipPast('-->', lt + 4);
            continue;
        }
        if (content.startsWith('<![CDATA[', lt)) {
            i = skipPast(']]>', lt + 9);
            continue;
        }
        if (content.startsWith('<?', lt)) {
            i = skipPast('?>', lt + 2);
            continue;
        }
        if (content.startsWith('<!', lt)) {
            // DOCTYPE, possibly with an internal subset in [...]
            let depth = 0;
            let k = lt + 2;
            for (; k < content.length; k++) {
                const c = content[k];
                if (c === '[') {
                    depth++;
                } else if (c === ']') {
                    depth--;
                } else if (c === '>' && depth <= 0) {
                    break;
                }
            }
            i = k + 1;
            continue;
        }
        if (content[lt + 1] === '/') {
            i = skipPast('>', lt + 2);
            stack.pop();
            continue;
        }

        // Start tag
        let k = lt + 1;
        const nameStart = k;
        while (k < content.length && !/[\s/>]/.test(content[k])) {
            k++;
        }
        const name = content.slice(nameStart, k);
        const attributes: XmlAttribute[] = [];
        let selfClosing = false;
        let closeOffset = content.length;

        while (k < content.length) {
            while (k < content.length && /\s/.test(content[k])) {
                k++;
            }
            if (content[k] === '>') {
                closeOffset = k;
                break;
            }
            if (content[k] === '/' && content[k + 1] === '>') {
                selfClosing = true;
                closeOffset = k;
                break;
            }
            const attrStart = k;
            while (k < content.length && !/[\s=/>]/.test(content[k])) {
                k++;
            }
            const attrName = content.slice(attrStart, k);
            while (k < content.length && /\s/.test(content[k])) {
                k++;
            }
            if (content[k] !== '=') {
                // Malformed; avoid looping forever
                if (k === attrStart) {
                    k++;
                }
                continue;
            }
            k++;
            while (k < content.length && /\s/.test(content[k])) {
                k++;
            }
            const quote = content[k];
            if (quote !== '"' && quote !== "'") {
                continue;
            }
            const valueStart = k + 1;
            const valueEnd = content.indexOf(quote, valueStart);
            const end = valueEnd < 0 ? content.length : valueEnd;
            attributes.push({ name: attrName, value: decodeEntities(content.slice(valueStart, end)), valueStart, valueEnd: end });
            k = end + 1;
        }

        const parentScope = stack.length > 0 ? stack[stack.length - 1].scope : rootScope;
        let scope = parentScope;
        for (const a of attributes) {
            if (a.name === 'xmlns' || a.name.startsWith('xmlns:')) {
                if (scope === parentScope) {
                    scope = new Map(parentScope);
                }
                scope.set(a.name === 'xmlns' ? '' : a.name.slice(6), a.value);
            }
        }

        const colon = name.indexOf(':');
        const prefix = colon >= 0 ? name.slice(0, colon) : '';
        const tag: XmlStartTag = {
            name,
            namespace: scope.get(prefix) ?? '',
            localName: colon >= 0 ? name.slice(colon + 1) : name,
            attributes,
            start: lt,
            closeOffset,
            selfClosing,
            line: lineAt(lt),
            ancestors: stack.map(s => s.tag),
        };
        result.push(tag);
        if (!selfClosing) {
            stack.push({ tag, scope });
        }
        i = selfClosing ? closeOffset + 2 : closeOffset + 1;
    }

    return result;
}

export function getAttribute(tag: XmlStartTag, name: string): XmlAttribute | undefined {
    return tag.attributes.find(a => a.name === name);
}

function decodeEntities(s: string): string {
    return s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

export function escapeAttribute(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
