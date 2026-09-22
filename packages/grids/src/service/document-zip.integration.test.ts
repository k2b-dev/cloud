import { beforeAll, describe, expect } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { err } from "@k2b/stdlib";
import { sql } from "bun";
import { testInfra } from "../../../../scripts/fixtures/test-infra";
import { localVerificationUrl } from "../../scripts/verification";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import type { WorkflowDocumentDataCapture } from "../workflows/query-contracts";
import { createDocumentIssuanceService, openDocumentArtifact } from "./document-issuance";
import { persistIssuedDocument } from "./document-issuance-storage";
import { canonicalDocumentJson } from "./document-json";
import { createTemplate } from "./document-templates";
import { readZipArchive } from "./document-zip-test-reader";
import { persistWorkflowQueryDataInTransaction } from "./workflow-query-store";
import { insertTestWorkflow, insertTestWorkflowRun } from "./workflow-test-fixture";

beforeAll(async () => {
  if (testInfra.database) await migrate();
}, 30_000);

const service = createDocumentIssuanceService();

const pdf = (label: string, padding = 0) => {
  const bytes = new Uint8Array(padding + 64);
  crypto.getRandomValues(bytes);
  bytes.set(new TextEncoder().encode(`%PDF-1.7\n% ${label}\n`));
  return bytes;
};

