import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { CODE_FILE_LIMITS, generateCodeSdk } from "@k2b/cloud/code";
import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import * as pdf from "@k2b/cloud/services";
import { codePolicyRow } from "../policy-contracts";
import { createGeneratedFileQueries } from "./capabilities";
import { testIdentity } from "./test-identity";

beforeEach(() => setSystemTime(new Date("2026-11-11T10:00:00.000Z")));
afterEach(() => setSystemTime());
const identity = testIdentity("file-owner");
const context: CapabilityExecutionContext = {
  ...identity,
  locale: "de-DE",
  requestId: "generation-one",
  origin: "app",
  signal: new AbortController().signal,
};
function fixture() {
  let saved = new Uint8Array();
  let reservations = 0;
  const queries = createGeneratedFileQueries({
    reserve: async () => {
      reservations++;
      return "reserved";
    },
    put: async (bytes, name, mediaType) => {
      saved = new Uint8Array(bytes);
      return { id: "opaque-file", name, mediaType, size: bytes.byteLength, direction: "read", expiresAt: "2026-11-11T10:10:00Z" };
    },
    read: async () => new Response(saved),
  });
  return { queries, bytes: () => saved, reservations: () => reservations };
}
test("generated helpers compile as read streams and read-only Code policy", () => {
  const manifest = compileCapabilityManifest("core", { protocolVersion: 2, queries: fixture().queries });
  expect(manifest.actions).toEqual([]);
  for (const query of manifest.queries) {
    expect(query.stream).toEqual({ direction: "read", maxBytes: CODE_FILE_LIMITS.fileBytes });
    expect(codePolicyRow("query")).toBe("read");
  }
  const sdk = generateCodeSdk([manifest], { mode: "personal" });
  for (const name of ["pdf", "sheet", "finance", "chart"]) expect(sdk.declarations).toContain(`export declare const ${name}:`);
});
test("CSV uses locale decimals and neutralizes spreadsheet formulas", async () => {
  const f = fixture();
  const result = await f.queries["file.sheet.to-csv.v1"].run(
    {
      name: "report.csv",
      rows: [
        { amount: 12.5, note: " =SUM(A1:A9)" },
        { amount: -4, note: 'a;"b' },
      ],
    },
    context,
  );
  expect(result.ok).toBe(true);
  expect(new TextDecoder().decode(f.bytes())).toBe('amount;note\r\n12,5;\' =SUM(A1:A9)\r\n-4;"a;""b"\r\n');
  expect(f.reservations()).toBe(1);
});
test("ODS output is a real readable workbook of plain cells", async () => {
  const f = fixture();
  expect(
    (
      await f.queries["file.sheet.to-ods.v1"].run(
        {
          name: "report.ods",
          sheets: [
            {
              name: "Report",
              rows: [
                ["Name", "Amount"],
                ["=literal", 12.5],
              ],
            },
          ],
        },
        context,
      )
    ).ok,
  ).toBe(true);
  const { readOds } = await import("hucre/ods");
  const workbook = await readOds(f.bytes().slice().buffer);
  expect(workbook.sheets[0]?.rows).toEqual([
    ["Name", "Amount"],
    ["=literal", 12.5],
  ]);
});
test("DATEV and SEPA use stdlib validation and exact decimal serialization", async () => {
  const f = fixture();
  const datev = {
    name: "postings.csv",
    batch: {
      format: "datev-700-13" as const,
      currency: "EUR" as const,
      consultantNumber: "1001",
      clientNumber: "1",
      fiscalYearStart: "2026-01-01",
      accountLength: 4,
      periodStart: "2026-11-01",
      periodEnd: "2026-11-30",
      label: "November",
      finalize: false,
      createdAt: "2026-11-11T10:00:00.000Z",
      rows: [
        {
          amount: "12.50",
          direction: "S" as const,
          account: "1200",
          counterAccount: "8400",
          documentDate: "2026-11-11",
          documentNumber: "INV-1",
        },
      ],
    },
  };
  expect((await f.queries["file.finance.datev.v1"].run(datev, context)).ok).toBe(true);
  expect(new TextDecoder().decode(f.bytes())).toContain('12,50;"S";"EUR"');
  const sepa = {
    name: "payments.xml",
    batch: {
      format: "sepa-sct-pain.001.001.09-gbic-5" as const,
      currency: "EUR" as const,
      debtorName: "Example",
      debtorIban: "DE89370400440532013000",
      executionDate: "2026-11-12",
      createdAt: "2026-11-11T10:00:00.000Z",
      messageId: "batch-1",
      paymentInformationId: "payment-1",
      rows: [
        {
          endToEndId: "invoice-1",
          amount: "12.50",
          creditorName: "Supplier",
          creditorIban: "DE89370400440532013000",
          remittance: "Invoice 1",
        },
      ],
    },
  };
  expect((await f.queries["file.finance.sepa.v1"].run(sepa, context)).ok).toBe(true);
  expect(new TextDecoder().decode(f.bytes())).toContain('<InstdAmt Ccy="EUR">12.50</InstdAmt>');
  sepa.batch.rows[0]!.amount = "12.500";
  await expect(f.queries["file.finance.sepa.v1"].run(sepa, context)).rejects.toMatchObject({ code: "BAD_INPUT" });
});
test("chart output is SVG drawn from a checked description", async () => {
  const f = fixture();
  const result = await f.queries["file.chart.render.v1"].run(
    { name: "chart.svg", chart: { kind: "bar", title: "Items", data: [{ label: "One", value: 12 }] } },
    context,
  );
  expect(result.ok).toBe(true);
  expect(new TextDecoder().decode(f.bytes())).toContain("<svg");
  await expect(
    f.queries["file.chart.render.v1"].run(
      {
        name: "invalid.svg",
        chart: {
          kind: "waterfall",
          title: "Invalid range",
          start: { label: "Start", value: 1e308 },
          steps: [{ label: "Overflow", value: 1e308 }],
          end: { label: "End" },
        },
      },
      context,
    ),
  ).rejects.toMatchObject({ code: "BAD_INPUT", status: 400 });
});
test("oversized generator input fails before reserving resources", async () => {
  const f = fixture();
  const result = await f.queries["file.pdf.render.v1"].run({ name: "report.pdf", html: "x".repeat(256 * 1024) }, context);
  expect(result).toMatchObject({ ok: false, error: { code: "BAD_INPUT" } });
  expect(f.reservations()).toBe(0);
});
test("PDF uses the existing renderer with tagged output, the file byte ceiling and cancellation", async () => {
  const configuration = {
    url: "http://renderer.test",
    timeoutMs: 1000,
    maxHtmlBytes: 256 * 1024,
    maxPdfBytes: CODE_FILE_LIMITS.totalBytes,
  };
  const config = spyOn(pdf, "getGotenbergConfig").mockResolvedValue(configuration);
  const render = spyOn(pdf, "renderHtmlToPdfWithConfig").mockResolvedValue({
    pdf: new Uint8Array([37, 80, 68, 70]),
    contentType: "application/pdf",
  });
  try {
    const f = fixture();
    expect((await f.queries["file.pdf.render.v1"].run({ name: "report.pdf", html: "<h1>Report</h1>" }, context)).ok).toBe(true);
    expect(render).toHaveBeenCalledWith(
      { name: "report.pdf", html: "<h1>Report</h1>", tagged: true },
      { ...configuration, maxPdfBytes: CODE_FILE_LIMITS.fileBytes },
      { signal: context.signal },
    );
    expect(f.bytes()).toEqual(new Uint8Array([37, 80, 68, 70]));
  } finally {
    config.mockRestore();
    render.mockRestore();
  }
});
