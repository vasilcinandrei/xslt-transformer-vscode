import { block, firstText, partyCountry } from '../rules/facts';
import { UblDocumentInfo } from '../validation/types';

export interface PeppolParty {
    role: 'sender' | 'receiver';
    /** UBL element the party was read from, e.g. AccountingSupplierParty */
    element?: string;
    /** EAS scheme from cbc:EndpointID/@schemeID, e.g. "0208" */
    scheme?: string;
    value?: string;
    /** Peppol participant identifier value, e.g. "0208:1035904075" */
    participantId?: string;
    name?: string;
    country?: string;
    problem?: string;
}

export interface PeppolDocument {
    rootElement: string;
    customizationId?: string;
    profileId?: string;
    /** busdox-docid-qns::<namespace>::<root>##<CustomizationID>::2.1 */
    documentTypeId?: string;
    /** cenbii-procid-ubl::<ProfileID> */
    processId?: string;
    sender: PeppolParty;
    receiver: PeppolParty;
}

/** Sending and receiving party elements per UBL document type (first match wins). */
const PARTY_ELEMENTS: Record<string, [string[], string[]]> = {
    Invoice: [['AccountingSupplierParty'], ['AccountingCustomerParty']],
    CreditNote: [['AccountingSupplierParty'], ['AccountingCustomerParty']],
    Order: [['BuyerCustomerParty'], ['SellerSupplierParty']],
    OrderChange: [['BuyerCustomerParty'], ['SellerSupplierParty']],
    OrderCancellation: [['BuyerCustomerParty'], ['SellerSupplierParty']],
    OrderResponse: [['SellerSupplierParty'], ['BuyerCustomerParty']],
    DespatchAdvice: [['DespatchSupplierParty'], ['DeliveryCustomerParty']],
    Catalogue: [['ProviderParty', 'SellerSupplierParty'], ['ReceiverParty', 'ContractorCustomerParty']],
    ApplicationResponse: [['SenderParty'], ['ReceiverParty']],
};
const DEFAULT_PARTIES: [string[], string[]] = [
    ['AccountingSupplierParty', 'SellerSupplierParty', 'SenderParty'],
    ['AccountingCustomerParty', 'BuyerCustomerParty', 'ReceiverParty'],
];

function readParty(content: string, role: PeppolParty['role'], candidates: string[]): PeppolParty {
    for (const element of candidates) {
        const party = block(content, element);
        if (!party) {
            continue;
        }
        const result: PeppolParty = {
            role,
            element,
            name: firstText(block(party, 'PartyName') ?? '', 'Name') ?? firstText(block(party, 'PartyLegalEntity') ?? '', 'RegistrationName'),
            country: partyCountry(party),
        };
        const endpoint = party.match(/<(?:[\w.-]+:)?EndpointID\b([^>]*)>([^<]*)</);
        if (!endpoint) {
            result.problem = 'No cbc:EndpointID, so this party cannot be addressed on the Peppol network.';
            return result;
        }
        result.scheme = endpoint[1].match(/schemeID\s*=\s*["']([^"']*)["']/)?.[1]?.trim();
        result.value = endpoint[2].trim();
        if (!result.scheme) {
            result.problem = 'cbc:EndpointID has no schemeID (the Peppol EAS code, e.g. 0208 or 9930).';
        } else if (!/^\d{4}$/.test(result.scheme)) {
            result.problem = `schemeID "${result.scheme}" is not a Peppol EAS code (four digits, e.g. 0208 or 9930).`;
        } else if (!result.value) {
            result.problem = 'cbc:EndpointID is empty.';
        } else {
            result.participantId = `${result.scheme}:${result.value}`;
        }
        return result;
    }
    return { role, problem: `No ${candidates.join(' / ')} element found.` };
}

/** Reads what a Peppol lookup needs: parties, document type and process. */
export function extractPeppolDocument(content: string, docInfo: UblDocumentInfo): PeppolDocument {
    const head = content.length > 2_000_000 ? content.slice(0, 2_000_000) : content;
    const [senders, receivers] = PARTY_ELEMENTS[docInfo.rootElement] ?? DEFAULT_PARTIES;
    const customizationId = firstText(head, 'CustomizationID');
    const profileId = firstText(head, 'ProfileID');
    return {
        rootElement: docInfo.rootElement,
        customizationId,
        profileId,
        documentTypeId: customizationId
            ? `busdox-docid-qns::${docInfo.namespace}::${docInfo.rootElement}##${customizationId}::2.1`
            : undefined,
        processId: profileId ? `cenbii-procid-ubl::${profileId}` : undefined,
        sender: readParty(head, 'sender', senders),
        receiver: readParty(head, 'receiver', receivers),
    };
}
