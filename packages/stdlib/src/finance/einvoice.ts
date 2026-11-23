import { ok } from "../result";
import { invalid, validate, type FinanceResult } from "./common";
import { calculateInvoice, checkInvoiceTotals, invoiceFormat, invoiceSchema, invoiceTaxKey, type Invoice, type InvoiceCalculation, type InvoiceFormat, type InvoiceParseOptions, type InvoicePdfOptions, type InvoiceXmlFile, type ParsedInvoice } from "./einvoice-contracts";
import { parseInvoiceXml } from "./einvoice-read";
import { parseIncomingInvoiceXml } from "./einvoice-incoming";
import type { IncomingInvoiceParseOptions, IncomingInvoicePdfOptions, ParsedIncomingInvoice } from "./einvoice-incoming-types";
import { writeInvoiceXml } from "./einvoice-write";

/** Validate supported values and all supplied amounts without changing declared data. */
function prepareInvoice(input: unknown): FinanceResult<{ invoice: Invoice; calculated: InvoiceCalculation }> {
  const checked = validate(invoiceSchema, input);
  if (!checked.ok) return checked;
  const calculated = calculateInvoice(checked.data.lines, { roundingAmount: checked.data.totals?.roundingAmount });
  if (!calculated.ok) return invalid(calculated.error.issues.map(issue => issue.path[0] === "roundingAmount"
    ? { ...issue, path: ["totals", ...issue.path] } : issue));
  const totals = checkInvoiceTotals(checked.data, calculated.data);
  if (totals.ok && checked.data.totals) {
    const supplied = new Map(checked.data.totals.taxGroups.map(group => [invoiceTaxKey(group), group]));
    calculated.data.taxGroups = calculated.data.taxGroups.map(group => {
      const declared = supplied.get(invoiceTaxKey(group));
      return { ...group,
        ...(declared?.taxExemptionReason !== undefined ? { taxExemptionReason: declared.taxExemptionReason } : {}),
        ...(declared?.taxExemptionReasonCode !== undefined ? { taxExemptionReasonCode: declared.taxExemptionReasonCode } : {}),
      };
    });
  }
  return totals.ok ? ok({ invoice: checked.data, calculated: calculated.data }) : totals;
}

function serialize(invoice: Invoice, options: { format: InvoiceFormat }): FinanceResult<InvoiceXmlFile> {
  if (options?.format !== invoiceFormat) return invalid([{ code: "unsupported_format", path: ["format"], message: `Expected ${invoiceFormat}.` }]);
  const checked = prepareInvoice(invoice);
  if (!checked.ok) return checked;
  const xml = writeInvoiceXml(checked.data.invoice, checked.data.calculated);
  return ok({ format: invoiceFormat, xml, bytes: new TextEncoder().encode(xml) });
}

function parseXml(xml: string, options: IncomingInvoiceParseOptions): FinanceResult<ParsedIncomingInvoice>;
function parseXml(xml: string, options?: InvoiceParseOptions & { mode?: never }): FinanceResult<ParsedInvoice>;
function parseXml(xml: string, options: InvoiceParseOptions | IncomingInvoiceParseOptions): FinanceResult<ParsedInvoice | ParsedIncomingInvoice>;
function parseXml(xml: string, options: InvoiceParseOptions & { mode?: "incoming" } = {}): FinanceResult<ParsedInvoice | ParsedIncomingInvoice> {
  const { mode, ...limits } = options;
  if (mode !== undefined && mode !== "incoming") return invalid([{ code: "invalid_input", path: ["options", "mode"], message: "Unknown invoice parsing mode." }]);
  return mode === "incoming" ? parseIncomingInvoiceXml(xml, limits) : parseInvoiceXml(xml, limits);
}

function parsePdf(bytes: Uint8Array, options: IncomingInvoicePdfOptions): Promise<FinanceResult<ParsedIncomingInvoice & { filename: string }>>;
function parsePdf(bytes: Uint8Array, options?: InvoicePdfOptions & { mode?: never }): Promise<FinanceResult<ParsedInvoice & { filename: string }>>;
function parsePdf(bytes: Uint8Array, options: InvoicePdfOptions | IncomingInvoicePdfOptions): Promise<FinanceResult<(ParsedInvoice | ParsedIncomingInvoice) & { filename: string }>>;
async function parsePdf(bytes: Uint8Array, options: InvoicePdfOptions & { mode?: "incoming" } = {}): Promise<FinanceResult<(ParsedInvoice | ParsedIncomingInvoice) & { filename: string }>> {
  const { maxPdfBytes = 25 * 1024 * 1024, mode, ...xmlOptions } = options;
  if (mode !== undefined && mode !== "incoming") return invalid([{ code: "invalid_input", path: ["options", "mode"], message: "Unknown invoice parsing mode." }]);
  if (!Number.isSafeInteger(maxPdfBytes) || maxPdfBytes < 1) return invalid([{ code: "invalid_input", path: ["options", "maxPdfBytes"], message: "Expected a positive safe integer limit." }]);
  if (!(bytes instanceof Uint8Array)) return invalid([{ code: "invalid_input", path: ["pdf"], message: "Expected PDF bytes." }]);
  if (bytes.byteLength > maxPdfBytes) return invalid([{ code: "input_limit", path: ["pdf"], message: "PDF exceeds maxPdfBytes." }]);
  let pdfModule: typeof import("./einvoice-pdf");
  try { pdfModule = await import("./einvoice-pdf"); }
  catch { return invalid([{ code: "validator_unavailable", path: ["pdf"], message: "PDF invoice reading requires pdf-lib@1.17.1." }], true); }
  const { extractInvoiceXml } = pdfModule;
  const extracted = await extractInvoiceXml(bytes, xmlOptions);
  if (!extracted.ok) return extracted;
  const parsed = mode === "incoming" ? parseIncomingInvoiceXml(extracted.data.xml, xmlOptions) : parseInvoiceXml(extracted.data.xml, xmlOptions);
  return parsed.ok ? ok({ ...parsed.data, filename: extracted.data.filename }) : parsed;
}

export const einvoice = {
  validate: (input: unknown): FinanceResult<Invoice> => {
    const checked = prepareInvoice(input);
    return checked.ok ? ok(checked.data.invoice) : checked;
  },
  calculate: calculateInvoice,
  serialize,
  parseXml,
  parsePdf,
};
