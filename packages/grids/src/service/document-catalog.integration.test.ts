import { beforeAll, describe, expect } from "bun:test";
import { createHash } from "node:crypto";
import { sql } from "bun";
import { testInfra } from "../../../../scripts/fixtures/test-infra";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import {
  browseDocumentsForBase,
  documentCursorMatchesSort,
  listDocumentArchiveContents,
  listDocumentsForBase,
  listDocumentsForWorkflow,
  loadDocumentCatalogFacets,
  loadDocumentWorkflowOrigins,
} from "./document-browse";
import { insertTestWorkflow, insertTestWorkflowRun } from "./workflow-test-fixture";

beforeAll(async () => {
  if (testInfra.database) await migrate();
});

type Named = { id: string; shortId: string; name: string };

const named = (prefix: string, name: string): Named => ({ id: testUuid(), shortId: testShortId(prefix), name });

const insertTable = async (baseId: string, table: Named) => {
  await sql`INSERT INTO grids.tables (id, short_id, base_id, name, position) VALUES (${table.id}::uuid, ${table.shortId}, ${baseId}::uuid, ${table.name}, 0)`;
};

const insertTemplate = async (tableId: string, template: Named) => {
  await sql`
    INSERT INTO grids.document_templates (id, short_id, table_id, name, source, renderer_kind, html, number_template, filename_template)
    VALUES (${template.id}::uuid, ${template.shortId}, ${tableId}::uuid, ${template.name}, 'from table T', 'html', '<p>x</p>', 'N-{{ series.value }}', '{{ document.number }}.pdf')
  `;
};

const insertRecord = async (baseId: string, tableId: string) => {
  const recordId = testUuid();
  const snapshotId = testUuid();
  await sql`INSERT INTO grids.records (id, short_id, table_id, data) VALUES (${recordId}::uuid, ${testShortId("R")}, ${tableId}::uuid, '{}'::jsonb)`;
  await sql`
    INSERT INTO grids.record_snapshots (id, short_id, base_id, table_id, record_id, root, graph)
    VALUES (${snapshotId}::uuid, ${testShortId("S")}, ${baseId}::uuid, ${tableId}::uuid, ${recordId}::uuid, '{"version":1}'::jsonb, '{}'::jsonb)
  `;
  return { recordId, snapshotId };
};

const insertWorkflowRun = async (baseId: string, workflow: Named) => {
  const runId = testUuid();
  const runShortId = testShortId("U");
  await insertTestWorkflowRun({ id: runId, shortId: runShortId, workflowId: workflow.id, baseId, state: "succeeded" });
  return { runId, runShortId };
};

type DocumentInput = {
  baseId: string;
  number: string;
  filename: string;
  mimeType: string;
  createdAt: string;
  record?: { templateId: string; tableId: string; recordId: string; snapshotId: string };
  runId?: string;
  zipEntries?: Array<{ document: string; key: string; path: string; sizeBytes: number }>;
};

