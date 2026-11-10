import * as fs from 'fs';
import * as path from 'path';
import { DocumentFacts, RuleCatalog, RuleEntry, RulePack } from './types';
import { extractFacts } from './facts';
import { mergeCatalogs, selectPacks, trustRemoteCatalog, validateCatalog } from './selector';
import { DEFAULT_ALLOWED_HOSTS, downloadTo, fetchChecked, resolveLatest } from './sources';
import { JavaHelper } from '../utils/javaRunner';
import { UblDocumentInfo } from '../validation/types';

export interface RuleSettings {
    /** 'latest': download current rules; 'bundled': only the rules shipped with the extension */
    source: 'latest' | 'bundled';
    /** Pack ids never to run */
    disabled: string[];
    /** Check installed packs for new versions once a day */
    autoUpdate: boolean;
    /** Remote catalog that can add/override packs without an extension update ('' = off) */
    catalogUrl: string;
    /** Extra hosts allowed for downloads */
    allowedHosts: string[];
    /** Extra GitHub repos (owner/name) the remote catalog may use */
    allowedRepos?: string[];
    timeoutMs: number;
}

export interface PlannedCheck {
    id: string;
    label: string;
    version?: string;
    reason?: string;
    xsltPaths: string[];
    /** Folders the rule stylesheets may read from (sandbox) */
    sandboxRoots: string[];
}

export interface RulePlan {
    facts: DocumentFacts;
    checks: PlannedCheck[];
    notes: string[];
    errors: string[];
}

export interface RuleResolver {
    plan(content: string, docInfo: UblDocumentInfo, onProgress?: (message: string) => void): Promise<RulePlan>;
}

interface InstalledPack {
    version: string;
    dir: string;
    installedAt: string;
    checkedAt: string;
    /** entry path (as in the catalog) → absolute XSLT path */
    files: Record<string, string>;
}

interface StoreState {
    packs: Record<string, InstalledPack>;
    catalogCheckedAt?: string;
}

export interface UpdateResult {
    id: string;
    label: string;
    from?: string;
    to?: string;
    error?: string;
}

export interface RuleStoreOptions {
    /** Writable folder for downloaded rules ('' = no downloads possible) */
    storageDir: string;
    extensionPath: string;
    helper: JavaHelper;
    getSettings: () => RuleSettings;
    /** Bundled artifacts folder used for offline fallbacks */
    bundledArtifactsPath: string;
    log?: (message: string) => void;
    onUpdated?: (results: UpdateResult[]) => void;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Downloads, caches and selects business-rule packs. Rule sets are fetched
 * from their official publishers on first use, compiled from Schematron when
 * needed, and refreshed in the background once a day.
 */
export class RuleStore implements RuleResolver {
    private state: StoreState = { packs: {} };
    private readonly bundledCatalog: RuleCatalog;
    private remoteCatalog: RuleCatalog | undefined;
    private readonly inflight = new Map<string, Promise<InstalledPack>>();
    private catalogRefresh: Promise<void> | undefined;

    constructor(private readonly opts: RuleStoreOptions) {
        this.bundledCatalog = validateCatalog(JSON.parse(
            fs.readFileSync(path.join(opts.extensionPath, 'rules', 'catalog.json'), 'utf8')
        ));
        if (opts.storageDir) {
            this.state = readJson<StoreState>(this.statePath()) ?? { packs: {} };
            const remote = readJson<unknown>(path.join(opts.storageDir, 'catalog.remote.json'));
            if (remote) {
                try {
                    this.remoteCatalog = this.trust(validateCatalog(remote));
                } catch {
                    // ignore a corrupt cached catalog
                }
            }
        }
    }

    /** Drops remote packs that point at untrusted sources or use unsafe regexes. */
    private trust(remote: RuleCatalog): RuleCatalog {
        const { catalog, rejected } = trustRemoteCatalog(remote, this.bundledCatalog, this.allowedHosts(), this.settings().allowedRepos);
        if (rejected.length > 0) {
            this.opts.log?.(`Ignored remote rule packs with untrusted sources: ${rejected.join(', ')} (settings: ublValidator.rules.allowedRepos / allowedHosts)`);
        }
        return catalog;
    }

    get catalog(): RuleCatalog {
        return mergeCatalogs(this.bundledCatalog, this.remoteCatalog);
    }

    installed(id: string): InstalledPack | undefined {
        return this.state.packs[id];
    }

    private settings(): RuleSettings {
        return this.opts.getSettings();
    }

