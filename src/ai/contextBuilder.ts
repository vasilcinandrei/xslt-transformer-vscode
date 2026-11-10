import * as fs from 'fs';
import { TracedIssue } from '../tracing/errorTraceMapper';
import { AiConfig, FixContext, FixSection, FixSession, ConversationMessage } from './types';

/** Above this size the model edits only the relevant template, not the whole file. */
export const FULL_XSLT_MAX_CHARS = 120_000;

export function buildFixContext(
    issue: TracedIssue,
    xsltContent: string,
    outputContent: string,
    inputXmlPath: string,
    config: AiConfig
): FixContext {
    const xsltFilePath = issue.xsltSourceFile!;
    const traceLine = issue.xsltSourceLine ?? 1;

    let inputXml: FixContext['inputXml'];
    if (config.includeInputXml) {
        const full = fs.readFileSync(inputXmlPath, 'utf8');
        const truncated = full.length > config.maxInputXmlChars;
        inputXml = {
            content: truncated ? full.slice(0, config.maxInputXmlChars) : full,
            truncated,
            totalChars: full.length,
        };
    }

    return {
        error: {
            source: issue.source,
            ruleId: issue.ruleId,
            message: issue.message,
            line: issue.line,
        },
        xsltFilePath,
        xsltContent,
        mode: xsltContent.length > FULL_XSLT_MAX_CHARS ? 'section' : 'full',
        section: findEnclosingTemplate(xsltContent, traceLine),
        relevantTemplate: extractRelevantSection(xsltContent, traceLine, 50),
        inputXml,
        outputXmlSnippet: extractRelevantSection(outputContent, issue.line, 30),
    };
}

/**
 * The xsl:template (or xsl:function) around `line`, falling back to ±80 lines
 * when the enclosing declaration is missing or very large.
 */
export function findEnclosingTemplate(content: string, line: number, maxLines = 400): FixSection {
    const lines = content.split(/\r?\n/);
    const idx = Math.min(Math.max(line - 1, 0), lines.length - 1);
    let start = -1;
    for (let i = idx; i >= 0 && idx - i <= maxLines; i--) {
        if (/<xsl:(template|function)\b/.test(lines[i])) {
            start = i;
            break;
        }
    }
    let end = -1;
    if (start >= 0) {
        for (let i = idx; i < lines.length && i - start <= maxLines; i++) {
            if (/<\/xsl:(template|function)\s*>/.test(lines[i])) {
                end = i;
                break;
            }
        }
    }
    if (start < 0 || end < 0) {
        start = Math.max(0, idx - 80);
        end = Math.min(lines.length - 1, idx + 80);
    }
    return { startLine: start + 1, endLine: end + 1, text: lines.slice(start, end + 1).join('\n') };
}

function extractRelevantSection(content: string, centerLine: number, radius: number): string {
    const lines = content.split(/\r?\n/);
    const start = Math.max(0, centerLine - 1 - radius);
    const end = Math.min(lines.length, centerLine - 1 + radius);
    return lines
        .slice(start, end)
        .map((line, i) => {
            const lineNum = start + i + 1;
            const marker = lineNum === centerLine ? ' >>>' : '    ';
            return `${marker} ${lineNum}: ${line}`;
        })
        .join('\n');
}

export function buildMessages(context: FixContext, session: FixSession): ConversationMessage[] {
    const messages: ConversationMessage[] = [];
    const sectionMode = context.mode === 'section';

    messages.push({
        role: 'system',
        content: [
            'You are an XSLT repair agent for UBL documents.',
            'You get the validation error, the XSLT mapping stylesheet, a snippet of the generated UBL output and usually the input XML.',
            'Fix the XSLT stylesheet so it produces valid UBL output. Never edit the output XML itself.',
            sectionMode
                ? 'Return ONLY the replacement text for the "Section to modify" block (no line numbers), wrapped in <fix explanation="...">...</fix>.'
                : 'Return the complete modified XSLT stylesheet wrapped in <fix explanation="...">...</fix>.',
            'Make the smallest change that fixes the error, keep all namespace declarations, place elements in the order the UBL schema requires,',
            'and take values from the input XML via XPath rather than hardcoding them.',
            'Write nothing outside the <fix> tags. Keep the explanation to one sentence.',
        ].join(' '),
    });

    const sections: string[] = [];
    sections.push('## Validation error');
    sections.push(`- Source: ${context.error.source}`);
    if (context.error.ruleId) {
        sections.push(`- Rule ID: ${context.error.ruleId}`);
    }
    sections.push(`- Message: ${context.error.message}`);
    sections.push(`- Output line: ${context.error.line}`);

    if (context.inputXml) {
        sections.push('');
        sections.push('## Input XML (source data)');
        if (context.inputXml.truncated) {
            sections.push(`(Only the first ${context.inputXml.content.length} of ${context.inputXml.totalChars} characters are included.)`);
        }
        sections.push('```xml', context.inputXml.content, '```');
    }

    if (!sectionMode) {
        const xsltLines = context.xsltContent.split(/\r?\n/).length;
        sections.push('');
        sections.push(`## Full XSLT stylesheet (${xsltLines} lines)`);
        sections.push('```xml', context.xsltContent, '```');
    }

    sections.push('');
    sections.push('## XSLT around the traced line');
    sections.push('The line marked >>> produced the element the error refers to:');
    sections.push('```', context.relevantTemplate, '```');

    if (sectionMode) {
        sections.push('');
        sections.push(`## Section to modify (lines ${context.section.startLine}–${context.section.endLine})`);
        sections.push('The stylesheet is too large to send in full. Your <fix> must contain the replacement for exactly this text:');
        sections.push('```xml', context.section.text, '```');
    }

    sections.push('');
    sections.push('## Generated output XML (snippet around the error)');
    sections.push('```xml', context.outputXmlSnippet, '```');

    messages.push({ role: 'user', content: sections.join('\n') });

    // Retry context from previous failed attempts
    for (const attempt of session.attempts) {
        if (attempt.proposal) {
            messages.push({
                role: 'assistant',
                content: `<fix explanation="${attempt.proposal.explanation.replace(/"/g, "'")}">\n${attempt.proposal.rawFix}\n</fix>`,
            });
        } else if (attempt.rawResponse) {
            messages.push({ role: 'assistant', content: attempt.rawResponse.slice(0, 2000) });
        }

        const feedback: string[] = [];
        if (!attempt.proposal) {
            feedback.push('That response did not contain a usable <fix>...</fix> block with a valid XSLT stylesheet.');
        } else {
            feedback.push('The previous fix did not resolve the error.');
        }
        if (attempt.newErrors && attempt.newErrors.length > 0) {
            feedback.push('Errors after applying it:');
            for (const err of attempt.newErrors.slice(0, 20)) {
                feedback.push(`- ${err}`);
            }
            if (attempt.newErrors.length > 20) {
                feedback.push(`- ... and ${attempt.newErrors.length - 20} more`);
            }
        }
        feedback.push('Please try a different approach.');
        messages.push({ role: 'user', content: feedback.join('\n') });
    }

    return messages;
}
