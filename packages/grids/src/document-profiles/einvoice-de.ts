import { type RenderFacturXHtmlToPdfInput, renderFacturXHtmlToPdf } from "@k2b/cloud/services/pdf";
import { unwrap } from "@k2b/stdlib";
import { einvoice, type Invoice } from "@k2b/stdlib/finance";
import { validateInvoiceXml } from "@k2b/stdlib/finance/validate";
import Decimal from "decimal.js";
import { isValidIBAN } from "ibantools";
import { z } from "zod";
import type { DocumentProfile } from "../document-profiles";

const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !value.includes("\0"), "must not contain NUL");
const decimal = (scale: number) =>
  z
    .string()
    .max(200)
    .regex(new RegExp(`^(?:0|[1-9]\\d*)\\.\\d{${scale}}$`));
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "invalid date");
const party = z
  .object({
    name: text(200),
    vatId: z
      .string()
      .trim()
      .regex(/^DE\d{9}$/),
    address: z.object({ line1: text(200), city: text(100), postalCode: text(20), countryCode: z.literal("DE") }).strict(),
  })
  .strict();

// This is the deliberately narrower Grids input profile, also used before a
// document number exists. stdlib owns invoice calculation, serialization and
// final format validation; do not duplicate those rules here.
export const germanEInvoiceSnapshotSchema = z
  .object({
    invoiceDate: date,
    dueDate: date,
    currency: z.literal("EUR"),
    seller: party,
    buyer: party,
    buyerReference: text(100),
    payment: z
      .object({
        iban: z
          .string()
          .regex(/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/)
          .refine(isValidIBAN, "invalid IBAN"),
        accountName: text(200),
      })
      .strict(),
    lines: z
      .array(
        z
          .object({
            name: text(200),
            quantity: decimal(4).refine((value) => new Decimal(value).gt(0), "must be positive"),
            unitPrice: decimal(4),
            taxRate: decimal(2).refine(
              (value) => new Decimal(value).gt(0) && new Decimal(value).lte(100),
              "must be greater than 0 and at most 100",
            ),
          })
          .strict(),
      )
      .min(1)
      .max(1_000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.dueDate < value.invoiceDate) ctx.addIssue({ code: "custom", path: ["dueDate"], message: "must not precede invoiceDate" });
  });

const billingKindSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("invoice") }).strict(),
  z
    .object({
      kind: z.literal("creditNote"),
      original: z.object({ number: text(100), invoiceDate: date }).strict(),
      reason: text(500),
    })
    .strict(),
  z.object({ kind: z.literal("selfBilling"), agreementReference: text(200) }).strict(),
]);

export const germanBillingSnapshotSchema = germanEInvoiceSnapshotSchema
  .safeExtend({
    billing: billingKindSchema,
    serviceDate: date,
    lines: germanEInvoiceSnapshotSchema.shape.lines.element
      .extend({
        description: text(4_000).optional(),
        unitCode: z.enum(["C62", "HUR", "DAY", "KGM"]).optional(),
      })
      .strict()
      .array()
      .min(1)
      .max(1_000),
  })
  .superRefine((value, ctx) => {
    if (value.billing.kind === "creditNote" && value.billing.original.invoiceDate > value.invoiceDate) {
      ctx.addIssue({ code: "custom", path: ["billing", "original", "invoiceDate"], message: "must not follow invoiceDate" });
    }
    if (value.seller.vatId === value.buyer.vatId) {
      ctx.addIssue({ code: "custom", path: ["buyer", "vatId"], message: "seller and buyer must be different parties" });
    }
  });

type GermanEInvoiceSnapshot = z.infer<typeof germanEInvoiceSnapshotSchema> | z.infer<typeof germanBillingSnapshotSchema>;
type Render = (input: RenderFacturXHtmlToPdfInput) => Promise<{ pdf: Uint8Array }>;
type Validate = (input: { xml: string }) => Promise<{ valid: boolean; errors: unknown[] }>;
type ExtractEmbedded = (pdf: Uint8Array) => Promise<{ filename: string; xml: string }>;

const escapeXml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
const escapeHtml = escapeXml;
const normalizedXml = (value: string) => value.trim().replace(/encoding="utf-8"/i, 'encoding="UTF-8"');
const invoiceLines = (snapshot: GermanEInvoiceSnapshot): Invoice["lines"] =>
  snapshot.lines.map((line, index) => ({
    id: String(index + 1),
    name: line.name,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    taxRate: line.taxRate,
    unitCode: "unitCode" in line ? (line.unitCode ?? "C62") : "C62",
    ...("description" in line && line.description ? { description: line.description } : {}),
  }));