    private allowedHosts(): string[] {
        return [...DEFAULT_ALLOWED_HOSTS, ...this.settings().allowedHosts];
    }

    private canDownload(): boolean {
        return !!this.opts.storageDir && this.settings().source === 'latest';
    }

    // ─── Selection ─────────────────────────────────────────────────────

    async plan(content: string, docInfo: UblDocumentInfo, onProgress?: (message: string) => void): Promise<RulePlan> {
        const facts = extractFacts(content, docInfo.rootElement);
        if (this.canDownload()) {
            this.refreshCatalogIfStale();
        }
        const selection = selectPacks(this.catalog, facts, new Set(this.settings().disabled));
        const plan: RulePlan = { facts, checks: [], notes: [...selection.notes], errors: [] };

        for (const pack of selection.packs) {
            const entries = pack.entries[facts.rootElement] ?? pack.entries['*'];
            if (!entries || entries.length === 0) {
                continue;
            }
            const reason = selection.reasons.get(pack.id);
            try {
                plan.checks.push(await this.resolvePack(pack, entries, facts.rootElement, reason, plan, onProgress));
            } catch (e: any) {
                plan.errors.push(`${pack.label} rules unavailable: ${e.message}`);
            }
        }
        return plan;
    }

    private async resolvePack(
        pack: RulePack,
        entries: RuleEntry[],
        docType: string,
        reason: string | undefined,
        plan: RulePlan,
        onProgress?: (message: string) => void
    ): Promise<PlannedCheck> {
        if (this.canDownload()) {
            let installed = this.usableInstall(pack, entries);
            try {
                if (!installed) {
                    onProgress?.(`Downloading ${pack.label} rules...`);
                    installed = await this.install(pack);
                } else if (this.settings().autoUpdate && isStale(installed.checkedAt)) {
                    this.updateInBackground([pack]);
                }
                return {
                    id: pack.id, label: pack.label, version: installed.version, reason,
                    xsltPaths: entries.map(e => installed!.files[e.path]),
                    sandboxRoots: [installed.dir],
                };
            } catch (e: any) {
                const fallback = this.bundledCheck(pack, docType, reason);
                if (fallback) {
                    plan.notes.push(`${pack.label}: could not get the latest rules (${e.message}); using the bundled version.`);
                    return fallback;
                }
                throw e;
            }
        }
        const fallback = this.bundledCheck(pack, docType, reason);
        if (!fallback) {
            throw new Error(this.opts.storageDir
                ? 'not bundled with the extension (set "ublValidator.rules.source" to "latest" to download it)'
                : 'not bundled with the extension');
        }
        return fallback;
    }

    private usableInstall(pack: RulePack, entries: RuleEntry[]): InstalledPack | undefined {
        const installed = this.state.packs[pack.id];
        if (!installed) {
            return undefined;
        }
        return entries.every(e => installed.files[e.path] && fs.existsSync(installed.files[e.path])) ? installed : undefined;
    }

    private bundledCheck(pack: RulePack, docType: string, reason?: string): PlannedCheck | undefined {
        const rel = pack.bundled?.[docType] ?? pack.bundled?.['*'];
        if (!rel) {
            return undefined;
        }
        const files = rel.map(r => path.join(this.opts.bundledArtifactsPath, r));
        if (!files.every(f => fs.existsSync(f))) {
            return undefined;
        }
        const versions = readJson<Record<string, { version: string }>>(path.join(this.opts.bundledArtifactsPath, 'versions.json'));
        return {
            id: pack.id, label: pack.label, reason,
            version: versions?.[pack.id]?.version ? `${versions[pack.id].version} (bundled)` : 'bundled',
            xsltPaths: files,
            sandboxRoots: [this.opts.bundledArtifactsPath],
        };
    }

    // ─── Installing ────────────────────────────────────────────────────

    /** Installs the latest version of a pack (no-op if it's already current). */
    install(pack: RulePack): Promise<InstalledPack> {
        const running = this.inflight.get(pack.id);
        if (running) {
            return running;
        }
        const p = this.doInstall(pack).finally(() => this.inflight.delete(pack.id));
        this.inflight.set(pack.id, p);
        return p;
    }

