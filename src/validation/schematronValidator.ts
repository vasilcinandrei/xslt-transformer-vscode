import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as process from 'process';
import { ValidationIssue } from './types';
import { execAsync, checkToolAvailable, getInstallInstructions } from '../utils/execAsync';
import { parseSvrlOutput } from './svrlParser';

export type SchematronRuleset = 'en16931' | 'peppol';

const XSLT_FILES: Record<SchematronRuleset, string> = {
    en16931: path.join('schematron', 'en16931', 'EN16931-UBL-validation.xslt'),
    peppol: path.join('schematron', 'peppol', 'PEPPOL-EN16931-UBL.xslt'),
};

export async function validateSchematron(
    filePath: string,
    ruleset: SchematronRuleset,
    artifactsPath: string
): Promise<ValidationIssue[]> {
    const xsltFile = path.join(artifactsPath, XSLT_FILES[ruleset]);

    if (!fs.existsSync(xsltFile)) {
        throw new Error(
            `${ruleset} XSLT not found at ${xsltFile}. ` +
            `Please reinstall the extension or run the download-artifacts script.`
        );
    }

    // EN16931 and Peppol compiled XSLTs are XSLT 2.0, so xsltproc (1.0 only)
    // won't work. Go straight to Saxon.
    return validateWithSaxon(xsltFile, filePath, ruleset);
}

function findSaxonJar(): string | null {
    const homeDir = os.homedir();
    const isWindows = process.platform === 'win32';

    // Platform-specific well-known locations
    const staticLocations: string[] = [];

    if (process.platform === 'darwin') {
        // macOS - Homebrew
        staticLocations.push(
            '/opt/homebrew/share/saxon/saxon-he.jar',
            '/opt/homebrew/share/saxon/saxon9he.jar',
            '/usr/local/share/saxon/saxon-he.jar',
            '/usr/local/share/saxon/saxon9he.jar',
        );
    } else if (isWindows) {
        // Windows - common install locations
        const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
        const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
        for (const base of [programFiles, programFilesX86]) {
            staticLocations.push(
                path.join(base, 'Saxon', 'saxon-he.jar'),
                path.join(base, 'Saxon', 'saxon9he.jar'),
                path.join(base, 'Saxonica', 'SaxonHE', 'saxon-he.jar'),
            );
        }
        // Chocolatey
        const chocoDir = process.env['ChocolateyInstall'] || 'C:\\ProgramData\\chocolatey';
        staticLocations.push(path.join(chocoDir, 'lib', 'saxon', 'tools', 'saxon-he.jar'));
    } else {
        // Linux
        staticLocations.push(
            '/usr/share/java/saxon-he.jar',
            '/usr/share/java/Saxon-HE.jar',
            '/usr/share/java/saxon.jar',
            '/usr/local/share/saxon/saxon-he.jar',
            '/usr/local/share/java/saxon-he.jar',
            '/snap/saxon/current/jar/saxon-he.jar',
        );
    }

    for (const loc of staticLocations) {
        if (fs.existsSync(loc)) {
            return loc;
        }
    }

    // Check SAXON_HOME environment variable (cross-platform)
    const saxonHome = process.env['SAXON_HOME'];
    if (saxonHome) {
        const candidates = ['saxon-he.jar', 'saxon9he.jar', 'Saxon-HE.jar'];
        for (const name of candidates) {
            const jar = path.join(saxonHome, name);
            if (fs.existsSync(jar)) {
                return jar;
            }
        }
    }

    // Search Maven local repo for Saxon-HE (cross-platform)
    const m2SaxonDir = path.join(homeDir, '.m2', 'repository', 'net', 'sf', 'saxon', 'Saxon-HE');
    if (fs.existsSync(m2SaxonDir)) {
        try {
            const versions = fs.readdirSync(m2SaxonDir)
                .filter(v => /^\d+\.\d+/.test(v))
                .sort((a, b) => {
                    const [aMaj, aMin] = a.split('.').map(Number);
                    const [bMaj, bMin] = b.split('.').map(Number);
                    return aMaj !== bMaj ? aMaj - bMaj : aMin - bMin;
                });

            // Prefer version 10.x (self-contained, no xmlresolver needed)
            const v10 = versions.find(v => v.startsWith('10.'));
            if (v10) {
                const jar = path.join(m2SaxonDir, v10, `Saxon-HE-${v10}.jar`);
                if (fs.existsSync(jar)) {
                    return jar;
                }
            }

            // Fall back to any available version
            for (const v of versions) {
                const jar = path.join(m2SaxonDir, v, `Saxon-HE-${v}.jar`);
                if (fs.existsSync(jar)) {
                    return jar;
                }
            }
        } catch {
            // ignore read errors
        }
    }

    return null;
}

function findXmlResolverJar(): string | null {
    const homeDir = os.homedir();
    const resolverDir = path.join(homeDir, '.m2', 'repository', 'org', 'xmlresolver', 'xmlresolver');
    if (!fs.existsSync(resolverDir)) {
        return null;
    }
    try {
        const versions = fs.readdirSync(resolverDir)
            .filter(v => /^\d+/.test(v))
            .sort()
            .reverse();
        for (const v of versions) {
            const jar = path.join(resolverDir, v, `xmlresolver-${v}.jar`);
            if (fs.existsSync(jar)) {
                return jar;
            }
        }
    } catch {
        // ignore
    }
    return null;
}

function getSaxonInstallInstructions(): string {
    switch (process.platform) {
        case 'darwin':
            return 'Install Saxon-HE with: brew install saxon. Or download from https://www.saxonica.com/download/java.xml';
        case 'win32':
            return 'Download Saxon-HE from https://www.saxonica.com/download/java.xml or install with: choco install saxon. You can also set the SAXON_HOME environment variable.';
        default:
            return 'Install Saxon-HE with: sudo apt install libsaxon-java (Debian/Ubuntu) or download from https://www.saxonica.com/download/java.xml. You can also set the SAXON_HOME environment variable.';
    }
}

async function validateWithSaxon(
    xsltFile: string,
    filePath: string,
    ruleset: SchematronRuleset
): Promise<ValidationIssue[]> {
    const javaAvailable = await checkToolAvailable('java');
    if (!javaAvailable) {
        throw new Error(
            `Java is required for Schematron validation (${ruleset}) but is not installed or not in your PATH. ` +
            getInstallInstructions('java')
        );
    }

    const saxonJar = findSaxonJar();
    if (!saxonJar) {
        throw new Error(
            `Saxon-HE is required for Schematron validation (${ruleset}) but was not found. ` +
            getSaxonInstallInstructions()
        );
    }

    // Build classpath - Saxon 11+ needs xmlresolver on the classpath
    // Use platform-correct path separator (: on Unix, ; on Windows)
    const cpSeparator = process.platform === 'win32' ? ';' : ':';
    let classpath = saxonJar;
    const xmlResolverJar = findXmlResolverJar();
    if (xmlResolverJar) {
        classpath = `${saxonJar}${cpSeparator}${xmlResolverJar}`;
    }

    try {
        const { stdout } = await execAsync('java', [
            '-cp', classpath,
            'net.sf.saxon.Transform',
            `-s:${filePath}`,
            `-xsl:${xsltFile}`,
        ]);
        return parseSvrlOutput(stdout, filePath, ruleset);
    } catch (error: any) {
        if (error.stdout && error.stdout.includes('svrl:')) {
            return parseSvrlOutput(error.stdout, filePath, ruleset);
        }
        throw new Error(`Schematron validation (${ruleset}) with Saxon failed: ${error.message}`);
    }
}
