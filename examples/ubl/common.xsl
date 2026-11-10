<?xml version="1.0" encoding="UTF-8"?>
<!-- Shared helpers, pulled in with xsl:include from order-to-invoice.xsl -->
<xsl:stylesheet version="2.0"
    xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
    xmlns:xs="http://www.w3.org/2001/XMLSchema"
    xmlns:f="urn:example:functions"
    xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
    xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
    exclude-result-prefixes="xs f">

    <xsl:function name="f:amount" as="xs:string">
        <xsl:param name="value" as="xs:decimal"/>
        <xsl:sequence select="format-number($value, '0.00')"/>
    </xsl:function>

    <xsl:template name="postal-address">
        <xsl:param name="party"/>
        <cac:PostalAddress>
            <cbc:StreetName><xsl:value-of select="$party/street"/></cbc:StreetName>
            <cbc:CityName><xsl:value-of select="$party/city"/></cbc:CityName>
            <cbc:PostalZone><xsl:value-of select="$party/zip"/></cbc:PostalZone>
            <cac:Country>
                <cbc:IdentificationCode><xsl:value-of select="$party/country"/></cbc:IdentificationCode>
            </cac:Country>
        </cac:PostalAddress>
    </xsl:template>
</xsl:stylesheet>
