import { expect, test } from "bun:test";
import { MAX_WORKFLOW_QUERY_ROWS, WorkflowValuesPayloadSchema } from "../workflows/query-contracts";
import { renderDocumentTableOutput } from "./document-table-output";
import { captureWorkflowDocumentValues } from "./workflow-document-values";

const capturedAt = "2026-09-11T00:00:00.000Z";
const input = {
  columns: [
    { key: "amount", type: "decimal" },
    { key: "approved", type: "boolean" },
    { key: "items", type: "json" },
  ],
  rows: [{ amount: "9007199254740993.01", approved: true, items: [{ title: "Receipt", amount: "1.23" }] }],
};

test("workflow values retain exact types and honest provenance through the existing serializer", () => {
  const result = captureWorkflowDocumentValues(input, capturedAt);
  if (!result.ok) throw result.error;
  expect(result.data.payload.source).toEqual({ kind: "values" });
  expect(result.data.payload.schemaHash).toBeNull();
  expect(result.data.payload.tableIds).toEqual([]);
  expect(result.data.payload.rows).toEqual(input.rows);
  const rendered = renderDocumentTableOutput({ data: result.data.payload, output: { kind: "json" }, filename: "values.json" });
  if (!rendered.ok) throw rendered.error;
  expect(JSON.parse(new TextDecoder().decode(rendered.data.artifact.bytes))).toEqual(input.rows);
  expect(captureWorkflowDocumentValues({ ...input, rows: [] }, capturedAt).ok).toBe(true);
});

test("typed values fail closed for missing, extra or incorrectly typed cells", () => {
  for (const rows of [
    [{ ...input.rows[0], amount: 12.3 }],
    [{ ...input.rows[0], amount: "1e2" }],
    [{ ...input.rows[0], approved: "true" }],
    [{ amount: "1.00", approved: true }],
    [{ ...input.rows[0], hidden: "not declared" }],
    [{ ...input.rows[0], items: undefined }],
  ])
    expect(captureWorkflowDocumentValues({ ...input, rows }, capturedAt).ok).toBe(false);
  expect(captureWorkflowDocumentValues({ columns: [...input.columns, input.columns[0]], rows: [] }, capturedAt).ok).toBe(false);
  expect(captureWorkflowDocumentValues({ columns: [{ key: "date", type: "date" }], rows: [{ date: "2026-02-30" }] }, capturedAt).ok).toBe(
    false,
  );
  const nullable = captureWorkflowDocumentValues({ ...input, rows: [{ amount: null, approved: null, items: null }] }, capturedAt);
  expect(nullable.ok).toBe(true);
});

test("workflow values enforce capture budgets and cannot claim record provenance", () => {
  const columns = [{ key: "value", type: "text" }];
  expect(
    captureWorkflowDocumentValues({ columns, rows: Array.from({ length: MAX_WORKFLOW_QUERY_ROWS + 1 }, () => ({ value: "" })) }, capturedAt)
      .ok,
  ).toBe(false);
  expect(captureWorkflowDocumentValues({ columns, rows: [{ value: "x".repeat(5 * 1024 * 1024) }] }, capturedAt).ok).toBe(false);
  expect(captureWorkflowDocumentValues(Object.assign(new Date(), input), capturedAt).ok).toBe(false);
  const captured = captureWorkflowDocumentValues(input, capturedAt);
  if (!captured.ok) throw captured.error;
  expect(
    WorkflowValuesPayloadSchema.safeParse({ ...captured.data.payload, rowOrigins: [{ tableId: "TBL001", recordId: "REC001" }] }).success,
  ).toBe(false);
});
