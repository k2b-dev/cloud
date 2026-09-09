import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { insertTestDocumentArtifact, postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import {
  browseDocumentsForBase,
  browseDocumentsForTemplate,
  listDocumentSummariesForRecordByTemplates,
  listDocumentsForBase,
  listDocumentsForRecord,
  listDocumentsForTemplate,
  listDocumentsForWorkflow,
} from "./document-browse";
import { getDocument } from "./document-core";
import { summarizeDocument } from "./document-mappers";
import { insertTestWorkflow, insertTestWorkflowRun } from "./workflow-test-fixture";

type Fixture = {
  baseId: string;
  tableId: string;
  templateId: string;
  snapshotId: string;
  recordId: string;
  workflowId: string;
  workflowRunId: string;
  documentIds: string[];
  artifactFileIds: string[];
};

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

const insertFixture = async (): Promise<Fixture> => {
  const baseId = testUuid();
  const tableId = testUuid();
  const templateId = testUuid();
  const snapshotId = testUuid();
  const recordId = testUuid();
  const workflowId = testUuid();
  const workflowRunId = testUuid();
  const documentIds = Array.from({ length: 5 }, () => testUuid());

  await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${testShortId("B")}, 'Document browse')`;
  await sql`
    INSERT INTO grids.tables (id, short_id, base_id, name, position)
    VALUES (${tableId}::uuid, ${testShortId("T")}, ${baseId}::uuid, 'Invoices', 0)
  `;
  await sql`
    INSERT INTO grids.document_templates (id, short_id, table_id, name, source, renderer_kind, html, number_template, filename_template)
    VALUES (${templateId}::uuid, ${testShortId("D")}, ${tableId}::uuid, 'Invoice', 'from table Invoices', 'html', '<p>Invoice</p>', 'INV-{{ series.value }}', '{{ document.number }}.pdf')
  `;
  await sql`INSERT INTO grids.records (id, short_id, table_id, data) VALUES (${recordId}::uuid, ${testShortId("R")}, ${tableId}::uuid, '{}'::jsonb)`;
  await sql`
    INSERT INTO grids.record_snapshots (id, short_id, base_id, table_id, record_id, root, graph)
    VALUES (${snapshotId}::uuid, ${testShortId("S")}, ${baseId}::uuid, ${tableId}::uuid, ${recordId}::uuid, '{}'::jsonb, '{}'::jsonb)
  `;
  await insertTestWorkflow({
    id: workflowId,
    shortId: testShortId("W"),
    baseId: baseId,
    name: "Invoice workflow",
    source: "steps: []",
    enabled: true,
  });
  await insertTestWorkflowRun({ id: workflowRunId, shortId: testShortId("W"), workflowId, baseId, state: "succeeded" });

  const rows = [
    {
      id: documentIds[0]!,
      number: "INV-100",
      filename: "100%_done\\final.pdf",
      tags: ["customer", "paid"],
      at: "2025-12-31T23:30:00.000Z",
    },
    { id: documentIds[1]!, number: "INV-101", filename: "invoice-101.pdf", tags: ["customer"], at: "2026-01-31T23:30:00.000Z" },
    { id: documentIds[2]!, number: "INV-102", filename: "invoice-102.pdf", tags: ["customer", "paid"], at: "2026-02-01T10:00:00.000Z" },
    { id: documentIds[3]!, number: "INV-103", filename: "invoice-103.pdf", tags: ["internal"], at: "2026-03-01T10:00:00.000Z" },
    { id: documentIds[4]!, number: "INV-104", filename: "invoice-104.pdf", tags: [], at: "2026-03-01T10:00:00.000Z" },
  ];
  const artifactFileIds: string[] = [];
  for (const row of rows) {
    const artifact = await insertTestDocumentArtifact({ documentId: row.id, baseId, tableId, recordId, filename: row.filename });
    artifactFileIds.push(artifact.fileId);
    await sql`
      INSERT INTO grids.documents (
        id, short_id, template_id, snapshot_id, base_id, table_id, record_id,
        workflow_run_id, workflow_step_key, document_number, filename, tags, template_snapshot, render_data,
        renderer_kind, renderer_version, template_revision, issued_actor, created_at
      ) VALUES (
        ${row.id}::uuid, ${testShortId("R")}, ${templateId}::uuid, ${snapshotId}::uuid, ${baseId}::uuid,
        ${tableId}::uuid, ${recordId}::uuid, ${workflowRunId}::uuid, ${`step-${row.number}`}, ${row.number}, ${row.filename}, ${sql.array(row.tags, "TEXT")},
        '{}'::jsonb, '{}'::jsonb,
        'html', ${artifact.rendererVersion}, ${artifact.templateRevision}, '{"kind":"system"}'::jsonb, ${row.at}::timestamptz
      )
    `;
    await artifact.attach();
  }
  return { baseId, tableId, templateId, snapshotId, recordId, workflowId, workflowRunId, documentIds, artifactFileIds };
};

const cleanupFixture = async (fixture: Fixture): Promise<void> => {
  void fixture;
};

describe("document browsing integration", () => {
  postgresTest("base folders group by public template id then local year, with bounded global search", async () => {
    const fixture = await insertFixture();
    const root = await browseDocumentsForBase({ baseId: fixture.baseId });
    expect(root.folders).toHaveLength(1);
    const folder = root.folders[0]!;
    expect(folder.kind).toBe("template");
    expect(folder.label).toBe("Invoice");
    expect(folder.key).not.toBe(fixture.templateId);
    expect(folder.count).toBe(5);
    const years = await browseDocumentsForBase({ baseId: fixture.baseId, path: folder.path, timeZone: "Europe/Berlin" });
    expect(years.folders.map((f) => [f.label, f.count])).toEqual([["2026", 5]]);
    const first = await browseDocumentsForBase({ baseId: fixture.baseId, path: [folder.key, "2026"], limit: 2, timeZone: "Europe/Berlin" });
    expect(first.items).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    const second = await browseDocumentsForBase({
      baseId: fixture.baseId,
      path: [folder.key, "2026"],
      limit: 2,
      cursor: first.nextCursor,
      timeZone: "Europe/Berlin",
    });
    expect(second.items.every((item) => !first.items.some((other) => other.id === item.id))).toBe(true);
    const search = await browseDocumentsForBase({ baseId: fixture.baseId, path: [folder.key, "1999"], q: "100%_done\\final" });
    expect(search.items.map((item) => item.id)).toEqual([fixture.documentIds[0]!]);
    const other = await insertFixture();
    expect((await browseDocumentsForBase({ baseId: other.baseId, path: [folder.key, "2026"] })).items).toEqual([]);
  });
  postgresTest("returns the same lightweight summaries through every list path", async () => {
    const fixture = await insertFixture();
    const base = await listDocumentsForBase({ baseId: fixture.baseId });
    const expected = await Promise.all(
      base.items.map(async ({ id }) => {
        const document = await getDocument(id);
        if (!document) throw new Error("Fixture document is missing");
        expect(document).toHaveProperty("templateSnapshot");
        expect(document).toHaveProperty("renderData");
        return summarizeDocument(document);
      }),
    );
    const pages = [
      base,
      await listDocumentsForRecord({ baseId: fixture.baseId, tableId: fixture.tableId, recordId: fixture.recordId }),
      await listDocumentsForTemplate({ templateId: fixture.templateId }),
      await browseDocumentsForTemplate({ templateId: fixture.templateId, mode: "list" }),
      await listDocumentsForWorkflow(fixture.workflowRunId, {}, async () => true),
      { items: await listDocumentSummariesForRecordByTemplates(fixture.tableId, fixture.recordId, [fixture.templateId]) },
    ];
    for (const page of pages) expect(page.items).toEqual(expected);
    const offsetPage = await listDocumentsForTemplate({ templateId: fixture.templateId, limit: 2, offset: 2 });
    expect(offsetPage.items).toEqual(expected.slice(2, 4));
    expect(offsetPage).toMatchObject({ total: 5, offset: 2, nextOffset: 4, hasMore: true });
    const workflowPage = await listDocumentsForWorkflow(fixture.workflowRunId, { limit: 2, offset: 2 }, async () => true);
    expect(workflowPage.items).toEqual(expected.slice(2, 4));
    expect(workflowPage).toMatchObject({ total: 5, offset: 2, nextOffset: 4, hasMore: true });
    const first = await listDocumentsForBase({ baseId: fixture.baseId, limit: 2 });
    const second = await listDocumentsForBase({ baseId: fixture.baseId, limit: 2, cursor: first.nextCursor });
    expect(first.items).toEqual(expected.slice(0, 2));
    expect(second.items).toEqual(expected.slice(2, 4));
  });

  postgresTest("escapes literal search patterns and applies all requested tags", async () => {
    const fixture = await insertFixture();
    try {
      const escaped = await listDocumentsForTemplate({ templateId: fixture.templateId, q: "%_done\\" });
      expect(escaped.items.map((document) => document.id)).toEqual([fixture.documentIds[0]!]);
      expect(escaped.items[0]?.artifacts[0]?.mimeType).toBe("application/pdf");

      const tagged = await listDocumentsForTemplate({ templateId: fixture.templateId, tags: [" customer ", "paid", "paid"] });
      expect(new Set(tagged.items.map((document) => document.id))).toEqual(new Set([fixture.documentIds[0]!, fixture.documentIds[2]!]));
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("paginates a stable ordering without duplicates and clamps limits", async () => {
    const fixture = await insertFixture();
    try {
      const first = await listDocumentsForTemplate({ templateId: fixture.templateId, limit: 2 });
      expect(first.items).toHaveLength(2);
      expect(first.hasMore).toBe(true);
      expect(first.nextCursor).not.toBeNull();

      const second = await listDocumentsForTemplate({ templateId: fixture.templateId, limit: 2, cursor: first.nextCursor });
      const third = await listDocumentsForTemplate({ templateId: fixture.templateId, limit: 2, cursor: second.nextCursor });
      const ids = [...first.items, ...second.items, ...third.items].map((document) => document.id);
      expect(ids).toHaveLength(5);
      expect(new Set(ids).size).toBe(5);
      expect(third.hasMore).toBe(false);

      const clamped = await listDocumentsForTemplate({ templateId: fixture.templateId, limit: 0, offset: -5 });
      expect(clamped.limit).toBe(1);
      expect(clamped.offset).toBe(0);
      expect(clamped.items).toHaveLength(1);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("groups year and month folders in the requested timezone", async () => {
    const fixture = await insertFixture();
    try {
      const years = await browseDocumentsForTemplate({ templateId: fixture.templateId, mode: "folders", timeZone: "Europe/Berlin" });
      expect(years.folders).toEqual([{ kind: "year", key: "2026", label: "2026", path: ["2026"], count: 5 }]);

      const months = await browseDocumentsForTemplate({
        templateId: fixture.templateId,
        mode: "folders",
        path: ["2026"],
        timeZone: "Europe/Berlin",
      });
      expect(months.folders.map((folder) => [folder.key, folder.count])).toEqual([
        ["03", 2],
        ["02", 2],
        ["01", 1],
      ]);

      expect((await browseDocumentsForTemplate({ templateId: fixture.templateId, mode: "folders", path: ["invalid"] })).path).toEqual([]);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  postgresTest("lists record and workflow Documents without crossing scopes", async () => {
    const fixture = await insertFixture();
    try {
      expect(
        (await listDocumentsForRecord({ baseId: fixture.baseId, tableId: fixture.tableId, recordId: fixture.recordId, limit: 1_000 }))
          .items,
      ).toHaveLength(5);
      expect(await listDocumentsForRecord({ baseId: fixture.baseId, tableId: fixture.tableId, recordId: testUuid() })).toMatchObject({
        items: [],
        hasMore: false,
      });
      expect(await listDocumentSummariesForRecordByTemplates(fixture.tableId, fixture.recordId, [fixture.templateId], 1_000)).toHaveLength(
        5,
      );
      expect(await listDocumentSummariesForRecordByTemplates(fixture.tableId, fixture.recordId, [testUuid()])).toEqual([]);
      expect(await listDocumentSummariesForRecordByTemplates(fixture.tableId, fixture.recordId, [])).toEqual([]);
      expect(await listDocumentsForWorkflow(fixture.workflowRunId, { limit: 10 }, async () => true)).toMatchObject({
        total: 5,
        items: expect.arrayContaining(fixture.documentIds.map((id) => expect.objectContaining({ id }))),
      });
      expect(await listDocumentsForWorkflow(fixture.workflowRunId, { limit: 10 }, async () => false)).toEqual({
        items: [],
        total: 0,
        limit: 10,
        offset: 0,
        hasMore: false,
        nextOffset: null,
      });
      expect(await listDocumentsForWorkflow(testUuid(), { limit: 0, offset: -1 }, async () => true)).toEqual({
        items: [],
        total: 0,
        limit: 1,
        offset: 0,
        hasMore: false,
        nextOffset: null,
      });
    } finally {
      await cleanupFixture(fixture);
    }
  });
});
