import { expect, test } from "bun:test";
import { WorkflowQueryPayloadSchema } from "../workflows/query-contracts";
import { capturedDocumentRecords } from "./document-record-sources";

const capture = WorkflowQueryPayloadSchema.parse({
  version: 1,
  columns: [],
  rows: [{}],
  rowOrigins: [{ tableId: "TABLE1", recordId: "RECORD", version: 7 }],
  rowCount: 1,
  capturedAt: "2026-09-13T00:00:00.000Z",
  complete: true,
  selectionLimit: null,
  source: "from table {TABLE1}",
  schemaHash: "a".repeat(64),
  context: {},
  tableIds: ["00000000-0000-4000-8000-000000000001"],
});

test("document membership preserves frozen record versions and deduplicates records", () => {
  expect(capturedDocumentRecords(capture)).toEqual([{ tableId: "TABLE1", recordId: "RECORD", version: 7 }]);
  expect(
    capturedDocumentRecords({ ...capture, rows: [{}, {}], rowCount: 2, rowOrigins: [...capture.rowOrigins, ...capture.rowOrigins] }),
  ).toEqual([{ tableId: "TABLE1", recordId: "RECORD", version: 7 }]);
  expect(capturedDocumentRecords({ ...capture, rows: [], rowOrigins: [], rowCount: 0 })).toEqual([]);
});

test("ambiguous provenance never implies document membership", () => {
  for (const source of [
    "from view {VIEW01}",
    "from table {TABLE1}\naggregate count(*) as total",
    "from table {TABLE1}\nleft join table {TABLE2} as other on {FIELD1} = other.{FIELD2}",
  ])
    expect(capturedDocumentRecords({ ...capture, source })).toBeNull();
  expect(capturedDocumentRecords({ ...capture, rowOrigins: [{ tableId: null, recordId: null }] })).toBeNull();
  expect(capturedDocumentRecords({ ...capture, rowOrigins: [{ tableId: "TABLE1", recordId: "RECORD" }] })).toBeNull();
  expect(
    capturedDocumentRecords({
      ...capture,
      rows: [{}, {}],
      rowCount: 2,
      rowOrigins: [...capture.rowOrigins, { ...capture.rowOrigins[0]!, version: 8 }],
    }),
  ).toBeNull();
});