    private async doInstall(pack: RulePack): Promise<InstalledPack> {
        const hosts = this.allowedHosts();
        const release = await resolveLatest(pack.source, hosts);
        const now = new Date().toISOString();
        const allEntries = uniqueEntries(pack);

        const current = this.state.packs[pack.id];
        if (current && current.version === release.version && allEntries.every(e => current.files[e.path] && fs.existsSync(current.files[e.path]))) {
            current.checkedAt = now;
            this.saveState();
            return current;
        }

        const packRoot = path.join(this.opts.storageDir, 'packs', pack.id);
        const dir = path.join(packRoot, safeName(release.version));
        const tmpDir = path.join(this.opts.storageDir, 'tmp');
        fs.mkdirSync(tmpDir, { recursive: true });
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        const download = path.join(tmpDir, `${pack.id}-${Date.now()}.download`);

        try {
            this.opts.log?.(`Downloading ${pack.label} ${release.version} from ${release.downloadUrl}`);
            await downloadTo(release.downloadUrl, download, hosts, release.browserUserAgent);
            if (isZip(download)) {
                await this.opts.helper.unzip(download, dir);
            } else {
                fs.copyFileSync(download, path.join(dir, path.basename(new URL(release.downloadUrl).pathname) || 'rules.xml'));
            }

            const files: Record<string, string> = {};
            for (const entry of allEntries) {
                const file = resolveGlob(dir, entry.path);
                if (!file) {
                    throw new Error(`${entry.path} not found in the ${release.version} download (the publisher may have changed the layout)`);
                }
                files[entry.path] = entry.format === 'sch' ? await this.compileSchematron(file, dir) : file;
            }

            const installed: InstalledPack = { version: release.version, dir, installedAt: now, checkedAt: now, files };
            this.state.packs[pack.id] = installed;
            this.saveState();
            // Keep the previous version: validations planned against it may still be running
            this.removeOtherVersions(packRoot, [dir, current?.dir]);
            this.opts.log?.(`Installed ${pack.label} ${release.version}`);
            return installed;
        } catch (e) {
            fs.rmSync(dir, { recursive: true, force: true });
            throw e;
        } finally {
            fs.rmSync(download, { force: true });
        }
    }

    /** Compiles a Schematron file to XSLT with the bundled SchXslt2, sandboxed to the pack folder. */
    private async compileSchematron(schPath: string, packDir: string): Promise<string> {
        const transpiler = path.join(this.opts.extensionPath, 'lib', 'schxslt2', 'transpile.xsl');
        const { output } = await this.opts.helper.transform(transpiler, schPath, true, {
            sandboxRoots: [packDir, path.dirname(transpiler)],
            timeoutMs: Math.max(this.settings().timeoutMs, 120_000),
        });
        const out = schPath.replace(/\.sch$/i, '') + '.compiled.xslt';
        fs.writeFileSync(out, output, 'utf8');
        return out;
    }

    private removeOtherVersions(packRoot: string, keep: (string | undefined)[]): void {
        for (const name of fs.readdirSync(packRoot)) {
            const p = path.join(packRoot, name);
            if (!keep.includes(p)) {
                fs.rmSync(p, { recursive: true, force: true });
            }
        }
    }

    // ─── Updates ───────────────────────────────────────────────────────

    private updateInBackground(packs: RulePack[]): void {
        const due = packs.filter(p => !this.inflight.has(p.id));
        if (due.length === 0) {
            return;
        }
        void this.updatePacks(due).then(results => {
            const changed = results.filter(r => r.to && r.from !== r.to);
            if (changed.length > 0) {
                this.opts.onUpdated?.(changed);
            }
        });
    }

    private async updatePacks(packs: RulePack[]): Promise<UpdateResult[]> {
        const results: UpdateResult[] = [];
        for (const pack of packs) {
            const from = this.state.packs[pack.id]?.version;
            try {
                const installed = await this.install(pack);
                results.push({ id: pack.id, label: pack.label, from, to: installed.version });
            } catch (e: any) {
                this.opts.log?.(`Update check failed for ${pack.label}: ${e.message}`);
                results.push({ id: pack.id, label: pack.label, from, error: e.message });
            }
        }
        return results;
    }

    /** Refreshes the catalog and every installed pack now. */
    async checkForUpdates(): Promise<UpdateResult[]> {
        if (!this.canDownload()) {
            throw new Error('Rule downloads are off (setting "ublValidator.rules.source" is "bundled").');
        }
        await this.refreshCatalog();
        const catalog = this.catalog;
        const packs = Object.keys(this.state.packs)
            .map(id => catalog.packs.find(p => p.id === id))
            .filter((p): p is RulePack => !!p);
        return this.updatePacks(packs);
    }

