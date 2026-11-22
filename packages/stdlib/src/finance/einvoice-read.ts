import { SaxesParser } from "saxes";
import { invoiceNamespaces as ns, invoiceProfile } from "./einvoice-write";
import { invoiceFormat, invoiceSchema, invoiceTaxKey, type InvoiceParseOptions, type ParsedInvoice } from "./einvoice-contracts";
import { invalid, validate, type FinanceIssue, type FinanceResult } from "./common";
import { ok } from "../result";

export type InvoiceXmlNode = { name: string; namespace: string; attributes: Map<string, string>; children: InvoiceXmlNode[]; text: string; line: number; column: number };
type Node = InvoiceXmlNode;
const incomingProfiles = new Set([invoiceProfile,
  `${invoiceProfile}#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0`,
  `${invoiceProfile}#compliant#urn:xoev-de:kosit:standard:xrechnung_2.3`,
]);
export class InvoiceReadError extends Error {
  constructor(readonly issue: FinanceIssue) { super(issue.message); }
}
const fail = (message: string, node?: Node, code: FinanceIssue["code"] = "invalid_xml"): never => {
  throw new InvoiceReadError({ code, path: ["xml", ...(node ? [node.name] : [])], message, ...(node ? { line: node.line, column: node.column } : {}) });
};

