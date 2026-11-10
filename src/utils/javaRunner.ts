import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { execAsync } from './execAsync';

export const SAXON_JAR = 'Saxon-HE-12.10.jar';
export const XMLRESOLVER_JAR = 'xmlresolver-5.3.3.jar';
export const MIN_JAVA_VERSION = 11;

export interface JavaStatus {
    available: boolean;
    /** Major version, e.g. 17. 0 when unknown. */
    version: number;
    raw?: string;
}

const javaStatusCache = new Map<string, JavaStatus>();

/** Parses the major version out of `java -version` output ("1.8.0_352" → 8, "17.0.2" → 17). */
export function parseJavaMajorVersion(output: string): number {
    const m = output.match(/version\s+"(\d+)(?:\.(\d+))?/);
    if (!m) {
        return 0;
    }
    const first = parseInt(m[1], 10);
    return first === 1 && m[2] ? parseInt(m[2], 10) : first;
}

export async function checkJava(javaPath: string): Promise<JavaStatus> {
    const cached = javaStatusCache.get(javaPath);
    if (cached) {
        return cached;
    }
    let status: JavaStatus;
    try {
        const { stdout, stderr } = await execAsync(javaPath, ['-version']);
        const raw = (stderr || stdout).trim();
        status = { available: true, version: parseJavaMajorVersion(raw), raw };
    } catch {
        status = { available: false, version: 0 };
    }
    javaStatusCache.set(javaPath, status);
    return status;
}

export function clearJavaStatusCache(): void {
    javaStatusCache.clear();
}

export function javaRequirementError(javaPath: string, status: JavaStatus): string | undefined {
    if (!status.available) {
        return `Java was not found ("${javaPath}"). Install Java ${MIN_JAVA_VERSION} or newer, ` +
            'or point the "ublValidator.javaPath" setting at a Java executable.';
    }
    if (status.version > 0 && status.version < MIN_JAVA_VERSION) {
        return `Java ${status.version} found, but Java ${MIN_JAVA_VERSION} or newer is required. ` +
            'Install a newer Java or set "ublValidator.javaPath".';
    }
    return undefined;
}

export class JavaToolError extends Error {
    constructor(message: string, readonly details: string) {
        super(details ? `${message}\n${details}` : message);
    }
}

export interface HelperResult {
    output: string;
    messages: string;
}

interface Pending {
    resolve: (r: HelperResult) => void;
    reject: (e: Error) => void;
}

/**
 * Client for the long-lived Java helper (java/UblHelper.java). One JVM serves
 * all transforms and validations, so start-up and Schematron compilation costs
 * are paid once per session instead of on every run.
 */
export interface RequestOptions {
    /** Kill the helper if the request takes longer (0 = no limit) */
    timeoutMs?: number;
    /** Abort the request; the helper is restarted on the next request */
    signal?: AbortSignal;
    /**
     * Run the stylesheet sandboxed: it may only read files below these folders
     * and may not write files. Used for downloaded rule sets.
     */
    sandboxRoots?: string[];
}

export class JavaHelper {
    private proc: ChildProcess | undefined;
    private starting: Promise<ChildProcess> | undefined;
    private buffer = '';
    private nextId = 1;
    private pending = new Map<number, Pending>();
    private stderrTail = '';

    constructor(
        private readonly extensionPath: string,
        private readonly getJavaPath: () => string
    ) {}

    private classpath(): string {
        const lib = path.join(this.extensionPath, 'lib');
        return [
            path.join(lib, 'classes'),
            path.join(lib, SAXON_JAR),
            path.join(lib, XMLRESOLVER_JAR),
        ].join(path.delimiter);
    }

    private ensureStarted(): Promise<ChildProcess> {
        if (this.proc && this.proc.exitCode === null && !this.proc.killed) {
            return Promise.resolve(this.proc);
        }
        // Concurrent callers share one start-up so only one JVM is ever spawned
        if (!this.starting) {
            this.starting = this.start().finally(() => {
                this.starting = undefined;
            });
        }
        return this.starting;
    }

    private async start(): Promise<ChildProcess> {
        const javaPath = this.getJavaPath();
        const err = javaRequirementError(javaPath, await checkJava(javaPath));
        if (err) {
            throw new JavaToolError(err, '');
        }

        const proc = spawn(javaPath, ['-Xss8m', '-cp', this.classpath(), 'UblHelper', 'serve'], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.proc = proc;
        this.buffer = '';
        this.stderrTail = '';

        proc.stdout!.setEncoding('utf8');
        proc.stdout!.on('data', (chunk: string) => {
            if (this.proc === proc) {
                this.onData(chunk);
            }
        });
        proc.stderr!.setEncoding('utf8');
        proc.stderr!.on('data', (chunk: string) => {
            this.stderrTail = (this.stderrTail + chunk).slice(-4000);
        });
        // Writing to a JVM that already exited raises EPIPE; 'exit' handles the cleanup
        proc.stdin!.on('error', () => undefined);
        const onGone = (reason: string) => {
            if (this.proc === proc) {
                this.stop(new JavaToolError(`Java helper stopped (${reason})`, this.stderrTail.trim()));
            }
        };
        proc.on('exit', code => onGone(`exit code ${code}`));
        proc.on('error', e => onGone(e.message));
        return proc;
    }

    /** Kills the helper and rejects every pending request with `error`. */
    private stop(error: Error): void {
        const proc = this.proc;
        this.proc = undefined;
        if (proc) {
            proc.stdin?.end();
            proc.kill();
        }
        for (const p of this.pending.values()) {
            p.reject(error);
        }
        this.pending.clear();
    }

    private onData(chunk: string): void {
        this.buffer += chunk;
        let nl: number;
        while ((nl = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, nl);
            this.buffer = this.buffer.slice(nl + 1);
            const [idStr, status, out = '', msgs = ''] = line.split('\t');
            const id = parseInt(idStr, 10);
            const p = this.pending.get(id);
            if (!p) {
                continue;
            }
            this.pending.delete(id);
            const output = Buffer.from(out, 'base64').toString('utf8');
            const messages = Buffer.from(msgs, 'base64').toString('utf8');
            if (status === 'ok') {
                p.resolve({ output, messages });
            } else {
                const [first, ...rest] = messages.split('\n');
                p.reject(new JavaToolError(first, rest.join('\n').trim()));
            }
        }
    }

    private async request(args: string[], options: RequestOptions = {}): Promise<HelperResult> {
        for (const a of args) {
            if (/[\t\r\n]/.test(a)) {
                throw new Error(`Unsupported character in path: ${a}`);
            }
        }
        if (options.signal?.aborted) {
            throw new JavaToolError('Cancelled', '');
        }
        const proc = await this.ensureStarted();
        const id = this.nextId++;
        return new Promise<HelperResult>((resolve, reject) => {
            let timer: NodeJS.Timeout | undefined;
            const onAbort = () => this.stop(new JavaToolError('Cancelled', ''));
            const done = () => {
                if (timer) {
                    clearTimeout(timer);
                }
                options.signal?.removeEventListener('abort', onAbort);
            };
            this.pending.set(id, {
                resolve: r => { done(); resolve(r); },
                reject: e => { done(); reject(e); },
            });
            // Sandboxed (downloaded) rules always get a ceiling
            const timeoutMs = options.timeoutMs || (options.sandboxRoots ? 600_000 : 0);
            if (timeoutMs) {
                // The helper is single-threaded: a runaway stylesheet would block every later request
                timer = setTimeout(() => this.stop(new JavaToolError(
                    `Timed out after ${Math.round(timeoutMs / 1000)}s (setting: ublValidator.transformTimeoutSeconds)`, ''
                )), timeoutMs);
            }
            options.signal?.addEventListener('abort', onAbort, { once: true });
            proc.stdin!.write([String(id), ...args].join('\t') + '\n');
        });
    }

    /**
     * Runs an XSLT transform with Saxon-HE. Set `cache` for stylesheets that do
     * not change between runs (the bundled Schematron rules).
     */
    transform(xslPath: string, sourcePath: string, cache = false, options?: RequestOptions): Promise<HelperResult> {
        const roots = options?.sandboxRoots?.join(path.delimiter) ?? '';
        return this.request(['transform', xslPath, sourcePath, cache ? '1' : '0', roots], options);
    }

    /** Validates a document against an XSD. Issues come back as tab-separated lines in `messages`. */
    validateXsd(schemaPath: string, documentPath: string, options?: RequestOptions): Promise<HelperResult> {
        return this.request(['xsd', schemaPath, documentPath], options);
    }

    /** Extracts a zip archive into `destDir`, refusing entries that escape it. */
    unzip(zipPath: string, destDir: string): Promise<HelperResult> {
        return this.request(['unzip', zipPath, destDir], { timeoutMs: 120000 });
    }

    /** Returns "java=..." and "saxon=..." lines from the running helper. */
    ping(): Promise<HelperResult> {
        return this.request(['ping'], { timeoutMs: 30000 });
    }

    dispose(): void {
        this.stop(new JavaToolError('Java helper restarted', ''));
    }
}
