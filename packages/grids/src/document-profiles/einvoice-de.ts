import {
  buildXml,
  DocumentTypeCode,
  extractXml,
  type FacturXInvoiceInput,
  Flavor,
  Profile,
  UnitCode,
  VatCategoryCode,
  validateInput,
  validateXsd,
} from "@stackforge-eu/factur-x";
import { type RenderFacturXHtmlToPdfInput, renderFacturXHtmlToPdf } from "@valentinkolb/cloud/services/pdf";
import Decimal from "decimal.js";
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
const validIban = (value: string) => {
  const rearranged = `${value.slice(4)}${value.slice(0, 4)}`;
  let remainder = 0;
  for (const character of rearranged) {
    const digits = /\d/.test(character) ? character : String(character.charCodeAt(0) - 55);
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
};
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
          .refine(validIban, "invalid IBAN checksum"),
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

type GermanEInvoiceSnapshot = z.infer<typeof germanEInvoiceSnapshotSchema>;
type Render = (input: RenderFacturXHtmlToPdfInput) => Promise<{ pdf: Uint8Array }>;
type Validate = (input: { xml: string }) => Promise<{ valid: boolean; errors: unknown[] }>;
type ExtractEmbedded = (pdf: Uint8Array) => Promise<{ filename: string; xml: string }>;

const escapeXml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
const escapeHtml = escapeXml;
const normalizedXml = (value: string) => value.trim().replace(/encoding="utf-8"/i, 'encoding="UTF-8"');
const money = (value: Decimal) => value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

const calculate = (snapshot: GermanEInvoiceSnapshot) => {
  const lines = snapshot.lines.map((line, index) => {
    const net = new Decimal(line.quantity).mul(line.unitPrice).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    return { ...line, id: String(index + 1), net };
  });
  const groups = new Map<string, { basis: Decimal; tax: Decimal }>();
  for (const line of lines) {
    const group = groups.get(line.taxRate) ?? { basis: new Decimal(0), tax: new Decimal(0) };
    group.basis = group.basis.plus(line.net);
    groups.set(line.taxRate, group);
  }
  for (const [rate, group] of groups) group.tax = group.basis.mul(rate).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const net = lines.reduce((sum, line) => sum.plus(line.net), new Decimal(0));
  const tax = [...groups.values()].reduce((sum, group) => sum.plus(group.tax), new Decimal(0));
  return { lines, groups, net, tax, total: net.plus(tax) };
};

const facturXInput = (
  snapshot: GermanEInvoiceSnapshot,
  context: Parameters<DocumentProfile<GermanEInvoiceSnapshot>["issue"]>[1],
): FacturXInvoiceInput => {
  const totals = calculate(snapshot);
  const party = (value: GermanEInvoiceSnapshot["seller"]) => ({
    name: value.name,
    address: {
      line1: value.address.line1,
      city: value.address.city,
      postalCode: value.address.postalCode,
      country: value.address.countryCode,
    },
    taxRegistrations: [{ id: value.vatId, schemeId: "VA" as const }],
  });
  return {
    document: {
      id: context.number,
      issueDate: snapshot.invoiceDate,
      typeCode: DocumentTypeCode.COMMERCIAL_INVOICE,
      buyerReference: snapshot.buyerReference,
    },
    seller: party(snapshot.seller),
    buyer: party(snapshot.buyer),
    lines: totals.lines.map((line) => ({
      id: line.id,
      name: line.name,
      quantity: Number(line.quantity),
      unitCode: UnitCode.UNIT,
      unitPrice: Number(line.unitPrice),
      vatCategoryCode: VatCategoryCode.STANDARD_RATE,
      vatRatePercent: Number(line.taxRate),
    })),
    totals: {
      lineTotal: Number(money(totals.net)),
      allowanceTotal: 0,
      chargeTotal: 0,
      taxBasisTotal: Number(money(totals.net)),
      taxTotal: Number(money(totals.tax)),
      grandTotal: Number(money(totals.total)),
      duePayableAmount: Number(money(totals.total)),
      currency: snapshot.currency,
    },
    vatBreakdown: [...totals.groups.entries()].map(([rate, group]) => ({
      categoryCode: VatCategoryCode.STANDARD_RATE,
      ratePercent: Number(rate),
      taxableAmount: Number(money(group.basis)),
      taxAmount: Number(money(group.tax)),
    })),
    payment: {
      meansCode: "58",
      iban: snapshot.payment.iban,
      accountName: snapshot.payment.accountName,
      dueDate: snapshot.dueDate,
    },
    delivery: { date: snapshot.invoiceDate },
  };
};

export const buildGermanEInvoiceXml = (
  snapshot: GermanEInvoiceSnapshot,
  context: Parameters<DocumentProfile<GermanEInvoiceSnapshot>["issue"]>[1],
): string => {
  const input = facturXInput(snapshot, context);
  const validation = validateInput(input, Profile.EN16931);
  if (!validation.valid)
    throw new Error(`E-Invoice input failed EN 16931 validation: ${JSON.stringify(validation.errors).slice(0, 2_000)}`);
  return buildXml(input, Profile.EN16931, Flavor.ZUGFERD);
};

const buildHtml = (snapshot: GermanEInvoiceSnapshot, number: string) => {
  const totals = calculate(snapshot);
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>@page{size:A4;margin:18mm}body{font:12px system-ui;color:#17202a}h1{font-size:24px}table{width:100%;border-collapse:collapse;margin-top:24px}th,td{padding:8px;border-bottom:1px solid #ccd1d1;text-align:right}th:first-child,td:first-child{text-align:left}.total{font-weight:700}</style></head><body><h1>Rechnung ${escapeHtml(number)}</h1><p>${escapeHtml(snapshot.seller.name)} · ${escapeHtml(snapshot.seller.address.line1)} · ${escapeHtml(snapshot.seller.address.postalCode)} ${escapeHtml(snapshot.seller.address.city)}</p><p>An: ${escapeHtml(snapshot.buyer.name)}<br>${escapeHtml(snapshot.buyer.address.line1)}<br>${escapeHtml(snapshot.buyer.address.postalCode)} ${escapeHtml(snapshot.buyer.address.city)}</p><p>Rechnungsdatum: ${snapshot.invoiceDate} · Fällig: ${snapshot.dueDate}</p><table><thead><tr><th>Leistung</th><th>Menge</th><th>Einzelpreis</th><th>USt.</th><th>Netto</th></tr></thead><tbody>${totals.lines.map((line) => `<tr><td>${escapeHtml(line.name)}</td><td>${line.quantity}</td><td>${line.unitPrice} EUR</td><td>${line.taxRate} %</td><td>${money(line.net)} EUR</td></tr>`).join("")}<tr><td colspan="4">Netto</td><td>${money(totals.net)} EUR</td></tr><tr><td colspan="4">Umsatzsteuer</td><td>${money(totals.tax)} EUR</td></tr><tr class="total"><td colspan="4">Gesamt</td><td>${money(totals.total)} EUR</td></tr></tbody></table><p>IBAN: ${snapshot.payment.iban}</p></body></html>`;
};

export const createGermanEInvoiceProfile = (
  dependencies: { render?: Render; validate?: Validate; extractEmbedded?: ExtractEmbedded } = {},
): DocumentProfile<GermanEInvoiceSnapshot> => ({
  id: "de.zugferd.en16931",
  version: 1,
  title: "German E-Invoice (ZUGFeRD EN 16931)",
  description:
    "Outgoing EUR invoices using ZUGFeRD 2.5 / Factur-X 1.09 EN 16931. Technical validation is not tax or legal approval. The issuer is responsible for invoice content and suitability for the intended use.",
  rendererVersion: "gotenberg-8.36.0-factur-x",
  validatorVersion: "stackforge-factur-x-1.2.0-xsd-en16931",
  input: germanEInvoiceSnapshotSchema,
  formatNumber: ({ value, issuedAt }) => `RE-${issuedAt.getUTCFullYear()}-${String(value).padStart(6, "0")}`,
  issue: async (snapshot, context) => {
    const xml = buildGermanEInvoiceXml(snapshot, context);
    const validation = await (dependencies.validate ?? (async ({ xml: value }) => validateXsd(value, Profile.EN16931)))({ xml });
    if (!validation.valid) {
      throw new Error(`Generated E-Invoice failed XSD validation: ${JSON.stringify(validation.errors).slice(0, 2_000)}`);
    }
    const rendered = await (dependencies.render ?? renderFacturXHtmlToPdf)({ html: buildHtml(snapshot, context.number), xml });
    const embedded = await (dependencies.extractEmbedded ?? (async (pdf) => extractXml(pdf)))(rendered.pdf);
    if (embedded.filename.toLowerCase() !== "factur-x.xml" || normalizedXml(embedded.xml) !== normalizedXml(xml)) {
      throw new Error("Rendered E-Invoice does not contain the generated Factur-X XML.");
    }
    const safeNumber = context.number.replaceAll(/[^A-Za-z0-9._-]/g, "_");
    return {
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
