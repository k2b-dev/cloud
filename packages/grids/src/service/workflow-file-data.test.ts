import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { unwrap } from "@k2b/stdlib";
import { workflowFileReferenceFromOutcome } from "../workflows/file-preview-contracts";
import { WorkflowFilePayloadSchema } from "../workflows/query-contracts";
import { captureWorkflowCamt, workflowFilePreview } from "./workflow-file-data";
import { camtFixture } from "./workflow-file-data.fixture";

const capture = (content: string | Uint8Array = camtFixture) => {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  return captureWorkflowCamt(
    {
      bytes,
      capturedAt: "2026-09-15T12:00:00.000Z",
      source: {
        fileId: "11111111-1111-4111-8111-111111111111",
        tableId: "22222222-2222-4222-8222-222222222222",
        recordId: "33333333-3333-4333-8333-333333333333",
        fieldId: "44444444-4444-4444-8444-444444444444",
        filename: "bank.xml",
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    },
    "en",
  );
};

describe("captured CAMT file", () => {
  test("reads the public MNB bank example through the Grids capture boundary", async () => {
    // Public example, namespace-normalized fixture from stdlib 0.25.0.
    // Original: https://www.mnb.hu/letoltes/camt-052-001-08-type1.txt
    const xml = await Bun.file(new URL("./fixtures/camt-mnb-type1.xml", import.meta.url)).text();
    const payload = WorkflowFilePayloadSchema.parse(unwrap(capture(xml)).payload);
    const preview = workflowFilePreview(payload);
    expect(preview.reports[0]).toMatchObject({ account: "OTPVHUHBXXX", entryCount: 0, pagination: { lastPage: true } });
    expect(preview.reports[0]?.details).toMatchObject({
      balances: [{ amount: { amount: "3000000", currency: "HUF" }, direction: "DBIT" }],
    });
  });
  test("retains exact bytes, decimal strings, bank status and hierarchy without inferring payments", () => {
    const original = `\uFEFF${camtFixture}`;
    const data = unwrap(capture(original));
    const payload = WorkflowFilePayloadSchema.parse(data.payload);
    expect(Buffer.from(payload.source.bytesBase64, "base64").toString("utf8")).toBe(original);
    expect(payload.source.pagination).toEqual({ pageNumber: "1", lastPage: false });
    expect(data.rowCount).toBe(2);
    const preview = workflowFilePreview(payload);
    expect(preview.reports[0]).toMatchObject({
      account: "DE89370400440532013000",
      entryCount: 2,
      statuses: { BOOK: 1, PDNG: 1 },
      pagination: { lastPage: false },
    });
    expect(preview.reports[0]?.details).toMatchObject({
      entries: [
        {
          amount: { amount: "125.50", currency: "EUR" },
          direction: "DBIT",
          reversal: true,
          details: [
            { transactions: [{ amount: { amount: "100.00", currency: "EUR" } }, { references: { endToEndId: "unknown-amount" } }] },
          ],
        },
        { amount: { amount: "0.00001", currency: "KWD" }, status: { value: "PDNG" } },
      ],
    });
    expect(JSON.stringify(payload.rows)).not.toContain('"amount":null');
    expect(preview.reports[1]).toMatchObject({ account: "another-account", currency: null, period: null, entryCount: 0 });
    expect(unwrap(capture(original)).sha256).toBe(data.sha256);
    expect(unwrap(capture(camtFixture)).sha256).not.toBe(data.sha256);
  });

  test("rejects unsupported versions, DTDs, malformed XML and non-UTF8 without exposing parser payloads", () => {
    for (const content of [
      camtFixture.replaceAll("052.001.08", "053.001.08"),
      camtFixture.slice(0, -10),
      camtFixture.replace("<Document", '<!DOCTYPE Document SYSTEM "file:///etc/passwd"><Document'),
      camtFixture.replace("UTF-8", "ISO-8859-1"),
      new Uint8Array([0xff, 0xfe, 0x80]),
    ]) {
      const result = capture(content);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("BAD_INPUT");
        expect(result.error.message).not.toContain("/etc/passwd");
      }
    }
    const version = capture(camtFixture.replaceAll("052.001.08", "053.001.08"));
    if (!version.ok) expect(version.error.message).toContain("only camt.052.001.08");
  });

  test("enforces the combined source and parsed-output byte budget, not just source size", () => {
    expect(capture(" ".repeat(5 * 1024 * 1024 + 1)).ok).toBe(false);
    const padded = camtFixture.replace("</Rpt>", `<AddtlRptInf>${"x".repeat(2300000)}</AddtlRptInf></Rpt>`);
    expect(new TextEncoder().encode(padded).length).toBeLessThan(5 * 1024 * 1024);
    expect(capture(padded).ok).toBe(false);
  });

  test("only a real successful file result opens the preview", () => {
    expect(workflowFileReferenceFromOutcome({ state: "succeeded", output: { kind: "fileSnapshot", id: "bad" } })).toBeNull();
    expect(workflowFileReferenceFromOutcome({ state: "planned", output: { kind: "fileSnapshot" } })).toBeNull();
    const result = unwrap(capture());
    expect(
      workflowFileReferenceFromOutcome({
        state: "succeeded",
        output: {
          kind: "fileSnapshot",
          stepKey: "steps.0",
          sha256: result.sha256,
          rowCount: 2,
          capturedAt: result.capturedAt,
        },
      }),
    ).not.toBeNull();
  });
});