const calculate = (snapshot: GermanEInvoiceSnapshot) => {
  const totals = unwrap(einvoice.calculate(invoiceLines(snapshot)));
  return {
    lines: totals.lines.map((line) => ({ ...line, net: line.netAmount })),
    groups: new Map(totals.taxGroups.map((group) => [group.taxRate, { basis: group.netAmount, tax: group.taxAmount }])),
    net: totals.netAmount,
    tax: totals.taxAmount,
    total: totals.grossAmount,
  };
};

const invoiceInput = (snapshot: GermanEInvoiceSnapshot, number: string): Invoice => {
  const billing = "billing" in snapshot ? snapshot.billing : undefined;
  return {
    kind: billing?.kind ?? "invoice",
    number,
    invoiceDate: snapshot.invoiceDate,
    serviceDate: "serviceDate" in snapshot ? snapshot.serviceDate : snapshot.invoiceDate,
    dueDate: snapshot.dueDate,
    currency: snapshot.currency,
    buyerReference: snapshot.buyerReference,
    seller: snapshot.seller,
    buyer: snapshot.buyer,
    payment: snapshot.payment,
    lines: invoiceLines(snapshot),
    ...(billing?.kind === "creditNote"
      ? { precedingInvoice: billing.original, notes: [billing.reason] }
      : billing?.kind === "selfBilling"
        ? { notes: [`Gutschrift (Selbstabrechnung). Vereinbarung: ${billing.agreementReference}`] }
        : {}),
  };
};

export const buildGermanEInvoiceXml = (
  snapshot: GermanEInvoiceSnapshot,
  context: Parameters<DocumentProfile<GermanEInvoiceSnapshot>["issue"]>[1],
): string => unwrap(einvoice.serialize(invoiceInput(snapshot, context.number), { format: "zugferd-2.5-en16931" })).xml;

