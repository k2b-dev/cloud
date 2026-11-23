import type { InvoiceParseOptions, InvoicePdfOptions, InvoiceTaxCategory } from "./einvoice-contracts";

export type IncomingInvoiceParseOptions = InvoiceParseOptions & { mode: "incoming" };
export type IncomingInvoicePdfOptions = InvoicePdfOptions & { mode: "incoming" };
export type IncomingInvoiceId = { value: string; schemeId?: string };
export type IncomingInvoicePeriod = { startDate?: string; endDate?: string };
export type IncomingInvoiceTax = {
  taxCategory: InvoiceTaxCategory;
  /** Absent for O. Declared decimal spelling is preserved. */
  taxRate?: string;
  taxExemptionReason?: string;
  taxExemptionReasonCode?: string;
};
export type IncomingInvoiceParty = {
  name?: string;
  ids: IncomingInvoiceId[];
  globalIds: IncomingInvoiceId[];
  vatId?: string;
  taxRegistrationId?: string;
  legalOrganization?: { id?: IncomingInvoiceId; tradingName?: string };
  electronicAddress?: IncomingInvoiceId;
  address?: { line1?: string; line2?: string; line3?: string; postalCode?: string; city?: string; countryCode: string; subdivision?: string };
  contacts: { name?: string; department?: string; telephone?: string; email?: string }[];
};
export type IncomingInvoiceAdjustment = {
  charge: boolean; amount: string; basisAmount?: string; percent?: string;
  reason?: string; reasonCode?: string; tax?: IncomingInvoiceTax;
};
export type IncomingInvoicePayment = {
  typeCode: string; information?: string;
  creditorAccount?: { iban?: string; id?: string; name?: string };
  creditorBic?: string;
  debtorIban?: string;
  card?: { id: string; holderName?: string };
};
export type IncomingInvoiceNote = { content: string; subjectCode?: string };
export type IncomingInvoiceLine = IncomingInvoiceTax & {
  id: string; name: string; description?: string; sellerId?: string; buyerId?: string; globalId?: IncomingInvoiceId;
  quantity: string; unitCode: string; unitPrice: string;
  priceBasis?: { quantity: string; unitCode?: string };
  grossPrice?: { amount: string; basis?: { quantity: string; unitCode?: string }; adjustments: IncomingInvoiceAdjustment[] };
  netAmount: string; period?: IncomingInvoicePeriod; adjustments: IncomingInvoiceAdjustment[];
  notes: IncomingInvoiceNote[]; buyerOrderLineId?: string; accountingReference?: string;
};
/** Incoming amounts are declared data, not recalculated or certified totals. */
export type IncomingInvoice = {
  typeCode: string; number: string; invoiceDate: string; currency: string; taxCurrency?: string;
  serviceDate?: string; period?: IncomingInvoicePeriod; buyerReference?: string; paymentReference?: string;
  seller: IncomingInvoiceParty; buyer: IncomingInvoiceParty; payee?: IncomingInvoiceParty;
  sellerTaxRepresentative?: IncomingInvoiceParty; deliverTo?: IncomingInvoiceParty;
  notes: IncomingInvoiceNote[]; payments: IncomingInvoicePayment[];
  paymentTerms?: { description?: string; dueDate?: string; mandateId?: string };
  buyerOrderReference?: string; sellerOrderReference?: string; contractReference?: string;
  precedingInvoices: { number: string; invoiceDate?: string }[];
  accountingReference?: string; adjustments: IncomingInvoiceAdjustment[]; lines: IncomingInvoiceLine[];
  totals: {
    netAmount: string; taxBasisAmount: string; taxAmount?: string; taxAccountingAmount?: string;
    grossAmount: string; dueAmount: string; chargeAmount?: string; allowanceAmount?: string;
    prepaidAmount?: string; roundingAmount?: string;
    taxGroups: (IncomingInvoiceTax & { netAmount: string; taxAmount: string; taxPointDate?: string; dueDateTypeCode?: string })[];
  };
};
/** Supplementary XML is retained for inspection, never silently discarded or executed. */
export type IncomingInvoiceXmlElement = {
  name: string; namespace: string; text: string;
  attributes: { name: string; namespace: string; value: string }[];
  children: IncomingInvoiceXmlElement[];
};
export type IncomingInvoiceUnmapped = { path: string; line: number; column: number } & (
  { kind: "element"; element: IncomingInvoiceXmlElement } |
  { kind: "attribute"; name: string; namespace: string; value: string }
);
export type ParsedIncomingInvoice = {
  /** Identifies the read model, not a ZUGFeRD version or validation result. */
  format: "cii-en16931";
  profile: string; xml: string; invoice: IncomingInvoice; unmapped: IncomingInvoiceUnmapped[];
};
