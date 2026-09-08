import { beforeAll, describe, expect } from "bun:test";
import { err, fail, ok } from "@k2b/stdlib";
import { sql } from "bun";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { createDocumentForRecord } from "./document-core";
import { createTemplate, updateTemplate } from "./document-templates";
import * as fields from "./fields";
import * as records from "./record-write";
import { get as getTable } from "./tables";

type CreateDocumentInput = Parameters<typeof createDocumentForRecord>[0];
const renderedPdf = async () => ok({ pdf: new TextEncoder().encode("%PDF-1.7\npublic capture"), contentType: "application/pdf" });

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

const fixture = async () => {
  const baseId = testUuid();
  const tableId = testUuid();
  await sql`INSERT INTO grids.bases (id, short_id, name)
    VALUES (${baseId}::uuid, ${testShortId("B")}, 'Public Document capture')`;
  await sql`INSERT INTO grids.tables (id, short_id, base_id, name)
    VALUES (${tableId}::uuid, ${testShortId("T")}, ${baseId}::uuid, 'Root')`;
  const name = await fields.create({ tableId, name: "Name", type: "text", presentable: true }, null);
  if (!name.ok) throw name.error;
  const record = await records.create(tableId, { [name.data.id]: "Original root" }, null, "direct");
  if (!record.ok) throw record.error;
  const table = await getTable(tableId);
  if (!table) throw new Error("Missing Document fixture Table");
  const template = await createTemplate(
    tableId,
    {
      name: "Original template",
      source: `from table {${table.shortId}}\nlimit 1`,
      renderer: {
        kind: "html",
        body: "<p>Original template {{ document.number }}</p>",
        numberTemplate: "CAPTURE-{{ series.value }}",
        filenameTemplate: "{{ document.number }}.pdf",
      },
    },
    null,
  );
  if (!template.ok) throw template.error;
  const input: CreateDocumentInput = {
    template: template.data,
    table,
    recordId: record.data.id,
    actor: { kind: "system" },
    idempotencyKey: `capture-${testUuid()}`,
    canReadTable: async () => true,
    renderPdf: renderedPdf,
  };
  // Immutable issued Documents remain in the isolated verification database.
  return { baseId, table, name: name.data, record: record.data, template: template.data, input };
};

