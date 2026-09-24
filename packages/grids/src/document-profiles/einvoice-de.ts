import { type RenderFacturXHtmlToPdfInput, renderFacturXHtmlToPdf } from "@k2b/cloud/services/pdf";
import { unwrap } from "@k2b/stdlib";
import { einvoice, type Invoice } from "@k2b/stdlib/finance";
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

const escapeXml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
const escapeHtml = escapeXml;
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

// The profile emits German human-readable documents; machine values stay exact.
const germanInteger = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });
const germanDate = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
const displayDecimal = (value: string, minimumFractionDigits = 0): string => {
  const decimal = new Decimal(value);
  const [integer = "0", fraction] = decimal.toFixed(Math.max(minimumFractionDigits, decimal.decimalPlaces())).split(".");
  return `${germanInteger.format(BigInt(integer))}${fraction ? `,${fraction}` : ""}`;
};
const displayDate = (value: string): string => germanDate.format(new Date(`${value}T00:00:00Z`));

const buildHtml = (snapshot: GermanEInvoiceSnapshot, number: string) => {
  const totals = calculate(snapshot);
  const billing = "billing" in snapshot ? snapshot.billing : undefined;
  const title =
    billing?.kind === "creditNote" ? "Rechnungskorrektur" : billing?.kind === "selfBilling" ? "Gutschrift (Selbstabrechnung)" : "Rechnung";
  const detail =
    billing?.kind === "creditNote"
      ? `<p>Bezug: ${escapeHtml(billing.original.number)} vom ${displayDate(billing.original.invoiceDate)}<br>${escapeHtml(billing.reason)}</p>`
      : billing?.kind === "selfBilling"
        ? `<p>Erstellt durch den Leistungsempfänger (Käufer). Vereinbarung: ${escapeHtml(billing.agreementReference)}</p>`
        : "";
  const service = "serviceDate" in snapshot ? `<p>Leistungsdatum: ${displayDate(snapshot.serviceDate)}</p>` : "";
  const unitLabel = (line: (typeof totals.lines)[number]) => {
    const unit = "unitCode" in line ? line.unitCode : "C62";
    return unit === "HUR" ? "Std." : unit === "DAY" ? "Tage" : unit === "KGM" ? "kg" : "Stk.";
  };
  const rows = totals.lines
    .map(
      (line) =>
        `<tr><td>${escapeHtml(line.name)}${"description" in line && line.description ? `<div class="description">${escapeHtml(line.description)}</div>` : ""}</td><td>${displayDecimal(line.quantity)} ${unitLabel(line)}</td><td>${displayDecimal(line.unitPrice)} EUR</td><td>${displayDecimal(line.taxRate)} %</td><td>${displayDecimal(line.net, 2)} EUR</td></tr>`,
    )
    .join("");
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>@page{size:A4;margin:18mm}body{font:12px system-ui;color:#17202a}h1{font-size:24px}table{width:100%;border-collapse:collapse;margin-top:24px}thead{display:table-header-group}tr{break-inside:avoid}th,td{padding:8px;border-bottom:1px solid #ccd1d1;text-align:right;vertical-align:top}th:first-child,td:first-child{text-align:left;overflow-wrap:anywhere}.description{white-space:pre-wrap;margin-top:4px}.total{font-weight:700}.settlement{break-inside:avoid}.settlement td{white-space:nowrap}.settlement .payment{text-align:left;white-space:normal;overflow-wrap:anywhere}</style></head><body><h1>${title} ${escapeHtml(number)}</h1>${detail}${service}<p>${escapeHtml(snapshot.seller.name)} · ${escapeHtml(snapshot.seller.address.line1)} · ${escapeHtml(snapshot.seller.address.postalCode)} ${escapeHtml(snapshot.seller.address.city)}</p><p>An: ${escapeHtml(snapshot.buyer.name)}<br>${escapeHtml(snapshot.buyer.address.line1)}<br>${escapeHtml(snapshot.buyer.address.postalCode)} ${escapeHtml(snapshot.buyer.address.city)}</p><p>Rechnungsdatum: ${displayDate(snapshot.invoiceDate)} · Fällig: ${displayDate(snapshot.dueDate)}</p><table><thead><tr><th>Leistung</th><th>Menge</th><th>Einzelpreis</th><th>USt.</th><th>Netto</th></tr></thead><tbody>${rows}</tbody><tbody class="settlement"><tr><td colspan="4">Netto</td><td>${displayDecimal(totals.net, 2)} EUR</td></tr><tr><td colspan="4">Umsatzsteuer</td><td>${displayDecimal(totals.tax, 2)} EUR</td></tr><tr class="total"><td colspan="4">Gesamt</td><td>${displayDecimal(totals.total, 2)} EUR</td></tr><tr><td class="payment" colspan="5">IBAN: ${snapshot.payment.iban}</td></tr></tbody></table></body></html>`;
};

export const createGermanEInvoiceProfile = (dependencies: { render?: Render } = {}): DocumentProfile<GermanEInvoiceSnapshot> => ({
  id: "de.zugferd.en16931",
  version: 1,
  title: "German E-Invoice (ZUGFeRD EN 16931)",
  description:
    "Outgoing EUR invoices using ZUGFeRD 2.5 / Factur-X 1.09 EN 16931. Technical validation is not tax or legal approval. The issuer is responsible for invoice content and suitability for the intended use.",
  rendererVersion: "stdlib-0.26.0-gotenberg-8.36.0-factur-x",
  validatorVersion: "stdlib-0.26.0-input-rules",
  primaryArtifact: { key: "pdf", mediaType: "application/pdf" },
  input: germanEInvoiceSnapshotSchema,
  formatNumber: ({ value, issuedAt }) => `RE-${issuedAt.getUTCFullYear()}-${String(value).padStart(6, "0")}`,
  issue: async (snapshot, context) => {
    const xml = buildGermanEInvoiceXml(snapshot, context);
    const rendered = await (dependencies.render ?? renderFacturXHtmlToPdf)({ html: buildHtml(snapshot, context.number), xml });
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
      validationStatus: "unchecked",
      validationReport: {
        standard: "EN 16931",
        syntax: "UN/CEFACT CII D22B",
        profile: "ZUGFeRD 2.5 / Factur-X 1.09 EN 16931",
        inputRules: "valid",
        xsd: "not_checked",
        embeddedXml: "not_checked",
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
