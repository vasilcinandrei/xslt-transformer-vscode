import { DocumentFacts, MatchRule, RuleCatalog, RulePack, StringMatch } from './types';

function stringMatches(value: string | undefined, m: StringMatch): boolean {
    if (value === undefined) {
        return false;
    }
    if (m.equals !== undefined && value !== m.equals) {
        return false;
    }
    if (m.startsWith !== undefined && !value.startsWith(m.startsWith)) {
        return false;
    }
    if (m.contains !== undefined && !value.includes(m.contains)) {
        return false;
    }
    if (m.regex !== undefined) {
        try {
            if (!new RegExp(m.regex).test(value.slice(0, 1000))) {
                return false;
            }
        } catch {
            return false;
        }
    }
    return true;
}

export function ruleMatches(rule: MatchRule, facts: DocumentFacts): boolean {
    if (rule.customizationId && !stringMatches(facts.customizationId, rule.customizationId)) {
        return false;
    }
    if (rule.profileId && !stringMatches(facts.profileId, rule.profileId)) {
        return false;
    }
    if (rule.sellerCountry && !(facts.sellerCountry && rule.sellerCountry.includes(facts.sellerCountry))) {
        return false;
    }
    if (rule.buyerCountry && !(facts.buyerCountry && rule.buyerCountry.includes(facts.buyerCountry))) {
        return false;
    }
    return Object.keys(rule).length > 0;
}

export function appliesToDocument(pack: RulePack, rootElement: string): boolean {
    return pack.documentTypes.includes('*') || pack.documentTypes.includes(rootElement);
}

export interface Selection {
    packs: RulePack[];
    /** Why each pack was chosen */
    reasons: Map<string, string>;
    notes: string[];
}

/**
 * Picks the rule packs for a document from its CustomizationID, ProfileID and
 * seller/buyer country, then applies `requires` and `replaces`. Packs that
 * others depend on come first.
 */
export function selectPacks(catalog: RuleCatalog, facts: DocumentFacts, disabled: Set<string> = new Set()): Selection {
    const byId = new Map(catalog.packs.map(p => [p.id, p]));
    const reasons = new Map<string, string>();
    const notes: string[] = [];
    const usable = (p: RulePack | undefined): p is RulePack =>
        !!p && !disabled.has(p.id) && appliesToDocument(p, facts.rootElement);

    const direct = catalog.packs.filter(p => usable(p) && p.match.some(r => ruleMatches(r, facts)));
    for (const p of direct) {
        reasons.set(p.id, describeMatch(p, facts));
    }

    // Documents without a recognised CustomizationID still get the generic base rules
    if (direct.length === 0 && (facts.rootElement === 'Invoice' || facts.rootElement === 'CreditNote')) {
        const base = catalog.packs.find(p => p.generic && usable(p));
        if (base) {
            direct.push(base);
            reasons.set(base.id, 'fallback for invoices');
            notes.push(facts.customizationId
                ? `No rules are known for CustomizationID "${facts.customizationId}"; checked against ${base.label} only.`
                : `The document has no cbc:CustomizationID; checked against ${base.label} only.`);
        }
    } else if (direct.length > 0 && direct.every(p => p.generic) && facts.customizationId && facts.customizationId.includes('#')) {
        notes.push(`No country-specific rules are known for CustomizationID "${facts.customizationId}"; checked against ${direct.map(p => p.label).join(', ')} only.`);
    }

    // Add required packs (transitively)
    const selected = new Map<string, RulePack>();
    const visit = (p: RulePack, via?: RulePack) => {
        if (selected.has(p.id)) {
            return;
        }
        for (const req of p.requires ?? []) {
            const r = byId.get(req);
            if (usable(r)) {
                visit(r, p);
            }
        }
        selected.set(p.id, p);
        if (via && !reasons.has(p.id)) {
            reasons.set(p.id, `required by ${via.label}`);
        }
    };
    for (const p of direct) {
        visit(p);
    }

    // Drop packs that a selected pack replaces (it ships its own copy of those rules)
    const replaced = new Set<string>();
    for (const p of selected.values()) {
        for (const r of p.replaces ?? []) {
            if (r !== p.id) {
                replaced.add(r);
            }
        }
    }
    const packs = [...selected.values()].filter(p => !replaced.has(p.id));
    return { packs, reasons, notes };
}

function describeMatch(pack: RulePack, facts: DocumentFacts): string {
    const rule = pack.match.find(r => ruleMatches(r, facts))!;
    const parts: string[] = [];
    if (rule.customizationId) {
        parts.push('CustomizationID');
    }
    if (rule.profileId) {
        parts.push(`ProfileID ${facts.profileId}`);
    }
    if (rule.sellerCountry) {
        parts.push(`seller in ${facts.sellerCountry}`);
    }
    if (rule.buyerCountry) {
        parts.push(`buyer in ${facts.buyerCountry}`);
    }
    return `matched ${parts.join(' + ')}`;
}

