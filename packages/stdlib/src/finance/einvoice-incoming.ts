import { ok } from "../result";
import { invalid, type FinanceResult } from "./common";
import { isVatExemptionCode, vatExemptionCategory } from "./einvoice-codes";
import type { InvoiceParseOptions } from "./einvoice-contracts";
import { InvoiceReadError, readInvoiceTree, type InvoiceXmlNode as Node } from "./einvoice-read";
import { invoiceNamespaces as ns } from "./einvoice-write";
import type { IncomingInvoice, IncomingInvoiceAdjustment, IncomingInvoiceLine, IncomingInvoiceParty, IncomingInvoiceTax, IncomingInvoiceUnmapped, IncomingInvoiceXmlElement, ParsedIncomingInvoice } from "./einvoice-incoming-types";

function fail(node: Node, message: string): never { throw new InvoiceReadError({ code: "invalid_xml", path: ["xml", node.name], line: node.line, column: node.column, message }); }
// Canonical keys without converting arbitrary precision XML decimals to Number.
const canonical = (value: string): string => {
  const [integer = "", fraction = ""] = value.replace(/^[+-]/, "").split(".");
  const whole = integer.replace(/^0+/, "") || "0", part = fraction.replace(/0+$/, "");
  return `${value.startsWith("-") && (whole !== "0" || part) ? "-" : ""}${whole}${part ? `.${part}` : ""}`;
};
const taxKey = (tax: IncomingInvoiceTax) => `${tax.taxCategory}:${canonical(tax.taxRate ?? "0")}`;
const attributes = (node: Node) => [...node.attributes].map(([key, value]) => {
  const split = key.lastIndexOf("|");
  return { namespace: key.slice(0, split), name: key.slice(split + 1), value };
});
const element = (node: Node): IncomingInvoiceXmlElement => ({ name: node.name, namespace: node.namespace, text: node.text, attributes: attributes(node), children: node.children.map(element) });

