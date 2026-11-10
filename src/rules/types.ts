/** One condition on a text value; all given properties must hold. */
export interface StringMatch {
    equals?: string;
    startsWith?: string;
    contains?: string;
    regex?: string;
}

/** All given conditions must hold (AND). A pack matches if any of its rules match (OR). */
export interface MatchRule {
    customizationId?: StringMatch;
    profileId?: StringMatch;
    /** ISO 3166-1 alpha-2 codes */
    sellerCountry?: string[];
    buyerCountry?: string[];
}

export type RuleSource =
    /** Asset of the latest GitHub release, chosen by file-name regex */
    | { type: 'github-release-asset'; repo: string; asset: string }
    /** Source archive (zipball) of the latest GitHub release */
    | { type: 'github-release-archive'; repo: string }
    /** Fixed URL; the version comes from ETag / Last-Modified */
    | { type: 'url'; url: string }
    /** Link scraped from an HTML page; regex with named groups `url` and optional `version` */
    | { type: 'html-link'; page: string; link: string; pick?: 'max-version' | 'first'; browserUserAgent?: boolean };

export interface RuleEntry {
    /** Path inside the download; `*` matches one path segment */
    path: string;
    format: 'xslt' | 'sch';
}

export interface RulePack {
    id: string;
    label: string;
    country?: string;
    description?: string;
    /** Applies to everything that starts with this spec (e.g. EN16931 base) — used for "no specific rules" notes */
    generic?: boolean;
    /** UBL root element names, or '*' */
    documentTypes: string[];
    match: MatchRule[];
    /** Packs that must run too (unless another selected pack replaces them) */
    requires?: string[];
    /** Packs made redundant by this one (e.g. it bundles its own CEN rules) */
    replaces?: string[];
    source: RuleSource;
    /** Rule files per document type ('*' = any) */
    entries: Record<string, RuleEntry[]>;
    /** Offline fallback: paths relative to the bundled validation-artifacts folder */
    bundled?: Record<string, string[]>;
    license?: string;
    homepage?: string;
}

export interface RuleCatalog {
    version: 1;
    updated?: string;
    packs: RulePack[];
}

/** Values read from the document that drive rule selection. */
export interface DocumentFacts {
    rootElement: string;
    customizationId?: string;
    profileId?: string;
    sellerCountry?: string;
    buyerCountry?: string;
}
