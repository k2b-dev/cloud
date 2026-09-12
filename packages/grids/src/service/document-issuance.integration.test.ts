import { beforeAll, describe, expect } from "bun:test";
import { err, fail } from "@k2b/stdlib";
import { SQL, sql } from "bun";
import { z } from "zod";
import { migrate as migrateCoreWorkflows } from "../../../core/src/migrate/core/workflows";
import type { DocumentTemplate } from "../contracts";
import type { DocumentProfile } from "../document-profiles";
import { renderDatevBatch } from "../document-profiles/datev-csv";
import { createGermanBillingProfile } from "../document-profiles/einvoice-de";
import { invoiceAccountingStarterSource } from "../frontend/_components/workflows/financial-workflow-starters";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { compileAndBindGridsWorkflowSource } from "../workflows/binder";
import { grantAccess } from "./access";
import { getDocumentPdf, getDocumentPrimaryArtifact, renderWorkflowDocumentsPdf } from "./document-core";
import { type FinancialDocumentOutput, normalizeFinancialDocumentOutput } from "./document-financial-output";
import { createDocumentIssuanceService, type IssueDocumentInput } from "./document-issuance";
import { MAX_DOCUMENT_PROFILE_INPUT_BYTES } from "./document-json";
import { type DocumentDbRow, mapDocumentTemplate } from "./document-mappers";
import { createTemplate, getTemplate } from "./document-templates";
import { provisionDocumentNumberSeries } from "./number-series";
import { canExecuteRun, documentActorForScope } from "./workflow-action-scope";
import { loadWorkflowCatalog } from "./workflow-catalog";
import { captureWorkflowDocumentSource } from "./workflow-document-sources";
import { persistWorkflowQueryDataInTransaction } from "./workflow-query-store";
import { getWorkflowDocumentConfirmation, getWorkflowRunScope } from "./workflow-runs";
import { invokeGridsWorkflow, runGridsWorkflowRun } from "./workflow-runtime";
import { insertTestWorkflow, insertTestWorkflowRun } from "./workflow-test-fixture";

const pdf = (label: string) => new TextEncoder().encode(`%PDF-1.7\n${label}`);

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
}, 30_000);

const createScope = async (database: SQL = sql) => {
  const baseId = testUuid();
  const tableId = testUuid();
  const recordId = testUuid();
  const recordShortId = testShortId("R");
  await database`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${testShortId("B")}, 'Issuance')`;
  await database`INSERT INTO grids.tables (id, short_id, base_id, name) VALUES (${tableId}::uuid, ${testShortId("T")}, ${baseId}::uuid, 'Invoices')`;
  await database`
    INSERT INTO grids.records (id, short_id, table_id, data, version, updated_at)
    VALUES (${recordId}::uuid, ${recordShortId}, ${tableId}::uuid, '{}'::jsonb, 1, '2026-08-22T10:00:00.000Z')
  `;
  return { baseId, tableId, recordId, recordShortId };
};

const inputFor = (
  template: DocumentTemplate,
  scope: Awaited<ReturnType<typeof createScope>>,
  overrides: Partial<IssueDocumentInput> = {},
): IssueDocumentInput => {
  const root = {
    id: scope.recordId,
    table: { id: scope.tableId, shortId: testShortId("T"), name: "Invoices" },
    fields: [],
    data: {},
    version: 1,
    createdAt: "2026-08-22T10:00:00.000Z",
    updatedAt: "2026-08-22T10:00:00.000Z",
    deletedAt: null,
  };
  return {
    template,
    snapshot: {
      id: testUuid(),
      baseId: scope.baseId,
      tableId: scope.tableId,
      recordId: scope.recordId,
      root,
      graph: { rootId: `${scope.tableId}:${scope.recordId}`, records: { [`${scope.tableId}:${scope.recordId}`]: root } },
      createdBy: null,
      createdAt: "2026-08-22T10:00:00.000Z",
    },
    renderData: {
      record: { id: scope.recordShortId, shortId: scope.recordShortId, version: 1, updatedAt: "2026-08-22T10:00:00.000Z", data: {} },
      table: { id: testShortId("T"), name: "Invoices" },
    },
    actor: { kind: "system" },
    idempotencyKey: `issue-${testUuid()}`,
    ...overrides,
  };
};

const insertProfileTemplate = async (
  tableId: string,
  renderer: Extract<DocumentTemplate["renderer"], { kind: "profile" }>,
): Promise<DocumentTemplate> => {
  const id = testUuid();
  await sql`
    INSERT INTO grids.document_templates (
      id, short_id, table_id, name, source, renderer_kind,
      profile_id, profile_version, profile_input_template, enabled, position
    ) VALUES (
      ${id}::uuid, ${testShortId("D")}, ${tableId}::uuid, 'Statement', 'from table Invoices', 'profile',
      ${renderer.id}, ${renderer.version}, ${renderer.inputTemplate}, true, 0
    )
  `;
  const template = await getTemplate(id);
  if (!template) throw new Error("profile template missing");
  return template;
};

