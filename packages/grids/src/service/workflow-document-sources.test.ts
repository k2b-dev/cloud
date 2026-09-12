import { expect, test } from "bun:test";
import { sql } from "bun";
import {
  captureWorkflowDocumentSource,
  planWorkflowDocumentSource,
  projectDocumentSnapshotRows,
  WorkflowDocumentSourceSchema,
} from "./workflow-document-sources";

const source = WorkflowDocumentSourceSchema.parse({
  documents: ["DOC001"],
  columns: [{ key: "amount", type: "decimal", path: ["profile", "amount"] }],
});
const at = "2026-09-11T00:00:00.000Z";

test("document snapshot projection preserves exact values and source identities", () => {
  const result = projectDocumentSnapshotRows(source, [{ profile: { amount: "9007199254740993.01" } }], at);
  if (!result.ok) throw result.error;
  expect(result.data.payload.source).toEqual({ kind: "documents", ids: ["DOC001"] });
  expect(result.data.payload.rows).toEqual([{ amount: "9007199254740993.01" }]);
  expect(result.data.payload.rowCount).toBe(1);
  expect(result.data.payload.schemaHash).toBeNull();
});

test("document projection rejects missing paths, inherited values, duplicates and type mismatches", () => {
  for (const document of [
    { profile: {} },
    { profile: null },
    { profile: { amount: 12.3 } },
    { profile: Object.create({ amount: "1.00" }) },
  ])
    expect(projectDocumentSnapshotRows(source, [document], at).ok).toBe(false);
  expect(projectDocumentSnapshotRows(source, [], at).ok).toBe(false);
  expect(WorkflowDocumentSourceSchema.safeParse({ ...source, documents: ["DOC001", "DOC001"] }).success).toBe(false);
  expect(WorkflowDocumentSourceSchema.safeParse({ ...source, documents: ["not-a-public-id"] }).success).toBe(false);
});

test("planned source IDs need no database lookup and are rejected by real capture", async () => {
  const input = { source: { ...source, documents: ["dry-run:steps.0"] }, baseId: "00000000-0000-4000-8000-000000000001" };
  expect(await planWorkflowDocumentSource(input, sql)).toEqual({ ok: true, data: { plannedDocuments: 1 } });
  expect((await captureWorkflowDocumentSource({ ...input, capturedAt: at }, sql)).ok).toBe(false);
  expect(
    (await planWorkflowDocumentSource({ ...input, source: { ...input.source, documents: ["dry-run:steps.0", "dry-run:steps.0"] } }, sql))
      .ok,
  ).toBe(false);
});
