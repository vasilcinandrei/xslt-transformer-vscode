import { DocumentFacts } from './types';

const P = '(?:[\\w.-]+:)?';

export function firstText(content: string, localName: string): string | undefined {
    const m = content.match(new RegExp(`<${P}${localName}\\b[^>]*>([^<]*)</${P}${localName}>`));
    const v = m?.[1].trim();
    return v || undefined;
}

export function block(content: string, localName: string): string | undefined {
    const open = content.search(new RegExp(`<${P}${localName}[\\s>]`));
    if (open < 0) {
        return undefined;
    }
    const closeRe = new RegExp(`</${P}${localName}\\s*>`, 'g');
    closeRe.lastIndex = open;
    const close = closeRe.exec(content);
    return content.slice(open, close ? close.index : undefined);
}

/** Country of a party: postal address first, then the VAT number prefix (EL → GR). */
export function partyCountry(party: string | undefined): string | undefined {
    if (!party) {
        return undefined;
    }
    const address = block(party, 'PostalAddress');
    const country = address?.match(new RegExp(`<${P}Country\\b[^>]*>\\s*<${P}IdentificationCode\\b[^>]*>\\s*([A-Za-z]{2})\\s*<`));
    if (country) {
        return country[1].toUpperCase();
    }
    const taxScheme = block(party, 'PartyTaxScheme');
    const vat = taxScheme && firstText(taxScheme, 'CompanyID');
    const prefix = vat?.match(/^([A-Za-z]{2})/)?.[1].toUpperCase();
    return prefix === 'EL' ? 'GR' : prefix;
}

/** Reads the values that decide which business rules apply. */
export function extractFacts(content: string, rootElement: string): DocumentFacts {
    // The header elements come before any lines/attachments; avoid scanning huge payloads
    const head = content.length > 2_000_000 ? content.slice(0, 2_000_000) : content;
    return {
        rootElement,
        customizationId: firstText(head, 'CustomizationID'),
        profileId: firstText(head, 'ProfileID'),
        sellerCountry: partyCountry(block(head, 'AccountingSupplierParty') ?? block(head, 'SellerSupplierParty')),
        buyerCountry: partyCountry(block(head, 'AccountingCustomerParty') ?? block(head, 'BuyerCustomerParty')),
    };
}
