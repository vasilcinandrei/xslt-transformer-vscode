import { TracedIssue } from '../tracing/errorTraceMapper';

export type AiProvider = 'anthropic' | 'openai' | 'gemini' | 'groq';

export interface AiConfig {
    provider: AiProvider;
    model: string;
    maxRetries: number;
    timeoutSeconds: number;
    includeInputXml: boolean;
    maxInputXmlChars: number;
}

export interface FixSection {
    /** 1-based, inclusive */
    startLine: number;
    endLine: number;
    text: string;
}

export interface FixContext {
    error: {
        source: string;
        ruleId?: string;
        message: string;
        line: number;
    };
    xsltFilePath: string;
    xsltContent: string;
    /** 'full': the model returns the whole stylesheet; 'section': only `section` */
    mode: 'full' | 'section';
    section: FixSection;
    /** Numbered lines around the traced XSLT line */
    relevantTemplate: string;
    inputXml?: { content: string; truncated: boolean; totalChars: number };
    outputXmlSnippet: string;
}

export interface FixProposal {
    originalContent: string;
    proposedContent: string;
    explanation: string;
    /** Raw content inside <fix>, as returned by the model */
    rawFix: string;
}

export interface ConversationMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface FixAttempt {
    /** Undefined when the response could not be parsed */
    proposal?: FixProposal;
    rawResponse?: string;
    succeeded: boolean;
    newErrors?: string[];
}

export interface FixSession {
    issue: TracedIssue;
    attempts: FixAttempt[];
}
