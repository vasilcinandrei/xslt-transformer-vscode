<?xml version="1.0" encoding="UTF-8"?>
<!--
  Renders a UBL 2.x document as an HTML fragment for the UBL Preview panel.
  Rich view for Invoice and CreditNote; header and parties for other types.
  Text is always output escaped; no attribute takes a URL from the document.
-->
<xsl:stylesheet version="2.0"
    xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
    xmlns:xs="http://www.w3.org/2001/XMLSchema"
    xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
    xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
    xmlns:p="urn:x-ubl-validator:preview"
    exclude-result-prefixes="xs cac cbc p">

    <xsl:output method="html" encoding="UTF-8" indent="no"/>

    <xsl:variable name="root" select="/*"/>
    <xsl:variable name="type" select="local-name($root)"/>
    <xsl:variable name="isCredit" select="$type = 'CreditNote'"/>
    <xsl:variable name="currency" select="string($root/cbc:DocumentCurrencyCode)"/>

    <!-- ─── Code lists (most common values) ─────────────────────────── -->

    <xsl:function name="p:docTypeName" as="xs:string">
        <xsl:param name="code" as="xs:string"/>
        <xsl:sequence select="
            if ($code = '380') then 'Commercial invoice'
            else if ($code = '381') then 'Credit note'
            else if ($code = '383') then 'Debit note'
            else if ($code = '384') then 'Corrected invoice'
            else if ($code = '386') then 'Prepayment invoice'
            else if ($code = '389') then 'Self-billed invoice'
            else if ($code = '326') then 'Partial invoice'
            else if ($code = '261') then 'Self-billed credit note'
            else if ($code = '751') then 'Invoice information'
            else ''"/>
    </xsl:function>

    <xsl:function name="p:vatCategory" as="xs:string">
        <xsl:param name="code" as="xs:string"/>
        <xsl:sequence select="
            if ($code = 'S') then 'Standard rate'
            else if ($code = 'Z') then 'Zero rated'
            else if ($code = 'E') then 'Exempt'
            else if ($code = 'AE') then 'Reverse charge'
            else if ($code = 'K') then 'Intra-community supply'
            else if ($code = 'G') then 'Export outside the EU'
            else if ($code = 'O') then 'Outside scope of VAT'
            else if ($code = 'L') then 'Canary Islands IGIC'
            else if ($code = 'M') then 'Ceuta and Melilla IPSI'
            else if ($code = 'B') then 'Split payment'
            else ''"/>
    </xsl:function>

    <xsl:function name="p:paymentMeans" as="xs:string">
        <xsl:param name="code" as="xs:string"/>
        <xsl:sequence select="
            if ($code = '1') then 'Not defined'
            else if ($code = '10') then 'Cash'
            else if ($code = '20') then 'Cheque'
            else if ($code = '30') then 'Credit transfer'
            else if ($code = '31') then 'Debit transfer'
            else if ($code = '42') then 'Payment to bank account'
            else if ($code = '48') then 'Bank card'
            else if ($code = '49') then 'Direct debit'
            else if ($code = '54') then 'Credit card'
            else if ($code = '55') then 'Debit card'
            else if ($code = '57') then 'Standing agreement'
            else if ($code = '58') then 'SEPA credit transfer'
            else if ($code = '59') then 'SEPA direct debit'
            else if ($code = '68') then 'Online payment service'
            else if ($code = 'ZZZ') then 'Mutually defined'
            else ''"/>
    </xsl:function>

    <xsl:function name="p:unit" as="xs:string">
        <xsl:param name="code" as="xs:string"/>
        <xsl:sequence select="
            if ($code = ('C62', 'H87', 'EA', 'XPP')) then 'pcs'
            else if ($code = 'HUR') then 'h'
            else if ($code = 'DAY') then 'day'
            else if ($code = 'WEE') then 'week'
            else if ($code = 'MON') then 'month'
            else if ($code = 'ANN') then 'year'
            else if ($code = 'MIN') then 'min'
            else if ($code = 'KGM') then 'kg'
            else if ($code = 'GRM') then 'g'
            else if ($code = 'TNE') then 't'
            else if ($code = 'MTR') then 'm'
            else if ($code = 'KMT') then 'km'
            else if ($code = 'MTK') then 'm²'
            else if ($code = 'MTQ') then 'm³'
            else if ($code = 'LTR') then 'l'
            else if ($code = 'KWH') then 'kWh'
            else if ($code = 'SET') then 'set'
            else if ($code = 'PR') then 'pair'
            else if ($code = 'LS') then 'lump sum'
            else $code"/>
    </xsl:function>

    <xsl:function name="p:amount" as="xs:string">
        <xsl:param name="node" as="node()?"/>
        <xsl:sequence select="
            if (empty($node) or normalize-space($node) = '') then ''
            else if (string(number($node)) = 'NaN') then string($node)
            else concat(format-number(number($node), '#,##0.00##'),
                        if ($node/@currencyID and string($node/@currencyID) != $currency) then concat(' ', $node/@currencyID) else '')"/>
    </xsl:function>

    <xsl:function name="p:qty" as="xs:string">
        <xsl:param name="node" as="node()?"/>
        <xsl:sequence select="
            if (empty($node)) then ''
            else if (string(number($node)) = 'NaN') then string($node)
            else format-number(number($node), '#,##0.####')"/>
    </xsl:function>

    <!-- ─── Page ───────────────────────────────────────────────────── -->

    <xsl:template match="/">
        <div class="ubl-doc">
            <xsl:choose>
                <xsl:when test="$type = ('Invoice', 'CreditNote')">
                    <xsl:call-template name="invoice"/>
                </xsl:when>
                <xsl:otherwise>
                    <xsl:call-template name="generic"/>
                </xsl:otherwise>
            </xsl:choose>
        </div>
    </xsl:template>

    <xsl:template name="invoice">
        <xsl:variable name="typeCode" select="string(($root/cbc:InvoiceTypeCode, $root/cbc:CreditNoteTypeCode)[1])"/>
        <header class="title">
            <div>
                <h1>
                    <xsl:value-of select="if (p:docTypeName($typeCode) != '') then p:docTypeName($typeCode) else ($type)"/>
                    <xsl:text> </xsl:text>
                    <span class="docid"><xsl:value-of select="$root/cbc:ID"/></span>
                </h1>
                <div class="muted">
                    <xsl:if test="$typeCode != ''">Type code <xsl:value-of select="$typeCode"/></xsl:if>
                    <xsl:if test="$currency != ''"> · Currency <xsl:value-of select="$currency"/></xsl:if>
                    <xsl:if test="$root/cbc:TaxCurrencyCode"> · VAT currency <xsl:value-of select="$root/cbc:TaxCurrencyCode"/></xsl:if>
                </div>
            </div>
            <table class="facts">
                <xsl:call-template name="fact"><xsl:with-param name="label">Issue date</xsl:with-param><xsl:with-param name="value" select="$root/cbc:IssueDate"/></xsl:call-template>
                <xsl:call-template name="fact"><xsl:with-param name="label">Due date</xsl:with-param><xsl:with-param name="value" select="($root/cbc:DueDate, $root/cac:PaymentMeans/cbc:PaymentDueDate)[1]"/></xsl:call-template>
                <xsl:call-template name="fact"><xsl:with-param name="label">Tax point date</xsl:with-param><xsl:with-param name="value" select="$root/cbc:TaxPointDate"/></xsl:call-template>
                <xsl:call-template name="fact"><xsl:with-param name="label">Buyer reference</xsl:with-param><xsl:with-param name="value" select="$root/cbc:BuyerReference"/></xsl:call-template>
                <xsl:call-template name="fact"><xsl:with-param name="label">Order</xsl:with-param><xsl:with-param name="value" select="$root/cac:OrderReference/cbc:ID"/></xsl:call-template>
                <xsl:call-template name="fact"><xsl:with-param name="label">Sales order</xsl:with-param><xsl:with-param name="value" select="$root/cac:OrderReference/cbc:SalesOrderID"/></xsl:call-template>
                <xsl:call-template name="fact"><xsl:with-param name="label">Contract</xsl:with-param><xsl:with-param name="value" select="$root/cac:ContractDocumentReference/cbc:ID"/></xsl:call-template>
                <xsl:call-template name="fact"><xsl:with-param name="label">Project</xsl:with-param><xsl:with-param name="value" select="$root/cac:ProjectReference/cbc:ID"/></xsl:call-template>
                <xsl:call-template name="fact"><xsl:with-param name="label">Accounting cost</xsl:with-param><xsl:with-param name="value" select="$root/cbc:AccountingCost"/></xsl:call-template>
                <xsl:for-each select="$root/cac:BillingReference/cac:InvoiceDocumentReference">
                    <xsl:call-template name="fact">
                        <xsl:with-param name="label">Preceding invoice</xsl:with-param>
                        <xsl:with-param name="value" select="string-join((cbc:ID, cbc:IssueDate), ' of ')"/>
                    </xsl:call-template>
                </xsl:for-each>
                <xsl:for-each select="$root/cac:InvoicePeriod">
                    <xsl:call-template name="fact">
                        <xsl:with-param name="label">Period</xsl:with-param>
                        <xsl:with-param name="value" select="string-join((cbc:StartDate, cbc:EndDate), ' – ')"/>
                    </xsl:call-template>
                </xsl:for-each>
            </table>
        </header>

        <section class="parties">
            <xsl:call-template name="party">
                <xsl:with-param name="title">Seller</xsl:with-param>
                <xsl:with-param name="party" select="$root/cac:AccountingSupplierParty/cac:Party"/>
            </xsl:call-template>
            <xsl:call-template name="party">
                <xsl:with-param name="title">Buyer</xsl:with-param>
                <xsl:with-param name="party" select="$root/cac:AccountingCustomerParty/cac:Party"/>
            </xsl:call-template>
            <xsl:if test="$root/cac:PayeeParty">
                <xsl:call-template name="party">
                    <xsl:with-param name="title">Payee</xsl:with-param>
                    <xsl:with-param name="party" select="$root/cac:PayeeParty"/>
                </xsl:call-template>
            </xsl:if>
            <xsl:if test="$root/cac:TaxRepresentativeParty">
                <xsl:call-template name="party">
                    <xsl:with-param name="title">Seller tax representative</xsl:with-param>
                    <xsl:with-param name="party" select="$root/cac:TaxRepresentativeParty"/>
                </xsl:call-template>
            </xsl:if>
            <xsl:for-each select="$root/cac:Delivery">
                <div class="party">
                    <h3>Delivery</h3>
                    <xsl:if test="cac:DeliveryParty/cac:PartyName/cbc:Name"><div class="name"><xsl:value-of select="cac:DeliveryParty/cac:PartyName/cbc:Name"/></div></xsl:if>
                    <xsl:if test="cbc:ActualDeliveryDate"><div>Date: <xsl:value-of select="cbc:ActualDeliveryDate"/></div></xsl:if>
                    <xsl:call-template name="address"><xsl:with-param name="a" select="cac:DeliveryLocation/cac:Address"/></xsl:call-template>
                    <xsl:if test="cac:DeliveryLocation/cbc:ID"><div class="muted">Location <xsl:value-of select="cac:DeliveryLocation/cbc:ID"/></div></xsl:if>
                </div>
            </xsl:for-each>
        </section>

        <xsl:if test="$root/cbc:Note">
            <section class="notes">
                <xsl:for-each select="$root/cbc:Note"><p><xsl:value-of select="."/></p></xsl:for-each>
            </section>
        </xsl:if>

        <xsl:call-template name="lines"/>

        <xsl:if test="$root/cac:AllowanceCharge">
            <h2>Document allowances and charges</h2>
            <table class="grid">
                <thead><tr><th>Type</th><th>Reason</th><th>VAT</th><th class="num">Base</th><th class="num">%</th><th class="num">Amount</th></tr></thead>
                <tbody>
                    <xsl:for-each select="$root/cac:AllowanceCharge">
                        <tr>
                            <td><xsl:value-of select="if (cbc:ChargeIndicator = 'true') then 'Charge' else 'Allowance'"/></td>
                            <td><xsl:value-of select="string-join((cbc:AllowanceChargeReasonCode, cbc:AllowanceChargeReason), ' – ')"/></td>
                            <td><xsl:value-of select="string-join((cac:TaxCategory/cbc:ID, cac:TaxCategory/cbc:Percent/concat(., '%')), ' ')"/></td>
                            <td class="num"><xsl:value-of select="p:amount(cbc:BaseAmount)"/></td>
                            <td class="num"><xsl:value-of select="cbc:MultiplierFactorNumeric"/></td>
                            <td class="num"><xsl:value-of select="(if (cbc:ChargeIndicator = 'true') then '' else '−'), p:amount(cbc:Amount)" separator=""/></td>
                        </tr>
                    </xsl:for-each>
                </tbody>
            </table>
        </xsl:if>

        <section class="bottom">
            <div class="vat">
                <h2>VAT breakdown</h2>
                <table class="grid">
                    <thead><tr><th>Category</th><th class="num">Rate</th><th class="num">Taxable</th><th class="num">VAT</th></tr></thead>
                    <tbody>
                        <xsl:for-each select="$root/cac:TaxTotal[cac:TaxSubtotal]/cac:TaxSubtotal">
                            <tr>
                                <td>
                                    <xsl:value-of select="cac:TaxCategory/cbc:ID"/>
                                    <xsl:variable name="cat" select="p:vatCategory(string(cac:TaxCategory/cbc:ID))"/>
                                    <xsl:if test="$cat != ''"><span class="muted"> · <xsl:value-of select="$cat"/></span></xsl:if>
                                    <xsl:for-each select="cac:TaxCategory/(cbc:TaxExemptionReason, cbc:TaxExemptionReasonCode)">
                                        <div class="muted small"><xsl:value-of select="."/></div>
                                    </xsl:for-each>
                                </td>
                                <td class="num"><xsl:if test="cac:TaxCategory/cbc:Percent"><xsl:value-of select="cac:TaxCategory/cbc:Percent"/>%</xsl:if></td>
                                <td class="num"><xsl:value-of select="p:amount(cbc:TaxableAmount)"/></td>
                                <td class="num"><xsl:value-of select="p:amount(cbc:TaxAmount)"/></td>
                            </tr>
                        </xsl:for-each>
                    </tbody>
                </table>
                <xsl:call-template name="payment"/>
            </div>
            <div class="totals">
                <h2>Totals</h2>
                <xsl:variable name="t" select="$root/cac:LegalMonetaryTotal"/>
                <table class="sum">
                    <xsl:call-template name="sum"><xsl:with-param name="label">Sum of lines</xsl:with-param><xsl:with-param name="v" select="$t/cbc:LineExtensionAmount"/></xsl:call-template>
                    <xsl:call-template name="sum"><xsl:with-param name="label">Allowances</xsl:with-param><xsl:with-param name="v" select="$t/cbc:AllowanceTotalAmount"/><xsl:with-param name="sign">−</xsl:with-param></xsl:call-template>
                    <xsl:call-template name="sum"><xsl:with-param name="label">Charges</xsl:with-param><xsl:with-param name="v" select="$t/cbc:ChargeTotalAmount"/></xsl:call-template>
                    <xsl:call-template name="sum"><xsl:with-param name="label">Total without VAT</xsl:with-param><xsl:with-param name="v" select="$t/cbc:TaxExclusiveAmount"/></xsl:call-template>
                    <xsl:for-each select="$root/cac:TaxTotal">
                        <xsl:call-template name="sum">
                            <xsl:with-param name="label" select="if (cbc:TaxAmount/@currencyID != $currency) then concat('VAT (', cbc:TaxAmount/@currencyID, ')') else 'VAT'"/>
                            <xsl:with-param name="v" select="cbc:TaxAmount"/>
                        </xsl:call-template>
                    </xsl:for-each>
                    <xsl:call-template name="sum"><xsl:with-param name="label">Total with VAT</xsl:with-param><xsl:with-param name="v" select="$t/cbc:TaxInclusiveAmount"/></xsl:call-template>
                    <xsl:call-template name="sum"><xsl:with-param name="label">Prepaid</xsl:with-param><xsl:with-param name="v" select="$t/cbc:PrepaidAmount"/><xsl:with-param name="sign">−</xsl:with-param></xsl:call-template>
                    <xsl:call-template name="sum"><xsl:with-param name="label">Rounding</xsl:with-param><xsl:with-param name="v" select="$t/cbc:PayableRoundingAmount"/></xsl:call-template>
                    <tr class="due">
                        <td><xsl:value-of select="if ($isCredit) then 'Amount to credit' else 'Amount due'"/></td>
                        <td class="num"><xsl:value-of select="p:amount($t/cbc:PayableAmount)"/><xsl:text> </xsl:text><xsl:value-of select="$currency"/></td>
                    </tr>
                </table>
            </div>
        </section>

        <xsl:call-template name="references"/>
    </xsl:template>

    <xsl:template name="lines">
        <xsl:variable name="lines" select="$root/(cac:InvoiceLine, cac:CreditNoteLine)"/>
        <h2>Lines <span class="muted">(<xsl:value-of select="count($lines)"/>)</span></h2>
        <table class="grid lines">
            <thead>
                <tr><th>#</th><th>Item</th><th class="num">Quantity</th><th class="num">Price</th><th>VAT</th><th class="num">Net amount</th></tr>
            </thead>
            <tbody>
                <xsl:for-each select="$lines">
                    <xsl:variable name="qty" select="(cbc:InvoicedQuantity, cbc:CreditedQuantity)[1]"/>
                    <tr>
                        <td class="muted"><xsl:value-of select="cbc:ID"/></td>
                        <td>
                            <div class="name"><xsl:value-of select="cac:Item/cbc:Name"/></div>
                            <xsl:if test="cac:Item/cbc:Description"><div class="muted small"><xsl:value-of select="cac:Item/cbc:Description"/></div></xsl:if>
                            <xsl:variable name="ids" select="(
                                cac:Item/cac:SellersItemIdentification/cbc:ID/concat('Seller item ', .),
                                cac:Item/cac:BuyersItemIdentification/cbc:ID/concat('Buyer item ', .),
                                cac:Item/cac:StandardItemIdentification/cbc:ID/concat('GTIN/std ', .),
                                cac:Item/cac:CommodityClassification/cbc:ItemClassificationCode/concat('Class ', .),
                                cac:OrderLineReference/cbc:LineID/concat('Order line ', .),
                                cac:InvoicePeriod/concat('Period ', string-join((cbc:StartDate, cbc:EndDate), ' – ')),
                                cbc:AccountingCost/concat('Cost ', .))"/>
                            <xsl:if test="exists($ids)"><div class="muted small"><xsl:value-of select="$ids" separator=" · "/></div></xsl:if>
                            <xsl:for-each select="cac:Item/cac:AdditionalItemProperty">
                                <div class="muted small"><xsl:value-of select="cbc:Name"/>: <xsl:value-of select="cbc:Value"/></div>
                            </xsl:for-each>
                            <xsl:for-each select="cac:AllowanceCharge">
                                <div class="small">
                                    <xsl:value-of select="if (cbc:ChargeIndicator = 'true') then 'Charge' else 'Allowance'"/>
                                    <xsl:if test="cbc:AllowanceChargeReason"> (<xsl:value-of select="cbc:AllowanceChargeReason"/>)</xsl:if>:
                                    <xsl:value-of select="(if (cbc:ChargeIndicator = 'true') then '+' else '−'), p:amount(cbc:Amount)" separator=""/>
                                </div>
                            </xsl:for-each>
                            <xsl:for-each select="cbc:Note"><div class="muted small"><xsl:value-of select="."/></div></xsl:for-each>
                        </td>
                        <td class="num">
                            <xsl:value-of select="p:qty($qty)"/>
                            <xsl:if test="$qty/@unitCode"><span class="muted"><xsl:text> </xsl:text><xsl:value-of select="p:unit(string($qty/@unitCode))"/></span></xsl:if>
                        </td>
                        <td class="num">
                            <xsl:value-of select="p:amount(cac:Price/cbc:PriceAmount)"/>
                            <xsl:if test="cac:Price/cbc:BaseQuantity and number(cac:Price/cbc:BaseQuantity) != 1">
                                <span class="muted"> / <xsl:value-of select="p:qty(cac:Price/cbc:BaseQuantity)"/></span>
                            </xsl:if>
                            <xsl:if test="cac:Price/cac:AllowanceCharge/cbc:BaseAmount">
                                <div class="muted small">gross <xsl:value-of select="p:amount(cac:Price/cac:AllowanceCharge/cbc:BaseAmount)"/></div>
                            </xsl:if>
                        </td>
                        <td>
                            <xsl:value-of select="cac:Item/cac:ClassifiedTaxCategory/cbc:ID"/>
                            <xsl:if test="cac:Item/cac:ClassifiedTaxCategory/cbc:Percent"><xsl:text> </xsl:text><xsl:value-of select="cac:Item/cac:ClassifiedTaxCategory/cbc:Percent"/>%</xsl:if>
                        </td>
                        <td class="num"><xsl:value-of select="p:amount(cbc:LineExtensionAmount)"/></td>
                    </tr>
                </xsl:for-each>
            </tbody>
        </table>
    </xsl:template>

    <xsl:template name="payment">
        <xsl:if test="$root/(cac:PaymentMeans, cac:PaymentTerms)">
            <h2>Payment</h2>
            <xsl:for-each select="$root/cac:PaymentMeans">
                <div class="pay">
                    <xsl:variable name="m" select="p:paymentMeans(string(cbc:PaymentMeansCode))"/>
                    <div class="name">
                        <xsl:value-of select="if ($m != '') then $m else concat('Payment means ', cbc:PaymentMeansCode)"/>
                        <xsl:if test="cbc:PaymentMeansCode/@name"> (<xsl:value-of select="cbc:PaymentMeansCode/@name"/>)</xsl:if>
                    </div>
                    <xsl:for-each select="cac:PayeeFinancialAccount">
                        <div>IBAN/account: <span class="mono"><xsl:value-of select="cbc:ID"/></span>
                            <xsl:if test="cac:FinancialInstitutionBranch/cbc:ID"> · BIC <span class="mono"><xsl:value-of select="cac:FinancialInstitutionBranch/cbc:ID"/></span></xsl:if>
                        </div>
                        <xsl:if test="cbc:Name"><div class="muted">Account name: <xsl:value-of select="cbc:Name"/></div></xsl:if>
                    </xsl:for-each>
                    <xsl:if test="cbc:PaymentID"><div>Payment reference: <span class="mono"><xsl:value-of select="cbc:PaymentID"/></span></div></xsl:if>
                    <xsl:for-each select="cac:CardAccount"><div>Card: <span class="mono"><xsl:value-of select="cbc:PrimaryAccountNumberID"/></span> <xsl:value-of select="cbc:NetworkID"/></div></xsl:for-each>
                    <xsl:for-each select="cac:PaymentMandate">
                        <div>Mandate <span class="mono"><xsl:value-of select="cbc:ID"/></span>
                            <xsl:if test="cac:PayerFinancialAccount/cbc:ID"> · debited account <span class="mono"><xsl:value-of select="cac:PayerFinancialAccount/cbc:ID"/></span></xsl:if>
                        </div>
                    </xsl:for-each>
                </div>
            </xsl:for-each>
            <xsl:for-each select="$root/cac:PaymentTerms/cbc:Note"><p class="muted"><xsl:value-of select="."/></p></xsl:for-each>
        </xsl:if>
    </xsl:template>

    <xsl:template name="references">
        <xsl:variable name="refs" select="$root/(cac:AdditionalDocumentReference, cac:DespatchDocumentReference, cac:ReceiptDocumentReference, cac:OriginatorDocumentReference)"/>
        <xsl:if test="$refs">
            <h2>Referenced documents</h2>
            <table class="grid">
                <thead><tr><th>Reference</th><th>Description</th><th>Content</th></tr></thead>
                <tbody>
                    <xsl:for-each select="$refs">
                        <tr>
                            <td>
                                <span class="mono"><xsl:value-of select="cbc:ID"/></span>
                                <div class="muted small"><xsl:value-of select="local-name()"/><xsl:if test="cbc:DocumentTypeCode"> · type <xsl:value-of select="cbc:DocumentTypeCode"/></xsl:if></div>
                            </td>
                            <td><xsl:value-of select="cbc:DocumentDescription"/></td>
                            <td>
                                <xsl:for-each select="cac:Attachment/cbc:EmbeddedDocumentBinaryObject">
                                    Embedded <xsl:value-of select="@mimeCode"/><xsl:if test="@filename"> · <xsl:value-of select="@filename"/></xsl:if>
                                    <span class="muted"> (see Attachments)</span>
                                </xsl:for-each>
                                <xsl:for-each select="cac:Attachment/cac:ExternalReference/cbc:URI">
                                    Link: <span class="mono"><xsl:value-of select="."/></span>
                                </xsl:for-each>
                            </td>
                        </tr>
                    </xsl:for-each>
                </tbody>
            </table>
        </xsl:if>
    </xsl:template>

    <!-- ─── Parties ────────────────────────────────────────────────── -->

    <xsl:template name="party">
        <xsl:param name="title"/>
        <xsl:param name="party"/>
        <div class="party">
            <h3><xsl:value-of select="$title"/></h3>
            <xsl:choose>
                <xsl:when test="empty($party)"><div class="muted">(missing)</div></xsl:when>
                <xsl:otherwise>
                    <div class="name"><xsl:value-of select="($party/cac:PartyName/cbc:Name, $party/cac:PartyLegalEntity/cbc:RegistrationName)[1]"/></div>
                    <xsl:if test="$party/cac:PartyLegalEntity/cbc:RegistrationName != $party/cac:PartyName/cbc:Name">
                        <div class="muted"><xsl:value-of select="$party/cac:PartyLegalEntity/cbc:RegistrationName"/></div>
                    </xsl:if>
                    <xsl:call-template name="address"><xsl:with-param name="a" select="$party/cac:PostalAddress"/></xsl:call-template>
                    <table class="ids">
                        <xsl:for-each select="$party/cac:PartyTaxScheme">
                            <tr><td><xsl:value-of select="if (cac:TaxScheme/cbc:ID = 'VAT') then 'VAT' else concat('Tax (', cac:TaxScheme/cbc:ID, ')')"/></td><td class="mono"><xsl:value-of select="cbc:CompanyID"/></td></tr>
                        </xsl:for-each>
                        <xsl:for-each select="$party/cac:PartyLegalEntity/cbc:CompanyID">
                            <tr><td>Legal ID<xsl:if test="@schemeID"> (<xsl:value-of select="@schemeID"/>)</xsl:if></td><td class="mono"><xsl:value-of select="."/></td></tr>
                        </xsl:for-each>
                        <xsl:for-each select="$party/cac:PartyIdentification/cbc:ID">
                            <tr><td>ID<xsl:if test="@schemeID"> (<xsl:value-of select="@schemeID"/>)</xsl:if></td><td class="mono"><xsl:value-of select="."/></td></tr>
                        </xsl:for-each>
                        <xsl:for-each select="$party/cbc:EndpointID">
                            <tr><td>Peppol endpoint</td><td class="mono"><xsl:value-of select="concat(@schemeID, ':', .)"/></td></tr>
                        </xsl:for-each>
                        <xsl:for-each select="$party/cac:Contact">
                            <xsl:if test="cbc:Name"><tr><td>Contact</td><td><xsl:value-of select="cbc:Name"/></td></tr></xsl:if>
                            <xsl:if test="cbc:Telephone"><tr><td>Phone</td><td><xsl:value-of select="cbc:Telephone"/></td></tr></xsl:if>
                            <xsl:if test="cbc:ElectronicMail"><tr><td>Email</td><td><xsl:value-of select="cbc:ElectronicMail"/></td></tr></xsl:if>
                        </xsl:for-each>
                    </table>
                    <xsl:if test="$party/cac:PartyLegalEntity/cbc:CompanyLegalForm">
                        <div class="muted small"><xsl:value-of select="$party/cac:PartyLegalEntity/cbc:CompanyLegalForm"/></div>
                    </xsl:if>
                </xsl:otherwise>
            </xsl:choose>
        </div>
    </xsl:template>

    <xsl:template name="address">
        <xsl:param name="a"/>
        <xsl:if test="$a">
            <div class="addr">
                <xsl:for-each select="$a/(cbc:StreetName, cbc:AdditionalStreetName, cac:AddressLine/cbc:Line)"><div><xsl:value-of select="."/></div></xsl:for-each>
                <div><xsl:value-of select="string-join(($a/cbc:PostalZone, $a/cbc:CityName), ' ')"/></div>
                <xsl:if test="$a/cbc:CountrySubentity"><div><xsl:value-of select="$a/cbc:CountrySubentity"/></div></xsl:if>
                <div><xsl:value-of select="$a/cac:Country/cbc:IdentificationCode"/></div>
            </div>
        </xsl:if>
    </xsl:template>

    <!-- ─── Other UBL document types ───────────────────────────────── -->

    <xsl:template name="generic">
        <header class="title">
            <div>
                <h1><xsl:value-of select="$type"/><xsl:text> </xsl:text><span class="docid"><xsl:value-of select="$root/cbc:ID"/></span></h1>
                <div class="muted"><xsl:value-of select="$root/cbc:CustomizationID"/></div>
            </div>
            <table class="facts">
                <xsl:for-each select="$root/cbc:*[not(self::cbc:ID or self::cbc:UBLVersionID or self::cbc:CustomizationID or self::cbc:ProfileID or self::cbc:Note)][normalize-space()]">
                    <xsl:call-template name="fact">
                        <xsl:with-param name="label" select="replace(local-name(), '([a-z])([A-Z])', '$1 $2')"/>
                        <xsl:with-param name="value" select="."/>
                    </xsl:call-template>
                </xsl:for-each>
            </table>
        </header>
        <section class="parties">
            <xsl:for-each select="$root/cac:*[cac:Party]">
                <xsl:call-template name="party">
                    <xsl:with-param name="title" select="replace(local-name(), '([a-z])([A-Z])', '$1 $2')"/>
                    <xsl:with-param name="party" select="cac:Party"/>
                </xsl:call-template>
            </xsl:for-each>
            <xsl:for-each select="$root/cac:*[local-name() = ('SenderParty', 'ReceiverParty', 'ProviderParty')]">
                <xsl:call-template name="party">
                    <xsl:with-param name="title" select="replace(local-name(), '([a-z])([A-Z])', '$1 $2')"/>
                    <xsl:with-param name="party" select="."/>
                </xsl:call-template>
            </xsl:for-each>
        </section>
        <xsl:for-each select="$root/cbc:Note"><p><xsl:value-of select="."/></p></xsl:for-each>
        <xsl:variable name="lines" select="$root/cac:*[ends-with(local-name(), 'Line')]"/>
        <xsl:if test="$lines">
            <h2>Lines <span class="muted">(<xsl:value-of select="count($lines)"/>)</span></h2>
            <table class="grid lines">
                <thead><tr><th>#</th><th>Item</th><th class="num">Quantity</th></tr></thead>
                <tbody>
                    <xsl:for-each select="$lines">
                        <xsl:variable name="l" select="(cac:LineItem, .)[1]"/>
                        <xsl:variable name="q" select="($l/cbc:Quantity, $l/cbc:DeliveredQuantity, $l/cbc:ActionCode)[1]"/>
                        <tr>
                            <td class="muted"><xsl:value-of select="($l/cbc:ID, cbc:ID)[1]"/></td>
                            <td><div class="name"><xsl:value-of select="$l/cac:Item/cbc:Name"/></div><div class="muted small"><xsl:value-of select="$l/cac:Item/cbc:Description"/></div></td>
                            <td class="num"><xsl:value-of select="p:qty($q)"/><xsl:if test="$q/@unitCode"><span class="muted"><xsl:text> </xsl:text><xsl:value-of select="p:unit(string($q/@unitCode))"/></span></xsl:if></td>
                        </tr>
                    </xsl:for-each>
                </tbody>
            </table>
        </xsl:if>
        <xsl:call-template name="references"/>
    </xsl:template>

    <!-- ─── Helpers ────────────────────────────────────────────────── -->

    <xsl:template name="fact">
        <xsl:param name="label"/>
        <xsl:param name="value"/>
        <xsl:if test="normalize-space(string-join($value, '')) != ''">
            <tr><td class="muted"><xsl:value-of select="$label"/></td><td><xsl:value-of select="$value"/></td></tr>
        </xsl:if>
    </xsl:template>

    <xsl:template name="sum">
        <xsl:param name="label"/>
        <xsl:param name="v"/>
        <xsl:param name="sign" select="''"/>
        <xsl:if test="exists($v) and normalize-space($v) != ''">
            <tr><td><xsl:value-of select="$label"/></td><td class="num"><xsl:value-of select="$sign"/><xsl:value-of select="p:amount($v)"/></td></tr>
        </xsl:if>
    </xsl:template>
</xsl:stylesheet>
