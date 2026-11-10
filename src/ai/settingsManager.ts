import * as vscode from 'vscode';
import { AiConfig, AiProvider } from './types';

const SECRET_KEY_PREFIX = 'ublValidator.ai.apiKey.';
const CONSENT_KEY_PREFIX = 'ublValidator.ai.consent.';

export const DEFAULT_PROVIDER: AiProvider = 'gemini';

export const PROVIDERS: Record<AiProvider, { name: string; placeholder: string; pricing: string }> = {
    gemini: { name: 'Google Gemini', placeholder: 'AIza...', pricing: 'Free tier available' },
    groq: { name: 'Groq', placeholder: 'gsk_...', pricing: 'Free tier available' },
    anthropic: { name: 'Anthropic Claude', placeholder: 'sk-ant-...', pricing: 'Paid' },
    openai: { name: 'OpenAI', placeholder: 'sk-...', pricing: 'Paid' },
};

export function getAiConfig(): AiConfig {
    const cfg = vscode.workspace.getConfiguration('ublValidator.ai');
    return {
        provider: cfg.get<AiProvider>('provider', DEFAULT_PROVIDER),
        model: cfg.get<string>('model', '').trim(),
        maxRetries: cfg.get<number>('maxRetries', 3),
        timeoutSeconds: cfg.get<number>('timeoutSeconds', 180),
        includeInputXml: cfg.get<boolean>('includeInputXml', true),
        maxInputXmlChars: cfg.get<number>('maxInputXmlChars', 50000),
    };
}

export async function storeApiKey(secrets: vscode.SecretStorage, provider: AiProvider, key: string): Promise<void> {
    await secrets.store(`${SECRET_KEY_PREFIX}${provider}`, key);
}

export async function getApiKey(secrets: vscode.SecretStorage, provider: AiProvider): Promise<string | undefined> {
    return secrets.get(`${SECRET_KEY_PREFIX}${provider}`);
}

export async function promptForApiKey(secrets: vscode.SecretStorage, provider: AiProvider): Promise<string | undefined> {
    const info = PROVIDERS[provider];
    const key = await vscode.window.showInputBox({
        title: `Enter ${info.name} API Key`,
        prompt: "Your API key is stored in VS Code's secret storage and never saved in plain text.",
        password: true,
        placeHolder: info.placeholder,
        ignoreFocusOut: true,
    });
    if (!key) {
        return undefined;
    }
    await storeApiKey(secrets, provider, key.trim());
    return key.trim();
}

export async function ensureApiKey(secrets: vscode.SecretStorage, provider: AiProvider): Promise<string | undefined> {
    return (await getApiKey(secrets, provider)) ?? promptForApiKey(secrets, provider);
}

export async function pickProvider(placeHolder: string): Promise<AiProvider | undefined> {
    const current = getAiConfig().provider;
    const items = (Object.keys(PROVIDERS) as AiProvider[]).map(p => ({
        label: PROVIDERS[p].name,
        description: `${PROVIDERS[p].pricing}${p === current ? ' · current' : ''}`,
        value: p,
    }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder });
    return pick?.value;
}

/** Makes `provider` the configured AI provider (user settings). */
export async function setProvider(provider: AiProvider): Promise<void> {
    await vscode.workspace.getConfiguration('ublValidator.ai').update('provider', provider, vscode.ConfigurationTarget.Global);
}

/**
 * Asks once per provider before sending data off the machine. Input XML is
 * typically a real invoice with names, VAT numbers and bank details.
 */
export async function ensureAiConsent(
    state: vscode.Memento,
    provider: AiProvider,
    config: AiConfig
): Promise<boolean> {
    const key = `${CONSENT_KEY_PREFIX}${provider}`;
    if (state.get<boolean>(key)) {
        return true;
    }
    const name = PROVIDERS[provider].name;
    const sent = config.includeInputXml
        ? 'the XSLT stylesheet, the validation error, a snippet of the generated output and the input XML'
        : 'the XSLT stylesheet, the validation error and a snippet of the generated output';
    const always = `Always Allow for ${name}`;
    const choice = await vscode.window.showWarningMessage(
        `AI Fix will send ${sent} to ${name}.`,
        {
            modal: true,
            detail: 'Input and output XML often contain personal and commercial data (names, addresses, VAT numbers, bank accounts). ' +
                'Set "ublValidator.ai.includeInputXml" to false to keep the input XML local.',
        },
        'Send', always
    );
    if (choice === always) {
        await state.update(key, true);
        return true;
    }
    return choice === 'Send';
}
