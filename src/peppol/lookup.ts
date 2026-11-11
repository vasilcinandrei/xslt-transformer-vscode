import * as crypto from 'crypto';
import { promises as dns } from 'dns';

export type PeppolNetwork = 'production' | 'test';

/** Peppol SML DNS zones (operated by OpenPeppol since the move from the EC infrastructure) */
export const SML_ZONES: Record<PeppolNetwork, string> = {
    production: 'participant.sml.prod.tech.peppol.org',
    test: 'participant.sml.test.tech.peppol.org',
};

export const DIRECTORY_URLS: Record<PeppolNetwork, string> = {
    production: 'https://directory.peppol.eu',
    test: 'https://test-directory.peppol.eu',
};

const PARTICIPANT_SCHEME = 'iso6523-actorid-upis';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

function base32(buf: Buffer): string {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
    let bits = 0;
    let value = 0;
    let out = '';
    for (const byte of buf) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += alphabet[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) {
        out += alphabet[(value << (5 - bits)) & 31];
    }
    return out;
}

/**
 * DNS name of a participant in the SML (Peppol BDXL/U-NAPTR):
 * base32(sha256(lowercase(value))) without padding + "." + scheme + "." + zone
 */
export function smlHostname(participantId: string, network: PeppolNetwork): string {
    const hash = base32(crypto.createHash('sha256').update(participantId.toLowerCase(), 'utf8').digest());
    return `${hash}.${PARTICIPANT_SCHEME}.${SML_ZONES[network]}`;
}

/** Applies a U-NAPTR regexp like "!.*!https://smp.example.com!" (only the "match anything" form is used in Peppol). */
export function parseNaptrRegexp(regexp: string): string | undefined {
    if (regexp.length < 3) {
        return undefined;
    }
    const delim = regexp[0];
    const parts = regexp.split(delim);
    // ["", pattern, replacement, flags]
    if (parts.length < 3 || !/^https?:\/\//i.test(parts[2])) {
        return undefined;
    }
    return parts[2].replace(/\/+$/, '');
}

/** SMP base URL of a participant, or undefined when it isn't registered on that network. */
export async function lookupSmpUrl(participantId: string, network: PeppolNetwork): Promise<string | undefined> {
    let records: { service: string; regexp: string; flags: string }[];
    try {
        records = await dns.resolveNaptr(smlHostname(participantId, network));
    } catch (e: any) {
        if (e.code === 'ENOTFOUND' || e.code === 'ENODATA') {
            return undefined;
        }
        throw new Error(`DNS lookup failed (${e.code ?? e.message})`);
    }
    for (const r of records) {
        if (r.service.toLowerCase() === 'meta:smp') {
            const url = parseNaptrRegexp(r.regexp);
            if (url) {
                return url;
            }
        }
    }
    return undefined;
}

