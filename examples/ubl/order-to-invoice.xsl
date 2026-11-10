<?xml version="1.0" encoding="UTF-8"?>
<!-- Maps examples/ubl/order.xml to a Peppol BIS Billing 3.0 UBL Invoice -->
<xsl:stylesheet version="2.0"
    xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
    xmlns:xs="http://www.w3.org/2001/XMLSchema"
    xmlns:f="urn:example:functions"
    xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
    xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
    xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
    exclude-result-prefixes="xs f">

    <xsl:include href="common.xsl"/>
    <xsl:output method="xml" indent="yes" encoding="UTF-8"/>

    <xsl:template match="/order">
        <xsl:variable name="cur" select="currency"/>
        <xsl:variable name="net" as="xs:decimal"
            select="sum(lines/line/(xs:decimal(quantity) * xs:decimal(unitPrice)))"/>
        <xsl:variable name="vat" as="xs:decimal"
            select="round-half-to-even($net * xs:decimal(lines/line[1]/vatRate) div 100, 2)"/>
        <Invoice>
            <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0</cbc:CustomizationID>
            <cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>
            <cbc:ID><xsl:value-of select="number"/></cbc:ID>
            <cbc:IssueDate><xsl:value-of select="date"/></cbc:IssueDate>
            <cbc:DueDate><xsl:value-of select="dueDate"/></cbc:DueDate>
            <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
            <cbc:DocumentCurrencyCode><xsl:value-of select="$cur"/></cbc:DocumentCurrencyCode>
            <cbc:BuyerReference><xsl:value-of select="buyerReference"/></cbc:BuyerReference>
            <cac:AccountingSupplierParty>
                <cac:Party>
                    <cbc:EndpointID schemeID="{seller/endpoint/@scheme}"><xsl:value-of select="seller/endpoint"/></cbc:EndpointID>
                    <cac:PartyName><cbc:Name><xsl:value-of select="seller/name"/></cbc:Name></cac:PartyName>
                    <xsl:call-template name="postal-address">
                        <xsl:with-param name="party" select="seller"/>
                    </xsl:call-template>
                    <cac:PartyTaxScheme>
                        <cbc:CompanyID><xsl:value-of select="seller/vat"/></cbc:CompanyID>
                        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
                    </cac:PartyTaxScheme>
                    <cac:PartyLegalEntity>
                        <cbc:RegistrationName><xsl:value-of select="seller/name"/></cbc:RegistrationName>
                        <cbc:CompanyID schemeID="{seller/endpoint/@scheme}"><xsl:value-of select="seller/endpoint"/></cbc:CompanyID>
                    </cac:PartyLegalEntity>
                </cac:Party>
            </cac:AccountingSupplierParty>
            <cac:AccountingCustomerParty>
                <cac:Party>
                    <cbc:EndpointID schemeID="{buyer/endpoint/@scheme}"><xsl:value-of select="buyer/endpoint"/></cbc:EndpointID>
                    <cac:PartyName><cbc:Name><xsl:value-of select="buyer/name"/></cbc:Name></cac:PartyName>
                    <xsl:call-template name="postal-address">
                        <xsl:with-param name="party" select="buyer"/>
                    </xsl:call-template>
                    <cac:PartyLegalEntity>
                        <cbc:RegistrationName><xsl:value-of select="buyer/name"/></cbc:RegistrationName>
                    </cac:PartyLegalEntity>
                </cac:Party>
            </cac:AccountingCustomerParty>
            <cac:PaymentMeans>
                <cbc:PaymentMeansCode>30</cbc:PaymentMeansCode>
                <cac:PayeeFinancialAccount><cbc:ID><xsl:value-of select="seller/iban"/></cbc:ID></cac:PayeeFinancialAccount>
            </cac:PaymentMeans>
            <cac:TaxTotal>
                <cbc:TaxAmount currencyID="{$cur}"><xsl:value-of select="f:amount($vat)"/></cbc:TaxAmount>
                <cac:TaxSubtotal>
                    <cbc:TaxableAmount currencyID="{$cur}"><xsl:value-of select="f:amount($net)"/></cbc:TaxableAmount>
                    <cbc:TaxAmount currencyID="{$cur}"><xsl:value-of select="f:amount($vat)"/></cbc:TaxAmount>
                    <cac:TaxCategory>
                        <cbc:ID>S</cbc:ID>
                        <cbc:Percent><xsl:value-of select="lines/line[1]/vatRate"/></cbc:Percent>
                        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
                    </cac:TaxCategory>
                </cac:TaxSubtotal>
            </cac:TaxTotal>
            <cac:LegalMonetaryTotal>
                <cbc:LineExtensionAmount currencyID="{$cur}"><xsl:value-of select="f:amount($net)"/></cbc:LineExtensionAmount>
                <cbc:TaxExclusiveAmount currencyID="{$cur}"><xsl:value-of select="f:amount($net)"/></cbc:TaxExclusiveAmount>
                <cbc:TaxInclusiveAmount currencyID="{$cur}"><xsl:value-of select="f:amount($net + $vat)"/></cbc:TaxInclusiveAmount>
                <cbc:PayableAmount currencyID="{$cur}"><xsl:value-of select="f:amount($net + $vat)"/></cbc:PayableAmount>
            </cac:LegalMonetaryTotal>
            <xsl:for-each select="lines/line">
                <cac:InvoiceLine>
                    <cbc:ID><xsl:value-of select="position()"/></cbc:ID>
                    <cbc:InvoicedQuantity unitCode="C62"><xsl:value-of select="quantity"/></cbc:InvoicedQuantity>
                    <cbc:LineExtensionAmount currencyID="{$cur}"><xsl:value-of select="f:amount(xs:decimal(quantity) * xs:decimal(unitPrice))"/></cbc:LineExtensionAmount>
                    <cac:Item>
                        <cbc:Name><xsl:value-of select="description"/></cbc:Name>
                        <cac:ClassifiedTaxCategory>
                            <cbc:ID>S</cbc:ID>
                            <cbc:Percent><xsl:value-of select="vatRate"/></cbc:Percent>
                            <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
                        </cac:ClassifiedTaxCategory>
                    </cac:Item>
                    <cac:Price><cbc:PriceAmount currencyID="{$cur}"><xsl:value-of select="unitPrice"/></cbc:PriceAmount></cac:Price>
                </cac:InvoiceLine>
            </xsl:for-each>
        </Invoice>
    </xsl:template>
</xsl:stylesheet>
