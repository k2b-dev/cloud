import { describe, expect, test } from "bun:test";
import { financialQueryProfiles } from "../document-profiles/financial";
import type { WorkflowQueryCapture } from "../workflows/query-contracts";
import { type FinancialDocumentOutput, normalizeFinancialDocumentOutput } from "./document-financial-output";

// Exercise the Grids boundary, not a particular serializer implementation.
// These checks must keep working when the format layer moves to stdlib.
const outputs = [
  {
    kind: "datev-csv",
    version: 1,
    header: {
      destinationKey: "accounting-main",
      consultantNumber: "12345",
      clientNumber: "1",
      fiscalYearStart: "2026-01-01",
      accountLength: 4,
      periodStart: "2026-09-01",
      periodEnd: "2026-09-30",
      label: "September",
      finalize: false,
    },
    mapping: {
      businessId: "business",
      entryId: "entry",
      amount: "amount",
      direction: "side",
      account: "account",
      counterAccount: "other",
      documentDate: "date",
      documentNumber: "number",
    },
  },
  {
    kind: "sepa-xml",
    version: 1,
    header: {
      destinationKey: "bank-main",
      debtorName: "Example",
      debtorIban: "DE89370400440532013000",
      executionDate: "2026-09-16",
    },
    mapping: {
      businessId: "business",
      amount: "amount",
      endToEndId: "payment",
      creditorName: "payee",
      creditorIban: "iban",
      remittance: "purpose",
    },
  },
] satisfies [FinancialDocumentOutput, FinancialDocumentOutput];
const identifiers = { messageId: "message-1", paymentInformationId: "payment-1" };
const issuedAt = new Date("2026-09-15T12:00:00.000Z");

const capture = (output: FinancialDocumentOutput): WorkflowQueryCapture["payload"] => {
  const columns = [...Object.values(output.mapping), "private"].map((label, index) => ({
    key: `q_col_${index}`,
    label,
    type: "text",
    sqlType: "text",
  }));
  return {
    version: 1,
    columns,
    rows: ["0.1000", "0.2000"].map((amount, index) => {
      const values: Record<string, string> = {
        business: `internal-business-${index}`,
        entry: `internal-entry-${index}`,
        amount,
        side: "S",
        account: "00440",
        other: "70000",
        date: "2026-09-15",
        number: `RE-${index}`,
        payment: `transfer-${index}`,
        payee: `Partner ${index}`,
        iban: "DE89370400440532013000",
        purpose: `RE-${index}`,
        private: "unmapped-sensitive-value",
      };
      return Object.fromEntries(columns.map((column) => [column.key, values[column.label] ?? null]));
    }),
    rowOrigins: [
      { tableId: null, recordId: null },
      { tableId: null, recordId: null },
    ],
    rowCount: 2,
    capturedAt: issuedAt.toISOString(),
    complete: true,
    selectionLimit: null,
    source: "from table {ABC123}\nselect amount",
    schemaHash: "a".repeat(64),
    context: {},
    tableIds: ["00000000-0000-4000-8000-000000000001"],
  };
};

const normalized = (output: FinancialDocumentOutput, source = capture(output), ids = identifiers) => {
  const result = normalizeFinancialDocumentOutput(output, source, ids);
  if (!result.ok) throw result.error;
  return result.data;
};

const issue = (batch: ReturnType<typeof normalized>) => {
  const profile = financialQueryProfiles.find((item) => item.id === `grids.${batch.kind}`);
  if (!profile) throw new Error(`Missing profile ${batch.kind}`);
  return profile.issue(
    { ...batch.input, filename: batch.kind === "datev-csv" ? "EXTF_test.csv" : "test.xml" },
    {
      number: "EXPORT-1",
      issuedAt,
    },
  );
};