/** No entity or DTD resolution; bounded namespace-aware parsing before schema/PDF consumers. */
export function readInvoiceTree(xml: string, options: InvoiceParseOptions = {}, incoming = false): Node {
  const limits = { maxCharacters: 10 * 1024 * 1024, maxElements: 100_000, maxDepth: 64, ...options };
  for (const [name, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value < 1) throw new InvoiceReadError({ code: "invalid_input", path: ["options", name], message: "Expected a positive safe integer limit." });
  if (typeof xml !== "string") fail("Expected XML text.");
  if (xml.length > limits.maxCharacters) fail("XML exceeds maxCharacters.", undefined, "input_limit");
  const parser = new SaxesParser({ xmlns: true, defaultXMLVersion: "1.0", forceXMLVersion: true });
  let root: Node | undefined;
  const stack: Node[] = [];
  let count = 0;
  parser.on("error", () => fail("Malformed XML.", stack.at(-1)));
  parser.on("doctype", () => fail("DTD declarations are not supported.", stack.at(-1)));
  parser.on("xmldecl", declaration => { if (declaration.version !== "1.0") fail("Only XML 1.0 is supported."); });
  parser.on("opentag", tag => {
    if (++count > limits.maxElements || stack.length >= limits.maxDepth) fail("XML exceeds element or depth limit.", stack.at(-1), "input_limit");
    const node: Node = { name: tag.local, namespace: tag.uri, attributes: new Map(Object.values(tag.attributes).filter(attr => attr.uri !== "http://www.w3.org/2000/xmlns/").map(attr => [`${attr.uri}|${attr.local}`, attr.value])), children: [], text: "", line: parser.line, column: parser.column + 1 };
    const parent = stack.at(-1);
    if (parent) parent.children.push(node); else root = node;
    stack.push(node);
  });
  parser.on("text", value => { const node = stack.at(-1); if (node) node.text += value; });
  parser.on("cdata", value => { const node = stack.at(-1); if (node) node.text += value; });
  parser.on("closetag", () => { stack.pop(); });
  parser.write(xml).close();
  const document = root ?? fail("Expected XML document.");
  if (document.name !== "CrossIndustryInvoice" || document.namespace !== ns.rsm) fail("Only CII CrossIndustryInvoice is supported.", document, "unsupported_format");
  const context = document.children.filter(node => node.namespace === ns.rsm && node.name === "ExchangedDocumentContext");
  const guidelines = context[0]?.children.filter(node => node.namespace === ns.ram && node.name === "GuidelineSpecifiedDocumentContextParameter") ?? [];
  const ids = guidelines[0]?.children.filter(node => node.namespace === ns.ram && node.name === "ID") ?? [];
  const profile = ids[0]?.text.trim();
  if (context.length !== 1 || guidelines.length !== 1 || ids.length !== 1 || !profile || !(incoming ? incomingProfiles.has(profile) : profile === invoiceProfile)) fail("Expected a supported CII EN16931 guideline.", document, "unsupported_format");
  return document;
}

// Every consumed element and attribute is accounted for. Unknown semantics fail closed.
class Reader {
  private readonly used = new Set<Node>();
  private readonly attrs = new Map<Node, Set<string>>();
  constructor(readonly root: Node) { this.used.add(root); }
  many(parent: Node, name: string, namespace: string = ns.ram): Node[] {
    const nodes = parent.children.filter(node => node.name === name && node.namespace === namespace);
    for (const node of nodes) this.used.add(node);
    return nodes;
  }
  optional(parent: Node, name: string, namespace: string = ns.ram): Node | undefined {
    const nodes = this.many(parent, name, namespace);
    if (nodes.length > 1) fail(`Duplicate ${name}.`, parent);
    return nodes[0];
  }
  one(parent: Node, name: string, namespace: string = ns.ram): Node {
    return this.optional(parent, name, namespace) ?? fail(`Missing ${name}.`, parent);
  }
  text(node: Node): string {
    if (node.children.length) fail("Expected a text-only element.", node);
    return node.text;
  }
  value(parent: Node, name: string): string { return this.text(this.one(parent, name)); }
  optionalValue(parent: Node, name: string): string | undefined {
    const node = this.optional(parent, name); return node ? this.text(node) : undefined;
  }
  attr(node: Node, name: string): string {
    const key = `|${name}`;
    const used = this.attrs.get(node) ?? new Set<string>(); used.add(key); this.attrs.set(node, used);
    return node.attributes.get(key) ?? fail(`Missing ${name} attribute.`, node);
  }
  expect(value: string, expected: string, node: Node) {
    if (value !== expected) fail(`Unsupported value; expected ${expected}.`, node, "unsupported_format");
  }
  date(parent: Node, name: string, namespace: string = ns.udt): string {
    const node = this.one(this.one(parent, name), "DateTimeString", namespace);
    this.expect(this.attr(node, "format"), "102", node);
    const text = this.text(node);
    if (!/^\d{8}$/.test(text)) fail("Expected YYYYMMDD date.", node);
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6)}`;
  }
  party(parent: Node, name: string) {
    const node = this.one(parent, name);
    const address = this.one(node, "PostalTradeAddress");
    const registrations = new Map<string, string>();
    for (const registration of this.many(node, "SpecifiedTaxRegistration")) {
      const id = this.one(registration, "ID");
      const scheme = this.attr(id, "schemeID");
      if (scheme !== "VA" && scheme !== "FC") fail("Unsupported tax registration scheme.", id, "unsupported_format");
      if (registrations.has(scheme)) fail("Duplicate tax registration scheme.", id);
      const value = this.text(id);
      if (!value.trim()) fail("Tax registration IDs must not be empty; omit the registration instead.", id);
      registrations.set(scheme, value);
    }
    const partyId = this.optionalValue(node, "ID");
    return { name: this.value(node, "Name"), vatId: registrations.get("VA") ?? "",
      ...(partyId === undefined ? {} : { id: partyId }),
      ...(registrations.has("FC") ? { taxRegistrationId: registrations.get("FC") } : {}), address: {
      line1: this.optionalValue(address, "LineOne"), postalCode: this.value(address, "PostcodeCode"), city: this.value(address, "CityName"), countryCode: this.value(address, "CountryID"),
    } };
  }
  tax(node: Node, group = false) {
    this.expect(this.value(node, "TypeCode"), "VAT", node);
    const taxCategory = this.value(node, "CategoryCode");
    const taxRate = this.optionalValue(node, "RateApplicablePercent");
    if (taxCategory === "O" && taxRate !== undefined) fail("O must omit the VAT rate (BR-O-05).", node);
    if (taxRate === undefined && taxCategory !== "O") fail("Missing VAT rate (BR-48).", node);
    const taxExemptionReason = group ? this.optionalValue(node, "ExemptionReason") : undefined;
    const taxExemptionReasonCode = group ? this.optionalValue(node, "ExemptionReasonCode") : undefined;
    return { taxCategory, taxRate: taxRate ?? "0",
      ...(taxExemptionReason === undefined ? {} : { taxExemptionReason }),
      ...(taxExemptionReasonCode === undefined ? {} : { taxExemptionReasonCode }),
    };
  }
  finish(node: Node = this.root) {
    if (!this.used.has(node)) fail(`Unsupported element ${node.name}.`, node, "unsupported_format");
    if (node.children.length && node.text.trim()) fail("Mixed XML content is unsupported.", node);
    for (const key of node.attributes.keys()) if (!this.attrs.get(node)?.has(key)) fail(`Unsupported attribute ${key}.`, node, "unsupported_format");
    for (const child of node.children) this.finish(child);
  }
}

export function parseInvoiceXml(xml: string, options?: InvoiceParseOptions): FinanceResult<ParsedInvoice> {
  try {
    const root = readInvoiceTree(xml, options);
    const r = new Reader(root);
    const context = r.one(root, "ExchangedDocumentContext", ns.rsm);
    const profile = r.value(r.one(context, "GuidelineSpecifiedDocumentContextParameter"), "ID");
    r.expect(profile, invoiceProfile, context);
    const document = r.one(root, "ExchangedDocument", ns.rsm);
    const code = r.value(document, "TypeCode");
    const kind = code === "380" ? "invoice" : code === "381" ? "creditNote" : code === "389" ? "selfBilling" : code === "261" ? "selfBillingCreditNote" : fail("Unsupported document type.", document, "unsupported_format");
    const tx = r.one(root, "SupplyChainTradeTransaction", ns.rsm);
    const agreement = r.one(tx, "ApplicableHeaderTradeAgreement");
    const delivery = r.one(tx, "ApplicableHeaderTradeDelivery");
    const settlement = r.one(tx, "ApplicableHeaderTradeSettlement");
    const means = r.optional(settlement, "SpecifiedTradeSettlementPaymentMeans");
    const account = means ? r.optional(means, "PayeePartyCreditorFinancialAccount") : undefined;
    const event = r.optional(delivery, "ActualDeliverySupplyChainEvent");
    const period = r.optional(settlement, "BillingSpecifiedPeriod");
    const sum = r.one(settlement, "SpecifiedTradeSettlementHeaderMonetarySummation");
    for (const name of ["ChargeTotalAmount", "AllowanceTotalAmount", "TotalPrepaidAmount"]) {
      const value = r.optionalValue(sum, name);
      if (value !== undefined && !/^0(?:\.0+)?$/.test(value)) fail(`${name} must be zero in this slice.`, sum, "unsupported_format");
    }
    const roundingAmount = r.optionalValue(sum, "RoundingAmount");
    const netAmount = r.value(sum, "LineTotalAmount");
    const basis = r.value(sum, "TaxBasisTotalAmount");
    if (basis !== netAmount) fail("Tax basis differs from line total; adjustments are unsupported.", sum, "unsupported_format");
    const tax = r.one(sum, "TaxTotalAmount");
    r.expect(r.attr(tax, "currencyID"), "EUR", tax);
    const original = r.optional(settlement, "InvoiceReferencedDocument");
    const notes = r.many(document, "IncludedNote").map(note => r.value(note, "Content"));
    const shipTo = r.optional(delivery, "ShipToTradeParty");
    const input = {
      kind, number: r.value(document, "ID"), invoiceDate: r.date(document, "IssueDateTime"),
      ...(event ? { serviceDate: r.date(event, "OccurrenceDateTime") } : {}),
      ...(period ? { period: {
        ...(r.optional(period, "StartDateTime") ? { startDate: r.date(period, "StartDateTime") } : {}),
        ...(r.optional(period, "EndDateTime") ? { endDate: r.date(period, "EndDateTime") } : {}),
      } } : {}),
      dueDate: r.date(r.one(settlement, "SpecifiedTradePaymentTerms"), "DueDateDateTime"),
      currency: r.value(settlement, "InvoiceCurrencyCode"), buyerReference: r.value(agreement, "BuyerReference"),
      seller: r.party(agreement, "SellerTradeParty"), buyer: r.party(agreement, "BuyerTradeParty"),
      ...(shipTo ? { deliverToCountryCode: r.value(r.one(shipTo, "PostalTradeAddress"), "CountryID") } : {}),
      ...(notes.length ? { notes } : {}),
      ...(original ? { precedingInvoice: { number: r.value(original, "IssuerAssignedID"), invoiceDate: r.date(original, "FormattedIssueDateTime", ns.qdt) } } : {}),
      ...(means ? { payment: { typeCode: r.value(means, "TypeCode"), information: r.optionalValue(means, "Information"),
        ...(account ? { iban: r.value(account, "IBANID"), accountName: r.optionalValue(account, "AccountName") } : {}),
      } } : {}),
      lines: r.many(tx, "IncludedSupplyChainTradeLineItem").map(line => {
        const product = r.one(line, "SpecifiedTradeProduct");
        const price = r.one(r.one(line, "SpecifiedLineTradeAgreement"), "NetPriceProductTradePrice");
        const quantity = r.one(r.one(line, "SpecifiedLineTradeDelivery"), "BilledQuantity");
        const settle = r.one(line, "SpecifiedLineTradeSettlement");
        const description = r.optionalValue(product, "Description");
        return { id: r.value(r.one(line, "AssociatedDocumentLineDocument"), "LineID"), name: r.value(product, "Name"),
          ...(description === undefined ? {} : { description }), quantity: r.text(quantity), unitCode: r.attr(quantity, "unitCode"), unitPrice: r.value(price, "ChargeAmount"),
          ...r.tax(r.one(settle, "ApplicableTradeTax")), netAmount: r.value(r.one(settle, "SpecifiedTradeSettlementLineMonetarySummation"), "LineTotalAmount"),
        };
      }),
      totals: { ...(roundingAmount !== undefined ? { roundingAmount } : {}), netAmount, taxAmount: r.text(tax), grossAmount: r.value(sum, "GrandTotalAmount"), dueAmount: r.value(sum, "DuePayableAmount"),
        taxGroups: r.many(settlement, "ApplicableTradeTax").map(group => ({ ...r.tax(group, true), netAmount: r.value(group, "BasisAmount"), taxAmount: r.value(group, "CalculatedAmount") })),
      },
    };
    r.finish();
    const checked = validate(invoiceSchema, input);
    if (checked.ok) {
      const groups = new Map(checked.data.totals?.taxGroups.map(group => [invoiceTaxKey(group), group]));
      for (const line of checked.data.lines) {
        const group = groups.get(invoiceTaxKey(line));
        if (group?.taxExemptionReason !== undefined) line.taxExemptionReason = group.taxExemptionReason;
        if (group?.taxExemptionReasonCode !== undefined) line.taxExemptionReasonCode = group.taxExemptionReasonCode;
      }
    }
    return checked.ok ? ok({ format: invoiceFormat, profile, xml, invoice: checked.data }) : checked;
  } catch (error) {
    if (error instanceof InvoiceReadError) return invalid([error.issue]);
    throw error;
  }
}