/** One stored Document with a single primary artifact of the given media type. */
const insertDocument = async (input: DocumentInput): Promise<string> => {
  const id = testUuid();
  const fileId = testUuid();
  const key = input.mimeType.split("/")[1]!.replace(/[^a-z0-9]/g, "") || "file";
  const bytes = new TextEncoder().encode(`artifact ${input.number}`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await sql`
    INSERT INTO grids.files (id, short_id, filename, mime_type, size_bytes, sha256, bytes)
    VALUES (${fileId}::uuid, ${testShortId("F")}, ${input.filename}, ${input.mimeType}, ${bytes.byteLength}, ${sha256}, ${bytes})
  `;
  await sql`
    INSERT INTO grids.file_protected_references (file_id, owner_kind, owner_id, base_id, table_id, record_id)
    VALUES (${fileId}::uuid, 'document_artifact', ${id}::uuid, ${input.baseId}::uuid, ${input.record?.tableId ?? null}::uuid, ${input.record?.recordId ?? null}::uuid)
  `;
  const zip = input.zipEntries !== undefined;
  await sql`
    INSERT INTO grids.documents (
      id, short_id, template_id, snapshot_id, base_id, table_id, record_id, workflow_run_id, workflow_step_key,
      document_number, filename, primary_artifact_key, tags, template_snapshot, render_data,
      renderer_kind, renderer_version, template_revision, profile_id, profile_version, profile_snapshot, profile_output,
      snapshot_sha256, validator_version, validation_status, validation_report, issued_actor, created_at
    ) VALUES (
      ${id}::uuid, ${testShortId("D")}, ${input.record?.templateId ?? null}::uuid, ${input.record?.snapshotId ?? null}::uuid,
      ${input.baseId}::uuid, ${input.record?.tableId ?? null}::uuid, ${input.record?.recordId ?? null}::uuid,
      ${input.runId ?? null}::uuid, ${input.runId ? `step-${input.number}` : null},
      ${input.number}, ${input.filename}, ${key}, '{}'::text[], '{}'::jsonb, '{}'::jsonb,
      ${zip ? "profile" : "html"}, 'test-v1', ${sha256},
      ${zip ? "grids.zip" : null}, ${zip ? 1 : null}, ${zip ? { archive: "frozen" } : null}::jsonb,
      ${zip ? { entries: input.zipEntries } : null}::jsonb,
      ${zip ? sha256 : null}, ${zip ? "grids-zip-v1" : null}, ${zip ? "valid" : null}, ${zip ? {} : null}::jsonb,
      '{"kind":"system"}'::jsonb, ${input.createdAt}::timestamptz
    )
  `;
  await sql`INSERT INTO grids.document_artifacts (document_id, artifact_key, file_id) VALUES (${id}::uuid, ${key}, ${fileId}::uuid)`;
  return id;
};

const shortIdOf = async (documentId: string) => {
  const [row] = await sql<Array<{ short_id: string }>>`SELECT short_id FROM grids.documents WHERE id = ${documentId}::uuid`;
  return row!.short_id;
};

/**
 * Two Bases. Base A: tables Invoices and Payments, a template on each, two
 * workflows, and PDF, CSV and ZIP Documents from templates, workflows or both.
 * Base B mirrors one of each so every filter must stay inside its Base.
 */
const insertCatalog = async () => {
  const baseA = testUuid();
  const baseB = testUuid();
  await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseA}::uuid, ${testShortId("B")}, 'Catalog A'), (${baseB}::uuid, ${testShortId("B")}, 'Catalog B')`;
  const invoices = named("T", "Invoices");
  const payments = named("T", "Payments");
  const otherTable = named("T", "Invoices");
  await insertTable(baseA, invoices);
  await insertTable(baseA, payments);
  await insertTable(baseB, otherTable);
  const invoicePdf = named("P", "Invoice PDF");
  const receipt = named("P", "Receipt");
  const otherTemplate = named("P", "Invoice PDF");
  await insertTemplate(invoices.id, invoicePdf);
  await insertTemplate(payments.id, receipt);
  await insertTemplate(otherTable.id, otherTemplate);
  const monthly = named("W", "Monthly export");
  const reminders = named("W", "Reminders");
  const otherWorkflow = named("W", "Monthly export");
  for (const [baseId, workflow] of [
    [baseA, monthly],
    [baseA, reminders],
    [baseB, otherWorkflow],
  ] as const) {
    await insertTestWorkflow({ id: workflow.id, shortId: workflow.shortId, baseId, name: workflow.name, source: "steps: []" });
  }
  const monthlyRun = await insertWorkflowRun(baseA, monthly);
  const reminderRun = await insertWorkflowRun(baseA, reminders);
  const otherRun = await insertWorkflowRun(baseB, otherWorkflow);
  const invoice = await insertRecord(baseA, invoices.id);
  const payment = await insertRecord(baseA, payments.id);
  const otherRecord = await insertRecord(baseB, otherTable.id);

  const invoiceBinding = { templateId: invoicePdf.id, tableId: invoices.id, ...invoice };
  const d1 = await insertDocument({
    baseId: baseA,
    number: "A-1",
    filename: "b-invoice.pdf",
    mimeType: "application/pdf",
    createdAt: "2026-09-01T08:00:00Z",
    record: invoiceBinding,
  });
  const d2 = await insertDocument({
    baseId: baseA,
    number: "A-2",
    filename: "a-invoice.pdf",
    mimeType: "application/pdf",
    createdAt: "2026-09-02T08:00:00Z",
    record: invoiceBinding,
    runId: monthlyRun.runId,
  });
  const d3 = await insertDocument({
    baseId: baseA,
    number: "A-3",
    filename: "c-receipt.pdf",
    mimeType: "application/pdf",
    createdAt: "2026-09-03T08:00:00Z",
    record: { templateId: receipt.id, tableId: payments.id, ...payment },
  });
  const d4 = await insertDocument({
    baseId: baseA,
    number: "A-4",
    filename: "export.csv",
    mimeType: "text/csv",
    createdAt: "2026-09-04T08:00:00Z",
    runId: monthlyRun.runId,
  });
  const entries = [
    { document: await shortIdOf(d1), key: "pdf", path: "invoices/b-invoice.pdf", sizeBytes: 11 },
    { document: await shortIdOf(d3), key: "pdf", path: "receipts/c-receipt.pdf", sizeBytes: 11 },
  ];
  const d5 = await insertDocument({
    baseId: baseA,
    number: "A-5",
    filename: "bundle.zip",
    mimeType: "application/zip",
    createdAt: "2026-09-05T08:00:00Z",
    runId: reminderRun.runId,
    zipEntries: entries,
  });
  // The archive's captured query row is a payment; its contents come from invoices and receipts.
  await sql`INSERT INTO grids.document_record_sources (document_id, table_id, record_id, version) VALUES (${d5}::uuid, ${payments.id}::uuid, ${payment.recordId}::uuid, 1)`;
  const otherDocument = await insertDocument({
    baseId: baseB,
    number: "B-1",
    filename: "a-other.pdf",
    mimeType: "application/pdf",
    createdAt: "2026-09-06T08:00:00Z",
    record: { templateId: otherTemplate.id, tableId: otherTable.id, ...otherRecord },
    runId: otherRun.runId,
  });
  return {
    baseA,
    baseB,
    invoices,
    payments,
    invoicePdf,
    receipt,
    monthly,
    reminders,
    otherWorkflow,
    monthlyRun,
    documents: { d1, d2, d3, d4, d5, otherDocument },
    entries,
  };
};

const ids = (page: { items: Array<{ id: string }> }) => page.items.map((item) => item.id);

describe("Base document catalog", () => {
  postgresTest("combines workflow, template, direct table and file type filters inside one Base", async () => {
    const c = await insertCatalog();
    const { d1, d2, d3, d4, d5 } = c.documents;
    const list = (filters: Parameters<typeof listDocumentsForBase>[0]["filters"]) => listDocumentsForBase({ baseId: c.baseA, filters });

    expect(ids(await list({}))).toEqual([d5, d4, d3, d2, d1]);
    expect(ids(await list({ workflowId: c.monthly.shortId }))).toEqual([d4, d2]);
    expect(ids(await list({ workflowId: c.reminders.shortId }))).toEqual([d5]);
    expect(ids(await list({ templateId: c.invoicePdf.shortId }))).toEqual([d2, d1]);
    expect(ids(await list({ workflowId: c.monthly.shortId, templateId: c.invoicePdf.shortId }))).toEqual([d2]);
    expect(ids(await list({ tableId: c.invoices.shortId }))).toEqual([d2, d1]);
    // Direct association only: the ZIP's captured payment row does not bind it to Payments.
    expect(ids(await list({ tableId: c.payments.shortId }))).toEqual([d3]);
    expect(ids(await list({ mediaType: "application/zip" }))).toEqual([d5]);
    expect(ids(await list({ mediaType: "text/csv" }))).toEqual([d4]);
    expect(ids(await list({ mediaType: "application/pdf", workflowId: c.monthly.shortId }))).toEqual([d2]);
    expect(ids(await list({ mediaType: "text/csv", templateId: c.invoicePdf.shortId }))).toEqual([]);
    // Public IDs of another Base never match.
    expect(ids(await list({ workflowId: c.otherWorkflow.shortId }))).toEqual([]);
    const counted = await listDocumentsForBase({ baseId: c.baseA, filters: { workflowId: c.monthly.shortId }, limit: 1 });
    expect(counted).toMatchObject({ total: 2, hasMore: true });
  });

  postgresTest("sorts newest first by default, oldest first or by filename, with keyset pages per order", async () => {
    const c = await insertCatalog();
    const { d1, d2, d3, d4, d5 } = c.documents;
    const all = async (sort: "newest" | "oldest" | "name") => {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await listDocumentsForBase({ baseId: c.baseA, sort, limit: 2, cursor });
        seen.push(...ids(page));
        cursor = page.nextCursor;
        if (cursor) expect(documentCursorMatchesSort(cursor, sort)).toBe(true);
      } while (cursor);
      return seen;
    };
    expect(await all("newest")).toEqual([d5, d4, d3, d2, d1]);
    expect(await all("oldest")).toEqual([d1, d2, d3, d4, d5]);
    // a-invoice, b-invoice, bundle.zip, c-receipt, export.csv
    expect(await all("name")).toEqual([d2, d1, d5, d3, d4]);
  });

  postgresTest("browse keeps every Document visible in folders and flattens for filters or a non-default sort", async () => {
    const c = await insertCatalog();
    const { d1, d2, d3, d4, d5 } = c.documents;
    const root = await browseDocumentsForBase({ baseId: c.baseA });
    expect(root.items).toEqual([]);
    expect(root.folders.reduce((sum, folder) => sum + folder.count, 0)).toBe(5);
    expect(root.folders.map((folder) => [folder.kind, folder.label, folder.count])).toEqual([
      ["template", "Invoice PDF", 2],
      ["workflow", "Monthly export", 1],
      ["template", "Receipt", 1],
      ["workflow", "Reminders", 1],
    ]);
    const filtered = await browseDocumentsForBase({
      baseId: c.baseA,
      path: root.folders[0]!.path,
      filters: { mediaType: "application/zip" },
    });
    expect(filtered.folders).toEqual([]);
    expect(filtered.path).toEqual([]);
    expect(ids(filtered)).toEqual([d5]);
    const sorted = await browseDocumentsForBase({ baseId: c.baseA, sort: "oldest" });
    expect(ids(sorted)).toEqual([d1, d2, d3, d4, d5]);
    // Workflow results list template and workflow-only Documents of the run alike.
    const run = await listDocumentsForWorkflow(c.monthlyRun.runId, {}, async () => true);
    expect(run.items.map((item) => item.id)).toEqual([d4, d2]);
  });

  postgresTest("reports filter values per Base and links workflow Documents to their runs", async () => {
    const c = await insertCatalog();
    const facets = await loadDocumentCatalogFacets(c.baseA);
    expect(facets).toEqual({
      workflows: [
        { id: c.monthly.shortId, name: "Monthly export" },
        { id: c.reminders.shortId, name: "Reminders" },
      ],
      templates: [
        { id: c.invoicePdf.shortId, name: "Invoice PDF" },
        { id: c.receipt.shortId, name: "Receipt" },
      ],
      tables: [
        { id: c.invoices.shortId, name: "Invoices" },
        { id: c.payments.shortId, name: "Payments" },
      ],
      mediaTypes: ["application/pdf", "application/zip", "text/csv"],
    });
    const other = await loadDocumentCatalogFacets(c.baseB);
    expect(other.workflows.map((workflow) => workflow.id)).toEqual([c.otherWorkflow.shortId]);
    expect(other.mediaTypes).toEqual(["application/pdf"]);
    const origins = await loadDocumentWorkflowOrigins([c.monthlyRun.runId]);
    expect(origins.get(c.monthlyRun.runId)).toEqual({ workflowId: c.monthly.shortId, runId: c.monthlyRun.runShortId });
  });

  postgresTest("pages archive contents as provenance and reports none for other Documents", async () => {
    const c = await insertCatalog();
    const first = await listDocumentArchiveContents(c.documents.d5, 0, 1);
    expect(first).toEqual({
      items: [{ path: "invoices/b-invoice.pdf", sizeBytes: 11, documentId: c.entries[0]!.document, artifactKey: "pdf" }],
      total: 2,
      hasMore: true,
    });
    const second = await listDocumentArchiveContents(c.documents.d5, 1, 1);
    expect(second.items.map((item) => item.path)).toEqual(["receipts/c-receipt.pdf"]);
    expect(second.hasMore).toBe(false);
    expect(await listDocumentArchiveContents(c.documents.d5, 5, 10)).toEqual({ items: [], total: 2, hasMore: false });
    expect(await listDocumentArchiveContents(c.documents.d1, 0, 10)).toEqual({ items: [], total: 0, hasMore: false });
  });
});
