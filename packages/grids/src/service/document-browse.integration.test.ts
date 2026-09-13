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
import { createDocumentLink, resolveDocumentLinkDownload, revokeDocumentLink } from "./document-links";
import { summarizeDocument } from "./document-mappers";
import { listDocumentRecordSources } from "./document-record-sources";
import { compileFormulaSourceToSql } from "./formula-sql-compiler";
import { list as listRecords } from "./records";
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
      INSERT INTO grids.documents (primary_artifact_key,
        id, short_id, template_id, snapshot_id, base_id, table_id, record_id,
        workflow_run_id, workflow_step_key, document_number, filename, tags, template_snapshot, render_data,
        renderer_kind, renderer_version, template_revision, issued_actor, created_at
      ) VALUES ('pdf',
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
  postgresTest("workflow-only documents keep their source, authorization and folders without a root record", async () => {
    const fixture = await insertFixture();
    const id = testUuid();
    const artifact = await insertTestDocumentArtifact({
      documentId: id,
      baseId: fixture.baseId,
      tableId: null,
      recordId: null,
      filename: "report.pdf",
    });
    await sql`
      INSERT INTO grids.documents (
        id, short_id, base_id, workflow_run_id, workflow_step_key, template_id, snapshot_id, table_id, record_id,
        document_number, filename, primary_artifact_key, template_snapshot, render_data, renderer_kind, renderer_version, template_revision, issued_actor
      ) VALUES (
        ${id}::uuid, ${testShortId("D")}, ${fixture.baseId}::uuid, ${fixture.workflowRunId}::uuid, 'summary', NULL, NULL, NULL, NULL,
        'SUMMARY', 'report.pdf', 'pdf', '{}'::jsonb, '{}'::jsonb, 'html', ${artifact.rendererVersion}, ${artifact.templateRevision}, '{"kind":"system"}'::jsonb
      )
    `;
    await artifact.attach();
    expect(await getDocument(id)).toMatchObject({
      tableId: null,
      recordId: null,
      templateId: null,
      snapshotId: null,
      workflowRunId: fixture.workflowRunId,
    });
    const document = await getDocument(id);
    if (!document) throw new Error("Missing workflow document");
    const shared = await createDocumentLink({ document, input: { expiresIn: "1d" }, actorId: null });
    expect(shared.ok).toBe(true);
    if (!shared.ok) throw new Error(shared.error.message);
    expect(shared.data.link).toMatchObject({ baseId: fixture.baseId, tableId: null, recordId: null });
    expect((await resolveDocumentLinkDownload(shared.data.token)).ok).toBe(true);
    expect((await revokeDocumentLink({ linkId: shared.data.link.id, actorId: null })).ok).toBe(true);
    expect((await resolveDocumentLinkDownload(shared.data.token)).ok).toBe(false);
    const allowed = await listDocumentsForWorkflow(fixture.workflowRunId, {}, async (source) => source.tableId === null);
    expect(allowed.items.map((document) => document.id)).toEqual([id]);
    expect((await listDocumentsForWorkflow(fixture.workflowRunId, {}, async () => false)).items).toEqual([]);
    const root = await browseDocumentsForBase({ baseId: fixture.baseId });
    const folder = root.folders.find((entry) => entry.kind === "workflow");
    expect(folder?.label).toBe("Invoice workflow");
    if (!folder) throw new Error("Missing workflow folder");
    const years = await browseDocumentsForBase({ baseId: fixture.baseId, path: folder.path });
    const year = years.folders[0];
    if (!year) throw new Error("Missing year folder");
    expect((await browseDocumentsForBase({ baseId: fixture.baseId, path: year.path })).items.map((document) => document.id)).toEqual([id]);
    const other = await insertFixture();
    expect((await browseDocumentsForBase({ baseId: other.baseId, path: year.path })).items).toEqual([]);
    await expect(
      (async () => {
        await sql`DELETE FROM grids.workflow_run_profile WHERE run_id = ${fixture.workflowRunId}::uuid`;
      })(),
    ).rejects.toMatchObject({ code: "ERR_POSTGRES_SERVER_ERROR", errno: "23503" });
    for (const binding of [
      {
        templateId: fixture.templateId,
        tableId: null,
        recordId: null,
        snapshotId: null,
        runId: fixture.workflowRunId,
        baseId: fixture.baseId,
        constraint: "documents_source_binding_chk",
      },
      {
        templateId: null,
        tableId: null,
        recordId: null,
        snapshotId: null,
        runId: null,
        baseId: fixture.baseId,
        constraint: "documents_source_binding_chk",
      },
      {
        templateId: null,
        tableId: null,
        recordId: null,
        snapshotId: null,
        runId: fixture.workflowRunId,
        baseId: other.baseId,
        constraint: "documents_workflow_base_fkey",
      },
    ]) {
      await expect(
        (async () => {
          await sql`
          INSERT INTO grids.documents (
            id, short_id, base_id, workflow_run_id, workflow_step_key, template_id, snapshot_id, table_id, record_id,
            document_number, filename, primary_artifact_key, template_snapshot, render_data, renderer_kind, renderer_version, template_revision, issued_actor
          ) VALUES (
            ${testUuid()}::uuid, ${testShortId("D")}, ${binding.baseId}::uuid, ${binding.runId}::uuid,
            ${binding.runId ? testShortId("S") : null}, ${binding.templateId}::uuid, ${binding.snapshotId}::uuid, ${binding.tableId}::uuid, ${binding.recordId}::uuid,
            'INVALID', 'report.pdf', 'pdf', '{}'::jsonb, '{}'::jsonb, 'html', ${artifact.rendererVersion}, ${artifact.templateRevision}, '{"kind":"system"}'::jsonb
          )
        `;
        })(),
      ).rejects.toMatchObject({ constraint: binding.constraint });
    }
  });
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
  postgresTest("associates one immutable document with multiple records without widening template-scoped reads", async () => {
    const fixture = await insertFixture();
    const second = testUuid();
    await sql`INSERT INTO grids.records (id, short_id, table_id, data) VALUES (${second}::uuid, ${testShortId("R")}, ${fixture.tableId}::uuid, '{}'::jsonb)`;
    const document = fixture.documentIds[0]!;
    await sql`INSERT INTO grids.document_record_sources (document_id, table_id, record_id, version)
      VALUES (${document}::uuid, ${fixture.tableId}::uuid, ${fixture.recordId}::uuid, 1),
        (${document}::uuid, ${fixture.tableId}::uuid, ${second}::uuid, 2)`;
    const page = await listDocumentsForRecord({ baseId: fixture.baseId, tableId: fixture.tableId, recordId: second });
    expect(page.items.map((item) => item.id)).toEqual([document]);
    expect((await listDocumentSummariesForRecordByTemplates(fixture.tableId, second, [fixture.templateId])).length).toBe(0);
    expect((await listDocumentRecordSources(document, 0, 1)).hasMore).toBe(true);
    expect((await listDocumentRecordSources(document)).items.map((item) => item.version).sort()).toEqual([1, 2]);
    const compiled = compileFormulaSourceToSql("documentCount()", { fields: [], documentMetadata: true });
    if (!compiled.ok) throw new Error(compiled.error);
    const [row] = await sql`SELECT ${compiled.expression.sql} AS count FROM grids.records r WHERE r.id = ${second}::uuid`;
    expect(Number(row.count)).toBe(1);
    const [original] = await sql`SELECT ${compiled.expression.sql} AS count FROM grids.records r WHERE r.id = ${fixture.recordId}::uuid`;
    expect(Number(original.count)).toBe(5);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await listDocumentsForRecord({
        baseId: fixture.baseId,
        tableId: fixture.tableId,
        recordId: fixture.recordId,
        limit: 2,
        cursor,
      });
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(new Set(fixture.documentIds));
    for (const format of ["pdf", "csv", "sepa-xml"]) {
      const latest = compileFormulaSourceToSql(`latestDocumentAt('${format}')`, { fields: [], documentMetadata: true });
      if (!latest.ok) throw new Error(latest.error);
      const [value] = await sql`SELECT ${latest.expression.sql} AS latest FROM grids.records r WHERE r.id = ${second}::uuid`;
      if (format === "pdf") {
        const [expected] = await sql`SELECT created_at FROM grids.documents WHERE id = ${document}::uuid`;
        expect(value.latest).toEqual(expected.created_at);
      } else expect(value.latest).toBeNull();
    }
    const records = await listRecords({
      tableId: fixture.tableId,
      computedColumns: [
        { kind: "computed", id: "computed_count", label: "Documents", expression: "documentCount()" },
        { kind: "computed", id: "computed_lastsepa", label: "Last SEPA", expression: "latestDocumentAt('sepa-xml')" },
      ],
    });
    if (!records.ok) throw records.error;
    expect(Number(records.data.items.find((item) => item.id === second)?.data.computed_count)).toBe(1);
    expect(records.data.items.find((item) => item.id === second)?.data.computed_lastsepa).toBeNull();
    await expect(
      (async () => {
        await sql`UPDATE grids.document_record_sources SET version = 3 WHERE document_id = ${document}::uuid`;
      })(),
    ).rejects.toMatchObject({ errno: "55000" });
    await expect(
      (async () => {
        await sql`DELETE FROM grids.document_record_sources WHERE document_id = ${document}::uuid`;
      })(),
    ).rejects.toMatchObject({ errno: "55000" });
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