    /** Downloads every pack in the catalog (e.g. before going offline). */
    async installAll(onProgress?: (message: string) => void): Promise<UpdateResult[]> {
        if (!this.canDownload()) {
            throw new Error('Rule downloads are off (setting "ublValidator.rules.source" is "bundled").');
        }
        await this.refreshCatalog();
        const results: UpdateResult[] = [];
        for (const pack of this.catalog.packs.filter(p => !this.settings().disabled.includes(p.id))) {
            onProgress?.(pack.label);
            results.push(...await this.updatePacks([pack]));
        }
        return results;
    }

    private refreshCatalogIfStale(): void {
        if (this.settings().catalogUrl && isStale(this.state.catalogCheckedAt)) {
            void this.refreshCatalog();
        }
    }

    private refreshCatalog(): Promise<void> {
        if (!this.catalogRefresh) {
            this.catalogRefresh = this.doRefreshCatalog().finally(() => {
                this.catalogRefresh = undefined;
            });
        }
        return this.catalogRefresh;
    }

    private async doRefreshCatalog(): Promise<void> {
        const url = this.settings().catalogUrl;
        if (!url) {
            return;
        }
        try {
            const res = await fetchChecked(url, { allowedHosts: this.allowedHosts() });
            const catalog = validateCatalog(await res.json());
            this.remoteCatalog = this.trust(catalog);
            fs.mkdirSync(this.opts.storageDir, { recursive: true });
            fs.writeFileSync(path.join(this.opts.storageDir, 'catalog.remote.json'), JSON.stringify(catalog));
        } catch (e: any) {
            this.opts.log?.(`Rules catalog not refreshed from ${url}: ${e.message}`);
        } finally {
            this.state.catalogCheckedAt = new Date().toISOString();
            this.saveState();
        }
    }

    // ─── State ─────────────────────────────────────────────────────────

    private statePath(): string {
        return path.join(this.opts.storageDir, 'state.json');
    }

    private saveState(): void {
        if (!this.opts.storageDir) {
            return;
        }
        fs.mkdirSync(this.opts.storageDir, { recursive: true });
        fs.writeFileSync(this.statePath(), JSON.stringify(this.state, null, 2));
    }
}

function uniqueEntries(pack: RulePack): RuleEntry[] {
    const seen = new Map<string, RuleEntry>();
    for (const list of Object.values(pack.entries)) {
        for (const e of list) {
            seen.set(e.path, e);
        }
    }
    return [...seen.values()];
}

/**
 * Resolves a path pattern inside a download: `*` matches one path segment
 * (e.g. a zipball's top folder) and `**` any number of segments.
 */
export function resolveGlob(root: string, pattern: string): string | undefined {
    const segments = pattern.split('/').filter(Boolean);
    const walk = (dir: string, i: number): string | undefined => {
        if (i === segments.length) {
            return isFile(dir) ? dir : undefined;
        }
        const seg = segments[i];
        if (seg === '**') {
            const here = walk(dir, i + 1);
            if (here) {
                return here;
            }
            for (const child of listDirs(dir)) {
                const found = walk(child, i);
                if (found) {
                    return found;
                }
            }
            return undefined;
        }
        if (seg === '*') {
            for (const name of safeReaddir(dir)) {
                const found = walk(path.join(dir, name), i + 1);
                if (found) {
                    return found;
                }
            }
            return undefined;
        }
        const next = path.join(dir, seg);
        return fs.existsSync(next) ? walk(next, i + 1) : undefined;
    };
    return walk(root, 0);
}

function safeReaddir(dir: string): string[] {
    try {
        return fs.readdirSync(dir).sort();
    } catch {
        return [];
    }
}

function listDirs(dir: string): string[] {
    return safeReaddir(dir).map(n => path.join(dir, n)).filter(p => !isFile(p));
}

function isFile(p: string): boolean {
    try {
        return fs.statSync(p).isFile();
    } catch {
        return false;
    }
}

function isZip(file: string): boolean {
    const fd = fs.openSync(file, 'r');
    try {
        const buf = Buffer.alloc(4);
        fs.readSync(fd, buf, 0, 4, 0);
        return buf[0] === 0x50 && buf[1] === 0x4b;
    } finally {
        fs.closeSync(fd);
    }
}

/** Folder name for a version; the prefix keeps "." / ".." (from scraped pages) harmless. */
function safeName(version: string): string {
    return 'v-' + (version.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'unknown');
}

function isStale(iso: string | undefined): boolean {
    return !iso || Date.now() - Date.parse(iso) > DAY_MS;
}

function readJson<T>(file: string): T | undefined {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
    } catch {
        return undefined;
    }
}
