import * as https from 'https';
import Anthropic from '@anthropic-ai/sdk';
import { AiProvider, ConversationMessage } from './types';

export interface LlmCallOptions {
    provider: AiProvider;
    model: string;
    apiKey: string;
    messages: ConversationMessage[];
    timeoutMs: number;
    signal?: AbortSignal;
}

export interface LlmResponse {
    content: string;
    inputTokens: number;
    outputTokens: number;
}

export const DEFAULT_MODELS: Record<AiProvider, string> = {
    anthropic: 'claude-opus-5-5',
    openai: 'gpt-5',
    gemini: 'gemini-2.5-flash',
    groq: 'llama-3.3-70b-versatile',
};

export class LlmCancelledError extends Error {
    constructor() {
        super('AI request cancelled');
    }
}

export async function callLlm(options: LlmCallOptions): Promise<LlmResponse> {
    const model = options.model || DEFAULT_MODELS[options.provider];
    switch (options.provider) {
        case 'anthropic':
            return callAnthropic(options, model);
        case 'openai':
            return callOpenAiCompatible(options, model, 'api.openai.com', '/v1/chat/completions', 'max_completion_tokens');
        case 'gemini':
            return callOpenAiCompatible(options, model, 'generativelanguage.googleapis.com', '/v1beta/openai/chat/completions', 'max_tokens');
        case 'groq':
            return callOpenAiCompatible(options, model, 'api.groq.com', '/openai/v1/chat/completions', 'max_tokens');
    }
}

// Models that accept the server-side "default" refusal fallback
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

function supportsEffort(model: string): boolean {
    return /^claude-(opus|sonnet|fable|haiku|mythos)-(5|4-[6-9])/.test(model);
}

async function callAnthropic(options: LlmCallOptions, model: string): Promise<LlmResponse> {
    const client = new Anthropic({ apiKey: options.apiKey, timeout: options.timeoutMs, maxRetries: 2 });
    const system = options.messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const messages: Anthropic.Beta.BetaMessageParam[] = options.messages
        .filter(m => m.role !== 'system')
        .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));
    const useFallback = FALLBACK_MODELS.has(model);

    try {
        // Streaming: a full stylesheet can be a long response
        const stream = client.beta.messages.stream({
            model,
            max_tokens: 64000,
            system,
            messages,
            ...(supportsEffort(model) ? { output_config: { effort: 'high' as const } } : {}),
            ...(useFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        }, { signal: options.signal });
        const message = await stream.finalMessage();

        if (message.stop_reason === 'refusal') {
            throw new Error('The model declined this request. Try again or choose a different provider.');
        }
        if (message.stop_reason === 'max_tokens') {
            throw new Error('The AI response was cut off (output limit reached). The stylesheet may be too large for a full rewrite.');
        }
        const content = message.content
            .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
            .map(b => b.text)
            .join('');
        return {
            content,
            inputTokens: message.usage.input_tokens,
            outputTokens: message.usage.output_tokens,
        };
    } catch (error) {
        if (error instanceof Anthropic.APIUserAbortError) {
            throw new LlmCancelledError();
        }
        if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
            throw new Error('Invalid Anthropic API key. Update it with "UBL: Set AI API Key".');
        }
        if (error instanceof Anthropic.RateLimitError) {
            throw new Error('Anthropic rate limit reached. Wait a moment and try again.');
        }
        if (error instanceof Anthropic.APIConnectionTimeoutError) {
            throw new Error(`Anthropic request timed out after ${Math.round(options.timeoutMs / 1000)}s (setting: ublValidator.ai.timeoutSeconds).`);
        }
        if (error instanceof Anthropic.APIError) {
            throw new Error(`Anthropic API error${error.status ? ` (${error.status})` : ''}: ${error.message}`);
        }
        throw error;
    }
}

function callOpenAiCompatible(
    options: LlmCallOptions,
    model: string,
    hostname: string,
    path: string,
    maxTokensField: 'max_tokens' | 'max_completion_tokens'
): Promise<LlmResponse> {
    const body = JSON.stringify({
        model,
        messages: options.messages.map(m => ({ role: m.role, content: m.content })),
        [maxTokensField]: 16384,
    });

    return httpPost({
        hostname,
        path,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${options.apiKey}`,
        },
        body,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        parseResponse(data: any): LlmResponse {
            const choice = data.choices?.[0];
            if (choice?.finish_reason === 'length') {
                throw new Error('The AI response was cut off (output limit reached).');
            }
            return {
                content: choice?.message?.content ?? '',
                inputTokens: data.usage?.prompt_tokens ?? 0,
                outputTokens: data.usage?.completion_tokens ?? 0,
            };
        },
    });
}

interface HttpPostOptions {
    hostname: string;
    path: string;
    headers: Record<string, string>;
    body: string;
    timeoutMs: number;
    signal?: AbortSignal;
    parseResponse: (data: any) => LlmResponse;
}

function httpPost(options: HttpPostOptions): Promise<LlmResponse> {
    return new Promise((resolve, reject) => {
        if (options.signal?.aborted) {
            reject(new LlmCancelledError());
            return;
        }
        const req = https.request(
            {
                hostname: options.hostname,
                port: 443,
                path: options.path,
                method: 'POST',
                headers: {
                    ...options.headers,
                    'Content-Length': Buffer.byteLength(options.body),
                },
                timeout: options.timeoutMs,
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => {
                    const raw = Buffer.concat(chunks).toString('utf8');
                    const statusCode = res.statusCode ?? 0;

                    if (statusCode === 401 || statusCode === 403) {
                        reject(new Error('Invalid API key. Update it with "UBL: Set AI API Key".'));
                        return;
                    }
                    if (statusCode < 200 || statusCode >= 300) {
                        let detail = raw;
                        try {
                            const parsed = JSON.parse(raw);
                            const err = Array.isArray(parsed) ? parsed[0]?.error : parsed.error;
                            detail = err?.message || parsed.message || raw;
                        } catch { /* use raw */ }
                        reject(new Error(`API error (${statusCode}): ${detail}`));
                        return;
                    }
                    try {
                        resolve(options.parseResponse(JSON.parse(raw)));
                    } catch (e: any) {
                        reject(new Error(`Failed to parse API response: ${e.message}`));
                    }
                });
            }
        );

        const onAbort = () => req.destroy(new LlmCancelledError());
        options.signal?.addEventListener('abort', onAbort, { once: true });
        req.on('close', () => options.signal?.removeEventListener('abort', onAbort));
        req.on('timeout', () => req.destroy(new Error(
            `AI request timed out after ${Math.round(options.timeoutMs / 1000)}s (setting: ublValidator.ai.timeoutSeconds).`
        )));
        req.on('error', (e) => reject(e instanceof LlmCancelledError || /timed out/.test(e.message) ? e : new Error(`Network error: ${e.message}`)));
        req.write(options.body);
        req.end();
    });
}