postgresTest(
  "issued invoice totals remain exact immutable workflow source values",
  async () => {
    const scope = await createScope();
    let renderedXml = "";
    const profile = createGermanBillingProfile({
      render: async ({ xml }) => {
        renderedXml = xml;
        return { pdf: pdf("issued invoice totals") };
      },
      extractEmbedded: async () => ({ filename: "factur-x.xml", xml: renderedXml }),
    });
    const template = await insertProfileTemplate(scope.tableId, {
      kind: "profile",
      id: profile.id,
      version: profile.version,
      inputTemplate: JSON.stringify({
        billing: { kind: "invoice" },
        invoiceDate: "2026-09-11",
        dueDate: "2026-09-25",
        serviceDate: "2026-09-11",
        currency: "EUR",
        seller: {
          name: "Seller GmbH",
          vatId: "DE123456789",
          address: { line1: "Strasse 1", city: "Ulm", postalCode: "89073", countryCode: "DE" },
        },
        buyer: {
          name: "Buyer GmbH",
          vatId: "DE987654321",
          address: { line1: "Strasse 2", city: "Ulm", postalCode: "89073", countryCode: "DE" },
        },
        buyerReference: "ORDER-1",
        payment: { iban: "DE89370400440532013000", accountName: "Seller GmbH" },
        lines: [
          { name: "First", quantity: "1.0000", unitPrice: "0.0050", taxRate: "19.00" },
          { name: "Second", quantity: "1.0000", unitPrice: "0.0050", taxRate: "19.00" },
        ],
      }),
    });
    const service = createDocumentIssuanceService({ profiles: [profile] });
    const baseInput = inputFor(template, scope);
    const input = {
      ...baseInput,
      renderData: {
        ...baseInput.renderData,
        record: {
          id: scope.recordShortId,
          shortId: scope.recordShortId,
          version: 1,
          updatedAt: "2026-08-22T10:00:00.000Z",
          data: { DIR001: "S", ACC001: "10000", CTR001: "8400" },
        },
      },
    };
    const issued = await service.issueDocument(input);
    if (!issued.ok) throw issued.error;
    const document = issued.data.document;
    expect(renderedXml).toContain("<ram:GrandTotalAmount>0.02</ram:GrandTotalAmount>");
    const capture = () =>
      captureWorkflowDocumentSource(
        {
          baseId: scope.baseId,
          capturedAt: "2026-09-11T12:00:00.000Z",
          source: { documents: [document.shortId], columns: [{ key: "amount", type: "decimal", path: ["output", "grossAmount"] }] },
        },
        sql,
      );
    const exported = await capture();
    if (!exported.ok) throw exported.error;
    expect(exported.data.payload.rows).toEqual([{ amount: "0.02" }]);
    const accounting = await captureWorkflowDocumentSource(
      {
        baseId: scope.baseId,
        capturedAt: "2026-09-11T12:00:00.000Z",
        source: {
          documents: [document.shortId],
          columns: [
            { key: "businessId", type: "text", path: ["data", "record", "id"] },
            { key: "entryId", type: "text", path: ["number"] },
            { key: "amount", type: "decimal", path: ["output", "grossAmount"] },
            { key: "direction", type: "text", path: ["data", "record", "data", "DIR001"] },
            { key: "account", type: "text", path: ["data", "record", "data", "ACC001"] },
            { key: "counterAccount", type: "text", path: ["data", "record", "data", "CTR001"] },
            { key: "documentDate", type: "date", path: ["profile", "invoiceDate"] },
            { key: "documentNumber", type: "text", path: ["number"] },
          ],
        },
      },
      sql,
    );
    if (!accounting.ok) throw accounting.error;
    const financialOutput: FinancialDocumentOutput = {
      kind: "datev-csv",
      version: 1,
      header: {
        destinationKey: "company-ledger",
        consultantNumber: "12345",
        clientNumber: "1",
        fiscalYearStart: "2026-01-01",
        accountLength: 4,
        periodStart: "2026-09-01",
        periodEnd: "2026-09-30",
        label: "Invoices",
        finalize: false,
      },
      mapping: {
        businessId: "businessId",
        entryId: "entryId",
        amount: "amount",
        direction: "direction",
        account: "account",
        counterAccount: "counterAccount",
        documentDate: "documentDate",
        documentNumber: "documentNumber",
      },
    };
    const normalized = normalizeFinancialDocumentOutput(financialOutput, accounting.data.payload, {
      messageId: "unused",
      paymentInformationId: "unused",
    });
    if (!normalized.ok) throw normalized.error;
    if (normalized.data.kind !== "datev-csv") throw new Error("Expected DATEV output");
    expect(normalized.data.input.rows[0]).toMatchObject({ businessId: scope.recordShortId, amount: "0.02", direction: "S" });
    const datev = renderDatevBatch(normalized.data.input, new Date("2026-09-11T12:00:00.000Z"));
    expect(new TextDecoder().decode(datev.bytes)).toContain('0,02;"S";"EUR"');
    const workflowId = await insertTestWorkflow({ baseId: scope.baseId, shortId: testShortId("W") });
    const runId = await insertTestWorkflowRun({
      baseId: scope.baseId,
      workflowId,
      shortId: testShortId("R"),
      state: "waiting",
      channel: "api",
    });
    const storedCapture = await sql.begin((tx) =>
      persistWorkflowQueryDataInTransaction({ baseId: scope.baseId, runId, stepKey: "invoices", capture: accounting.data }, tx),
    );
    if (!storedCapture.ok) throw storedCapture.error;
    const exportRequest = {
      baseId: scope.baseId,
      runId,
      stepKey: "accounting",
      data: storedCapture.data,
      output: financialOutput,
      actor: { kind: "service_account" as const, serviceAccountId: testUuid(), delegatedUserId: null, credentialId: null },
      filename: null,
      tags: [],
      idempotencyKey: `${runId}:accounting`,
      authorize: async () => {},
    };
    const pending = await service.issueQueryDocument(exportRequest);
    if (!pending.ok) throw pending.error;
    if (!("kind" in pending.data)) throw new Error("Expected financial confirmation");
    const [beforeConfirmation] = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM grids.documents WHERE base_id = ${scope.baseId}::uuid
    `;
    expect(beforeConfirmation?.count).toBe(1);
    const confirmed = await service.confirmQueryDocument({
      ...exportRequest,
      receiptId: pending.data.receiptId,
      sha256: pending.data.sha256,
    });
    if (!confirmed.ok) throw confirmed.error;
    const financialDocument = await service.issueQueryDocument(exportRequest);
    if (!financialDocument.ok) throw financialDocument.error;
    if ("kind" in financialDocument.data) throw new Error("Expected issued financial document");
    const financialArtifact = await service.getDocumentArtifact(financialDocument.data.id, "csv");
    if (!financialArtifact.ok) throw financialArtifact.error;
    expect(new TextDecoder().decode(financialArtifact.data.bytes)).toContain('0,02;"S";"EUR"');
    const exportReplay = await service.issueQueryDocument(exportRequest);
    if (!exportReplay.ok) throw exportReplay.error;
    expect(exportReplay.data).toEqual(financialDocument.data);
    await sql`UPDATE grids.records SET data = ${{ amount: "999.00" }}::jsonb WHERE id = ${scope.recordId}::uuid`;
    const unchanged = await capture();
    if (!unchanged.ok) throw unchanged.error;
    expect(unchanged.data.sha256).toBe(exported.data.sha256);
    await expect(
      Promise.resolve(sql`UPDATE grids.documents SET profile_output = '{}'::jsonb WHERE id = ${document.id}::uuid`),
    ).rejects.toThrow("immutable");
    const replay = await service.issueDocument(input);
    if (!replay.ok) throw replay.error;
    expect(replay.data.document.id).toBe(document.id);
    expect(replay.data.replayed).toBe(true);

    // Run the exact UI starter through the compiler and real workflow kernel.
    // A separate destination represents a separate ledger, not a dedupe bypass.
    const actorId = testUuid();
    await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name)
      VALUES (${actorId}::uuid, ${`invoice-starter-${actorId}`}, 'local', 'user', 'Invoice author')`;
    const access = await grantAccess({
      resourceType: "base",
      resourceId: scope.baseId,
      principal: { type: "user", userId: actorId },
      permission: "write",
    });
    if (!access.ok) throw access.error;
    const starterSource = invoiceAccountingStarterSource({
      header: { ...financialOutput.header, destinationKey: "starter-ledger" },
      fields: { direction: "DIR001", account: "ACC001", counterAccount: "CTR001" },
    });
    const compiled = await compileAndBindGridsWorkflowSource(starterSource, await loadWorkflowCatalog(scope.baseId));
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
    const starterWorkflow = await insertTestWorkflow({
      baseId: scope.baseId,
      shortId: testShortId("W"),
      source: starterSource,
      plan: compiled.plan,
      enabled: true,
      ownerUserId: actorId,
    });
    const principal = { userId: actorId, groupIds: [], serviceAccountId: null };
    const invoked = await invokeGridsWorkflow({
      workflowId: starterWorkflow,
      principal,
      inputs: { document: document.shortId },
      mode: "execute",
      channel: "api",
      idempotencyKey: testUuid(),
    });
    if (!invoked.ok) throw invoked.error;
    const starterRun = invoked.data.runId;
    await runGridsWorkflowRun(starterRun);
    const starterPending = await getWorkflowDocumentConfirmation(starterRun);
    const starterScope = await getWorkflowRunScope(starterRun);
    if (!starterPending || !starterScope) throw new Error("Starter did not reach financial confirmation");
    const confirmationRequest = {
      baseId: scope.baseId,
      runId: starterRun,
      receiptId: starterPending.receiptId,
      actor: documentActorForScope(starterScope),
      authorize: async () => {
        if (!(await canExecuteRun(starterScope))) throw err.forbidden("Workflow access lost");
      },
    };
    const starterPreview = await service.inspectQueryDocumentConfirmation(confirmationRequest);
    if (!starterPreview.ok) throw starterPreview.error;
    expect(starterPreview.data.input.rows[0]).toMatchObject({ amount: "0.02", direction: "S", account: "10000" });
    const starterConfirmed = await service.confirmQueryDocument({ ...confirmationRequest, sha256: starterPending.sha256 });
    if (!starterConfirmed.ok) throw starterConfirmed.error;
    await runGridsWorkflowRun(starterRun);
    const [starterState] = await sql<Array<{ state: string }>>`SELECT state FROM workflows.run WHERE id = ${starterRun}::uuid`;
    expect(starterState?.state).toBe("succeeded");
    const starterDocuments = await sql<Array<{ id: string }>>`SELECT id FROM grids.documents WHERE workflow_run_id = ${starterRun}::uuid`;
    expect(starterDocuments).toHaveLength(1);
    const starterDocument = starterDocuments[0];
    if (!starterDocument) throw new Error("Missing starter export");
    const starterArtifact = await service.getDocumentArtifact(starterDocument.id, "csv");
    if (!starterArtifact.ok) throw starterArtifact.error;
    expect(new TextDecoder().decode(starterArtifact.data.bytes)).toContain('0,02;"S";"EUR"');
  },
  30_000,
);

