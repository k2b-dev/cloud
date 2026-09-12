import { beforeAll, describe, expect, spyOn } from "bun:test";
import { err } from "@k2b/stdlib";
import { sql } from "bun";
import type { z } from "zod";
import { PublicDocumentSchema } from "../api/document-public-contracts";
import { projectDocuments } from "../api/documents-api-shared";
import { financialQueryProfiles } from "../document-profiles/financial";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import type { WorkflowQueryPayloadSchema } from "../workflows/query-contracts";
import { loadDocumentDataSnapshots } from "./document-browse";
import type { FinancialDocumentOutput } from "./document-financial-output";
import { documentIssuanceService as service } from "./document-issuance";
import { canonicalDocumentJson, canonicalJson } from "./document-json";
import { summarizeDocument } from "./document-mappers";
import { requireDocumentSourceVersions } from "./document-source-versions";
import { persistWorkflowQueryDataInTransaction } from "./workflow-query-store";
import { deleteTestWorkflowScope, insertTestWorkflow, insertTestWorkflowRun, publishTestWorkflowVersion } from "./workflow-test-fixture";

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

const output: FinancialDocumentOutput = {
  kind: "datev-csv",
  version: 1,
  header: {
    destinationKey: "accounting",
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
};

const fixture = async () => {
  const baseId = testUuid();
  await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${testShortId("B")}, 'Financial issuance test')`;
  const workflowId = await insertTestWorkflow({ baseId, shortId: testShortId("W") });
  const actor = { kind: "service_account" as const, serviceAccountId: testUuid(), delegatedUserId: null, credentialId: null };
  const capture = async (channel: "api" | "schedule" = "api", format: FinancialDocumentOutput = output, businessId = "invoice-1") => {
    const runId = await insertTestWorkflowRun({ baseId, workflowId, shortId: testShortId("R"), state: "waiting", channel });
    const capturedAt = new Date().toISOString();
    const sourceRow: Record<string, string> = {
      business: businessId,
      entry: "main",
      amount: "12.3000",
      side: "S",
      account: "00440",
      other: "70000",
      date: "2026-09-11",
      number: "RE-1",
      payment: "RE-1",
      payee: "Example & Partner",
      iban: "DE89370400440532013000",
      purpose: "Expense RE-1",
    };
    const columns = Object.values(format.mapping).map((label, index) => ({ key: `q_col_${index}`, label, type: "text", sqlType: "text" }));
    const payload: z.infer<typeof WorkflowQueryPayloadSchema> = {
      version: 1,
      columns,
      rows: [Object.fromEntries(columns.map((column) => [column.key, sourceRow[column.label] ?? null]))],
      rowOrigins: [{ tableId: null, recordId: null }],
      rowCount: 1,
      capturedAt,
      complete: true,
      selectionLimit: 1,
      source: "from table {ABC123}\nselect amount",
      schemaHash: "a".repeat(64),
      context: {},
      tableIds: [testUuid()],
    };
    const reference = await sql.begin((tx) =>
      persistWorkflowQueryDataInTransaction(
        {
          baseId,
          runId,
          stepKey: "query",
          capture: { payload, sha256: canonicalDocumentJson(payload).sha256, hashVersion: 2, rowCount: 1, capturedAt },
        },
        tx,
      ),
    );
    if (!reference.ok) throw reference.error;
    return {
      baseId,
      runId,
      stepKey: "export",
      data: reference.data,
      output: format,
      actor,
      filename: null,
      tags: [],
      idempotencyKey: `${runId}:export`,
      authorize: async () => {},
    };
  };
  const cleanup = async () => {
    // Immutable bytes are evidence; preserve successful fixtures rather than
    // disabling production retention triggers for test cleanup.
    const [saved] = await sql<Array<{ count: number }>>`SELECT count(*)::int AS count FROM grids.documents WHERE base_id = ${baseId}::uuid`;
    if (saved?.count) return;
    await sql`UPDATE workflows.run SET state = 'canceled' WHERE scope_id = ${baseId} AND app_id = 'grids'`;
    await sql`DELETE FROM grids.document_export_claims WHERE base_id = ${baseId}::uuid`;
    await sql`DELETE FROM grids.document_issuances WHERE base_id = ${baseId}::uuid`;
    await sql`DELETE FROM grids.document_profile_counters WHERE base_id = ${baseId}::uuid`;
    await deleteTestWorkflowScope(baseId);
    await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
  };
  return { baseId, workflowId, capture, cleanup };
};

describe("financial query Document issuance", () => {
  postgresTest("a render failure retains no claims and retries the same confirmed receipt", async () => {
    const scope = await fixture();
    const profile = financialQueryProfiles.find((item) => item.id === "grids.datev-csv")!;
    const render = spyOn(profile, "issue").mockImplementationOnce(() => {
      throw new Error("Renderer temporarily unavailable");
    });
    try {
      const request = await scope.capture();
      const pending = await service.issueQueryDocument(request);
      if (!pending.ok) throw pending.error;
      if (!("kind" in pending.data)) throw new Error("Expected confirmation");
      const [receipt] = await sql`SELECT hash_version FROM grids.document_issuances WHERE base_id = ${scope.baseId}::uuid`;
      expect(receipt.hash_version).toBe(2);
      const confirmed = await service.confirmQueryDocument({ ...request, receiptId: pending.data.receiptId, sha256: pending.data.sha256 });
      if (!confirmed.ok) throw confirmed.error;
      await expect(service.issueQueryDocument(request)).rejects.toThrow("Renderer temporarily unavailable");
      expect(await sql`SELECT business_id FROM grids.document_export_claims WHERE base_id = ${scope.baseId}::uuid`).toHaveLength(0);
      render.mockRestore();
      const retry = await service.issueQueryDocument(request);
      if (!retry.ok) throw retry.error;
      expect(retry.data).toHaveProperty("shortId", pending.data.receiptId);
      const [document] = await sql`SELECT hash_version, template_snapshot, template_revision, profile_snapshot, snapshot_sha256
        FROM grids.documents WHERE base_id = ${scope.baseId}::uuid`;
      expect(document.hash_version).toBe(2);
      expect(document.template_revision).toBe(canonicalJson(document.template_snapshot).sha256);
      expect(document.snapshot_sha256).toBe(canonicalJson(document.profile_snapshot).sha256);
      expect(await sql`SELECT business_id FROM grids.document_export_claims WHERE base_id = ${scope.baseId}::uuid`).toHaveLength(1);
    } finally {
      render.mockRestore();
      await scope.cleanup();
    }
  });

  postgresTest("failure after document insertion rolls back bytes, claims and completion before retry", async () => {
    const scope = await fixture();
    // Fault injection belongs only to this isolated test database. The failure
    // happens after the document INSERT but before its receipt is completed.
    await sql`CREATE FUNCTION grids.test_reject_financial_completion() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.base_id::text = TG_ARGV[0] AND NEW.document_id IS NOT NULL THEN
          RAISE EXCEPTION 'test: interrupted before receipt completion';
        END IF;
        RETURN NEW;
      END
    $$`.simple();
    try {
      await sql.unsafe(`CREATE TRIGGER test_reject_financial_completion BEFORE UPDATE ON grids.document_issuances
        FOR EACH ROW EXECUTE FUNCTION grids.test_reject_financial_completion('${scope.baseId}')`);
      const request = await scope.capture();
      const pending = await service.issueQueryDocument(request);
      if (!pending.ok) throw pending.error;
      if (!("kind" in pending.data)) throw new Error("Expected confirmation");
      const approved = await service.confirmQueryDocument({ ...request, receiptId: pending.data.receiptId, sha256: pending.data.sha256 });
      if (!approved.ok) throw approved.error;
      const [before] = await sql`SELECT count(*)::int AS count FROM grids.files`;
      await expect(service.issueQueryDocument(request)).rejects.toThrow("interrupted before receipt completion");
      expect(await sql`SELECT id FROM grids.documents WHERE base_id = ${scope.baseId}::uuid`).toHaveLength(0);
      expect(await sql`SELECT business_id FROM grids.document_export_claims WHERE base_id = ${scope.baseId}::uuid`).toHaveLength(0);
      const [after] = await sql`SELECT count(*)::int AS count FROM grids.files`;
      expect(after.count).toBe(before.count);
      const [receipt] =
        await sql`SELECT document_id, completed_at, frozen_request FROM grids.document_issuances WHERE base_id = ${scope.baseId}::uuid`;
      expect(receipt.document_id).toBeNull();
      expect(receipt.completed_at).toBeNull();
      expect(receipt.frozen_request).not.toBeNull();
      await sql`DROP TRIGGER test_reject_financial_completion ON grids.document_issuances`.simple();
      const retried = await service.issueQueryDocument(request);
      if (!retried.ok) throw retried.error;
      expect(retried.data).toHaveProperty("shortId", pending.data.receiptId);
      expect(await sql`SELECT id FROM grids.documents WHERE base_id = ${scope.baseId}::uuid`).toHaveLength(1);
      expect(await sql`SELECT business_id FROM grids.document_export_claims WHERE base_id = ${scope.baseId}::uuid`).toHaveLength(1);
    } finally {
      await sql`DROP TRIGGER IF EXISTS test_reject_financial_completion ON grids.document_issuances`.simple();
      await sql`DROP FUNCTION grids.test_reject_financial_completion()`.simple();
      await scope.cleanup();
    }
  });

  for (const change of ["cancel", "republish"] as const) {
    postgresTest(`${change} during rendering leaves no document or claims and permits a new run`, async () => {
      const scope = await fixture();
      const profile = financialQueryProfiles.find((item) => item.id === "grids.datev-csv")!;
      const issue = profile.issue.bind(profile);
      const render = spyOn(profile, "issue");
      try {
        const request = await scope.capture();
        const pending = await service.issueQueryDocument(request);
        if (!pending.ok) throw pending.error;
        if (!("kind" in pending.data)) throw new Error("Expected confirmation");
        const confirmed = await service.confirmQueryDocument({
          ...request,
          receiptId: pending.data.receiptId,
          sha256: pending.data.sha256,
        });
        if (!confirmed.ok) throw confirmed.error;
        render.mockImplementationOnce(async (input, context) => {
          const result = await issue(input, context);
          if (change === "cancel") {
            await sql`UPDATE workflows.run SET cancel_requested_at = now() WHERE id = ${request.runId}::uuid`;
          } else {
            await publishTestWorkflowVersion(scope.workflowId, "steps: [] # republished");
          }
          return result;
        });
        expect((await service.issueQueryDocument(request)).ok).toBe(false);
        expect(render).toHaveBeenCalledTimes(1);
        expect(await sql`SELECT id FROM grids.documents WHERE base_id = ${scope.baseId}::uuid`).toHaveLength(0);
        expect(await sql`SELECT business_id FROM grids.document_export_claims WHERE base_id = ${scope.baseId}::uuid`).toHaveLength(0);
        const [receipt] = await sql`SELECT document_id, confirmed_at FROM grids.document_issuances WHERE base_id = ${scope.baseId}::uuid`;
        expect(receipt.document_id).toBeNull();
        expect(receipt.confirmed_at).not.toBeNull();
        render.mockRestore();
        const next = await scope.capture();
        const preview = await service.issueQueryDocument(next);
        if (!preview.ok) throw preview.error;
        if (!("kind" in preview.data)) throw new Error("Expected confirmation");
        const approval = await service.confirmQueryDocument({ ...next, receiptId: preview.data.receiptId, sha256: preview.data.sha256 });
        if (!approval.ok) throw approval.error;
        const saved = await service.issueQueryDocument(next);
        if (!saved.ok) throw saved.error;
        expect(saved.data).toHaveProperty("shortId", preview.data.receiptId);
        expect(await sql`SELECT id FROM grids.documents WHERE base_id = ${scope.baseId}::uuid`).toHaveLength(1);
        expect(await sql`SELECT business_id FROM grids.document_export_claims WHERE base_id = ${scope.baseId}::uuid`).toHaveLength(1);
      } finally {
        render.mockRestore();
        await scope.cleanup();
      }
    });
  }

  postgresTest("business claims survive workflow revisions while a different business identity remains distinct", async () => {
    const scope = await fixture();
    const approveAndIssue = async (request: Awaited<ReturnType<typeof scope.capture>>) => {
      const preview = await service.issueQueryDocument(request);
      if (!preview.ok) throw preview.error;
      if (!("kind" in preview.data)) throw new Error("Expected confirmation");
      const approval = await service.confirmQueryDocument({ ...request, receiptId: preview.data.receiptId, sha256: preview.data.sha256 });
      if (!approval.ok) throw approval.error;
      return service.issueQueryDocument(request);
    };
    try {
      expect((await approveAndIssue(await scope.capture())).ok).toBe(true);
      // A later run failure must never free identities of an issued document.
      await sql`UPDATE workflows.run SET state = 'failed' WHERE app_id = 'grids' AND scope_id = ${scope.baseId}`;
      await publishTestWorkflowVersion(scope.workflowId, "steps: [] # revised export");
      const revisedOutput: FinancialDocumentOutput = { ...output, header: { ...output.header, label: "Revised export" } };
      const duplicate = await approveAndIssue(await scope.capture("api", revisedOutput));
      expect(duplicate.ok).toBe(false);
      if (!duplicate.ok) expect(duplicate.error.code).toBe("CONFLICT");
      expect(await sql`SELECT id FROM grids.documents WHERE base_id = ${scope.baseId}::uuid`).toHaveLength(1);
      // The author owns business identity: changing it deliberately denotes a
      // different transaction, even when all remaining mapped values match.
      expect((await approveAndIssue(await scope.capture("api", revisedOutput, "invoice-2"))).ok).toBe(true);
      expect(await sql`SELECT id FROM grids.documents WHERE base_id = ${scope.baseId}::uuid`).toHaveLength(2);
      const claims = await sql<
        Array<{ business_id: string }>
      >`SELECT business_id FROM grids.document_export_claims WHERE base_id = ${scope.baseId}::uuid ORDER BY business_id`;
      expect(claims.map((claim) => claim.business_id)).toEqual(["invoice-1", "invoice-2"]);
    } finally {
      await scope.cleanup();
    }
  });

  postgresTest("source changes during rendering abort issuance without retaining claims", async () => {
    const scope = await fixture();
    const tableId = testUuid(),
      recordId = testUuid();
    const tableShortId = testShortId("T"),
      recordShortId = testShortId("R");
    const profile = financialQueryProfiles.find((item) => item.id === "grids.datev-csv")!;
    const issue = profile.issue.bind(profile);
    let rendered = false;
    const render = spyOn(profile, "issue").mockImplementation(async (input, context) => {
      const result = await issue(input, context);
      await sql`UPDATE grids.records SET version = version + 1 WHERE id = ${recordId}::uuid`;
      rendered = true;
      return result;
    });
    try {
      await sql`INSERT INTO grids.tables (id, short_id, base_id, name, position)
        VALUES (${tableId}::uuid, ${tableShortId}, ${scope.baseId}::uuid, 'Approval race', 0)`;
      await sql`INSERT INTO grids.records (id, short_id, table_id, data, version)
        VALUES (${recordId}::uuid, ${recordShortId}, ${tableId}::uuid, '{}'::jsonb, 1)`;
      const request = { ...(await scope.capture()), sourceVersions: [{ tableId: tableShortId, recordId: recordShortId, version: 1 }] };
      const pending = await service.issueQueryDocument(request);
      if (!pending.ok) throw pending.error;
      if (!("kind" in pending.data)) throw new Error("Expected confirmation");
      const confirmed = await service.confirmQueryDocument({ ...request, receiptId: pending.data.receiptId, sha256: pending.data.sha256 });
      if (!confirmed.ok) throw confirmed.error;
      const result = await service.issueQueryDocument(request);
      expect(rendered).toBe(true);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("CONFLICT");
      const [saved] = await sql<
        Array<{ count: number }>
      >`SELECT count(*)::int AS count FROM grids.documents WHERE base_id = ${scope.baseId}::uuid`;
      expect(saved?.count).toBe(0);
      const claims = await sql`SELECT business_id FROM grids.document_export_claims WHERE base_id = ${scope.baseId}::uuid`;
      expect(claims).toEqual([]);
    } finally {
      render.mockRestore();
      await scope.cleanup();
    }
  });

  postgresTest("source versions reject revoked approval before confirmation and changes after confirmation", async () => {
    const scope = await fixture();
    try {
      const tableId = testUuid(),
        recordId = testUuid();
      const tableShortId = testShortId("T"),
        recordShortId = testShortId("R");
      await sql`INSERT INTO grids.tables (id, short_id, base_id, name, position)
        VALUES (${tableId}::uuid, ${tableShortId}, ${scope.baseId}::uuid, 'Approvals', 0)`;
      await sql`INSERT INTO grids.records (id, short_id, table_id, data, version)
        VALUES (${recordId}::uuid, ${recordShortId}, ${tableId}::uuid, '{}'::jsonb, 1)`;
      const baseRequest = await scope.capture();
      const request = { ...baseRequest, sourceVersions: [{ tableId: tableShortId, recordId: recordShortId, version: 1 }] };
      await sql.begin(async (tx) => {
        await requireDocumentSourceVersions(
          {
            ...request,
            authorize: async (tables) => {
              expect(tables).toEqual([tableId]);
            },
          },
          tx,
        );
        await expect(
          sql.begin(async (other) => {
            await other`SET LOCAL lock_timeout = '100ms'`;
            await other`UPDATE grids.records SET version = version + 1 WHERE id = ${recordId}::uuid`;
          }),
        ).rejects.toThrow("lock timeout");
      });
      const pending = await service.issueQueryDocument(request);
      if (!pending.ok) throw pending.error;
      if (!("kind" in pending.data)) throw new Error("Expected confirmation");
      const confirmation = { ...request, receiptId: pending.data.receiptId, sha256: pending.data.sha256 };
      expect((await service.inspectQueryDocumentConfirmation(confirmation)).ok).toBe(true);
      await sql`UPDATE grids.records SET version = 2 WHERE id = ${recordId}::uuid`;
      for (const result of [
        await service.inspectQueryDocumentConfirmation(confirmation),
        await service.confirmQueryDocument(confirmation),
      ]) {
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe("CONFLICT");
      }
      const next = { ...(await scope.capture()), sourceVersions: [{ tableId: tableShortId, recordId: recordShortId, version: 2 }] };
      const fresh = await service.issueQueryDocument(next);
      if (!fresh.ok) throw fresh.error;
      if (!("kind" in fresh.data)) throw new Error("Expected fresh confirmation");
      expect((await service.confirmQueryDocument({ ...next, receiptId: fresh.data.receiptId, sha256: fresh.data.sha256 })).ok).toBe(true);
      await sql`UPDATE grids.records SET version = 3 WHERE id = ${recordId}::uuid`;
      const changed = await service.issueQueryDocument(next);
      expect(changed.ok).toBe(false);
      if (!changed.ok) expect(changed.error.code).toBe("CONFLICT");
      const [files] = await sql<
        Array<{ count: number }>
      >`SELECT count(*)::int AS count FROM grids.documents WHERE base_id = ${scope.baseId}::uuid`;
      expect(files?.count).toBe(0);
    } finally {
      await scope.cleanup();
    }
  });
  postgresTest("creates a schema-validated SEPA document from the exact preview and retains payment identifiers on replay", async () => {
    const scope = await fixture();
    try {
      const request = await scope.capture("api", {
        kind: "sepa-xml",
        version: 1,
        header: { destinationKey: "main-bank", debtorName: "Example", debtorIban: "DE89370400440532013000", executionDate: "2026-09-14" },
        mapping: {
          businessId: "business",
          amount: "amount",
          endToEndId: "payment",
          creditorName: "payee",
          creditorIban: "iban",
          remittance: "purpose",
        },
      });
      const pending = await service.issueQueryDocument(request);
      if (!pending.ok) throw pending.error;
      if (!("kind" in pending.data)) throw new Error("Expected SEPA confirmation");
      const confirmation = { ...request, receiptId: pending.data.receiptId, sha256: pending.data.sha256 };
      let readOnlyPreview = false;
      const preview = await service.inspectQueryDocumentConfirmation({
        ...confirmation,
        authorize: async (_tableIds, tx) => {
          await request.authorize();
          const [mode] = await tx<Array<{ transaction_read_only: string }>>`SHOW transaction_read_only`;
          readOnlyPreview = mode?.transaction_read_only === "on";
        },
      });
      if (!preview.ok) throw preview.error;
      expect(readOnlyPreview).toBe(true);
      if (preview.data.kind !== "sepa-xml") throw new Error("Expected SEPA preview");
      expect(preview.data.input.rows[0]?.amount).toBe("12.30");
      expect((await service.confirmQueryDocument(confirmation)).ok).toBe(true);
      const issued = await service.issueQueryDocument(request);
      if (!issued.ok) throw issued.error;
      if ("kind" in issued.data) throw new Error("Expected SEPA Document");
      expect(issued.data.primaryArtifactKey).toBe("xml");
      expect((await loadDocumentDataSnapshots([issued.data.id])).get(issued.data.id)).toEqual({
        rowCount: preview.data.source.rowCount,
        capturedAt: preview.data.source.capturedAt,
      });
      expect(await loadDocumentDataSnapshots([])).toEqual(new Map());
      expect(await loadDocumentDataSnapshots([testUuid()])).toEqual(new Map());
      const [publicDocument] = await projectDocuments([summarizeDocument(issued.data)]);
      expect(PublicDocumentSchema.safeParse(publicDocument).success).toBe(true);
      expect(publicDocument?.dataSnapshot).toEqual({ rowCount: 1, capturedAt: preview.data.source.capturedAt });
      expect(Object.keys(publicDocument?.dataSnapshot ?? {}).sort()).toEqual(["capturedAt", "rowCount"]);
      const artifact = await service.getDocumentArtifact(issued.data.id, "xml");
      if (!artifact.ok) throw artifact.error;
      const xml = new TextDecoder().decode(artifact.data.bytes);
      expect(xml).toContain(`<MsgId>${preview.data.input.messageId}</MsgId>`);
      expect(xml).toContain(`<PmtInfId>${preview.data.input.paymentInformationId}</PmtInfId>`);
      expect(xml).toContain("Example &amp; Partner");
      expect(xml).toContain('<InstdAmt Ccy="EUR">12.30</InstdAmt>');
      expect(xml).toContain("<CtrlSum>12.30</CtrlSum>");
      const replay = await service.issueQueryDocument(request);
      expect(replay).toEqual(issued);
      expect(await service.getDocumentArtifact(issued.data.id, "xml")).toEqual(artifact);
    } finally {
      await scope.cleanup();
    }
  });

  postgresTest("freezes a normalized preview, requires bound approval, issues once and rejects a duplicate business export", async () => {
    const scope = await fixture();
    try {
      const request = await scope.capture();
      const pending = await service.issueQueryDocument(request);
      if (!pending.ok) throw pending.error;
      if (!("kind" in pending.data)) throw new Error("Financial export must wait for confirmation");
      const confirmation = { ...request, receiptId: pending.data.receiptId, sha256: pending.data.sha256 };
      const preview = await service.inspectQueryDocumentConfirmation(confirmation);
      if (!preview.ok) throw preview.error;
      expect(preview.data.input.rows[0]).toMatchObject({ amount: "12.30", account: "00440" });
      expect(preview.data.source.selectionLimit).toBe(1);
      expect(preview.data.confirmedAt).toBeNull();
      expect((await service.confirmQueryDocument({ ...confirmation, sha256: "0".repeat(64) })).ok).toBe(false);
      expect(
        await service.confirmQueryDocument({ ...confirmation, actor: { ...request.actor, serviceAccountId: testUuid() } }),
      ).toMatchObject({
        ok: false,
        error: { code: "FORBIDDEN", message: expect.stringContaining("same account and access method") },
      });
      expect(
        await service.inspectQueryDocumentConfirmation({
          ...confirmation,
          locale: "de",
          actor: { ...request.actor, credentialId: testUuid() },
        }),
      ).toMatchObject({
        ok: false,
        error: { code: "FORBIDDEN", message: expect.stringContaining("demselben Konto und Zugangsweg") },
      });
      expect(
        (
          await service.confirmQueryDocument({
            ...confirmation,
            authorize: async () => {
              throw err.forbidden("revoked");
            },
          })
        ).ok,
      ).toBe(false);
      const [before] = await sql<
        Array<{ count: number }>
      >`SELECT count(*)::int AS count FROM grids.documents WHERE base_id = ${scope.baseId}::uuid`;
      expect(before?.count).toBe(0);
      const confirmed = await service.confirmQueryDocument(confirmation);
      if (!confirmed.ok) throw confirmed.error;
      expect((await service.confirmQueryDocument(confirmation)).ok).toBe(true);
      const [issued, raced, reconfirmed] = await Promise.all([
        service.issueQueryDocument(request),
        service.issueQueryDocument(request),
        service.confirmQueryDocument(confirmation),
      ]);
      expect(reconfirmed.ok).toBe(true);
      if (!issued.ok) throw issued.error;
      if (!raced.ok) throw raced.error;
      if ("kind" in issued.data) throw new Error("Expected confirmed export");
      expect(raced.data).toEqual(issued.data);
      expect(issued.data.filename).toMatch(/^EXTF_DATEV-\d+\.csv$/);
      expect(issued.data.primaryArtifactKey).toBe("csv");
      const [stored] = await sql<
        Array<{ profile_snapshot: Record<string, unknown> }>
      >`SELECT profile_snapshot FROM grids.documents WHERE id = ${issued.data.id}::uuid`;
      expect(stored?.profile_snapshot).toHaveProperty("data");
      expect(stored?.profile_snapshot).not.toHaveProperty("rows");
      expect(stored?.profile_snapshot).toHaveProperty("confirmation.actor", request.actor);
      const artifact = await service.getDocumentArtifact(issued.data.id, "csv");
      if (!artifact.ok) throw artifact.error;
      expect(new TextDecoder().decode(artifact.data.bytes)).toContain('12,30;"S";"EUR";;;;00440;70000');
      const replay = await service.issueQueryDocument(request);
      if (!replay.ok) throw replay.error;
      expect(replay.data).toEqual(issued.data);
      expect((await service.confirmQueryDocument(confirmation)).ok).toBe(true);
      expect((await service.confirmQueryDocument({ ...confirmation, sha256: "b".repeat(64) })).ok).toBe(false);
      await sql`UPDATE workflows.run SET state = 'failed' WHERE id = ${request.runId}::uuid`;
      await expect(Promise.resolve(sql`DELETE FROM grids.document_export_claims WHERE base_id = ${scope.baseId}::uuid`)).rejects.toThrow(
        "terminal",
      );
      const other = await scope.capture();
      const duplicate = await service.issueQueryDocument(other);
      if (!duplicate.ok) throw duplicate.error;
      if (!("kind" in duplicate.data)) throw new Error("Expected preview");
      expect(
        (await service.confirmQueryDocument({ ...other, receiptId: duplicate.data.receiptId, sha256: duplicate.data.sha256 })).ok,
      ).toBe(true);
      const rejected = await service.issueQueryDocument(other);
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) expect(rejected.error.message).toContain("reserved");
      const [after] = await sql<
        Array<{ count: number }>
      >`SELECT count(*)::int AS count FROM grids.documents WHERE base_id = ${scope.baseId}::uuid`;
      expect(after?.count).toBe(1);
    } finally {
      await scope.cleanup();
    }
  });

  postgresTest("rejects automatic runs and cancellation before confirmation", async () => {
    const scope = await fixture();
    try {
      expect((await service.issueQueryDocument(await scope.capture("schedule"))).ok).toBe(false);
      const request = await scope.capture();
      const pending = await service.issueQueryDocument(request);
      if (!pending.ok) throw pending.error;
      if (!("kind" in pending.data)) throw new Error("Expected preview");
      await sql`UPDATE workflows.run SET cancel_requested_at = now() WHERE id = ${request.runId}::uuid`;
      expect((await service.confirmQueryDocument({ ...request, receiptId: pending.data.receiptId, sha256: pending.data.sha256 })).ok).toBe(
        false,
      );
      const [row] = await sql<
        Array<{ confirmed_at: Date | null }>
      >`SELECT confirmed_at FROM grids.document_issuances WHERE base_id = ${scope.baseId}::uuid`;
      expect(row?.confirmed_at).toBeNull();
    } finally {
      await scope.cleanup();
    }
  });

  postgresTest("permission loss after rendering leaves no claims and a new run can issue the same business transaction", async () => {
    const scope = await fixture();
    const profile = financialQueryProfiles.find((item) => item.id === "grids.datev-csv")!;
    const issue = profile.issue.bind(profile);
    let rendered = false;
    const render = spyOn(profile, "issue").mockImplementation(async (input, context) => {
      const result = await issue(input, context);
      rendered = true;
      return result;
    });
    try {
      const request = await scope.capture();
      const pending = await service.issueQueryDocument(request);
      if (!pending.ok) throw pending.error;
      if (!("kind" in pending.data)) throw new Error("Expected preview");
      const confirmation = { ...request, receiptId: pending.data.receiptId, sha256: pending.data.sha256 };
      expect((await service.confirmQueryDocument(confirmation)).ok).toBe(true);
      const rejected = await service.issueQueryDocument({
        ...request,
        authorize: async () => {
          if (rendered) throw err.forbidden("Permission revoked before storing bytes");
        },
      });
      expect(rendered).toBe(true);
      expect(rejected.ok).toBe(false);
      const [saved] = await sql<
        Array<{ count: number }>
      >`SELECT count(*)::int AS count FROM grids.documents WHERE base_id = ${scope.baseId}::uuid`;
      expect(saved?.count).toBe(0);
      const claims = await sql<
        Array<{ business_id: string }>
      >`SELECT business_id FROM grids.document_export_claims WHERE base_id = ${scope.baseId}::uuid`;
      expect(claims).toEqual([]);
      await sql`UPDATE workflows.run SET state = 'failed' WHERE id = ${request.runId}::uuid`;
      expect((await service.issueQueryDocument(request)).ok).toBe(false);
      const next = await scope.capture();
      const preview = await service.issueQueryDocument(next);
      if (!preview.ok) throw preview.error;
      if (!("kind" in preview.data)) throw new Error("Expected preview");
      expect((await service.confirmQueryDocument({ ...next, receiptId: preview.data.receiptId, sha256: preview.data.sha256 })).ok).toBe(
        true,
      );
      const issued = await service.issueQueryDocument(next);
      if (!issued.ok) throw issued.error;
      expect(issued.data).toHaveProperty("primaryArtifactKey", "csv");
    } finally {
      render.mockRestore();
      await scope.cleanup();
    }
  });
});