/** Validates a catalog loaded from JSON; throws with a readable message. */
export function validateCatalog(obj: any): RuleCatalog {
    if (!obj || obj.version !== 1 || !Array.isArray(obj.packs)) {
        throw new Error('not a version 1 rules catalog');
    }
    const ids = new Set<string>();
    for (const p of obj.packs) {
        if (!p || typeof p.id !== 'string' || !/^[a-z0-9-]+$/.test(p.id)) {
            throw new Error(`invalid pack id: ${JSON.stringify(p?.id)}`);
        }
        if (ids.has(p.id)) {
            throw new Error(`duplicate pack id: ${p.id}`);
        }
        ids.add(p.id);
        if (typeof p.label !== 'string' || !Array.isArray(p.documentTypes) || !Array.isArray(p.match)
            || !p.source || typeof p.source.type !== 'string' || !p.entries || typeof p.entries !== 'object') {
            throw new Error(`pack ${p.id} is incomplete`);
        }
        for (const list of Object.values(p.bundled ?? {}) as any[]) {
            if (!Array.isArray(list) || list.some((f: any) => typeof f !== 'string' || !isSafeRelativePath(f))) {
                throw new Error(`pack ${p.id} has an invalid bundled path`);
            }
        }
        for (const list of Object.values(p.entries) as any[]) {
            for (const e of list) {
                if (typeof e.path !== 'string' || !isSafeRelativePath(e.path) || (e.format !== 'xslt' && e.format !== 'sch')) {
                    throw new Error(`pack ${p.id} has an invalid entry`);
                }
            }
        }
    }
    return obj as RuleCatalog;
}

function isSafeRelativePath(p: string): boolean {
    return p.length > 0 && !p.startsWith('/') && !/^[A-Za-z]:/.test(p) && !p.includes('\\') && !p.split('/').includes('..');
}

/**
 * Rejects regexes prone to catastrophic backtracking (nested quantifiers,
 * back-references) — remote catalog patterns run inside the extension host.
 */
export function isSafeRegex(pattern: string): boolean {
    if (pattern.length > 500 || /\\[1-9]|\\k</.test(pattern)) {
        return false;
    }
    // A quantified group that itself contains a quantifier, e.g. (a+)+ or (\w*x)*
    if (/\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/.test(pattern)) {
        return false;
    }
    try {
        new RegExp(pattern);
        return true;
    } catch {
        return false;
    }
}

const GITHUB_HOSTS = new Set(['github.com', 'api.github.com', 'codeload.github.com', 'raw.githubusercontent.com',
    'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);

function repoOf(source: RulePack['source']): string | undefined {
    return 'repo' in source ? source.repo.toLowerCase() : undefined;
}

/**
 * Filters a remote catalog down to packs that only use trusted sources:
 * GitHub repos already used by the bundled catalog (or allowed in settings),
 * non-GitHub hosts from the allowlist, and safe regexes. Returns the kept
 * catalog and a description of anything dropped.
 */
export function trustRemoteCatalog(
    remote: RuleCatalog,
    bundled: RuleCatalog,
    allowedHosts: string[],
    extraRepos: string[] = []
): { catalog: RuleCatalog; rejected: string[] } {
    const trustedRepos = new Set([
        ...bundled.packs.map(p => repoOf(p.source)).filter((r): r is string => !!r),
        ...extraRepos.map(r => r.toLowerCase()),
    ]);
    const hosts = new Set(allowedHosts);
    const rejected: string[] = [];

    const sourceTrusted = (s: RulePack['source']): boolean => {
        if (s.type === 'github-release-asset' || s.type === 'github-release-archive') {
            return trustedRepos.has(s.repo.toLowerCase()) && (s.type !== 'github-release-asset' || isSafeRegex(s.asset));
        }
        const url = new URL(s.type === 'url' ? s.url : s.page);
        if (url.protocol !== 'https:' || !hosts.has(url.hostname)) {
            return false;
        }
        if (GITHUB_HOSTS.has(url.hostname)) {
            // Only paths inside a trusted repo, e.g. raw.githubusercontent.com/<owner>/<repo>/...
            const [owner, repo] = url.pathname.split('/').filter(Boolean);
            if (!owner || !repo || !trustedRepos.has(`${owner}/${repo}`.toLowerCase())) {
                return false;
            }
        }
        return s.type !== 'html-link' || isSafeRegex(s.link);
    };

    const packs = remote.packs.filter(p => {
        const regexes = p.match.flatMap(m => [m.customizationId?.regex, m.profileId?.regex]).filter((r): r is string => !!r);
        let ok = false;
        try {
            ok = sourceTrusted(p.source) && regexes.every(isSafeRegex);
        } catch {
            ok = false;
        }
        if (!ok) {
            rejected.push(p.id);
        }
        return ok;
    });
    return { catalog: { ...remote, packs }, rejected };
}

/** Bundled catalog first, overridden/extended by a newer remote one (by pack id). */
export function mergeCatalogs(bundled: RuleCatalog, remote?: RuleCatalog): RuleCatalog {
    if (!remote) {
        return bundled;
    }
    const merged = new Map(bundled.packs.map(p => [p.id, p]));
    for (const p of remote.packs) {
        merged.set(p.id, { ...p, bundled: p.bundled ?? merged.get(p.id)?.bundled });
    }
    return { version: 1, updated: remote.updated ?? bundled.updated, packs: [...merged.values()] };
}