describe("Document issuance", () => {
  postgresTest("rejects a mixed-format run PDF download instead of silently omitting its CSV", async () => {
    const scope = await createScope();
    const workflowId = await insertTestWorkflow({ baseId: scope.baseId, shortId: testShortId("W") });
    const runId = await insertTestWorkflowRun({ baseId: scope.baseId, workflowId, shortId: testShortId("R"), state: "succeeded" });
    const profiles: DocumentProfile<Record<string, never>>[] = ["pdf", "csv"].map((key) => ({
      id: `test.run-${key}`,
      version: 1,
      title: key,
      description: "Mixed run fixture",
      rendererVersion: "test-v1",
      validatorVersion: "test-v1",
      primaryArtifact: { key, mediaType: key === "pdf" ? "application/pdf" : "text/csv" },
      input: z.object({}).strict(),
      formatNumber: ({ value }) => `RUN-${key}-${value}`,
      issue: () => ({
        artifacts: [
          {
            key,
            filename: `output.${key}`,
            mediaType: key === "pdf" ? "application/pdf" : "text/csv",
            bytes: key === "pdf" ? pdf("run") : new TextEncoder().encode("amount\r\n12.30\r\n"),
          },
        ],
        validationStatus: "valid",
        validationReport: { valid: true },
      }),
    }));
    const service = createDocumentIssuanceService({ profiles });
    for (const profile of profiles) {
      const template = await insertProfileTemplate(scope.tableId, { kind: "profile", id: profile.id, version: 1, inputTemplate: "{}" });
      const issued = await service.issueDocument(inputFor(template, scope, { workflowRunId: runId, workflowStepKey: profile.id }));
      if (!issued.ok) throw issued.error;
      if (profile.primaryArtifact.key === "pdf") {
        const single = await renderWorkflowDocumentsPdf(runId, async () => true);
        if (!single.ok) throw single.error;
        expect(single.data.documentCount).toBe(1);
        expect(single.data.pdf).toEqual(pdf("run"));
      }
    }
    const mixed = await renderWorkflowDocumentsPdf(runId, async () => true);
    expect(mixed.ok).toBe(false);
    if (!mixed.ok) {
      expect(mixed.error.code).toBe("BAD_INPUT");
      expect(mixed.error.message).toContain("PDF");
    }
  });

  postgresTest("rejects invalid derived profile output without issuing a document and permits a corrected retry", async () => {
    const scope = await createScope();
    let output: Record<string, unknown> = { amount: Number.NaN };
    const profile: DocumentProfile<Record<string, never>> = {
      id: "test.derived-output",
      version: 1,
      title: "Derived values",
      description: "Derived output boundary fixture",
      rendererVersion: "test-v1",
      validatorVersion: "test-v1",
      primaryArtifact: { key: "csv", mediaType: "text/csv" },
      input: z.object({}).strict(),
      formatNumber: ({ value }) => `OUTPUT-${value}`,
      issue: () => ({
        output,
        artifacts: [{ key: "csv", filename: "output.csv", mediaType: "text/csv", bytes: new TextEncoder().encode("amount\r\n0.02\r\n") }],
        validationStatus: "valid",
        validationReport: { valid: true },
      }),
    };
    const template = await insertProfileTemplate(scope.tableId, { kind: "profile", id: profile.id, version: 1, inputTemplate: "{}" });
    const service = createDocumentIssuanceService({ profiles: [profile] });
    const request = inputFor(template, scope);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const invalid of [{ amount: Number.NaN }, { amount: undefined }, cyclic, { text: "x".repeat(MAX_DOCUMENT_PROFILE_INPUT_BYTES) }]) {
      output = invalid;
      const rejected = await service.issueDocument(request);
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) expect(rejected.error.code).toBe("BAD_INPUT");
      const [count] = await sql<
        Array<{ count: number }>
      >`SELECT count(*)::int AS count FROM grids.documents WHERE base_id = ${scope.baseId}::uuid`;
      expect(count?.count).toBe(0);
    }
    output = { amount: "0.02" };
    const issued = await service.issueDocument(request);
    if (!issued.ok) throw issued.error;
    output.amount = "999.00";
    const [stored] = await sql<
      Array<{ profile_output: Record<string, unknown> }>
    >`SELECT profile_output FROM grids.documents WHERE id = ${issued.data.document.id}::uuid`;
    expect(stored?.profile_output).toEqual({ amount: "0.02" });
    expect(issued.data.document.documentNumber).toBe("OUTPUT-1");
  });

  for (const kind of ["csv", "json", "xml"] as const) {
    postgresTest(`built-in ${kind} profile issues and replays from a record template`, async () => {
      const scope = await createScope();
      const created = await createTemplate(
        scope.tableId,
        {
          name: `${kind} statement`,
          source: "from table Invoices",
          renderer: {
            kind: "profile",
            id: `grids.${kind}`,
            version: 1,
            inputTemplate: JSON.stringify({
              columns: [{ key: "amount", label: "Amount", type: "number", sqlType: "numeric" }],
              rows: [{ amount: "9007199254740993.01" }],
              ...(kind === "xml"
                ? { body: "{% raw %}<report>{% for row in rows %}<amount>{{ row.amount }}</amount>{% endfor %}</report>{% endraw %}" }
                : {}),
            }),
          },
        },
        null,
      );
      if (!created.ok) throw created.error;
      const service = createDocumentIssuanceService();
      const input = inputFor(created.data, scope);
      const issued = await service.issueDocument(input);
      if (!issued.ok) throw issued.error;
      expect(issued.data.document.primaryArtifactKey).toBe(kind);
      expect(issued.data.document.filename.endsWith(`.${kind}`)).toBe(true);
      const artifact = await service.getDocumentArtifact(issued.data.document.id, kind);
      if (!artifact.ok) throw artifact.error;
      expect(artifact.data.mimeType).toBe(kind === "csv" ? "text/csv" : `application/${kind}`);
      expect(new TextDecoder().decode(artifact.data.bytes)).toContain("9007199254740993.01");
      const replayed = await service.issueDocument(input);
      if (!replayed.ok) throw replayed.error;
      expect(replayed.data.document.id).toBe(issued.data.document.id);
      const [count] = await sql<
        Array<{ count: number }>
      >`SELECT count(*)::int AS count FROM grids.documents WHERE base_id = ${scope.baseId}::uuid`;
      expect(count?.count).toBe(1);
    });
  }

  postgresTest("stores and replays a non-PDF primary artifact through the same issuance owner", async () => {
    const scope = await createScope();
    let renders = 0;
    let validOutput = false;
    const profile: DocumentProfile<{ amount: string }> = {
      id: "test.csv-statement",
      version: 1,
      title: "CSV statement",
      description: "Non-PDF primary artifact fixture",
      rendererVersion: "test-csv-v1",
      validatorVersion: "test-csv-v1",
      primaryArtifact: { key: "csv", mediaType: "text/csv" },
      input: z.object({ amount: z.string() }).strict(),
      formatNumber: ({ value }) => `CSV-${value}`,
      issue: (data, context) => {
        renders++;
        return {
          artifacts: [
            {
              key: "csv",
              filename: `${context.number}.csv`,
              mediaType: validOutput ? "text/csv" : "text/plain",
              bytes: new TextEncoder().encode(`amount\r\n${data.amount}\r\n`),
            },
          ],
          validationStatus: "valid",
          validationReport: { valid: true },
        };
      },
    };
    const template = await insertProfileTemplate(scope.tableId, {
      kind: "profile",
      id: profile.id,
      version: profile.version,
      inputTemplate: '{"amount":"12.30"}',
    });
    const service = createDocumentIssuanceService({ profiles: [profile] });
    expect(service.profiles()[0]?.primaryArtifact).toEqual({ key: "csv", mediaType: "text/csv" });
    const input = inputFor(template, scope);
    const invalid = await service.issueDocument(input);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe("BAD_INPUT");
    const [empty] = await sql<
      Array<{ count: number }>
    >`SELECT count(*)::int AS count FROM grids.documents WHERE base_id = ${scope.baseId}::uuid`;
    expect(empty?.count).toBe(0);
    validOutput = true;
    const issued = await service.issueDocument(input);
    if (!issued.ok) throw issued.error;
    expect(issued.data.document.primaryArtifactKey).toBe("csv");
    expect(issued.data.document.documentNumber).toBe("CSV-1");
    expect(issued.data.document.filename).toBe("CSV-1.csv");
    expect(issued.data.document.renderData.document).toMatchObject({ filename: null });
    expect(issued.data.document.artifacts.map((artifact) => artifact.key)).toEqual(["csv"]);
    const noDerivedOutput = await captureWorkflowDocumentSource(
      {
        baseId: scope.baseId,
        capturedAt: "2026-09-11T12:00:00.000Z",
        source: {
          documents: [issued.data.document.shortId],
          columns: [{ key: "amount", type: "decimal", path: ["output", "grossAmount"] }],
        },
      },
      sql,
    );
    expect(noDerivedOutput.ok).toBe(false);
    if (!noDerivedOutput.ok) expect(noDerivedOutput.error.code).toBe("BAD_INPUT");
    const primary = await getDocumentPrimaryArtifact(issued.data.document);
    if (!primary.ok) throw primary.error;
    expect(primary.data.mimeType).toBe("text/csv");
    expect(new TextDecoder().decode(primary.data.bytes)).toBe("amount\r\n12.30\r\n");
    const notPdf = await getDocumentPdf(issued.data.document);
    expect(notPdf.ok).toBe(false);
    if (!notPdf.ok) expect(notPdf.error.code).toBe("BAD_INPUT");
    const replayed = await service.issueDocument(input);
    if (!replayed.ok) throw replayed.error;
    expect(replayed.data.replayed).toBe(true);
    expect(replayed.data.document).toEqual(issued.data.document);
    expect(renders).toBe(2);
  });

  postgresTest(
    "retries current pending HTML and profile receipts across restarts and rejects old provenance fields",
    async () => {
      const sourceUrl = process.env.DATABASE_URL;
      if (!sourceUrl) throw new Error("DATABASE_URL is required for issuance integration tests");
      const databaseName = `grids_issuance_${testUuid().replaceAll("-", "")}`;
      const databaseUrl = new URL(sourceUrl);
      databaseUrl.pathname = `/${databaseName}`;
      await sql.unsafe(`CREATE DATABASE "${databaseName}"`);
      const database = new SQL(databaseUrl);
      try {
        await database`CREATE SCHEMA auth`.simple();
        await database`CREATE TABLE auth.users (id UUID PRIMARY KEY)`.simple();
        await database`CREATE TABLE auth.access (id UUID PRIMARY KEY)`.simple();
        await database`CREATE TABLE auth.service_accounts (id UUID PRIMARY KEY)`.simple();
        await migrateCoreWorkflows(database);
        await migrate(database);
        // Simulate an unsupported writer only in this disposable database.
        // Never disable the immutable guard or change a saved receipt.
        await database`
        CREATE FUNCTION grids.test_obsolete_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.frozen_request->'tags' ? 'malformed' THEN
            NEW.frozen_request = NEW.frozen_request || jsonb_build_object(
              'source', jsonb_build_object('appId', 'grids', 'resourceType', 'document_template',
                'resourceId', NEW.frozen_request #>> '{template,shortId}'),
              'sourceRevision', jsonb_build_object('id', 'record@1',
                'observedAt', '2026-08-22T10:00:00.000Z', 'evidence', '{}'::jsonb)
            );
          END IF;
          RETURN NEW;
        END $$
      `.simple();
        await database`
        CREATE TRIGGER test_obsolete_receipt BEFORE INSERT ON grids.document_issuances
        FOR EACH ROW EXECUTE FUNCTION grids.test_obsolete_receipt()
      `.simple();
        for (const kind of ["html", "profile"] as const) {
          const scope = await createScope(database);
          let failRender = true;
          let renderCalls = 0;
          const profile: DocumentProfile<{ title: string }> = {
            id: "test.historical",
            version: 1,
            title: "Historical",
            description: "Historical receipt fixture",
            rendererVersion: "test-v1",
            validatorVersion: "test-v1",
            primaryArtifact: { key: "pdf", mediaType: "application/pdf" },
            input: z.object({ title: z.string() }).strict(),
            formatNumber: ({ value }) => `HIST-${value}`,
            issue: (_value, context) => {
              renderCalls++;
              if (failRender) throw err.internal("renderer unavailable");
              return {
                artifacts: [{ key: "pdf", filename: `${context.number}.pdf`, mediaType: "application/pdf", bytes: pdf(context.number) }],
                validationStatus: "valid",
                validationReport: { valid: true },
              };
            },
          };
          const [row] = await database<DocumentDbRow[]>`
          INSERT INTO grids.document_templates (
            id, short_id, table_id, name, source, renderer_kind, html, number_template, filename_template,
            profile_id, profile_version, profile_input_template
          ) VALUES (
            ${testUuid()}::uuid, ${testShortId("D")}, ${scope.tableId}::uuid, 'Historical', 'from table Invoices',
            ${kind}, ${kind === "html" ? "<p>{{ document.number }}</p>" : null},
            ${kind === "html" ? "HIST-{{ series.value }}" : null},
            ${kind === "html" ? "{{ document.number }}.pdf" : null},
            ${kind === "profile" ? profile.id : null}, ${kind === "profile" ? 1 : null},
            ${kind === "profile" ? '{"title":"Historical"}' : null}
          ) RETURNING *
        `;
          if (!row) throw new Error("historical template missing");
          const template = mapDocumentTemplate(row);
          if (kind === "html") await provisionDocumentNumberSeries(database, template.id, "HIST-{{ series.value }}");
          const service = createDocumentIssuanceService({ db: database, profiles: [profile] });
          const input = inputFor(template, scope, {
            renderPdf: async () => {
              renderCalls++;
              return failRender
                ? fail(err.internal("renderer unavailable"))
                : { ok: true, data: { pdf: pdf("historical"), contentType: "application/pdf" } };
            },
          });
          expect((await service.issueDocument(input)).ok).toBe(false);
          const readReceipts = () => database`SELECT * FROM grids.document_issuances WHERE base_id = ${scope.baseId}::uuid ORDER BY id`;
          const before = await readReceipts();
          expect(before).toHaveLength(1);
          expect(before[0]?.frozen_request).not.toHaveProperty("source");
          expect(before[0]?.frozen_request).not.toHaveProperty("sourceRevision");
          expect(before[0]?.frozen_request.documentNumber).toBe("HIST-1");
          const readAllocations = () => database<Array<{ id: string; consumer_kind: string | null; consumer_id: string | null }>>`
          SELECT allocation.* FROM grids.number_allocations allocation
          JOIN grids.number_series series ON series.id = allocation.series_id
          WHERE series.document_template_id = ${template.id}::uuid ORDER BY allocation.id
        `;
          const allocationsBefore = await readAllocations();
          expect(allocationsBefore).toHaveLength(kind === "html" ? 1 : 0);
          expect(before[0]?.frozen_request.allocationId).toBe(allocationsBefore[0]?.id ?? null);
          const countersBefore = await database`SELECT * FROM grids.document_profile_counters WHERE base_id = ${scope.baseId}::uuid`;
          await migrate(database);
          expect(await readReceipts()).toEqual(before);
          expect((await service.issueDocument(input)).ok).toBe(false);
          expect(await readReceipts()).toEqual(before);
          expect(renderCalls).toBe(2);
          failRender = false;
          const recovered = await service.issueDocument(input);
          if (!recovered.ok) throw recovered.error;
          expect(recovered.data.document.documentNumber).toBe("HIST-1");
          expect(recovered.data.document.shortId).toBe(before[0]?.document_short_id);
          const completed = await readReceipts();
          expect(completed[0]?.id).toBe(before[0]?.id);
          expect(completed[0]?.request_hash).toBe(before[0]?.request_hash);
          expect(completed[0]?.operation_key_hash).toBe(before[0]?.operation_key_hash);
          expect(completed[0]?.frozen_request).toBeNull();
          const allocationsAfter = await readAllocations();
          expect(allocationsAfter.map((allocation) => allocation.id)).toEqual(allocationsBefore.map((allocation) => allocation.id));
          expect(allocationsAfter.map(({ consumer_kind: _kind, consumer_id: _id, ...allocation }) => allocation)).toEqual(
            allocationsBefore.map(({ consumer_kind: _kind, consumer_id: _id, ...allocation }) => allocation),
          );
          if (kind === "html") expect(allocationsAfter[0]?.consumer_id).toBe(recovered.data.document.id);
          expect(await database`SELECT * FROM grids.document_profile_counters WHERE base_id = ${scope.baseId}::uuid`).toEqual(
            countersBefore,
          );
          const replay = await service.issueDocument(input);
          if (!replay.ok) throw replay.error;
          expect(replay.data.replayed).toBe(true);
          expect(replay.data.document.id).toBe(recovered.data.document.id);
          expect(renderCalls).toBe(3);
          await expect(service.issueDocument({ ...input, idempotencyKey: `malformed-${testUuid()}`, tags: ["malformed"] })).rejects.toThrow(
            "Document issuance receipt contains invalid JSON",
          );
          expect(renderCalls).toBe(3);
        }
      } finally {
        await database.close({ timeout: 5 });
        await sql.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      }
    },
    // This case migrates an isolated database repeatedly.
    60_000,
  );

  postgresTest("replays delayed HTML issuance and freezes its real public ID", async () => {
    const scope = await createScope();
    const created = await createTemplate(
      scope.tableId,
      {
        name: "Invoice",
        source: "from table Invoices",
        renderer: {
          kind: "html",
          body: "<p>{{ document.number }}</p>",
          numberTemplate: "DOC-{{ document.id }}-{{ series.value }}",
          filenameTemplate: "{{ document.number }}.pdf",
        },
      },
      null,
    );
    if (!created.ok) throw created.error;
    const service = createDocumentIssuanceService();
    const idempotencyKey = `html-${testUuid()}`;
    const input = inputFor(created.data, scope, {
      idempotencyKey,
      renderPdf: async (document) => ({ ok: true, data: { pdf: pdf(document.filename), contentType: "application/pdf" } }),
    });

    const first = await service.issueDocument(input);
    if (!first.ok) throw first.error;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const replay = await service.issueDocument(input);
    if (!replay.ok) throw replay.error;

    expect(first.data.replayed).toBe(false);
    expect(replay.data.replayed).toBe(true);
    expect(replay.data.document.id).toBe(first.data.document.id);
    expect(first.data.document.documentNumber).toContain(first.data.document.shortId);
    expect(first.data.document.artifacts).toHaveLength(1);
    expect(first.data.document.artifacts[0]?.fileId).toMatch(/^[0-9a-f-]{36}$/);
    const stored = await getDocumentPdf(first.data.document);
    expect(stored.ok).toBe(true);

    const [receipt] = await sql<Array<{ document_short_id: string; frozen_request: unknown; document_id: string }>>`
      SELECT document_short_id, frozen_request, document_id::text
      FROM grids.document_issuances WHERE document_id = ${first.data.document.id}::uuid
    `;
    expect(receipt).toEqual({ document_short_id: first.data.document.shortId, frozen_request: null, document_id: first.data.document.id });

    const large = await service.issueDocument({
      ...input,
      idempotencyKey: `large-${testUuid()}`,
      snapshot: { ...input.snapshot, id: testUuid() },
      renderData: { ...input.renderData, supportedPayload: "x".repeat(5 * 1024 * 1024 + 1) },
    });
    expect(large.ok).toBe(true);

    const invalidJson = await service.issueDocument({
      ...input,
      idempotencyKey: `invalid-json-${testUuid()}`,
      snapshot: { ...input.snapshot, id: testUuid() },
      renderData: { ...input.renderData, unsupported: 1n },
    });
    expect(invalidJson.ok).toBe(false);
    if (!invalidJson.ok) expect(invalidJson.error.code).toBe("BAD_INPUT");
  });

  postgresTest("rejects reuse with changed actor or binding and stores profile artifacts through Files", async () => {
    const scope = await createScope();
    const profile: DocumentProfile<{ title: string; issuedAt: string }> = {
      id: "test.statement",
      version: 1,
      title: "Statement",
      description: "Test profile",
      rendererVersion: "test-renderer-v1",
      validatorVersion: "test-validator-v1",
      primaryArtifact: { key: "pdf", mediaType: "application/pdf" },
      input: z.object({ title: z.string(), issuedAt: z.iso.datetime() }).strict(),
      formatNumber: ({ value }) => `STAT-${value}`,
      issue: (value, context) => ({
        artifacts: [
          { key: "pdf", filename: `${context.number}.pdf`, mediaType: "application/pdf", bytes: pdf(value.title) },
          {
            key: "structured",
            filename: `${context.number}.json`,
            mediaType: "application/json",
            bytes: new TextEncoder().encode(JSON.stringify(value)),
          },
        ],
        validationStatus: "valid",
        validationReport: { valid: true },
      }),
    };
    const template = await insertProfileTemplate(scope.tableId, {
      kind: "profile",
      id: profile.id,
      version: profile.version,
      inputTemplate: '{"title":"Hello","issuedAt":"{{ date.iso }}"}',
    });
    const service = createDocumentIssuanceService({ profiles: [profile] });
    const idempotencyKey = `profile-${testUuid()}`;
    const input = inputFor(template, scope, { idempotencyKey });
    const issued = await service.issueDocument(input);
    if (!issued.ok) throw issued.error;
    expect(issued.data.document.artifacts.map((artifact) => artifact.key)).toEqual(["pdf", "structured"]);
    const structured = await service.getDocumentArtifact(issued.data.document.id, "structured");
    if (!structured.ok) throw structured.error;
    expect(JSON.parse(new TextDecoder().decode(structured.data.bytes)).issuedAt).toBe(issued.data.document.createdAt);

    const profileV2: DocumentProfile<{ title: string; issuedAt: string }> = { ...profile, version: 2 };
    const templateV2 = await insertProfileTemplate(scope.tableId, {
      kind: "profile",
      id: profileV2.id,
      version: profileV2.version,
      inputTemplate: '{"title":"Version 2","issuedAt":"{{ date.iso }}"}',
    });
    const versioned = await createDocumentIssuanceService({ profiles: [profile, profileV2] }).issueDocument(
      inputFor(templateV2, scope, { idempotencyKey: `profile-v2-${testUuid()}` }),
    );
    if (!versioned.ok) throw versioned.error;
    expect(versioned.data.document.documentNumber).toBe("STAT-2");

    const changedActor = await service.issueDocument({ ...input, actor: { kind: "user", userId: testUuid() } });
    expect(changedActor.ok).toBe(false);
    if (!changedActor.ok) expect(changedActor.error.code).toBe("CONFLICT");
    const changedRecordId = testUuid();
    const changedRoot = { ...input.snapshot.root, id: changedRecordId };
    const changedBinding = await service.issueDocument({
      ...input,
      snapshot: {
        ...input.snapshot,
        recordId: changedRecordId,
        root: changedRoot,
        graph: {
          rootId: `${scope.tableId}:${changedRecordId}`,
          records: { [`${scope.tableId}:${changedRecordId}`]: changedRoot },
        },
      },
    });
    expect(changedBinding.ok).toBe(false);
    if (!changedBinding.ok) expect(changedBinding.error.code).toBe("CONFLICT");

    const rows = await sql<Array<{ artifact_key: string; file_id: string; protected: boolean }>>`
      SELECT artifact.artifact_key, artifact.file_id::text,
        EXISTS (
          SELECT 1 FROM grids.file_protected_references protected
          WHERE protected.file_id = artifact.file_id
            AND protected.owner_kind = 'document_artifact'
            AND protected.owner_id = artifact.document_id
        ) AS protected
      FROM grids.document_artifacts artifact
      WHERE artifact.document_id = ${issued.data.document.id}::uuid
      ORDER BY artifact.artifact_key
    `;
    expect(rows.map(({ artifact_key, protected: isProtected }) => [artifact_key, isProtected])).toEqual([
      ["pdf", true],
      ["structured", true],
    ]);

    const corruptFileId = testUuid();
    const corruptBytes = new TextEncoder().encode("corrupt");
    await sql`
      INSERT INTO grids.files (id, short_id, filename, mime_type, size_bytes, sha256, bytes)
      VALUES (${corruptFileId}::uuid, ${testShortId("F")}, 'corrupt.bin', 'application/octet-stream', ${corruptBytes.byteLength}, ${"0".repeat(64)}, ${corruptBytes})
    `;
    await sql`
      INSERT INTO grids.file_protected_references (file_id, owner_kind, owner_id, base_id, table_id, record_id)
      VALUES (${corruptFileId}::uuid, 'document_artifact', ${issued.data.document.id}::uuid, ${scope.baseId}::uuid, ${scope.tableId}::uuid, ${scope.recordId}::uuid)
    `;
    await sql`
      INSERT INTO grids.document_artifacts (document_id, artifact_key, file_id)
      VALUES (${issued.data.document.id}::uuid, 'corrupt', ${corruptFileId}::uuid)
    `;
    const corrupt = await service.getDocumentArtifact(issued.data.document.id, "corrupt");
    expect(corrupt.ok).toBe(false);
    if (!corrupt.ok) expect(corrupt.error.code).toBe("INTERNAL");
  });

  postgresTest("keeps failed receipts frozen and rejects a render/snapshot revision race", async () => {
    const scope = await createScope();
    const created = await createTemplate(
      scope.tableId,
      {
        name: "Retry invoice",
        source: "from table Invoices",
        renderer: {
          kind: "html",
          body: "<p>{{ document.number }}</p>",
          numberTemplate: "RETRY-{{ series.value }}",
          filenameTemplate: "{{ document.number }}.pdf",
        },
      },
      null,
    );
    if (!created.ok) throw created.error;
    const service = createDocumentIssuanceService();
    let failRender = true;
    const input = inputFor(created.data, scope, {
      idempotencyKey: `pending-${testUuid()}`,
      renderPdf: async () => {
        if (failRender) return fail(err.internal("renderer unavailable"));
        return { ok: true, data: { pdf: pdf("recovered"), contentType: "application/pdf" } };
      },
    });
    const failed = await service.issueDocument(input);
    expect(failed.ok).toBe(false);

    const changedActor = await service.issueDocument({ ...input, actor: { kind: "user", userId: testUuid() } });
    expect(changedActor.ok).toBe(false);
    if (!changedActor.ok) expect(changedActor.error.code).toBe("CONFLICT");

    failRender = false;
    const recovered = await service.issueDocument(input);
    expect(recovered.ok).toBe(true);
    if (recovered.ok) expect(recovered.data.document.documentNumber).toBe("RETRY-1");

    const raced = await service.issueDocument({
      ...inputFor(created.data, scope, { idempotencyKey: `race-${testUuid()}` }),
      snapshot: {
        ...input.snapshot,
        id: testUuid(),
        root: { ...input.snapshot.root, version: 2 },
        graph: {
          ...input.snapshot.graph,
          records: {
            [`${scope.tableId}:${scope.recordId}`]: { ...input.snapshot.root, version: 2 },
          },
        },
      },
    });
    expect(raced.ok).toBe(false);
    if (!raced.ok) expect(raced.error.code).toBe("CONFLICT");

    const recordBId = testUuid();
    await sql`
      INSERT INTO grids.records (id, short_id, table_id, data, version, updated_at)
      VALUES (${recordBId}::uuid, ${testShortId("R")}, ${scope.tableId}::uuid, '{"content":"B"}'::jsonb, 1, '2026-08-22T10:00:00.000Z')
    `;
    const recordBRoot = { ...input.snapshot.root, id: recordBId, data: { content: "B" } };
    const crossedBinding = await service.issueDocument({
      ...inputFor(created.data, scope, { idempotencyKey: `crossed-binding-${testUuid()}` }),
      snapshot: {
        ...input.snapshot,
        id: testUuid(),
        recordId: recordBId,
        root: recordBRoot,
        graph: {
          rootId: `${scope.tableId}:${recordBId}`,
          records: { [`${scope.tableId}:${recordBId}`]: recordBRoot },
        },
      },
    });
    expect(crossedBinding.ok).toBe(false);
    if (!crossedBinding.ok) expect(crossedBinding.error.code).toBe("CONFLICT");

    const forgedTemplate = await service.issueDocument(
      inputFor({ ...created.data, source: "from table Forged" }, scope, { idempotencyKey: `forged-template-${testUuid()}` }),
    );
    expect(forgedTemplate.ok).toBe(false);
    if (!forgedTemplate.ok) expect(forgedTemplate.error.code).toBe("CONFLICT");

    await sql`
      UPDATE grids.document_templates
      SET source = 'from table Changed', updated_at = updated_at + interval '1 second'
      WHERE id = ${created.data.id}::uuid
    `;
    const staleTemplate = await service.issueDocument(inputFor(created.data, scope, { idempotencyKey: `stale-template-${testUuid()}` }));
    expect(staleTemplate.ok).toBe(false);
    if (!staleTemplate.ok) expect(staleTemplate.error.code).toBe("CONFLICT");

    const freshTemplate = await getTemplate(created.data.id);
    if (!freshTemplate) throw new Error("updated template missing");
    const staleRecordInput = inputFor(freshTemplate, scope, { idempotencyKey: `stale-record-${testUuid()}` });
    await sql`
      UPDATE grids.records SET version = 2, updated_at = updated_at + interval '1 second'
      WHERE id = ${scope.recordId}::uuid
    `;
    const staleRecord = await service.issueDocument(staleRecordInput);
    expect(staleRecord.ok).toBe(false);
    if (!staleRecord.ok) expect(staleRecord.error.code).toBe("CONFLICT");
  });
});
