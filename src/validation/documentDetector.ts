import { UblDocumentInfo } from './types';
import { scanStartTags } from '../tracing/xmlTokenizer';

const UBL_21_NS = 'urn:oasis:names:specification:ubl:schema:xsd:';

const UBL_DOCUMENT_TYPES: Record<string, string> = {
    'ApplicationResponse': 'ApplicationResponse-2',
    'AttachedDocument': 'AttachedDocument-2',
    'AwardedNotification': 'AwardedNotification-2',
    'BillOfLading': 'BillOfLading-2',
    'CallForTenders': 'CallForTenders-2',
    'Catalogue': 'Catalogue-2',
    'CatalogueDeletion': 'CatalogueDeletion-2',
    'CatalogueItemSpecificationUpdate': 'CatalogueItemSpecificationUpdate-2',
    'CataloguePricingUpdate': 'CataloguePricingUpdate-2',
    'CatalogueRequest': 'CatalogueRequest-2',
    'CertificateOfOrigin': 'CertificateOfOrigin-2',
    'ContractAwardNotice': 'ContractAwardNotice-2',
    'ContractNotice': 'ContractNotice-2',
    'CreditNote': 'CreditNote-2',
    'DebitNote': 'DebitNote-2',
    'DespatchAdvice': 'DespatchAdvice-2',
    'DigitalAgreement': 'DigitalAgreement-2',
    'DigitalCapability': 'DigitalCapability-2',
    'DocumentStatus': 'DocumentStatus-2',
    'DocumentStatusRequest': 'DocumentStatusRequest-2',
    'EnquiryResponse': 'EnquiryResponse-2',
    'Enquiry': 'Enquiry-2',
    'ExceptionCriteria': 'ExceptionCriteria-2',
    'ExceptionNotification': 'ExceptionNotification-2',
    'ExpressionOfInterestRequest': 'ExpressionOfInterestRequest-2',
    'ExpressionOfInterestResponse': 'ExpressionOfInterestResponse-2',
    'ForecastRevision': 'ForecastRevision-2',
    'Forecast': 'Forecast-2',
    'FreightInvoice': 'FreightInvoice-2',
    'FulfilmentCancellation': 'FulfilmentCancellation-2',
    'GoodsItemItinerary': 'GoodsItemItinerary-2',
    'GuaranteeCertificate': 'GuaranteeCertificate-2',
    'InstructionForReturns': 'InstructionForReturns-2',
    'InventoryReport': 'InventoryReport-2',
    'Invoice': 'Invoice-2',
    'ItemInformationRequest': 'ItemInformationRequest-2',
    'Order': 'Order-2',
    'OrderCancellation': 'OrderCancellation-2',
    'OrderChange': 'OrderChange-2',
    'OrderResponse': 'OrderResponse-2',
    'OrderResponseSimple': 'OrderResponseSimple-2',
    'PackingList': 'PackingList-2',
    'PriorInformationNotice': 'PriorInformationNotice-2',
    'ProductActivity': 'ProductActivity-2',
    'Quotation': 'Quotation-2',
    'ReceiptAdvice': 'ReceiptAdvice-2',
    'Reminder': 'Reminder-2',
    'RemittanceAdvice': 'RemittanceAdvice-2',
    'RequestForQuotation': 'RequestForQuotation-2',
    'RetailEvent': 'RetailEvent-2',
    'SelfBilledCreditNote': 'SelfBilledCreditNote-2',
    'SelfBilledInvoice': 'SelfBilledInvoice-2',
    'Statement': 'Statement-2',
    'StockAvailabilityReport': 'StockAvailabilityReport-2',
    'Tender': 'Tender-2',
    'TendererQualification': 'TendererQualification-2',
    'TendererQualificationResponse': 'TendererQualificationResponse-2',
    'TenderReceipt': 'TenderReceipt-2',
    'TenderStatus': 'TenderStatus-2',
    'TenderStatusRequest': 'TenderStatusRequest-2',
    'TenderWithdrawal': 'TenderWithdrawal-2',
    'TradeItemLocationProfile': 'TradeItemLocationProfile-2',
    'TransportationStatus': 'TransportationStatus-2',
    'TransportationStatusRequest': 'TransportationStatusRequest-2',
    'TransportExecutionPlan': 'TransportExecutionPlan-2',
    'TransportExecutionPlanRequest': 'TransportExecutionPlanRequest-2',
    'TransportProgressStatus': 'TransportProgressStatus-2',
    'TransportProgressStatusRequest': 'TransportProgressStatusRequest-2',
    'TransportServiceDescription': 'TransportServiceDescription-2',
    'TransportServiceDescriptionRequest': 'TransportServiceDescriptionRequest-2',
    'UnawardedNotification': 'UnawardedNotification-2',
    'UnsubscribeFromProcedureRequest': 'UnsubscribeFromProcedureRequest-2',
    'UnsubscribeFromProcedureResponse': 'UnsubscribeFromProcedureResponse-2',
    'UtilityStatement': 'UtilityStatement-2',
    'Waybill': 'Waybill-2',
    'WeightStatement': 'WeightStatement-2',
};

const INVOICE_OR_CREDIT_NOTE = new Set(['Invoice', 'CreditNote']);

export function isUblRootElement(localName: string): boolean {
    return Object.prototype.hasOwnProperty.call(UBL_DOCUMENT_TYPES, localName);
}

/**
 * Detects a UBL 2.x document from its root element: the local name must be a
 * UBL document type and its namespace must be the matching UBL namespace.
 */
export function detectUblDocumentFromContent(content: string): UblDocumentInfo | null {
    // The root start tag is near the top; don't scan huge documents in full
    const root = scanStartTags(content.substring(0, 64 * 1024))[0];
    if (!root) {
        return null;
    }

    const rootElement = root.localName;
    const xsdName = UBL_DOCUMENT_TYPES[rootElement];
    if (!xsdName) {
        return null;
    }

    const namespace = `${UBL_21_NS}${rootElement}-2`;
    if (root.namespace !== namespace) {
        return null;
    }

    return {
        rootElement,
        namespace,
        documentType: xsdName,
        isInvoiceOrCreditNote: INVOICE_OR_CREDIT_NOTE.has(rootElement),
    };
}
