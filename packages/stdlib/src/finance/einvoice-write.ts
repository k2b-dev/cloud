import type { Invoice, InvoiceCalculation } from "./einvoice-contracts";
export const invoiceNamespaces = {
  rsm: "urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100",
  ram: "urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100",
  udt: "urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100",
  qdt: "urn:un:unece:uncefact:data:standard:QualifiedDataType:100",
};
export const invoiceProfile = "urn:cen.eu:en16931:2017";
const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;").replace(/\r/g, "&#13;");
const element = (name: string, value: string, attrs = "") => `<${name}${attrs}>${escape(value)}</${name}>`;
const ram = (name: string, value: string, attrs = "") => element(`ram:${name}`, value, attrs);
const wrap = (name: string, content: string) => `<ram:${name}>${content}</ram:${name}>`;
const date = (name: string, value: string, prefix = "udt") => wrap(name, element(`${prefix}:DateTimeString`, value.replaceAll("-", ""), ' format="102"'));
const party = (name: string, value: Invoice["seller"]) => wrap(name, (value.id ? ram("ID", value.id) : "") + ram("Name", value.name) +
  wrap("PostalTradeAddress", ram("PostcodeCode", value.address.postalCode) + (value.address.line1 ? ram("LineOne", value.address.line1) : "") + ram("CityName", value.address.city) + ram("CountryID", value.address.countryCode)) +
  (value.vatId ? wrap("SpecifiedTaxRegistration", ram("ID", value.vatId, ' schemeID="VA"')) : "") +
  (value.taxRegistrationId ? wrap("SpecifiedTaxRegistration", ram("ID", value.taxRegistrationId, ' schemeID="FC"')) : ""));

/** CII EN16931 subset. Prices and quantities retain their original decimal precision. */
export function writeInvoiceXml(invoice: Invoice, totals: InvoiceCalculation): string {
  const context = wrap("GuidelineSpecifiedDocumentContextParameter", ram("ID", invoiceProfile));
  const document = ram("ID", invoice.number) + ram("TypeCode", { invoice: "380", creditNote: "381", selfBilling: "389", selfBillingCreditNote: "261" }[invoice.kind]) +
    date("IssueDateTime", invoice.invoiceDate) + (invoice.notes ?? []).map(note => wrap("IncludedNote", ram("Content", note))).join("");
  const lines = totals.lines.map(line => wrap("IncludedSupplyChainTradeLineItem",
    wrap("AssociatedDocumentLineDocument", ram("LineID", line.id)) +
    wrap("SpecifiedTradeProduct", ram("Name", line.name) + (line.description === undefined ? "" : ram("Description", line.description))) +
    wrap("SpecifiedLineTradeAgreement", wrap("NetPriceProductTradePrice", ram("ChargeAmount", line.unitPrice))) +
    wrap("SpecifiedLineTradeDelivery", ram("BilledQuantity", line.quantity, ` unitCode="${line.unitCode}"`)) +
    wrap("SpecifiedLineTradeSettlement", wrap("ApplicableTradeTax", ram("TypeCode", "VAT") + ram("CategoryCode", line.taxCategory ?? "S") + (line.taxCategory === "O" ? "" : ram("RateApplicablePercent", line.taxRate))) +
      wrap("SpecifiedTradeSettlementLineMonetarySummation", ram("LineTotalAmount", line.netAmount))))).join("");
  const agreement = wrap("ApplicableHeaderTradeAgreement", ram("BuyerReference", invoice.buyerReference) + party("SellerTradeParty", invoice.seller) + party("BuyerTradeParty", invoice.buyer));
  const delivery = wrap("ApplicableHeaderTradeDelivery", (invoice.deliverToCountryCode ? wrap("ShipToTradeParty", wrap("PostalTradeAddress", ram("CountryID", invoice.deliverToCountryCode))) : "") + (invoice.serviceDate ? wrap("ActualDeliverySupplyChainEvent", date("OccurrenceDateTime", invoice.serviceDate)) : ""));
  const settlement = wrap("ApplicableHeaderTradeSettlement", ram("InvoiceCurrencyCode", invoice.currency) +
    (invoice.payment ? wrap("SpecifiedTradeSettlementPaymentMeans", ram("TypeCode", invoice.payment.typeCode ?? "58") +
      (invoice.payment.information ? ram("Information", invoice.payment.information) : "") +
      (invoice.payment.iban ? wrap("PayeePartyCreditorFinancialAccount", ram("IBANID", invoice.payment.iban) + (invoice.payment.accountName ? ram("AccountName", invoice.payment.accountName) : "")) : "")) : "") +
    totals.taxGroups.map(group => wrap("ApplicableTradeTax", ram("CalculatedAmount", group.taxAmount) + ram("TypeCode", "VAT") +
      (group.taxExemptionReason ? ram("ExemptionReason", group.taxExemptionReason) : "") +
      ram("BasisAmount", group.netAmount) + ram("CategoryCode", group.taxCategory ?? "S") +
      (group.taxExemptionReasonCode ? ram("ExemptionReasonCode", group.taxExemptionReasonCode) : "") +
      (group.taxCategory === "O" ? "" : ram("RateApplicablePercent", group.taxRate)))).join("") +
    (invoice.period ? wrap("BillingSpecifiedPeriod", (invoice.period.startDate ? date("StartDateTime", invoice.period.startDate) : "") + (invoice.period.endDate ? date("EndDateTime", invoice.period.endDate) : "")) : "") +
    wrap("SpecifiedTradePaymentTerms", date("DueDateDateTime", invoice.dueDate)) +
    wrap("SpecifiedTradeSettlementHeaderMonetarySummation", ram("LineTotalAmount", totals.netAmount) + ram("ChargeTotalAmount", "0.00") + ram("AllowanceTotalAmount", "0.00") + ram("TaxBasisTotalAmount", totals.netAmount) + ram("TaxTotalAmount", totals.taxAmount, ' currencyID="EUR"') + (totals.roundingAmount !== undefined ? ram("RoundingAmount", totals.roundingAmount) : "") + ram("GrandTotalAmount", totals.grossAmount) + ram("DuePayableAmount", totals.dueAmount)) +
    (invoice.precedingInvoice ? wrap("InvoiceReferencedDocument", ram("IssuerAssignedID", invoice.precedingInvoice.number) + date("FormattedIssueDateTime", invoice.precedingInvoice.invoiceDate, "qdt")) : ""));
  return '<?xml version="1.0" encoding="UTF-8"?>' + `<rsm:CrossIndustryInvoice${Object.entries(invoiceNamespaces).map(([prefix, ns]) => ` xmlns:${prefix}="${ns}"`).join("")}>` +
    `<rsm:ExchangedDocumentContext>${context}</rsm:ExchangedDocumentContext><rsm:ExchangedDocument>${document}</rsm:ExchangedDocument><rsm:SupplyChainTradeTransaction>${lines}${agreement}${delivery}${settlement}</rsm:SupplyChainTradeTransaction></rsm:CrossIndustryInvoice>`;
}