class IncomingReader {
  private readonly used = new Set<Node>();
  private readonly attrs = new Map<Node, Set<string>>();
  constructor(readonly root: Node) { this.used.add(root); }
  many(parent: Node, name: string, namespace: string = ns.ram): Node[] {
    if (parent.text.trim()) fail(parent, "Expected element-only content.");
    const nodes = parent.children.filter(node => node.name === name);
    for (const node of nodes) {
      if (node.namespace !== namespace) fail(node, `Unexpected namespace for ${name}.`);
      this.used.add(node);
    }
    return nodes;
  }
  optional(parent: Node, name: string, namespace: string = ns.ram): Node | undefined {
    const nodes = this.many(parent, name, namespace);
    if (nodes.length > 1) fail(parent, `Duplicate ${name}.`);
    return nodes[0];
  }
  one(parent: Node, name: string, namespace: string = ns.ram): Node { return this.optional(parent, name, namespace) ?? fail(parent, `Missing ${name}.`); }
  text(node: Node, allowEmpty = false): string {
    if (node.children.length || (!allowEmpty && !node.text.trim())) fail(node, "Expected non-empty text-only content.");
    return node.text;
  }
  value(parent: Node, name: string): string { return this.text(this.one(parent, name)); }
  optionalValue(parent: Node, name: string): string | undefined { const node = this.optional(parent, name); return node ? this.text(node, true) : undefined; }
  attr(node: Node, name: string): string | undefined {
    for (const attr of attributes(node)) if (attr.name === name && attr.namespace) fail(node, `Unexpected namespace for ${name} attribute.`);
    const key = `|${name}`, consumed = this.attrs.get(node) ?? new Set<string>();
    consumed.add(key); this.attrs.set(node, consumed);
    const value = node.attributes.get(key);
    if (value !== undefined && !value.trim()) fail(node, `Empty ${name} attribute.`);
    return value;
  }
  requiredAttr(node: Node, name: string): string { return this.attr(node, name) ?? fail(node, `Missing ${name} attribute.`); }
  decimal(node: Node): string {
    const value = this.text(node).trim();
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) fail(node, "Expected an XML decimal (no exponent or non-finite value).");
    return value;
  }
  amount(parent: Node, name: string, currency: string): string {
    return this.amountNode(this.one(parent, name), currency);
  }
  amountNode(node: Node, currency: string): string {
    const declared = this.attr(node, "currencyID");
    if (declared !== undefined && declared !== currency) fail(node, "Amount currency differs from invoice currency.");
    return this.decimal(node);
  }
  optionalAmount(parent: Node, name: string, currency: string): string | undefined {
    const node = this.optional(parent, name); return node ? this.amountNode(node, currency) : undefined;
  }
  date(parent: Node, name: string, namespace: string = ns.udt, leaf = "DateTimeString"): string | undefined {
    const container = this.optional(parent, name);
    if (!container) return undefined;
    const node = this.one(container, leaf, namespace);
    if (this.requiredAttr(node, "format") !== "102") fail(node, "Expected date format 102.");
    const value = this.text(node).trim();
    const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}`;
    const date = new Date(`${iso}T00:00:00Z`);
    if (!/^\d{8}$/.test(value) || value.startsWith("0000") || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== iso) fail(node, "Invalid calendar date.");
    return iso;
  }
  period(parent: Node) {
    const node = this.optional(parent, "BillingSpecifiedPeriod");
    if (!node) return undefined;
    const startDate = this.date(node, "StartDateTime"), endDate = this.date(node, "EndDateTime");
    if (!startDate && !endDate) fail(node, "Empty invoicing period.");
    if (startDate && endDate && startDate > endDate) fail(node, "Invoicing period ends before it starts.");
    return { startDate, endDate };
  }
  id(node: Node) { return { value: this.text(node), schemeId: this.attr(node, "schemeID") }; }
  reference(parent: Node, name: string, field = "IssuerAssignedID") { const node = this.optional(parent, name); return node ? this.value(node, field) : undefined; }
  party(node: Node): IncomingInvoiceParty {
    const address = this.optional(node, "PostalTradeAddress"), legal = this.optional(node, "SpecifiedLegalOrganization");
    const legalId = legal ? this.optional(legal, "ID") : undefined;
    const communication = this.optional(node, "URIUniversalCommunication");
    const registrations = new Map<string, string>();
    for (const registration of this.many(node, "SpecifiedTaxRegistration")) {
      const id = this.one(registration, "ID"), scheme = this.requiredAttr(id, "schemeID");
      if (scheme !== "VA" && scheme !== "FC") fail(id, "Unsupported tax registration scheme.");
      if (registrations.has(scheme)) fail(id, "Duplicate tax registration scheme.");
      registrations.set(scheme, this.text(id));
    }
    return {
      name: this.optionalValue(node, "Name"), ids: this.many(node, "ID").map(id => this.id(id)), globalIds: this.many(node, "GlobalID").map(id => this.id(id)),
      vatId: registrations.get("VA"), taxRegistrationId: registrations.get("FC"),
      legalOrganization: legal ? { id: legalId ? this.id(legalId) : undefined, tradingName: this.optionalValue(legal, "TradingBusinessName") } : undefined,
      electronicAddress: communication ? this.id(this.one(communication, "URIID")) : undefined,
      address: address ? { line1: this.optionalValue(address, "LineOne"), line2: this.optionalValue(address, "LineTwo"), line3: this.optionalValue(address, "LineThree"), postalCode: this.optionalValue(address, "PostcodeCode"), city: this.optionalValue(address, "CityName"), countryCode: this.value(address, "CountryID"), subdivision: this.optionalValue(address, "CountrySubDivisionName") } : undefined,
      contacts: this.many(node, "DefinedTradeContact").map(contact => ({ name: this.optionalValue(contact, "PersonName"), department: this.optionalValue(contact, "DepartmentName"), telephone: this.reference(contact, "TelephoneUniversalCommunication", "CompleteNumber"), email: this.reference(contact, "EmailURIUniversalCommunication", "URIID") })),
    };
  }
  optionalParty(parent: Node, name: string) { const node = this.optional(parent, name); return node ? this.party(node) : undefined; }
  notes(parent: Node) { return this.many(parent, "IncludedNote").map(node => ({ content: this.value(node, "Content"), subjectCode: this.optionalValue(node, "SubjectCode") })); }
  tax(node: Node, group = false): IncomingInvoiceTax {
    if (this.value(node, "TypeCode").trim() !== "VAT") fail(node, "Only VAT tax is supported.");
    const taxCategory = this.value(node, "CategoryCode").trim();
    if (taxCategory !== "S" && taxCategory !== "Z" && taxCategory !== "E" && taxCategory !== "AE" && taxCategory !== "K" && taxCategory !== "G" && taxCategory !== "O") fail(node, "Unsupported VAT category.");
    const rate = this.optional(node, "RateApplicablePercent"), taxRate = rate ? this.decimal(rate) : undefined;
    if (taxCategory === "O" ? !group && taxRate !== undefined : taxRate === undefined) fail(node, "VAT rate must be absent for O lines/adjustments and present for other categories.");
    if (taxRate !== undefined && (taxCategory === "S" ? canonical(taxRate) === "0" || taxRate.startsWith("-") : canonical(taxRate) !== "0")) fail(node, "S requires a positive VAT rate; other categories require zero.");
    const taxExemptionReason = this.optionalValue(node, "ExemptionReason"), taxExemptionReasonCode = this.optionalValue(node, "ExemptionReasonCode");
    if ((taxCategory === "S" || taxCategory === "Z") && (taxExemptionReason || taxExemptionReasonCode)) fail(node, "S and Z forbid exemption reasons.");
    if (taxExemptionReasonCode && (!isVatExemptionCode(taxExemptionReasonCode) || vatExemptionCategory(taxExemptionReasonCode) !== taxCategory)) fail(node, "VATEX code does not match the VAT category or code list.");
    return { taxCategory, taxRate, taxExemptionReason, taxExemptionReasonCode };
  }
  adjustments(parent: Node, currency: string, name = "SpecifiedTradeAllowanceCharge"): IncomingInvoiceAdjustment[] {
    return this.many(parent, name).map(node => {
      const indicator = this.text(this.one(this.one(node, "ChargeIndicator"), "Indicator", ns.udt)).trim();
      if (!["true", "false", "1", "0"].includes(indicator)) fail(node, "Invalid charge indicator.");
      const percent = this.optional(node, "CalculationPercent"), tax = this.optional(node, "CategoryTradeTax");
      return { charge: indicator === "true" || indicator === "1", amount: this.amount(node, "ActualAmount", currency), basisAmount: this.optionalAmount(node, "BasisAmount", currency), percent: percent ? this.decimal(percent) : undefined,
        reason: this.optionalValue(node, "Reason"), reasonCode: this.optionalValue(node, "ReasonCode"), tax: tax ? this.tax(tax) : undefined };
    });
  }
  quantity(node: Node) { return { quantity: this.decimal(node), unitCode: this.requiredAttr(node, "unitCode") }; }
  priceBasis(parent: Node) {
    const node = this.optional(parent, "BasisQuantity");
    if (!node) return undefined;
    const result = { quantity: this.decimal(node), unitCode: this.attr(node, "unitCode") };
    if (canonical(result.quantity) === "0" || result.quantity.startsWith("-")) fail(node, "Price basis must be positive.");
    return result;
  }
  unmapped(): IncomingInvoiceUnmapped[] {
    const result: IncomingInvoiceUnmapped[] = [];
    const visit = (node: Node, path: string) => {
      const location = { path, line: node.line, column: node.column };
      if (!this.used.has(node)) { result.push({ ...location, kind: "element", element: element(node) }); return; }
      for (const attr of attributes(node)) if (!this.attrs.get(node)?.has(`${attr.namespace}|${attr.name}`)) result.push({ ...location, path: `${path}/@Q{${attr.namespace}}${attr.name}`, kind: "attribute", ...attr });
      const counts = new Map<string, number>();
      for (const child of node.children) {
        const key = `Q{${child.namespace}}${child.name}`, index = (counts.get(key) ?? 0) + 1;
        counts.set(key, index); visit(child, `${path}/${key}[${index}]`);
      }
    };
    visit(this.root, `/Q{${this.root.namespace}}${this.root.name}[1]`);
    return result;
  }
}

/** Bounded extraction, not XSD/Schematron certification. Never invent missing values or recalculate totals. */
export function parseIncomingInvoiceXml(xml: string, options?: InvoiceParseOptions): FinanceResult<ParsedIncomingInvoice> {
  try {
    const root = readInvoiceTree(xml, options, true), r = new IncomingReader(root);
    const context = r.one(root, "ExchangedDocumentContext", ns.rsm);
    const profile = r.value(r.one(context, "GuidelineSpecifiedDocumentContextParameter"), "ID").trim();
    const document = r.one(root, "ExchangedDocument", ns.rsm), tx = r.one(root, "SupplyChainTradeTransaction", ns.rsm);
    const agreement = r.one(tx, "ApplicableHeaderTradeAgreement"), delivery = r.one(tx, "ApplicableHeaderTradeDelivery"), settlement = r.one(tx, "ApplicableHeaderTradeSettlement");
    const currency = r.value(settlement, "InvoiceCurrencyCode").trim(), taxCurrency = r.optionalValue(settlement, "TaxCurrencyCode")?.trim();
    if (!/^[A-Z]{3}$/.test(currency) || (taxCurrency !== undefined && (!/^[A-Z]{3}$/.test(taxCurrency) || taxCurrency === currency))) fail(settlement, "Invalid or duplicate invoice/tax currency.");
    const sum = r.one(settlement, "SpecifiedTradeSettlementHeaderMonetarySummation");
    const taxTotals = new Map<string, string>();
    for (const node of r.many(sum, "TaxTotalAmount")) {
      const code = r.requiredAttr(node, "currencyID");
      if (code !== currency && code !== taxCurrency) fail(node, "Unexpected VAT accounting currency.");
      if (taxTotals.has(code)) fail(node, "Duplicate VAT total currency.");
      taxTotals.set(code, r.decimal(node));
    }
    const groups = r.many(settlement, "ApplicableTradeTax").map(node => {
      const tax = r.tax(node, true), taxAmount = r.amount(node, "CalculatedAmount", currency);
      if (tax.taxCategory !== "S" && canonical(taxAmount) !== "0") fail(node, "Non-S VAT amount must be zero.");
      if (tax.taxCategory !== "S" && tax.taxCategory !== "Z" && !tax.taxExemptionReason?.trim() && !tax.taxExemptionReasonCode?.trim()) fail(node, "Missing VAT exemption reason or code.");
      return { ...tax, taxAmount, netAmount: r.amount(node, "BasisAmount", currency), taxPointDate: r.date(node, "TaxPointDate", ns.udt, "DateString"), dueDateTypeCode: r.optionalValue(node, "DueDateTypeCode") };
    });
    if (!groups.length) fail(settlement, "Missing VAT breakdown.");
    const taxes = new Map<string, IncomingInvoiceTax>();
    for (const group of groups) {
      if (taxes.has(taxKey(group))) fail(settlement, "Duplicate VAT category/rate group.");
      taxes.set(taxKey(group), group);
    }
    const lines: IncomingInvoiceLine[] = r.many(tx, "IncludedSupplyChainTradeLineItem").map(node => {
      const lineDocument = r.one(node, "AssociatedDocumentLineDocument"), product = r.one(node, "SpecifiedTradeProduct");
      const lineAgreement = r.one(node, "SpecifiedLineTradeAgreement"), price = r.one(lineAgreement, "NetPriceProductTradePrice"), gross = r.optional(lineAgreement, "GrossPriceProductTradePrice");
      const lineSettlement = r.one(node, "SpecifiedLineTradeSettlement"), tax = r.tax(r.one(lineSettlement, "ApplicableTradeTax"));
      const group = taxes.get(taxKey(tax));
      if (!group) fail(node, "Missing VAT breakdown for line category/rate.");
      for (const field of ["taxExemptionReason", "taxExemptionReasonCode"] as const) if (tax[field] !== undefined && tax[field] !== group[field]) fail(node, "Conflicting line/group exemption reasons.");
      const globalId = r.optional(product, "GlobalID");
      const quantity = r.quantity(r.one(r.one(node, "SpecifiedLineTradeDelivery"), "BilledQuantity"));
      const priceBasis = r.priceBasis(price);
      if (priceBasis?.unitCode && priceBasis.unitCode !== quantity.unitCode) fail(price, "Price basis unit differs from billed unit.");
      return { ...tax, taxExemptionReason: group.taxExemptionReason, taxExemptionReasonCode: group.taxExemptionReasonCode,
        id: r.value(lineDocument, "LineID"), name: r.value(product, "Name"), description: r.optionalValue(product, "Description"),
        sellerId: r.optionalValue(product, "SellerAssignedID"), buyerId: r.optionalValue(product, "BuyerAssignedID"), globalId: globalId ? r.id(globalId) : undefined,
        ...quantity, unitPrice: r.amount(price, "ChargeAmount", currency), priceBasis,
        grossPrice: gross ? { amount: r.amount(gross, "ChargeAmount", currency), basis: r.priceBasis(gross), adjustments: r.adjustments(gross, currency, "AppliedTradeAllowanceCharge") } : undefined,
        netAmount: r.amount(r.one(lineSettlement, "SpecifiedTradeSettlementLineMonetarySummation"), "LineTotalAmount", currency), period: r.period(lineSettlement), adjustments: r.adjustments(lineSettlement, currency),
        notes: r.notes(lineDocument), buyerOrderLineId: r.reference(lineAgreement, "BuyerOrderReferencedDocument", "LineID"), accountingReference: r.reference(lineSettlement, "ReceivableSpecifiedTradeAccountingAccount", "ID"),
      };
    });
    if (!lines.length) fail(tx, "Missing invoice lines.");
    if (new Set(lines.map(line => line.id.trim())).size !== lines.length) fail(tx, "Duplicate line ID.");
    const actualDelivery = r.optional(delivery, "ActualDeliverySupplyChainEvent"), terms = r.optional(settlement, "SpecifiedTradePaymentTerms");
    const seller = r.party(r.one(agreement, "SellerTradeParty")), buyer = r.party(r.one(agreement, "BuyerTradeParty"));
    if (!seller.name?.trim() || !seller.address || !buyer.name?.trim() || !buyer.address) fail(agreement, "Seller and buyer require names and postal addresses.");
    const invoiceDate = r.date(document, "IssueDateTime") ?? fail(document, "Missing invoice date.");
    const invoice: IncomingInvoice = {
      typeCode: r.value(document, "TypeCode"), number: r.value(document, "ID"), invoiceDate, currency, taxCurrency,
      serviceDate: actualDelivery ? r.date(actualDelivery, "OccurrenceDateTime") : undefined, period: r.period(settlement),
      buyerReference: r.optionalValue(agreement, "BuyerReference"), paymentReference: r.optionalValue(settlement, "PaymentReference"),
      seller, buyer, payee: r.optionalParty(settlement, "PayeeTradeParty"), sellerTaxRepresentative: r.optionalParty(agreement, "SellerTaxRepresentativeTradeParty"), deliverTo: r.optionalParty(delivery, "ShipToTradeParty"),
      notes: r.notes(document), payments: r.many(settlement, "SpecifiedTradeSettlementPaymentMeans").map(node => {
        const account = r.optional(node, "PayeePartyCreditorFinancialAccount"), card = r.optional(node, "ApplicableTradeSettlementFinancialCard");
        return { typeCode: r.value(node, "TypeCode"), information: r.optionalValue(node, "Information"), creditorAccount: account ? { iban: r.optionalValue(account, "IBANID"), id: r.optionalValue(account, "ProprietaryID"), name: r.optionalValue(account, "AccountName") } : undefined,
          creditorBic: r.reference(node, "PayeeSpecifiedCreditorFinancialInstitution", "BICID"), debtorIban: r.reference(node, "PayerPartyDebtorFinancialAccount", "IBANID"), card: card ? { id: r.value(card, "ID"), holderName: r.optionalValue(card, "CardholderName") } : undefined };
      }),
      paymentTerms: terms ? { description: r.optionalValue(terms, "Description"), dueDate: r.date(terms, "DueDateDateTime"), mandateId: r.optionalValue(terms, "DirectDebitMandateID") } : undefined,
      buyerOrderReference: r.reference(agreement, "BuyerOrderReferencedDocument"), sellerOrderReference: r.reference(agreement, "SellerOrderReferencedDocument"), contractReference: r.reference(agreement, "ContractReferencedDocument"),
      precedingInvoices: r.many(settlement, "InvoiceReferencedDocument").map(node => ({ number: r.value(node, "IssuerAssignedID"), invoiceDate: r.date(node, "FormattedIssueDateTime", ns.qdt) })),
      accountingReference: r.reference(settlement, "ReceivableSpecifiedTradeAccountingAccount", "ID"), adjustments: r.adjustments(settlement, currency), lines,
      totals: { netAmount: r.amount(sum, "LineTotalAmount", currency), taxBasisAmount: r.amount(sum, "TaxBasisTotalAmount", currency), taxAmount: taxTotals.get(currency), taxAccountingAmount: taxCurrency ? taxTotals.get(taxCurrency) : undefined,
        grossAmount: r.amount(sum, "GrandTotalAmount", currency), dueAmount: r.amount(sum, "DuePayableAmount", currency), chargeAmount: r.optionalAmount(sum, "ChargeTotalAmount", currency), allowanceAmount: r.optionalAmount(sum, "AllowanceTotalAmount", currency), prepaidAmount: r.optionalAmount(sum, "TotalPrepaidAmount", currency), roundingAmount: r.optionalAmount(sum, "RoundingAmount", currency), taxGroups: groups },
    };
    if (groups.some(group => group.taxCategory === "O") && (groups.length !== 1 || seller.vatId || buyer.vatId || invoice.sellerTaxRepresentative?.vatId)) fail(settlement, "O forbids other VAT categories and VAT identifiers.");
    if (!seller.vatId && !seller.ids.length && !seller.globalIds.length && !seller.legalOrganization?.id) fail(agreement, "Missing seller identifier (BR-CO-26).");
    const categories = new Set(groups.map(group => group.taxCategory));
    const sellerVat = seller.vatId || invoice.sellerTaxRepresentative?.vatId;
    if ([...categories].some(category => category !== "O") && !sellerVat && !seller.taxRegistrationId) fail(agreement, "Missing seller VAT/tax registration.");
    if ((categories.has("K") || categories.has("G")) && !sellerVat) fail(agreement, "K/G require seller or representative VAT identification.");
    if (categories.has("K") && (!buyer.vatId || !invoice.deliverTo?.address?.countryCode || (!invoice.serviceDate && !invoice.period))) fail(agreement, "K requires buyer VAT ID, delivery country and delivery date or invoicing period.");
    if (categories.has("AE") && !buyer.vatId && !buyer.legalOrganization?.id) fail(agreement, "AE requires buyer VAT or legal registration identification.");
    if (groups.some(group => group.taxCategory !== "O") && !taxTotals.has(currency)) fail(sum, "Missing VAT total in invoice currency.");
    if (taxCurrency && !taxTotals.has(taxCurrency)) fail(sum, "Missing VAT total in accounting currency.");
    for (const adjustment of invoice.adjustments) if (!adjustment.tax || !taxes.has(taxKey(adjustment.tax))) fail(settlement, "Missing VAT category/rate breakdown for document allowance/charge.");
    const usedTaxes = new Set([...lines.map(taxKey), ...invoice.adjustments.flatMap(adjustment => adjustment.tax ? [taxKey(adjustment.tax)] : [])]);
    if ([...taxes.keys()].some(key => !usedTaxes.has(key))) fail(settlement, "VAT breakdown has no matching line or document allowance/charge.");
    return ok({ format: "cii-en16931", profile, xml, invoice, unmapped: r.unmapped() });
  } catch (error) {
    if (error instanceof InvoiceReadError) return invalid([error.issue]);
    throw error;
  }
}