describe("public Document capture and replay", () => {
  postgresTest("concurrent first captures either replay or return a retryable conflict without duplicate issuance", async () => {
    const item = await fixture();
    const ready = Promise.withResolvers<void>();
    let arrivals = 0;
    const canReadTable = async () => {
      if (++arrivals === 2) ready.resolve();
      await ready.promise;
      return true;
    };
    const settled = await Promise.allSettled([
      createDocumentForRecord({ ...item.input, canReadTable }),
      createDocumentForRecord({ ...item.input, canReadTable }),
    ]);
    expect(settled.filter((result) => result.status === "rejected")).toEqual([]);
    const outcomes = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    const accepted = outcomes.find((result) => result.ok);
    expect(accepted?.ok).toBe(true);
    if (!accepted) throw new Error("No concurrent issuance was accepted");
    for (const result of outcomes) {
      if (!result.ok) expect(result.error.status).toBe(409);
    }
    expect(await createDocumentForRecord(item.input)).toEqual(accepted);
    const [count] = await sql<Array<{ value: number }>>`
      SELECT count(*)::int AS value FROM grids.documents WHERE base_id = ${item.baseId}::uuid
    `;
    expect(count?.value).toBe(1);
  });

  postgresTest("resumes a pending receipt and replays completion after Record and template edits", async () => {
    const item = await fixture();
    let renderCalls = 0;
    const attempts: Array<Parameters<NonNullable<CreateDocumentInput["renderPdf"]>>[0]> = [];
    const renderPdf: NonNullable<CreateDocumentInput["renderPdf"]> = async (document) => {
      renderCalls++;
      attempts.push(document);
      return renderCalls === 1 ? fail(err.internal("renderer unavailable")) : renderedPdf();
    };
    const failed = await createDocumentForRecord({ ...item.input, renderPdf });
    expect(failed.ok).toBe(false);
    const [pending] = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM grids.document_issuances
      WHERE base_id = ${item.baseId}::uuid AND document_id IS NULL
    `;
    expect(pending?.count).toBe(1);

    const changed = await records.update(item.table.id, item.record.id, { [item.name.id]: "Changed root" }, null, "direct");
    if (!changed.ok) throw changed.error;
    if (item.template.renderer.kind !== "html") throw new Error("Expected HTML template");
    const edited = await updateTemplate(
      item.template.id,
      { name: "Changed template", renderer: { ...item.template.renderer, body: "<p>Changed template</p>" }, enabled: false },
      null,
    );
    if (!edited.ok) throw edited.error;
    const recovered = await createDocumentForRecord({ ...item.input, template: edited.data, renderPdf });
    if (!recovered.ok) throw recovered.error;
    expect(attempts[1]).toEqual(attempts[0]);
    expect(recovered.data.documentNumber).toBe("CAPTURE-1");
    expect(recovered.data.renderData.record).toMatchObject({ version: 1, data: { [item.name.shortId]: "Original root" } });

    const changedAgain = await records.update(item.table.id, item.record.id, { [item.name.id]: "Changed again" }, null, "direct");
    if (!changedAgain.ok) throw changedAgain.error;
    const editedAgain = await updateTemplate(item.template.id, { name: "Changed again" }, null);
    if (!editedAgain.ok) throw editedAgain.error;
    const replay = await createDocumentForRecord({ ...item.input, template: editedAgain.data, renderPdf });
    expect(replay).toEqual(recovered);
    expect(renderCalls).toBe(2);

    const denied = await createDocumentForRecord({ ...item.input, template: editedAgain.data, canReadTable: async () => false, renderPdf });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("Denied replay returned a Document");
    expect(denied.error.status).toBe(404);
    for (const changedRequest of [
      { filename: "different.pdf" },
      { tags: ["different"] },
      { actor: { kind: "user" as const, userId: testUuid() } },
    ]) {
      const conflict = await createDocumentForRecord({ ...item.input, ...changedRequest, renderPdf });
      expect(conflict.ok).toBe(false);
      if (conflict.ok) throw new Error("Changed request reused an accepted issuance");
      expect(conflict.error.status).toBe(409);
    }
    expect(renderCalls).toBe(2);
    const [counts] = await sql<Array<{ receipts: number; documents: number; allocations: number }>>`
      SELECT
        (SELECT count(*)::int FROM grids.document_issuances WHERE base_id = ${item.baseId}::uuid) AS receipts,
        (SELECT count(*)::int FROM grids.documents WHERE base_id = ${item.baseId}::uuid) AS documents,
        (SELECT count(*)::int FROM grids.number_allocations a JOIN grids.number_series s ON s.id = a.series_id
          WHERE s.document_template_id = ${item.template.id}::uuid) AS allocations
    `;
    expect(counts).toEqual({ receipts: 1, documents: 1, allocations: 1 });
  });

  postgresTest("captures related query data and the snapshot graph from one database snapshot", async () => {
    const item = await fixture();
    const relatedTableId = testUuid();
    await sql`INSERT INTO grids.tables (id, short_id, base_id, name)
      VALUES (${relatedTableId}::uuid, ${testShortId("T")}, ${item.baseId}::uuid, 'Related')`;
    const name = await fields.create({ tableId: relatedTableId, name: "Name", type: "text", presentable: true }, null);
    if (!name.ok) throw name.error;
    const related = await records.create(relatedTableId, { [name.data.id]: "Original related" }, null, "direct");
    if (!related.ok) throw related.error;
    const relation = await fields.create(
      { tableId: item.table.id, name: "Related", type: "relation", config: { targetTableId: relatedTableId, cardinality: "single" } },
      null,
    );
    if (!relation.ok) throw relation.error;
    const linked = await records.update(item.table.id, item.record.id, { [relation.data.id]: [related.data.id] }, null, "direct");
    if (!linked.ok) throw linked.error;
    const relatedTable = await getTable(relatedTableId);
    if (!relatedTable) throw new Error("Missing related Table");
    const edited = await updateTemplate(
      item.template.id,
      { source: `from table {${relatedTable.shortId}}\nselect {${name.data.shortId}} as captured\nlimit 1` },
      null,
    );
    if (!edited.ok) throw edited.error;
    let rootAccessChecks = 0;
    let changed = false;
    const issued = await createDocumentForRecord({
      ...item.input,
      template: edited.data,
      canReadTable: async ({ tableId }) => {
        if (tableId === item.table.id && ++rootAccessChecks === 2) {
          // Rendering has read the related row. Commit an independent update
          // before the snapshot graph traverses that same relation.
          const updated = await records.update(relatedTableId, related.data.id, { [name.data.id]: "Changed related" }, null, "direct");
          if (!updated.ok) throw updated.error;
          changed = true;
        }
        return true;
      },
    });
    if (!issued.ok) throw issued.error;
    expect(changed).toBe(true);
    expect(issued.data.renderData.rows).toEqual([expect.objectContaining({ captured: "Original related" })]);
    const [snapshot] = await sql<Array<{ value: string }>>`
      SELECT graph #>> ${sql.array(["records", `${relatedTableId}:${related.data.id}`, "data", name.data.id], "TEXT")}::text[] AS value
      FROM grids.record_snapshots WHERE id = ${issued.data.snapshotId}::uuid
    `;
    expect(snapshot?.value).toBe("Original related");
    const [live] = await sql<Array<{ value: string }>>`
      SELECT data->>${name.data.id} AS value FROM grids.records WHERE id = ${related.data.id}::uuid
    `;
    expect(live?.value).toBe("Changed related");
  });
});
