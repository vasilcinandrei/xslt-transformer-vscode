import * as fs from 'fs';
import { RuleSource } from './types';

/** Hosts rule sets may be downloaded from (official publishers and their CDNs). */
export const DEFAULT_ALLOWED_HOSTS = [
    'api.github.com',
    'github.com',
    'codeload.github.com',
    'objects.githubusercontent.com',
    'release-assets.githubusercontent.com',
    'raw.githubusercontent.com',
    'docs.peppol.eu',
    'mfinante.gov.ro',
    'porezna.gov.hr',
];

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const TOOL_UA = 'ubl-validator-vscode';

export interface FetchOptions {
    allowedHosts: string[];
    browserUserAgent?: boolean;
    method?: 'GET' | 'HEAD';
    accept?: string;
    signal?: AbortSignal;
    /** Return the first redirect response instead of following it */
    noFollow?: boolean;
}

export class RuleSourceError extends Error {}

/**
 * fetch() that follows redirects manually so every hop can be checked
 * against the allowlist, and only https is used.
 */
export async function fetchChecked(url: string, opts: FetchOptions): Promise<Response> {
    let current = url;
    for (let hop = 0; hop < 8; hop++) {
        const u = new URL(current);
        if (u.protocol !== 'https:') {
            throw new RuleSourceError(`Refusing non-https URL: ${current}`);
        }
        if (!opts.allowedHosts.includes(u.hostname)) {
            throw new RuleSourceError(`Host not allowed for rule downloads: ${u.hostname} (setting: ublValidator.rules.allowedHosts)`);
        }
        const res = await fetch(current, {
            method: opts.method ?? 'GET',
            redirect: 'manual',
            signal: opts.signal ?? AbortSignal.timeout(120_000),
            headers: {
                'User-Agent': opts.browserUserAgent ? BROWSER_UA : TOOL_UA,
                ...(opts.accept ? { Accept: opts.accept } : {}),
            },
        });
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
            if (opts.noFollow) {
                return res;
            }
            current = new URL(res.headers.get('location')!, current).toString();
            continue;
        }
        if (!res.ok) {
            throw new RuleSourceError(`HTTP ${res.status} for ${current}`);
        }
        return res;
    }
    throw new RuleSourceError(`Too many redirects for ${url}`);
}

export interface ResolvedRelease {
    version: string;
    downloadUrl: string;
    browserUserAgent?: boolean;
}

/** Finds the newest published version of a rule source. */
export async function resolveLatest(source: RuleSource, allowedHosts: string[]): Promise<ResolvedRelease> {
    switch (source.type) {
        case 'github-release-asset':
        case 'github-release-archive': {
            // github.com pages first: the REST API allows only 60 anonymous requests per hour
            try {
                return await resolveGithubViaWeb(source, allowedHosts);
            } catch {
                return resolveGithubViaApi(source, allowedHosts);
            }
        }
        case 'url': {
            const res = await fetchChecked(source.url, { allowedHosts, method: 'HEAD' });
            const tag = res.headers.get('etag') ?? res.headers.get('last-modified');
            const lastModified = res.headers.get('last-modified');
            const version = lastModified
                ? new Date(lastModified).toISOString().slice(0, 10) + (tag && tag !== lastModified ? ` (${shortTag(tag)})` : '')
                : tag ? shortTag(tag) : 'unknown';
            return { version, downloadUrl: source.url };
        }
        case 'html-link': {
            const res = await fetchChecked(source.page, { allowedHosts, browserUserAgent: source.browserUserAgent });
            const html = await res.text();
            const found = findLinks(html, source.link);
            if (found.length === 0) {
                throw new RuleSourceError(`No download link found on ${source.page}`);
            }
            const chosen = source.pick === 'max-version'
                ? found.sort((a, b) => compareVersions(b.version ?? '', a.version ?? ''))[0]
                : found[0];
            return {
                version: chosen.version?.trim() || chosen.url,
                downloadUrl: new URL(chosen.url, source.page).toString(),
                browserUserAgent: source.browserUserAgent,
            };
        }
    }
}

type GithubSource = Extract<RuleSource, { type: 'github-release-asset' | 'github-release-archive' }>;

async function resolveGithubViaWeb(source: GithubSource, allowedHosts: string[]): Promise<ResolvedRelease> {
    const res = await fetchChecked(`https://github.com/${source.repo}/releases/latest`, { allowedHosts, method: 'HEAD', noFollow: true });
    const tag = res.headers.get('location')?.match(/\/releases\/tag\/([^/?#]+)$/)?.[1];
    if (!tag) {
        throw new RuleSourceError(`No release found for ${source.repo}`);
    }
    const version = decodeURIComponent(tag);
    if (source.type === 'github-release-archive') {
        return { version, downloadUrl: `https://codeload.github.com/${source.repo}/zip/refs/tags/${tag}` };
    }
    const page = await fetchChecked(`https://github.com/${source.repo}/releases/expanded_assets/${tag}`, { allowedHosts });
    const re = new RegExp(source.asset);
    const links = findLinks(await page.text(), 'href="(?<url>/[^"]+/releases/download/[^"]+)"');
    const asset = links.find(l => re.test(decodeURIComponent(l.url.split('/').pop() ?? '')));
    if (!asset) {
        throw new RuleSourceError(`No asset matching ${source.asset} in ${source.repo} ${version}`);
    }
    return { version, downloadUrl: new URL(asset.url, 'https://github.com').toString() };
}

async function resolveGithubViaApi(source: GithubSource, allowedHosts: string[]): Promise<ResolvedRelease> {
    const res = await fetchChecked(`https://api.github.com/repos/${source.repo}/releases/latest`, {
        allowedHosts, accept: 'application/vnd.github+json',
    });
    const release = await res.json() as { tag_name: string; zipball_url: string; assets: { name: string; browser_download_url: string }[] };
    if (source.type === 'github-release-archive') {
        return { version: release.tag_name, downloadUrl: release.zipball_url };
    }
    const re = new RegExp(source.asset);
    const asset = release.assets.find(a => re.test(a.name));
    if (!asset) {
        throw new RuleSourceError(`No asset matching ${source.asset} in ${source.repo} ${release.tag_name}`);
    }
    return { version: release.tag_name, downloadUrl: asset.browser_download_url };
}

function shortTag(tag: string): string {
    return tag.replace(/^W\//, '').replace(/"/g, '').slice(0, 16);
}

export function findLinks(html: string, pattern: string): { url: string; version?: string }[] {
    const re = new RegExp(pattern, 'g');
    const out: { url: string; version?: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
        if (m.groups?.url) {
            out.push({ url: m.groups.url.replace(/&amp;/g, '&'), version: m.groups.version });
        }
        if (m[0].length === 0) {
            re.lastIndex++;
        }
    }
    return out;
}

/** Compares dotted versions numerically ("1.0.10" > "1.0.9"). */
export function compareVersions(a: string, b: string): number {
    const pa = a.split(/[^0-9]+/).filter(Boolean).map(Number);
    const pb = b.split(/[^0-9]+/).filter(Boolean).map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0) {
            return d;
        }
    }
    return 0;
}

/** Downloads to a file, enforcing the allowlist on every redirect. */
export async function downloadTo(url: string, dest: string, allowedHosts: string[], browserUserAgent?: boolean): Promise<void> {
    const res = await fetchChecked(url, { allowedHosts, browserUserAgent });
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > 200 * 1024 * 1024) {
        throw new RuleSourceError(`Download too large: ${url}`);
    }
    fs.writeFileSync(dest, data);
}