const buildHtml = (snapshot: GermanEInvoiceSnapshot, number: string) => {
  const totals = calculate(snapshot);
  const billing = "billing" in snapshot ? snapshot.billing : undefined;
  const title =
    billing?.kind === "creditNote" ? "Rechnungskorrektur" : billing?.kind === "selfBilling" ? "Gutschrift (Selbstabrechnung)" : "Rechnung";
  const detail =
    billing?.kind === "creditNote"
      ? `<p>Bezug: ${escapeHtml(billing.original.number)} vom ${billing.original.invoiceDate}<br>${escapeHtml(billing.reason)}</p>`
      : billing?.kind === "selfBilling"
        ? `<p>Erstellt durch den Leistungsempfänger (Käufer). Vereinbarung: ${escapeHtml(billing.agreementReference)}</p>`
        : "";
  const service = "serviceDate" in snapshot ? `<p>Leistungsdatum: ${snapshot.serviceDate}</p>` : "";
  const unitLabel = (line: (typeof totals.lines)[number]) => {
    const unit = "unitCode" in line ? line.unitCode : "C62";
    return unit === "HUR" ? "Std." : unit === "DAY" ? "Tage" : unit === "KGM" ? "kg" : "Stk.";
  };
  const rows = totals.lines
    .map(
      (line) =>
        `<tr><td>${escapeHtml(line.name)}${"description" in line && line.description ? `<div class="description">${escapeHtml(line.description)}</div>` : ""}</td><td>${line.quantity} ${unitLabel(line)}</td><td>${line.unitPrice} EUR</td><td>${line.taxRate} %</td><td>${line.net} EUR</td></tr>`,
    )
    .join("");
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>@page{size:A4;margin:18mm}body{font:12px system-ui;color:#17202a}h1{font-size:24px}table{width:100%;border-collapse:collapse;margin-top:24px}thead{display:table-header-group}tr{break-inside:avoid}th,td{padding:8px;border-bottom:1px solid #ccd1d1;text-align:right;vertical-align:top}th:first-child,td:first-child{text-align:left;overflow-wrap:anywhere}.description{white-space:pre-wrap;margin-top:4px}.total{font-weight:700}.settlement{break-inside:avoid}.settlement td{white-space:nowrap}.settlement .payment{text-align:left;white-space:normal;overflow-wrap:anywhere}</style></head><body><h1>${title} ${escapeHtml(number)}</h1>${detail}${service}<p>${escapeHtml(snapshot.seller.name)} · ${escapeHtml(snapshot.seller.address.line1)} · ${escapeHtml(snapshot.seller.address.postalCode)} ${escapeHtml(snapshot.seller.address.city)}</p><p>An: ${escapeHtml(snapshot.buyer.name)}<br>${escapeHtml(snapshot.buyer.address.line1)}<br>${escapeHtml(snapshot.buyer.address.postalCode)} ${escapeHtml(snapshot.buyer.address.city)}</p><p>Rechnungsdatum: ${snapshot.invoiceDate} · Fällig: ${snapshot.dueDate}</p><table><thead><tr><th>Leistung</th><th>Menge</th><th>Einzelpreis</th><th>USt.</th><th>Netto</th></tr></thead><tbody>${rows}</tbody><tbody class="settlement"><tr><td colspan="4">Netto</td><td>${totals.net} EUR</td></tr><tr><td colspan="4">Umsatzsteuer</td><td>${totals.tax} EUR</td></tr><tr class="total"><td colspan="4">Gesamt</td><td>${totals.total} EUR</td></tr><tr><td class="payment" colspan="5">IBAN: ${snapshot.payment.iban}</td></tr></tbody></table></body></html>`;
};

export const createGermanEInvoiceProfile = (
  dependencies: { render?: Render; validate?: Validate; extractEmbedded?: ExtractEmbedded } = {},
): DocumentProfile<GermanEInvoiceSnapshot> => ({
  id: "de.zugferd.en16931",
  version: 1,
  title: "German E-Invoice (ZUGFeRD EN 16931)",
  description:
    "Outgoing EUR invoices using ZUGFeRD 2.5 / Factur-X 1.09 EN 16931. Technical validation is not tax or legal approval. The issuer is responsible for invoice content and suitability for the intended use.",
  rendererVersion: "stdlib-0.25.0-gotenberg-8.36.0-factur-x",
  validatorVersion: "stdlib-0.25.0-zugferd-2.5-en16931-xsd",
  primaryArtifact: { key: "pdf", mediaType: "application/pdf" },
  input: germanEInvoiceSnapshotSchema,
  formatNumber: ({ value, issuedAt }) => `RE-${issuedAt.getUTCFullYear()}-${String(value).padStart(6, "0")}`,
  issue: async (snapshot, context) => {
    const xml = buildGermanEInvoiceXml(snapshot, context);
    const validation = await (
      dependencies.validate ??
      (async ({ xml: value }) => {
        const result = await validateInvoiceXml(value, { format: "zugferd-2.5-en16931" });
        return result.ok ? { valid: true, errors: [] } : { valid: false, errors: result.error.issues };
      })
    )({ xml });
    if (!validation.valid) {
      throw new Error(`Generated E-Invoice failed XSD validation: ${JSON.stringify(validation.errors).slice(0, 2_000)}`);
    }
    const rendered = await (dependencies.render ?? renderFacturXHtmlToPdf)({ html: buildHtml(snapshot, context.number), xml });
    const embedded = await (
      dependencies.extractEmbedded ??
      (async (pdf) => {
        const parsed = unwrap(await einvoice.parsePdf(pdf));
        return { filename: parsed.filename, xml: parsed.xml };
      })
    )(rendered.pdf);
    if (embedded.filename.toLowerCase() !== "factur-x.xml" || normalizedXml(embedded.xml) !== normalizedXml(xml)) {
      throw new Error("Rendered E-Invoice does not contain the generated Factur-X XML.");
    }
    const safeNumber = context.number.replaceAll(/[^A-Za-z0-9._-]/g, "_");
    const totals = calculate(snapshot);
    return {
      output: {
        currency: snapshot.currency,
        netAmount: totals.net,
        taxAmount: totals.tax,
        grossAmount: totals.total,
        taxGroups: [...totals.groups].map(([taxRate, group]) => ({
          taxRate,
          netAmount: group.basis,
          taxAmount: group.tax,
        })),
      },
      artifacts: [
        { key: "pdf", filename: `${safeNumber}.pdf`, mediaType: "application/pdf", bytes: rendered.pdf },
        { key: "structured", filename: "factur-x.xml", mediaType: "application/xml", bytes: new TextEncoder().encode(xml) },
      ],
      validationStatus: "valid",
      validationReport: {
        standard: "EN 16931",
        syntax: "UN/CEFACT CII D22B",
        profile: "ZUGFeRD 2.5 / Factur-X 1.09 EN 16931",
        inputRules: "valid",
        xsd: "valid",
        embeddedXml: "verified",
        rounding: "line and tax-group half-up to 2 decimal places",
      },
    };
  },
});

export const germanEInvoiceProfile = createGermanEInvoiceProfile();

export const createGermanBillingProfile = (
  dependencies: Parameters<typeof createGermanEInvoiceProfile>[0] = {},
): DocumentProfile<z.infer<typeof germanBillingSnapshotSchema>> => ({
  ...createGermanEInvoiceProfile(dependencies),
  version: 2,
  title: "German invoices, credit notes and self-billing (ZUGFeRD EN 16931)",
  description:
    "EUR invoices, credit notes referring to an original invoice, and self-billing with an agreement reference. Seller remains the supplier and buyer the customer. Technical validation is not tax or legal approval; original-document eligibility and remaining credit or settlement balances must be checked by the issuing workflow.",
  input: germanBillingSnapshotSchema,
});

export const germanBillingProfile = createGermanBillingProfile();