/** A Base with invoices that carry issued Documents and payments that relate to them. */
const fixture = async (options: { artifactPadding?: number } = {}) => {
  const baseId = testUuid();
  const invoicesTableId = testUuid();
  const paymentsTableId = testUuid();
  const actorId = testUuid();
  await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn)
    VALUES (${actorId}::uuid, ${actorId}, 'local', 'user', 'Zip test', 'Zip', 'Test')`;
  await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${testShortId("B")}, 'ZIP export')`;
  const paymentsShortId = testShortId("T");
  await sql`INSERT INTO grids.tables (id, short_id, base_id, name) VALUES (${invoicesTableId}::uuid, ${testShortId("T")}, ${baseId}::uuid, 'Invoices')`;
  await sql`INSERT INTO grids.tables (id, short_id, base_id, name) VALUES (${paymentsTableId}::uuid, ${paymentsShortId}, ${baseId}::uuid, 'Payments')`;
  const template = await createTemplate(
    invoicesTableId,
    {
      name: "Invoice",
      source: "from table Invoices",
      renderer: {
        kind: "html",
        body: "<p>{{ document.number }}</p>",
        numberTemplate: "INV-{{ series.value }}",
        filenameTemplate: "Invoice.pdf",
      },
    },
    actorId,
  );
  if (!template.ok) throw new Error(template.error.message);
  const otherTemplate = await createTemplate(
    invoicesTableId,
    {
      name: "Reminder",
      source: "from table Invoices",
      renderer: {
        kind: "html",
        body: "<p>{{ document.number }}</p>",
        numberTemplate: "REM-{{ series.value }}",
        filenameTemplate: "Reminder.pdf",
      },
    },
    actorId,
  );
  if (!otherTemplate.ok) throw new Error(otherTemplate.error.message);

  const record = async (tableId: string) => {
    const id = testUuid();
    const shortId = testShortId("R");
    await sql`INSERT INTO grids.records (id, short_id, table_id, data, version) VALUES (${id}::uuid, ${shortId}, ${tableId}::uuid, '{}'::jsonb, 1)`;
    return { id, shortId };
  };
  let issued = 0;
  const issue = async (
    invoice: { id: string; shortId: string },
    templateId: string,
    artifacts: { key: string; filename: string; mediaType: string; bytes: Uint8Array }[],
  ) => {
    const snapshotId = testUuid();
    await sql`INSERT INTO grids.record_snapshots (id, short_id, base_id, table_id, record_id, root, graph)
      VALUES (${snapshotId}::uuid, ${testShortId("S")}, ${baseId}::uuid, ${invoicesTableId}::uuid, ${invoice.id}::uuid, '{"version": 1}'::jsonb, '{}'::jsonb)`;
    issued += 1;
    const primary = artifacts[0];
    if (!primary) throw new Error("artifact required");
    return sql.begin((tx) =>
      persistIssuedDocument(
        {
          receiptId: testUuid(),
          shortId: testShortId("D"),
          baseId,
          queryDataId: null,
          record: { templateId, snapshotId, tableId: invoicesTableId, recordId: invoice.id },
          workflowRunId: null,
          workflowStepKey: null,
          number: `DOC-${issued}`,
          tags: [],
          templateSnapshot: { renderer: { kind: "html" } },
          templateRevision: "a".repeat(64),
          renderData: {},
          rendererVersion: "test-v1",
          profile: null,
          primary,
          artifacts,
          actor: { kind: "system" },
          issuedAt: new Date().toISOString(),
          allocationId: null,
        },
        tx,
      ),
    );
  };
  const padding = options.artifactPadding ?? 0;
  const invoiceA = await record(invoicesTableId);
  const invoiceB = await record(invoicesTableId);
  const invoiceC = await record(invoicesTableId);
  const docA1 = await issue(invoiceA, template.data.id, [
    { key: "pdf", filename: "Invoice.pdf", mediaType: "application/pdf", bytes: pdf("A1", padding) },
  ]);
  const docA2 = await issue(invoiceA, template.data.id, [
    { key: "pdf", filename: "Invoice.pdf", mediaType: "application/pdf", bytes: pdf("A2", padding) },
  ]);
  const docB = await issue(invoiceB, template.data.id, [
    { key: "pdf", filename: "Invoice B.pdf", mediaType: "application/pdf", bytes: pdf("B", padding) },
    { key: "xml", filename: "Invoice B.xml", mediaType: "application/xml", bytes: new TextEncoder().encode("<invoice>B</invoice>") },
  ]);
  const reminderB = await issue(invoiceB, otherTemplate.data.id, [
    { key: "pdf", filename: "Reminder.pdf", mediaType: "application/pdf", bytes: pdf("reminder", padding) },
  ]);
  const payments = [
    await record(paymentsTableId),
    await record(paymentsTableId),
    await record(paymentsTableId),
    await record(paymentsTableId),
  ];

  const workflowId = await insertTestWorkflow({ baseId, shortId: testShortId("W") });
  const runId = await insertTestWorkflowRun({ baseId, workflowId, shortId: testShortId("R"), state: "running", channel: "api" });
  const capturedAt = new Date().toISOString();
  const rows = [
    { invoice: [invoiceA.shortId], amount: "10.00" },
    { invoice: [invoiceB.shortId], amount: "20.00" },
    { invoice: [invoiceA.shortId], amount: "30.00" },
    { invoice: [], amount: "40.00" },
  ];
  const capture = (selected: number[], source = "from table Payments\nselect Invoice, Amount"): WorkflowDocumentDataCapture => {
    const payload = {
      version: 1 as const,
      columns: [
        { key: "c1", label: "Invoice", type: "relation", sqlType: "uuid[]" },
        { key: "c2", label: "Amount", type: "decimal", sqlType: "numeric" },
      ],
      rows: selected.map((index) => ({ c1: rows[index]!.invoice, c2: rows[index]!.amount })),
      rowOrigins: selected.map((index) => ({ recordId: payments[index]!.shortId, tableId: paymentsShortId, version: 1 })),
      rowCount: selected.length,
      capturedAt,
      complete: true as const,
      selectionLimit: null,
      source,
      schemaHash: "0".repeat(64),
      context: {},
      tableIds: [paymentsTableId],
    };
    const canonical = canonicalDocumentJson(payload);
    return { payload, sha256: canonical.sha256, rowCount: selected.length, capturedAt };
  };
  const captureData = async (stepKey: string, selected: number[], source?: string) => {
    const stored = await sql.begin((tx) =>
      persistWorkflowQueryDataInTransaction({ baseId, runId, stepKey, capture: capture(selected, source) }, tx),
    );
    if (!stored.ok) throw stored.error;
    return stored.data;
  };
  return {
    baseId,
    invoicesTableId,
    paymentsTableId,
    runId,
    template: template.data,
    invoiceA,
    invoiceB,
    invoiceC,
    docA1,
    docA2,
    docB,
    reminderB,
    payments,
    issue,
    captureData,
  };
};

type ZipRequest = Parameters<typeof service.issueQueryDocument>[0];