for (const output of outputs) {
  describe(`${output.kind} capture-to-profile contract`, () => {
    test("renders exact normalized values without mutating the capture or leaking unmapped data", async () => {
      const source = capture(output);
      const original = structuredClone(source);
      const batch = normalized(output, source);
      const originalBatch = structuredClone(batch);
      expect(batch.input.rows.map((row) => row.amount)).toEqual(["0.10", "0.20"]);
      expect(batch.input.rows.map((row) => row.businessId)).toEqual(["internal-business-0", "internal-business-1"]);
      const result = await issue(batch);
      expect(result.validationStatus).toBe("valid");
      expect(result.validationReport).toMatchObject(
        output.kind === "datev-csv"
          ? { rowCount: 2, businessCount: 2, debitTotal: "0.30", creditTotal: "0.00", imported: false }
          : { rowCount: 2, total: "0.30", submitted: false },
      );
      expect(result.artifacts).toHaveLength(1);
      const artifact = result.artifacts[0]!;
      expect(artifact).toMatchObject(
        output.kind === "datev-csv"
          ? { key: "csv", mediaType: "text/csv", filename: "EXTF_test.csv" }
          : { key: "xml", mediaType: "application/xml", filename: "test.xml" },
      );
      const text = new TextDecoder().decode(artifact.bytes);
      expect(text.indexOf("RE-0")).toBeGreaterThan(-1);
      expect(text.indexOf("RE-1")).toBeGreaterThan(text.indexOf("RE-0"));
      for (const secret of ["unmapped-sensitive-value", "internal-business", "internal-entry", batch.input.destinationKey]) {
        expect(text).not.toContain(secret);
      }
      expect(JSON.stringify(batch.input)).not.toContain("unmapped-sensitive-value");
      expect(await issue(batch)).toEqual(result);
      expect(source).toEqual(original);
      expect(batch).toEqual(originalBatch);
    });

    test("hash binds Grids identities even when they do not affect file bytes", async () => {
      const source = capture(output);
      const original = normalized(output, source);
      const rendered = await issue(original);
      const differentTarget = structuredClone(output);
      differentTarget.header.destinationKey = "different-target";
      const changedTarget = normalized(differentTarget, source);
      expect(changedTarget.sha256).not.toBe(original.sha256);
      expect((await issue(changedTarget)).artifacts).toEqual(rendered.artifacts);
      for (const label of output.kind === "datev-csv" ? ["business", "entry"] : ["business"]) {
        const key = source.columns.find((column) => column.label === label)!.key;
        const changed = normalized(output, { ...source, rows: source.rows.map((row) => ({ ...row, [key]: `${row[key]}-changed` })) });
        expect(changed.sha256).not.toBe(original.sha256);
        expect((await issue(changed)).artifacts).toEqual(rendered.artifacts);
      }
    });

    test("hash and file preserve row order rather than sorting by business identity", async () => {
      const source = capture(output);
      const original = normalized(output, source);
      const reversed = normalized(output, { ...source, rows: source.rows.toReversed(), rowOrigins: source.rowOrigins.toReversed() });
      expect(reversed.sha256).not.toBe(original.sha256);
      expect(reversed.input.rows.map((row) => row.amount)).toEqual(["0.20", "0.10"]);
      const [forward, backward] = await Promise.all([issue(original), issue(reversed)]);
      expect(backward.artifacts[0]!.bytes).not.toEqual(forward.artifacts[0]!.bytes);
      expect(backward.validationReport).toEqual(forward.validationReport);
    });

    test("invalid mapped values return localized field paths, not sensitive payloads", () => {
      const source = capture(output);
      const label = output.kind === "datev-csv" ? "number" : "iban";
      const field = output.kind === "datev-csv" ? "documentNumber" : "creditorIban";
      const key = source.columns.find((column) => column.label === label)!.key;
      const invalid = { ...source, rows: source.rows.map((row) => ({ ...row, [key]: "sensitive invalid value" })) };
      for (const locale of ["de", "en"]) {
        const result = normalizeFinancialDocumentOutput(output, invalid, identifiers, locale);
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("Expected rejected input");
        expect(result.error).toMatchObject({ code: "BAD_INPUT", status: 400 });
        expect(result.error.message).toContain(locale === "de" ? "Prüfe diese Felder" : "Check these fields");
        expect(result.error.message).toContain(`rows.0.${field}`);
        expect(result.error.message).toContain(`rows.1.${field}`);
        expect(result.error.message).not.toContain("sensitive");
      }
    });
  });
}

test("persisted SEPA identifiers bind the normalized hash and rendered XML", async () => {
  const output = outputs[1];
  const original = normalized(output);
  for (const key of ["messageId", "paymentInformationId"] as const) {
    const changed = normalized(output, capture(output), { ...identifiers, [key]: "changed-id" });
    expect(changed.sha256).not.toBe(original.sha256);
    const result = await issue(changed);
    const xml = new TextDecoder().decode(result.artifacts[0]!.bytes);
    expect(xml).toContain(`<${key === "messageId" ? "MsgId" : "PmtInfId"}>changed-id</${key === "messageId" ? "MsgId" : "PmtInfId"}>`);
  }
});
