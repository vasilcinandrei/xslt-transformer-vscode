import { detectUblDocumentFromContent } from '../validation/documentDetector';
import { validateContent, ValidationContext } from '../validation/validator';
import { UblDocumentInfo, ValidationResult, ValidationScope } from '../validation/types';
import { runInstrumentedTransform, TraceEntry } from '../tracing/xsltTracer';
import { mapIssuesToXsltSource, TracedIssue } from '../tracing/errorTraceMapper';

export interface TransformResult {
    output: string;
    isUbl: boolean;
    documentInfo: UblDocumentInfo | null;
    validationResult: ValidationResult | null;
    tracedIssues?: TracedIssue[];
    traceEntries?: TraceEntry[];
    /** xsl:message output and warnings from the transform */
    messages: string;
    /** Main stylesheet plus local includes/imports (tracing runs only) */
    stylesheetFiles?: string[];
}

export interface PipelineOptions {
    sourceXml: string;
    xsltStylesheet: string;
    validationScope?: ValidationScope;
    enableTracing?: boolean;
    onProgress?: (message: string) => void;
    signal?: AbortSignal;
}

/**
 * Transforms the source with Saxon-HE (XSLT 1.0–3.0) and, when the output is a
 * UBL document, validates it. Transform errors are thrown; partial output from
 * a failed transform is never treated as a result.
 */
export async function transformAndValidate(
    options: PipelineOptions,
    ctx: ValidationContext
): Promise<TransformResult> {
    const { sourceXml, xsltStylesheet, validationScope = 'full', enableTracing = false, onProgress, signal } = options;
    const requestOptions = { timeoutMs: ctx.timeoutMs, signal };

    let output: string;
    let traceEntries: TraceEntry[] = [];
    let messages: string;
    let stylesheetFiles: string[] | undefined;

    onProgress?.('Running XSLT transformation...');
    if (enableTracing) {
        const traced = await runInstrumentedTransform(ctx.helper, sourceXml, xsltStylesheet, requestOptions);
        output = traced.cleanOutput;
        traceEntries = traced.traceEntries;
        messages = traced.messages;
        stylesheetFiles = traced.stylesheetFiles;
    } else {
        const result = await ctx.helper.transform(xsltStylesheet, sourceXml, false, requestOptions);
        output = result.output;
        messages = result.messages;
    }

    onProgress?.('Detecting document type...');
    const docInfo = detectUblDocumentFromContent(output);
    if (!docInfo) {
        return { output, isUbl: false, documentInfo: null, validationResult: null, messages, stylesheetFiles };
    }

    const validationResult = await validateContent(output, docInfo, validationScope, ctx, onProgress, signal);

    return {
        output,
        isUbl: true,
        documentInfo: docInfo,
        validationResult,
        tracedIssues: enableTracing
            ? mapIssuesToXsltSource(validationResult.issues, traceEntries, output)
            : undefined,
        traceEntries: enableTracing ? traceEntries : undefined,
        messages,
        stylesheetFiles,
    };
}