async function fetchText(url: string): Promise<string> {
    if (!/^https?:\/\//i.test(url)) {
        throw new Error(`Unsupported URL: ${url}`);
    }
    const res = await fetch(url, {
        headers: { Accept: 'application/xml, text/xml, application/json', 'User-Agent': 'ubl-validator-vscode' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) {
        throw Object.assign(new Error('not found'), { status: 404 });
    }
    if (!res.ok) {
        throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_RESPONSE_BYTES) {
        throw new Error(`Response from ${new URL(url).host} is too large`);
    }
    return buf.toString('utf8');
}

function safeDecode(s: string): string {
    try {
        return decodeURIComponent(s);
    } catch {
        return s;
    }
}

function decodeXml(s: string): string {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/** Document type identifiers ("scheme::value") listed in an SMP ServiceGroup. */
export function parseServiceGroup(xml: string): string[] {
    const ids: string[] = [];
    const re = /<(?:[\w.-]+:)?ServiceMetadataReference\b[^>]*\bhref\s*=\s*["']([^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
        const href = safeDecode(decodeXml(m[1]));
        const i = href.indexOf('/services/');
        if (i >= 0) {
            ids.push(href.slice(i + '/services/'.length));
        }
    }
    return ids;
}

export interface CertificateInfo {
    subject: string;
    issuer: string;
    validTo: string;
    expired: boolean;
    /** Issued by a Peppol test CA */
    testCertificate: boolean;
}

export interface EndpointInfo {
    transportProfile: string;
    url?: string;
    activation?: string;
    expiration?: string;
    certificate?: CertificateInfo;
}

export interface ProcessInfo {
    processId: string;
    endpoints: EndpointInfo[];
}

function localText(xml: string, name: string): string | undefined {
    const m = xml.match(new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*>([^<]*)<`));
    return m ? decodeXml(m[1]).trim() : undefined;
}

export function describeCertificate(base64: string): CertificateInfo | undefined {
    try {
        const cert = new crypto.X509Certificate(Buffer.from(base64.replace(/\s+/g, ''), 'base64'));
        const cn = (dn: string) => dn.match(/CN=([^\n,]+)/)?.[1]?.trim() ?? dn.replace(/\n/g, ', ');
        const issuer = cn(cert.issuer);
        return {
            subject: cn(cert.subject),
            issuer,
            validTo: new Date(cert.validTo).toISOString().slice(0, 10),
            expired: Date.parse(cert.validTo) < Date.now(),
            testCertificate: /test/i.test(issuer),
        };
    } catch {
        return undefined;
    }
}

/** Processes and endpoints from an SMP SignedServiceMetadata (Peppol SMP or OASIS BDXR SMP 1). */
export function parseServiceMetadata(xml: string): { processes: ProcessInfo[]; redirect?: string } {
    const redirect = xml.match(/<(?:[\w.-]+:)?Redirect\b[^>]*\bhref\s*=\s*["']([^"']+)["']/)?.[1];
    const processes: ProcessInfo[] = [];
    const processRe = /<(?:[\w.-]+:)?Process\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?Process>/g;
    let p: RegExpExecArray | null;
    while ((p = processRe.exec(xml)) !== null) {
        const body = p[1];
        const pid = body.match(/<(?:[\w.-]+:)?ProcessIdentifier\b([^>]*)>([^<]*)</);
        const scheme = pid?.[1].match(/scheme\s*=\s*["']([^"']*)["']/)?.[1];
        const endpoints: EndpointInfo[] = [];
        const endpointRe = /<(?:[\w.-]+:)?Endpoint\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?Endpoint>/g;
        let e: RegExpExecArray | null;
        while ((e = endpointRe.exec(body)) !== null) {
            const cert = localText(e[2], 'Certificate');
            endpoints.push({
                transportProfile: e[1].match(/transportProfile\s*=\s*["']([^"']*)["']/)?.[1] ?? '',
                url: localText(e[2], 'EndpointURI') ?? localText(e[2], 'Address'),
                activation: localText(e[2], 'ServiceActivationDate'),
                expiration: localText(e[2], 'ServiceExpirationDate'),
                certificate: cert ? describeCertificate(cert) : undefined,
            });
        }
        if (pid) {
            processes.push({ processId: `${scheme ? scheme + '::' : ''}${decodeXml(pid[2]).trim()}`, endpoints });
        }
    }
    return { processes, redirect: redirect ? decodeXml(redirect) : undefined };
}

/**
 * True if an SMP document type matches the document's: exact match, or a
 * peppol-doctype-wildcard entry (used by Peppol PINT) whose value ends in "*".
 */
export function documentTypeMatches(registered: string, wanted: string): boolean {
    if (registered === wanted) {
        return true;
    }
    const sep = registered.indexOf('::');
    const scheme = registered.slice(0, sep);
    const value = registered.slice(sep + 2);
    const wantedValue = wanted.slice(wanted.indexOf('::') + 2);
    if (scheme === 'peppol-doctype-wildcard') {
        return value.endsWith('*') ? wantedValue.startsWith(value.slice(0, -1)) : wantedValue === value;
    }
    return false;
}

export interface DirectoryEntry {
    name?: string;
    country?: string;
}

export async function lookupDirectory(participantId: string, network: PeppolNetwork): Promise<DirectoryEntry | undefined> {
    const url = `${DIRECTORY_URLS[network]}/search/1.0/json?participant=${encodeURIComponent(`${PARTICIPANT_SCHEME}::${participantId}`)}`;
    const data = JSON.parse(await fetchText(url));
    const entity = data?.matches?.[0]?.entities?.[0];
    if (!entity) {
        return undefined;
    }
    return { name: entity.name?.[0]?.name, country: entity.countryCode };
}

export interface ParticipantLookup {
    network: PeppolNetwork;
    participantId: string;
    registered: boolean;
    smpUrl?: string;
    documentTypes: string[];
    /** Whether the participant accepts the document's type (undefined when unknown) */
    acceptsDocument?: boolean;
    matchedDocumentType?: string;
    /** Whether the matched document type lists the document's process */
    acceptsProcess?: boolean;
    processes?: ProcessInfo[];
    directory?: DirectoryEntry;
    error?: string;
}

/**
 * Looks a participant up on one network: SML registration, SMP service group,
 * the service metadata for the document type (when given) and the Directory.
 */
export async function lookupParticipant(
    participantId: string,
    network: PeppolNetwork,
    documentTypeId?: string,
    processId?: string
): Promise<ParticipantLookup> {
    const result: ParticipantLookup = { network, participantId, registered: false, documentTypes: [] };
    try {
        result.smpUrl = await lookupSmpUrl(participantId, network);
    } catch (e: any) {
        result.error = e.message;
        return result;
    }
    if (!result.smpUrl) {
        return result;
    }
    result.registered = true;

    const encodedParticipant = encodeURIComponent(`${PARTICIPANT_SCHEME}::${participantId}`);
    const [group, directory] = await Promise.allSettled([
        fetchText(`${result.smpUrl}/${encodedParticipant}`),
        lookupDirectory(participantId, network),
    ]);
    if (directory.status === 'fulfilled') {
        result.directory = directory.value;
    }
    if (group.status === 'rejected') {
        result.error = `SMP ${new URL(result.smpUrl).host}: ${(group.reason as Error).message}`;
        return result;
    }
    result.documentTypes = parseServiceGroup(group.value);

    if (documentTypeId) {
        result.matchedDocumentType = result.documentTypes.find(d => documentTypeMatches(d, documentTypeId));
        result.acceptsDocument = !!result.matchedDocumentType;
        if (result.matchedDocumentType) {
            try {
                let url = `${result.smpUrl}/${encodedParticipant}/services/${encodeURIComponent(result.matchedDocumentType)}`;
                let meta = parseServiceMetadata(await fetchText(url));
                if (meta.redirect && meta.processes.length === 0) {
                    url = meta.redirect;
                    meta = parseServiceMetadata(await fetchText(url));
                }
                result.processes = meta.processes;
                if (processId) {
                    result.acceptsProcess = meta.processes.some(p => p.processId === processId);
                }
            } catch (e: any) {
                result.error = `Service details: ${e.message}`;
            }
        }
    }
    return result;
}

const cache = new Map<string, { at: number; value: Promise<ParticipantLookup> }>();
const CACHE_MS = 10 * 60 * 1000;

/** lookupParticipant with a 10-minute cache; `force` bypasses it. */
export function lookupParticipantCached(
    participantId: string,
    network: PeppolNetwork,
    documentTypeId?: string,
    processId?: string,
    force = false
): Promise<ParticipantLookup> {
    const key = [network, participantId.toLowerCase(), documentTypeId ?? '', processId ?? ''].join('|');
    const hit = cache.get(key);
    if (!force && hit && Date.now() - hit.at < CACHE_MS) {
        return hit.value;
    }
    const value = lookupParticipant(participantId, network, documentTypeId, processId);
    cache.set(key, { at: Date.now(), value });
    value.catch(() => cache.delete(key));
    return value;
}