const zipRequest = (
  f: Awaited<ReturnType<typeof fixture>>,
  data: Awaited<ReturnType<typeof f.captureData>>,
  output: Record<string, unknown>,
  overrides: Partial<ZipRequest> = {},
): ZipRequest => ({
  baseId: f.baseId,
  runId: f.runId,
  stepKey: `zip-${testShortId("K")}`,
  data,
  output: { kind: "zip", ...output } as ZipRequest["output"],
  actor: { kind: "system" },
  filename: null,
  tags: [],
  idempotencyKey: testUuid(),
  authorize: async () => {},
  ...overrides,
});

const issuedDocument = async (request: ZipRequest) => {
  const result = await service.issueQueryDocument(request);
  if (!result.ok) throw result.error;
  if ("kind" in result.data) throw new Error("Unexpected confirmation");
  return result.data;
};

const archiveOf = async (documentId: string) => {
  const artifact = await service.getDocumentArtifact(documentId, "zip");
  if (!artifact.ok) throw artifact.error;
  return { artifact: artifact.data, entries: readZipArchive(artifact.data.bytes) };
};

describe("Document ZIP output", () => {
  postgresTest("packages relation-selected Document files with original bytes, folders, dedupe and provenance", async () => {
    const f = await fixture();
    const data = await f.captureData("payments", [0, 1, 2]);
    const csv = await sql.begin((tx) =>
      persistIssuedDocument(
        {
          receiptId: testUuid(),
          shortId: testShortId("D"),
          baseId: f.baseId,
          queryDataId: data.id,
          record: null,
          workflowRunId: f.runId,
          workflowStepKey: "list",
          number: "CSV-1",
          tags: [],
          templateSnapshot: { renderer: { kind: "profile", id: "grids.csv", version: 1 } },
          templateRevision: "b".repeat(64),
          renderData: {},
          rendererVersion: "grids-csv-v1",
          profile: {
            id: "grids.csv",
            version: 1,
            input: {},
            sha256: "c".repeat(64),
            validatorVersion: "grids-table-v1",
            validationStatus: "valid",
            validationReport: {},
          },
          primary: {
            key: "csv",
            filename: "payments.csv",
            mediaType: "text/csv",
            bytes: new TextEncoder().encode("Invoice;Amount\r\n".repeat(200)),
          },
          artifacts: [
            {
              key: "csv",
              filename: "payments.csv",
              mediaType: "text/csv",
              bytes: new TextEncoder().encode("Invoice;Amount\r\n".repeat(200)),
            },
          ],
          actor: { kind: "system" },
          issuedAt: new Date().toISOString(),
          allocationId: null,
        },
        tx,
      ),
    );
    const request = zipRequest(
      f,
      data,
      {
        files: [{ column: "Invoice", template: f.template.id, mediaType: "application/pdf", folder: "invoices" }],
        include: [csv.id],
      },
      { filename: "cash-payments.zip" },
    );
    const authorized: string[][] = [];
    request.authorize = async (tableIds) => {
      authorized.push([...tableIds]);
    };
    const document = await issuedDocument(request);
    expect(document.filename).toBe("cash-payments.zip");
    expect(document.primaryArtifactKey).toBe("zip");
    expect(document.profile).toEqual({ id: "grids.zip", version: 1 });
    expect(document.artifacts.map((artifact) => [artifact.key, artifact.mimeType])).toEqual([["zip", "application/zip"]]);
    // Execution rechecked the captured table and the Documents' table.
    expect(authorized.some((ids) => ids.includes(f.paymentsTableId) && ids.includes(f.invoicesTableId))).toBe(true);

    const { artifact, entries } = await archiveOf(document.id);
    expect(artifact.sizeBytes).toBe(artifact.bytes.byteLength);
    expect(createHash("sha256").update(artifact.bytes).digest("hex")).toBe(artifact.sha256);
    expect(entries.map((entry) => [entry.path, entry.method])).toEqual([
      ["invoices/Invoice.pdf", 0],
      [`invoices/Invoice (${f.docA2.shortId}).pdf`, 0],
      ["invoices/Invoice B.pdf", 0],
      ["payments.csv", 8],
    ]);
    const stored = async (documentId: string, key: string) => {
      const content = await service.getDocumentArtifact(documentId, key);
      if (!content.ok) throw content.error;
      return content.data.bytes;
    };
    expect(entries[0]!.bytes).toEqual(await stored(f.docA1.id, "pdf"));
    expect(entries[1]!.bytes).toEqual(await stored(f.docA2.id, "pdf"));
    expect(entries[2]!.bytes).toEqual(await stored(f.docB.id, "pdf"));
    expect(entries[3]!.bytes).toEqual(await stored(csv.id, "csv"));

    const [row] = await sql<Array<{ profile_output: { entries: unknown[] }; validation_report: unknown; frozen: unknown }>>`
      SELECT d.profile_output, d.validation_report, (SELECT frozen_request FROM grids.document_issuances WHERE document_id = d.id) AS frozen
      FROM grids.documents d WHERE d.id = ${document.id}::uuid
    `;
    expect(row?.profile_output.entries).toEqual([
      { document: f.docA1.shortId, key: "pdf", path: "invoices/Invoice.pdf", sizeBytes: 64 },
      { document: f.docA2.shortId, key: "pdf", path: `invoices/Invoice (${f.docA2.shortId}).pdf`, sizeBytes: 64 },
      { document: f.docB.shortId, key: "pdf", path: "invoices/Invoice B.pdf", sizeBytes: 64 },
      { document: csv.shortId, key: "csv", path: "payments.csv", sizeBytes: 3200 },
    ]);
    expect(row?.validation_report).toEqual({ fileCount: 4, sourceBytes: 64 * 3 + 3200 });
    expect(row?.frozen).toBeNull();

    // Replays return the same Document without a second archive.
    const replay = await issuedDocument(request);
    expect(replay.id).toBe(document.id);
    const [count] = await sql<
      Array<{ count: number }>
    >`SELECT count(*)::int AS count FROM grids.documents WHERE base_id = ${f.baseId}::uuid AND primary_artifact_key = 'zip'`;
    expect(count?.count).toBe(1);

    // The streamed read equals the buffered read.
    const opened = await openDocumentArtifact(document.id, "zip");
    if (!opened.ok) throw opened.error;
    expect(opened.data.sizeBytes).toBe(artifact.sizeBytes);
    const reader = opened.data.stream().getReader();
    const streamed: Uint8Array[] = [];
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) streamed.push(chunk.value);
    expect(Buffer.concat(streamed)).toEqual(Buffer.from(artifact.bytes));
  });

  postgresTest("selects every issued Document of the captured rows and honours required and media type", async () => {
    const f = await fixture();
    // Payments have no Documents of their own; rows without a relation record fail while required.
    const data = await f.captureData("rows", [0, 1, 3]);
    const relationMissing = await service.issueQueryDocument(zipRequest(f, data, { files: [{ column: "Invoice" }] }));
    expect(relationMissing.ok).toBe(false);
    if (!relationMissing.ok) expect(relationMissing.error.message).toContain('Row 3 has no "Invoice" record');
    const noFiles = await service.issueQueryDocument(zipRequest(f, data, { files: [{}] }));
    expect(noFiles.ok).toBe(false);
    if (!noFiles.ok) expect(noFiles.error.message).toContain("has no matching document file");
    const unknownColumn = await service.issueQueryDocument(zipRequest(f, data, { files: [{ column: "Nope" }] }));
    expect(unknownColumn.ok).toBe(false);
    if (!unknownColumn.ok) expect(unknownColumn.error.message).toContain('Column "Nope"');
    const foreignTemplate = await service.issueQueryDocument(
      zipRequest(f, data, { files: [{ column: "Invoice", required: false, template: testUuid() }] }),
    );
    expect(foreignTemplate.ok).toBe(false);
    if (!foreignTemplate.ok) expect(foreignTemplate.error.message).toContain("Document template");
    const foreignInclude = await service.issueQueryDocument(zipRequest(f, data, { include: [testUuid()] }));
    expect(foreignInclude.ok).toBe(false);
    if (!foreignInclude.ok) expect(foreignInclude.error.message).toContain("Included document");
    expect(await sql`SELECT id FROM grids.documents WHERE base_id = ${f.baseId}::uuid AND primary_artifact_key = 'zip'`).toHaveLength(0);

    // Without template and media type: every issued Document of the related invoices, all artifacts.
    const all = await issuedDocument(zipRequest(f, data, { files: [{ column: "Invoice", required: false }] }));
    const { entries } = await archiveOf(all.id);
    expect(entries.map((entry) => entry.path)).toEqual([
      "Invoice.pdf",
      `Invoice (${f.docA2.shortId}).pdf`,
      "Invoice B.pdf",
      "Invoice B.xml",
      "Reminder.pdf",
    ]);
    expect(entries[3]!.method).toBe(8);
    expect(new TextDecoder().decode(entries[3]!.bytes)).toBe("<invoice>B</invoice>");

    // Aggregates cannot supply row records; an empty selection fails clearly.
    const grouped = await f.captureData("grouped", [0], "from table Payments\ngroup by Invoice\naggregate count(*) as payments");
    const notRows = await service.issueQueryDocument(zipRequest(f, grouped, { files: [{}] }));
    expect(notRows.ok).toBe(false);
    if (!notRows.ok) expect(notRows.error.message).toContain("single-table row query");
    const empty = await service.issueQueryDocument(zipRequest(f, await f.captureData("empty", []), { files: [{ column: "Invoice" }] }));
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.message).toContain("contains no files");
  });

  postgresTest("freezes the selection with the receipt and rechecks permissions before publishing", async () => {
    const f = await fixture();
    const data = await f.captureData("frozen", [0, 1]);
    const request = zipRequest(f, data, { files: [{ column: "Invoice", template: f.template.id }] });
    let executions = 0;
    request.authorize = async (tableIds) => {
      // The publishing transaction rechecks the captured and the Documents' tables together.
      if (tableIds.includes(f.paymentsTableId) && tableIds.includes(f.invoicesTableId)) {
        executions += 1;
        if (executions === 1) throw err.forbidden("access revoked");
      }
    };
    const denied = await service.issueQueryDocument(request);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.message).toBe("access revoked");
    const [receipt] = await sql<Array<{ document_id: string | null; frozen: { archive?: { entries: unknown[] } } }>>`
      SELECT document_id::text, frozen_request AS frozen FROM grids.document_issuances WHERE base_id = ${f.baseId}::uuid
    `;
    expect(receipt?.document_id).toBeNull();
    expect(receipt?.frozen.archive?.entries).toHaveLength(4);
    expect(
      await sql`SELECT file_id FROM grids.file_protected_references WHERE base_id = ${f.baseId}::uuid AND owner_kind = 'document_artifact' AND record_id IS NULL`,
    ).toHaveLength(0);

    // A Document issued after the reservation is not part of the frozen selection.
    await f.issue(f.invoiceA, f.template.id, [{ key: "pdf", filename: "Invoice.pdf", mediaType: "application/pdf", bytes: pdf("late") }]);

    const document = await issuedDocument(request);
    expect(executions).toBe(2);
    const { entries } = await archiveOf(document.id);
    expect(entries.map((entry) => entry.path)).toEqual([
      "Invoice.pdf",
      `Invoice (${f.docA2.shortId}).pdf`,
      "Invoice B.pdf",
      "Invoice B.xml",
    ]);
  });

  postgresTest("serializes overlapping attempts and builds separate runs concurrently", async () => {
    const f = await fixture({ artifactPadding: 300_000 });
    const data = await f.captureData("concurrent", [0, 1, 2]);
    const [objectsBefore] = await sql<Array<{ objects: number }>>`SELECT count(*)::int AS objects FROM pg_largeobject_metadata`;
    const request = zipRequest(f, data, { files: [{ column: "Invoice" }] });
    const overlapping = await Promise.all([service.issueQueryDocument(request), service.issueQueryDocument(request)]);
    const ids = overlapping.map((result) => {
      if (!result.ok) throw result.error;
      if ("kind" in result.data) throw new Error("Unexpected confirmation");
      return result.data.id;
    });
    expect(ids[0]).toBe(ids[1]!);
    expect(await sql`SELECT id FROM grids.documents WHERE base_id = ${f.baseId}::uuid AND primary_artifact_key = 'zip'`).toHaveLength(1);

    const parallel = await Promise.all(
      [1, 2, 3].map((index) => issuedDocument(zipRequest(f, data, { files: [{ column: "Invoice", folder: `run-${index}` }] }))),
    );
    expect(new Set(parallel.map((document) => document.id)).size).toBe(3);
    for (const [index, document] of parallel.entries()) {
      const { entries } = await archiveOf(document.id);
      expect(entries).toHaveLength(5);
      expect(entries.every((entry) => entry.path.startsWith(`run-${index + 1}/`))).toBe(true);
    }
    // Exactly one stored archive per Document, and no staged large object survived.
    const [stored] = await sql<Array<{ archives: number; objects: number }>>`
      SELECT (SELECT count(*)::int FROM grids.file_protected_references reference JOIN grids.files file ON file.id = reference.file_id
              WHERE reference.base_id = ${f.baseId}::uuid AND reference.record_id IS NULL AND file.mime_type = 'application/zip') AS archives,
             (SELECT count(*)::int FROM pg_largeobject_metadata) AS objects`;
    expect(stored).toEqual({ archives: 4, objects: objectsBefore!.objects });
  });

  postgresTest(
    "a crash while staging leaves no partial Document and the retry completes the frozen archive",
    async () => {
      const database = localVerificationUrl("PostgreSQL", testInfra.database);
      const f = await fixture({ artifactPadding: 600_000 });
      const data = await f.captureData("crash", [0, 1, 2]);
      const { authorize: _authorize, ...request } = zipRequest(f, data, { files: [{ column: "Invoice" }] });
      const [before] = await sql<Array<{ objects: number; files: number }>>`
        SELECT (SELECT count(*)::int FROM pg_largeobject_metadata) AS objects, (SELECT count(*)::int FROM grids.files) AS files`;
      const events: unknown[] = [];
      const childUrl = new URL(database);
      childUrl.searchParams.set("application_name", `grids-zip-crash:${f.runId}`);
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "document-zip-crash.worker.ts"), JSON.stringify(request)], {
        env: { ...process.env, DATABASE_URL: childUrl.toString() },
        stdout: "pipe",
        stderr: "pipe",
        ipc: (message) => {
          events.push(message);
        },
      });
      const until = async (label: string, check: () => boolean) => {
        const deadline = Date.now() + 30_000;
        while (!check()) {
          if (child.exitCode !== null) throw new Error(`Child exited before ${label}: ${await new Response(child.stderr).text()}`);
          if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
          await Bun.sleep(50);
        }
      };
      await until("ready", () => events.some((event) => typeof event === "object" && event !== null && "ready" in event));
      child.send("start");
      await until("first chunk", () =>
        events.some((event) => typeof event === "object" && event !== null && Reflect.get(event, "checkpoint") === "first-chunk"),
      );
      child.kill("SIGKILL");
      await child.exited;
      expect(child.signalCode).toBe("SIGKILL");
      // The aborted transaction released its connection; nothing of it is durable.
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const active = await sql`SELECT pid FROM pg_stat_activity WHERE application_name = ${`grids-zip-crash:${f.runId}`}`;
        if (active.length === 0) break;
        await Bun.sleep(50);
      }
      const [after] = await sql<Array<{ objects: number; files: number }>>`
        SELECT (SELECT count(*)::int FROM pg_largeobject_metadata) AS objects, (SELECT count(*)::int FROM grids.files) AS files`;
      expect(after).toEqual(before!);
      const [receipt] = await sql<Array<{ document_id: string | null; frozen: { archive?: { entries: unknown[] } } | null }>>`
        SELECT document_id::text, frozen_request AS frozen FROM grids.document_issuances WHERE base_id = ${f.baseId}::uuid`;
      expect(receipt?.document_id).toBeNull();
      expect(receipt?.frozen?.archive?.entries).toHaveLength(5);

      const document = await issuedDocument({ ...request, authorize: async () => {} });
      const { artifact, entries } = await archiveOf(document.id);
      expect(entries.map((entry) => entry.path)).toEqual([
        "Invoice.pdf",
        `Invoice (${f.docA2.shortId}).pdf`,
        "Invoice B.pdf",
        "Invoice B.xml",
        "Reminder.pdf",
      ]);
      expect(artifact.sizeBytes).toBeGreaterThan(4 * 600_000);
      const [settled] = await sql<Array<{ frozen: unknown; objects: number }>>`
        SELECT (SELECT frozen_request FROM grids.document_issuances WHERE document_id = ${document.id}::uuid) AS frozen,
               (SELECT count(*)::int FROM pg_largeobject_metadata) AS objects`;
      expect(settled?.frozen).toBeNull();
      expect(settled?.objects).toBe(before!.objects);
    },
    60_000,
  );
});
