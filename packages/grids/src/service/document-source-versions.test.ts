import { expect, test } from "bun:test";
import { WorkflowQueryPayloadSchema } from "../workflows/query-contracts";
import { canonicalDocumentJson } from "./document-json";
import { DocumentSourceVersionsSchema, sourceVersionsFromData } from "./document-source-versions";

test("source version declarations require unique public record identities and exact positive versions", () => {
  const item = { tableId: "TABLE1", recordId: "RECORD", version: 1 };
  expect(DocumentSourceVersionsSchema.safeParse([item]).success).toBe(true);
  for (const value of [
    [],
    [item, item],
    [{ ...item, version: 0 }],
    [{ ...item, version: 1.5 }],
    [{ ...item, version: "1" }],
    [{ ...item, version: Number.MAX_SAFE_INTEGER + 1 }],
    [{ ...item, recordId: "00000000-0000-4000-8000-000000000001" }],
    [{ ...item, extra: true }],
  ])
    expect(DocumentSourceVersionsSchema.safeParse(value).success).toBe(false);
});

test("automatic versions use frozen row metadata and fail closed for ambiguous or old captures", () => {
  const old = {
    version: 1,
    columns: [],
    rows: [{}],
    rowOrigins: [{ tableId: "TABLE1", recordId: "RECORD" }],
    rowCount: 1,
    capturedAt: "2026-09-11T00:00:00.000Z",
    complete: true,
    selectionLimit: null,
    source: "from table {TABLE1}",
    schemaHash: "a".repeat(64),
    context: {},
    tableIds: ["00000000-0000-4000-8000-000000000001"],
  };
  const legacy = WorkflowQueryPayloadSchema.parse(old);
  expect(canonicalDocumentJson(legacy).sha256).toBe(canonicalDocumentJson(old).sha256);
  expect(() => sourceVersionsFromData(legacy)).toThrow();
  const capture = WorkflowQueryPayloadSchema.parse({ ...old, rowOrigins: [{ ...old.rowOrigins[0], version: 7 }] });
  expect(sourceVersionsFromData(capture)).toEqual([{ tableId: "TABLE1", recordId: "RECORD", version: 7 }]);
  const empty = { ...capture, rowOrigins: [], rows: [], rowCount: 0 };
  for (const [locale, message] of [
    ["en", "No records were found"],
    ["de", "keine Datensätze gefunden"],
  ] as const) {
    let failure: unknown;
    try {
      sourceVersionsFromData(empty, locale);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "BAD_INPUT", status: 400, message: expect.stringContaining(message) });
  }
  for (const payload of [
    { ...capture, source: "from table {TABLE1}; left join table {TABLE1} as other on {FIELD1} = other.id; select {FIELD2}" },
    { ...capture, tableIds: [...capture.tableIds, "00000000-0000-4000-8000-000000000002"] },
    { ...capture, rowOrigins: [{ tableId: null, recordId: null }] },
    { ...capture, rowOrigins: [...capture.rowOrigins, ...capture.rowOrigins], rows: [{}, {}], rowCount: 2 },
    { ...capture, rowOrigins: [], rows: [], rowCount: 0 },
  ])
    expect(() => sourceVersionsFromData(payload)).toThrow();
});
