import { afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderFacturXHtmlToPdfWithConfig } from "@k2b/cloud/services/pdf";
import type { WorkflowJsonValue } from "@k2b/cloud/workflows";
import { createWorkflowRun } from "@k2b/cloud/workflows/store";
import { dates } from "@k2b/stdlib";
import { extractXml } from "@stackforge-eu/factur-x";
import { sql } from "bun";
import type { DocumentDefaults } from "../contracts";
import { createGermanBillingProfile, germanBillingProfile } from "../document-profiles/einvoice-de";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { parseGridsQueryDsl } from "../query-dsl/parser";
import { previewDslQuery } from "../query-dsl/preview";
import { resolveDslQueryToQueryPlan } from "../query-dsl/resolver";
import { update as updateBase } from "../service/bases";
import { getDocument, getDocumentArtifact, getDocumentPdf } from "../service/documents";
import { buildTrustedGqlResolverContext } from "../service/gql-resolver-context";
import { finalize } from "../service/record-finalization";
import { create, get, softDelete, update } from "../service/records";
import { instantiateDefinition } from "../service/templates";
import { GRIDS_APP_ID, gridsAuthorizationSnapshot } from "../service/workflow-runs";
import { runGridsWorkflowRun } from "../service/workflow-runtime";
import { createBillingTemplate } from "./billing";

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST !== "1") return;
  // Issued evidence is deliberately immutable. The harness drops its isolated
  // database afterward, rather than disabling application evidence protections.
  const [db] = await sql`SELECT current_database() AS name`;
  if (!db.name.startsWith("grids_verify_")) throw new Error("Billing journeys require an isolated grids_verify_ database");
  await migrate();
});

// A journey installs a Base and executes multiple successful and rejected runs.
// This measured end-to-end budget is not a change to query or workflow limits.
const journeyBudget = 180_000;
let activeJourney: Promise<void> | undefined;
const journeyTest = (name: string, run: () => Promise<void>) => postgresTest(name, () => (activeJourney = run()), journeyBudget);

// Bun does not cancel an async callback when its test times out. Wait for its
// finally block to restore the shared renderer before starting another journey.
afterEach(async () => {
  try {
    await activeJourney;
  } catch {
    // The test already reports its assertion or runtime failure.
  } finally {
    activeJourney = undefined;
  }
}, journeyBudget);

const fixture = async () => {
  const started = performance.now();
  const definition = createBillingTemplate("en");
  const installed = await instantiateDefinition(definition, { withSampleData: false }, null, "en");
  if (!installed.ok) throw new Error(installed.error.message);
  console.info(`[billing journey] Install template: ${Math.round(performance.now() - started)}ms`);
  const baseId = installed.data.id;
  const actorId = testUuid();
  await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn)
    VALUES (${actorId}::uuid, ${actorId}, 'local', 'user', 'Billing test', 'Billing', 'Test')`;
  const [access] = await sql`INSERT INTO auth.access (user_id, permission) VALUES (${actorId}::uuid, 'write') RETURNING id`;
  await sql`INSERT INTO grids.base_access (base_id, access_id) VALUES (${baseId}::uuid, ${access.id}::uuid)`;
  const tables = await sql<Array<{ id: string; name: string }>>`SELECT id::text, name FROM grids.tables WHERE base_id = ${baseId}::uuid`;
  const table = async (key: string) => {
    const spec = definition.tables.find((entry) => entry.key === key)!;
    const row = tables.find((entry) => entry.name === spec.name)!;
    const fields = await sql<Array<{ id: string; name: string }>>`SELECT id::text, name FROM grids.fields WHERE table_id = ${row.id}::uuid`;
    const ids = Object.fromEntries(spec.fields.map((entry) => [entry.key, fields.find((candidate) => candidate.name === entry.name)!.id]));
    const values = (data: Record<string, unknown>) => Object.fromEntries(Object.entries(data).map(([key, value]) => [ids[key]!, value]));
    return {
      ...row,
      ids,
      add: async (data: Record<string, unknown>) => {
        const result = await create(row.id, values(data), actorId, "workflow");
        if (!result.ok) throw new Error(result.error.message);
        return result.data;
      },
      edit: async (id: string, data: Record<string, unknown>) => {
        const result = await update(row.id, id, values(data), actorId, "workflow");
        if (!result.ok) throw new Error(result.error.message);
        return result.data;
      },
    };
  };
  const invoke = async (name: string, inputs: Record<string, WorkflowJsonValue>) => {
    const started = performance.now();
    console.info(`[billing journey] ${name}: started`);
    const [workflow] = await sql`SELECT w.id::text, w.active_version_id::text AS version_id FROM grids.workflow_profile p
      JOIN workflows.workflow w ON w.id = p.id WHERE p.base_id = ${baseId}::uuid AND w.name = ${name}`;
    if (!workflow) throw new Error(`Missing authored workflow: ${name}`);
    const runId = await createWorkflowRun({
      appId: GRIDS_APP_ID,
      scopeId: baseId,
      workflowId: workflow.id,
      workflowVersionId: workflow.version_id,
      mode: "execute",
      inputs,
      context: {},
      authorization: gridsAuthorizationSnapshot({ userId: actorId, groupIds: [], serviceAccountId: null }, { kind: "workflow" }, null),
      idempotencyKey: testUuid(),
      occurredAt: new Date(),
    });
    await sql`INSERT INTO grids.workflow_run_profile (run_id, short_id, base_id, workflow_id, channel, actor_user_id, request_fingerprint)
      VALUES (${runId}::uuid, ${testShortId("R")}, ${baseId}::uuid, ${workflow.id}::uuid, 'api', ${actorId}::uuid, ${runId})`;
    for (let attempt = 0; attempt < 30; attempt++) {
      await runGridsWorkflowRun(runId);
      const [run] = await sql`SELECT state, error FROM workflows.run WHERE id = ${runId}::uuid`;
      if (["failed", "succeeded", "needs_attention", "canceled"].includes(run.state)) {
        console.info(`[billing journey] ${name}: ${run.state} in ${Math.round(performance.now() - started)}ms`);
        if (process.env.GRIDS_JOURNEY_TIMINGS === "1") {
          const timings = await sql`SELECT step_key, EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000 AS elapsed_ms
            FROM workflows.step_outcome WHERE run_id = ${runId}::uuid ORDER BY started_at`;
          console.info(`[billing timings] ${name}: ${JSON.stringify(timings)}`);
        }
        return { ...run, runId };
      }
    }
    throw new Error(`Run did not settle: ${runId}`);
  };
  const queryRows = async (source: string) => {
    const parsed = parseGridsQueryDsl(source);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed));
    const context = await buildTrustedGqlResolverContext({ baseId, ast: parsed.ast, purpose: "custom-app-render" });
    const resolved = resolveDslQueryToQueryPlan(parsed.ast, context);
    if (!resolved.ok) throw new Error(JSON.stringify(resolved));
    const result = await previewDslQuery(resolved.plan, {
      fieldsByTableId: context.fieldsByTableId,
      authorizedTableIds: new Set(context.tables.map((table) => table.id)),
      primaryTableAuthorized: true,
    });
    if (!result.ok) throw new Error(result.error.message);
    return result.data.rows.map((row) => ({
      id: row.recordId,
      values: Object.fromEntries(result.data.columns.map((column) => [column.label, row.values[column.key]])),
    }));
  };
  const appRows = async (pageId: string, blockId: string) => {
    const [app] = await sql`SELECT published_definition FROM grids.custom_apps WHERE base_id = ${baseId}::uuid`;
    const source = app.published_definition.pages
      .find((page: { id: string }) => page.id === pageId)
      .rows[0].columns[0].blocks.find((block: { id: string }) => block.id === blockId).source.query;
    return queryRows(source);
  };
  const balanceRows = async () => {
    const name = definition.views!.find((view) => view.key === "balances")!.name;
    const [view] = await sql`SELECT source FROM grids.views WHERE base_id = ${baseId}::uuid AND name = ${name}`;
    return queryRows(view.source);
  };
  let business: DocumentDefaults = {};
  const configureBusiness = async (values: DocumentDefaults) => {
    business = { ...business, ...values };
    const result = await updateBase(baseId, { documentDefaults: business }, actorId);
    if (!result.ok) throw new Error(result.error.message);
  };
  const openBalanceRows = async () =>
    (await Promise.all(["overdue", "upcoming", "credits"].map((group) => appRows("balances", group)))).flat();
  return { baseId, table, invoke, appRows, openBalanceRows, balanceRows, configureBusiness };
};

const ref = (tableId: string, recordId: string): WorkflowJsonValue => ({ kind: "record", tableId, recordId });
const lines = (price: string) => [{ Label1: "Consulting", Unit01: ["C62"], Qty001: "1.0000", Price1: price, Vat001: ["vat019"] }];
const succeeded = (run: { state: unknown; error: unknown }) => expect(run.state, JSON.stringify(run.error)).toBe("succeeded");

const realPdfJourneyTest =
  process.env.GRIDS_DB_TEST === "1" && process.env.GRIDS_PDF_TEST === "1"
    ? journeyTest
    : (name: string, run: () => Promise<void>) => test.skip(name, run, journeyBudget);

realPdfJourneyTest("billing workflows persist real invoice, correction and self-billing PDFs with matching embedded XML", async () => {
  const pdftotext = Bun.which(process.env.PDFTOTEXT ?? "pdftotext");
  if (!pdftotext) throw new Error("Real billing PDF verification requires pdftotext on PATH or PDFTOTEXT");
  const directory = process.env.GRIDS_PDF_REVIEW_DIR ?? (await mkdtemp(join(tmpdir(), "grids-billing-journey-pdf-")));
  const profile = createGermanBillingProfile({
    render: (input) =>
      renderFacturXHtmlToPdfWithConfig(input, {
        url: process.env.GRIDS_PDF_URL ?? "http://localhost:3001",
        timeoutMs: 30_000,
        maxHtmlBytes: 1_000_000,
        maxPdfBytes: 10_000_000,
      }),
  });
  const render = spyOn(germanBillingProfile, "issue").mockImplementation((snapshot, context) => profile.issue(snapshot, context));
  try {
    const f = await fixture();
    const parties = await f.table("parties");
    const bills = await f.table("bills");
    const company = { street: "Test 1", postal_code: "89073", city: "Ulm", iban: "DE89370400440532013000", account_name: "Company" };
    await f.configureBusiness({
      legalName: "Journey issuer",
      vatId: "DE123456789",
      address: company.street,
      postalCode: company.postal_code,
      city: company.city,
      countryCode: "DE",
      iban: company.iban,
      accountName: company.account_name,
    });
    const partner = await parties.add({ ...company, name: "Journey partner", vat_id: "DE987654321" });
    const values = {
      party: [partner.id],
      invoice_date: "2026-09-15",
      service_date: "2026-09-01",
      due_date: "2026-09-28",
      buyer_reference: "Journey order 42",
      positions: lines("100.0000"),
    };
    const invoice = await bills.add({ ...values, kind: ["invoice"] });
    const invoiceRef = ref(bills.id, invoice.id);
    succeeded(await f.invoke("Issue invoice", { bill: invoiceRef }));
    succeeded(await f.invoke("Prepare correction", { bill: invoiceRef }));
    const [correction] = await sql`SELECT id::text FROM grids.records WHERE table_id = ${bills.id}::uuid AND id != ${invoice.id}::uuid`;
    expect(correction).toBeDefined();
    await bills.edit(correction.id, { reason: "Full journey correction", invoice_date: "2026-09-15", due_date: "2026-09-28" });
    succeeded(await f.invoke("Issue correction", { bill: ref(bills.id, correction.id) }));
    const selfBilling = await bills.add({ ...values, kind: ["selfBilling"], agreement: "Journey agreement 42" });
    succeeded(await f.invoke("Issue self-billing", { bill: ref(bills.id, selfBilling.id) }));

    const rows = await sql<Array<{ id: string; record_id: string }>>`
      SELECT id::text, record_id::text FROM grids.documents WHERE base_id = ${f.baseId}::uuid`;
    expect(rows).toHaveLength(3);
    let invoiceNumber = "";
    for (const [recordId, filename, title, typeCode] of [
      [invoice.id, "invoice", "Rechnung", "380"],
      [correction.id, "correction", "Rechnungskorrektur", "381"],
      [selfBilling.id, "self-billing", "Gutschrift (Selbstabrechnung)", "389"],
    ] as const) {
      const row = rows.find((entry) => entry.record_id === recordId);
      if (!row) throw new Error(`Missing ${filename} document`);
      const document = await getDocument(row.id);
      if (!document) throw new Error(`Missing ${filename} metadata`);
      const pdf = await getDocumentPdf(document, "en");
      const structured = await getDocumentArtifact(document.id, "structured", "en");
      if (!pdf.ok) throw new Error(pdf.error.message);
      if (!structured.ok) throw new Error(structured.error.message);
      const xml = new TextDecoder().decode(structured.data.bytes);
      const embedded = await extractXml(pdf.data.pdf);
      expect(embedded.filename.toLowerCase()).toBe("factur-x.xml");
      const normalized = (value: string) => value.trim().replace(/encoding="utf-8"/i, 'encoding="UTF-8"');
      expect(normalized(embedded.xml)).toBe(normalized(xml));
      expect(xml).toContain(`<ram:TypeCode>${typeCode}</ram:TypeCode>`);
      expect(xml).toContain("<ram:GrandTotalAmount>119.00</ram:GrandTotalAmount>");
      const path = join(directory, `${filename}.pdf`);
      await Bun.write(path, pdf.data.pdf);
      if (process.env.GRIDS_PDF_REVIEW_DIR) await Bun.write(join(directory, `${filename}.xml`), structured.data.bytes);
      const extraction = Bun.spawn([pdftotext, "-layout", path, "-"], { stdout: "pipe", stderr: "pipe" });
      const [text, error] = await Promise.all([new Response(extraction.stdout).text(), new Response(extraction.stderr).text()]);
      expect(await extraction.exited, error).toBe(0);
      expect(text).toContain(title);
      expect(text).toContain(document.documentNumber);
      expect(text).toContain("Consulting");
      expect(text).toContain("119,00 EUR");
      expect(text).toContain(company.iban);
      if (filename === "invoice") invoiceNumber = document.documentNumber;
      if (filename === "correction") {
        expect(invoiceNumber).not.toBe("");
        expect(text).toContain(invoiceNumber);
        expect(xml).toContain(invoiceNumber);
      }
      if (filename === "self-billing") {
        expect(text).toContain("Journey agreement 42");
        expect(xml).toContain("Journey agreement 42");
      }
    }
    expect(render).toHaveBeenCalledTimes(3);
    if (process.env.GRIDS_PDF_REVIEW_DIR) console.info(`Billing workflow PDF review files: ${directory}`);
  } finally {
    render.mockRestore();
    if (!process.env.GRIDS_PDF_REVIEW_DIR) await rm(directory, { recursive: true });
  }
});

journeyTest("invoice issuance recovers a renderer outage after finalization without changing its number or frozen data", async () => {
  let rendererAvailable = false;
  let renderAttempts = 0;
  const profile = createGermanBillingProfile({
    render: async ({ xml }) => {
      renderAttempts++;
      if (!rendererAvailable) throw new Error("Billing test PDF renderer unavailable");
      return { pdf: new TextEncoder().encode(`%PDF-TEST\n${xml}`) };
    },
  });
  const render = spyOn(germanBillingProfile, "issue").mockImplementation((snapshot, context) => profile.issue(snapshot, context));
  try {
    const f = await fixture();
    const parties = await f.table("parties");
    const bills = await f.table("bills");
    const address = { street: "Test 1", postal_code: "89073", city: "Ulm" };
    await f.configureBusiness({
      legalName: "Frozen issuer",
      vatId: "DE123456789",
      address: address.street,
      postalCode: address.postal_code,
      city: address.city,
      countryCode: "DE",
      iban: "DE89370400440532013000",
      accountName: "Frozen issuer account",
    });
    const buyer = await parties.add({ ...address, name: "Frozen buyer", vat_id: "DE987654321" });
    const invoice = await bills.add({
      kind: ["invoice"],
      party: [buyer.id],
      invoice_date: "2026-09-14",
      service_date: "2026-09-01",
      due_date: "2026-09-28",
      buyer_reference: "Order 42",
      positions: lines("100.0000"),
    });
    const input = { bill: ref(bills.id, invoice.id) };
    const interrupted = await f.invoke("Issue invoice", input);
    expect(interrupted.state).toBe("failed");
    expect(interrupted.error).toMatchObject({
      code: "WORKFLOW_ACTION_ERROR",
      message: "Billing test PDF renderer unavailable",
      retryable: false,
    });
    expect(renderAttempts).toBe(1);
    const frozen = await get(bills.id, invoice.id);
    expect(frozen?.finalizedAt).not.toBeNull();
    expect(frozen?.data[bills.ids.gross!]).toBe("119");
    const receipts = await sql`SELECT id::text, frozen_request, document_id::text FROM grids.document_issuances
        WHERE base_id = ${f.baseId}::uuid`;
    expect(receipts).toHaveLength(1);
    expect(receipts[0].document_id).toBeNull();
    expect(await sql`SELECT id FROM grids.documents WHERE base_id = ${f.baseId}::uuid`).toHaveLength(0);
    const firstSnapshot = structuredClone(render.mock.calls[0]![0]);
    const firstContext = structuredClone(render.mock.calls[0]![1]);
    expect(firstContext.number).not.toBe("PREVIEW");
    expect(firstContext.number.length).toBeGreaterThan(0);
    await parties.edit(buyer.id, { name: "Changed after outage" });
    await f.configureBusiness({ legalName: "Changed after outage" });
    rendererAvailable = true;
    // The same user action must recover a finalized bill, not require a
    // different draft, a manual status change, or another allocated number.
    succeeded(await f.invoke("Issue invoice", input));
    expect(renderAttempts).toBe(2);
    expect(render.mock.calls[1]![0]).toEqual(firstSnapshot);
    expect(render.mock.calls[1]![1]).toEqual(firstContext);
    const documents = await sql`SELECT id::text, document_number, profile_snapshot, profile_output FROM grids.documents
        WHERE base_id = ${f.baseId}::uuid`;
    expect(documents).toHaveLength(1);
    expect(documents[0].document_number).toBe(firstContext.number);
    expect(documents[0].profile_snapshot).toEqual(firstSnapshot);
    expect(documents[0].profile_output.grossAmount).toBe("119.00");
    const after = await sql`SELECT id::text, frozen_request, document_id::text FROM grids.document_issuances
        WHERE base_id = ${f.baseId}::uuid`;
    expect(after).toHaveLength(1);
    // Completion moves the frozen evidence into the immutable document and
    // clears the receipt's temporary payload while retaining its identity.
    expect(after[0]).toEqual({ id: receipts[0].id, document_id: documents[0].id, frozen_request: null });
    const recovered = await get(bills.id, invoice.id);
    expect(recovered?.finalizedAt).toEqual(frozen?.finalizedAt);
    expect(recovered?.data).toEqual(frozen?.data);
    succeeded(await f.invoke("Issue invoice", input));
    expect(renderAttempts).toBe(2);
    const retrieved = await sql<{ id: string }[]>`SELECT id::text FROM grids.documents WHERE base_id = ${f.baseId}::uuid`;
    expect(retrieved).toEqual([{ id: documents[0].id }]);
  } finally {
    render.mockRestore();
  }
});

journeyTest(
  "self-billing issues direct positions once and retains its frozen document through confirmed partial and full payouts",
  async () => {
    const profile = createGermanBillingProfile({
      render: async ({ xml }) => ({ pdf: new TextEncoder().encode(`%PDF-TEST\n${xml}`) }),
    });
    const render = spyOn(germanBillingProfile, "issue").mockImplementation((snapshot, context) => profile.issue(snapshot, context));
    try {
      const f = await fixture();
      const parties = await f.table("parties");
      const bills = await f.table("bills");
      const company = { street: "Test 1", postal_code: "89073", city: "Ulm", iban: "DE89370400440532013000", account_name: "Company" };
      await f.configureBusiness({
        legalName: "Buyer issuing settlement",
        vatId: "DE123456789",
        address: company.street,
        postalCode: company.postal_code,
        city: company.city,
        countryCode: "DE",
        iban: company.iban,
        accountName: company.account_name,
      });
      const supplier = await parties.add({
        ...company,
        name: "Commission supplier",
        vat_id: "DE987654321",
        account_name: "Supplier account",
      });
      const positions = ["vat007", "vat019"].map((vat) => ({
        Label1: "Commission",
        Unit01: ["C62"],
        Qty001: "1",
        Price1: "10.00",
        Vat001: [vat],
      }));
      const values = {
        kind: ["selfBilling"],
        party: [supplier.id],
        invoice_date: "2026-09-14",
        service_date: "2026-09-01",
        due_date: "2026-09-28",
        buyer_reference: "Settlement 42",
        agreement: "Agreement 42",
        positions,
      };
      const first = await bills.add(values);
      const prepared = await get(bills.id, first.id);
      expect(prepared?.data[bills.ids.positions!]).toMatchObject([
        { Price1: "10.0000", Qty001: "1.0000", Vat001: ["vat007"] },
        { Price1: "10.0000", Qty001: "1.0000", Vat001: ["vat019"] },
      ]);
      expect(prepared?.finalizedAt).toBeNull();
      expect(render).not.toHaveBeenCalled();
      await bills.edit(first.id, { agreement: null });
      const noAgreement = await f.invoke("Issue self-billing", { bill: ref(bills.id, first.id) });
      expect(noAgreement.state).toBe("failed");
      expect(noAgreement.error).toMatchObject({
        message: "Enter the self-billing agreement before issuing this settlement.",
        retryable: false,
      });
      await bills.edit(first.id, { agreement: values.agreement });
      await parties.edit(supplier.id, { iban: null });
      const noBank = await f.invoke("Issue self-billing", { bill: ref(bills.id, first.id) });
      expect(noBank.state).toBe("failed");
      expect(noBank.error).toMatchObject({
        code: "ATOMIC_CHECK_FAILED",
        message: "Add the commission recipient's IBAN and account holder under Business partners before issuing this settlement.",
        retryable: false,
      });
      expect(render).not.toHaveBeenCalled();
      const [unchanged] = await sql`SELECT finalized_at FROM grids.records WHERE id = ${first.id}::uuid`;
      expect(unchanged.finalized_at).toBeNull();
      await parties.edit(supplier.id, { iban: company.iban });
      const input = { bill: ref(bills.id, first.id) };
      const results = await Promise.all([f.invoke("Issue self-billing", input), f.invoke("Issue self-billing", input)]);
      // Both may succeed if one observes the already-finalized bill and retrieves
      // its document. If both observe the draft, the losing atomic check fails.
      expect(
        results.some((run) => run.state === "succeeded"),
        JSON.stringify(results),
      ).toBe(true);
      for (const run of results) {
        expect(["failed", "succeeded"]).toContain(run.state);
        if (run.state === "failed") expect(run.error).toMatchObject({ code: "ATOMIC_CHECK_FAILED", retryable: false });
      }
      const successfulRun = results.find((run) => run.state === "succeeded")!;
      await runGridsWorkflowRun(successfulRun.runId);
      expect(render).toHaveBeenCalledTimes(1);
      const snapshot = render.mock.calls[0]![0];
      expect(snapshot.billing).toEqual({ kind: "selfBilling", agreementReference: "Agreement 42" });
      expect(snapshot.seller.name).toBe("Commission supplier");
      expect(snapshot.buyer.name).toBe("Buyer issuing settlement");
      expect(snapshot.payment.accountName).toBe("Supplier account");
      const issuedDocuments = await sql`SELECT id::text, document_number, profile_snapshot, snapshot_sha256, profile_output
        FROM grids.documents WHERE base_id = ${f.baseId}::uuid`;
      expect(issuedDocuments).toHaveLength(1);
      const document = issuedDocuments[0];
      const artifactBytes = () => sql`SELECT a.artifact_key, f.bytes FROM grids.document_artifacts a
        JOIN grids.files f ON f.id = a.file_id WHERE a.document_id = ${document.id}::uuid ORDER BY a.artifact_key`;
      const originalArtifacts = await artifactBytes();
      expect(originalArtifacts.length).toBeGreaterThan(0);
      expect(document.profile_output.grossAmount).toBe("22.60");
      succeeded(await f.invoke("Issue self-billing", input));
      const retrievedDocuments = await sql`SELECT id::text, document_number, profile_snapshot, snapshot_sha256, profile_output
        FROM grids.documents WHERE base_id = ${f.baseId}::uuid`;
      expect(retrievedDocuments).toEqual(issuedDocuments);
      expect(await artifactBytes()).toEqual(originalArtifacts);
      expect(render).toHaveBeenCalledTimes(1);
      const frozen = await get(bills.id, first.id);
      expect(frozen?.finalizedAt).not.toBeNull();
      for (const origin of ["direct", "form", "workflow"] as const) {
        expect((await update(bills.id, first.id, { [bills.ids.positions!]: lines("999.00") }, null, origin)).ok).toBe(false);
      }
      expect((await softDelete(bills.id, first.id, null, "direct")).ok).toBe(false);
      const [issued] = await sql`SELECT id::text FROM grids.records WHERE table_id = ${bills.id}::uuid AND finalized_at IS NOT NULL`;
      expect((await f.invoke("Discard draft", { bill: ref(bills.id, issued.id) })).state).toBe("failed");
      expect(await get(bills.id, issued.id)).not.toBeNull();
      const payments = await f.table("payments");
      const balance = async () => (await f.balanceRows()).find((row) => row.id === issued.id)?.values;
      expect(await balance()).toMatchObject({ Paid: "0", Corrected: "0", Outstanding: "22.6" });
      const payout = await payments.add({ bill: [issued.id], date: "2026-09-16", amount: "10.00", reference: "Partial payout" });
      expect(await balance()).toMatchObject({ Paid: "0", Corrected: "0", Outstanding: "22.6" });
      succeeded(await f.invoke("Confirm payment", { payment: ref(payments.id, payout.id) }));
      expect((await get(payments.id, payout.id))?.finalizedAt).not.toBeNull();
      expect((await f.invoke("Confirm payment", { payment: ref(payments.id, payout.id) })).state).toBe("failed");
      expect(await balance()).toMatchObject({ Paid: "10", Corrected: "0", Outstanding: "12.6" });
      // An optional reference may be absent when confirming a real payment.
      const remainder = await payments.add({ bill: [issued.id], date: "2026-09-17", amount: "12.60" });
      succeeded(await f.invoke("Confirm payment", { payment: ref(payments.id, remainder.id) }));
      expect((await get(payments.id, remainder.id))?.finalizedAt).not.toBeNull();
      expect(await balance()).toMatchObject({ Paid: "22.6", Corrected: "0", Outstanding: "0" });
      expect((await f.openBalanceRows()).some((row) => row.id === issued.id)).toBe(false);
      expect((await get(bills.id, issued.id))?.data[bills.ids.gross!]).toBe("22.6");
      const documentsAfterPayout = await sql`SELECT id::text, document_number, profile_snapshot, snapshot_sha256, profile_output
        FROM grids.documents WHERE base_id = ${f.baseId}::uuid`;
      expect(documentsAfterPayout).toHaveLength(1);
      expect(documentsAfterPayout[0]).toEqual(document);
      expect(await artifactBytes()).toEqual(originalArtifacts);
      expect((await get(bills.id, first.id))?.data[bills.ids.positions!]).toEqual(frozen?.data[bills.ids.positions!]);
      expect(render).toHaveBeenCalledTimes(1);
    } finally {
      render.mockRestore();
    }
  },
);

for (const scenario of [
  { name: "rounded VAT", roundingCase: true, rates: ["vat019"], gross: "0.07" },
  { name: "19% net", roundingCase: false, rates: ["vat019"], gross: "119.00" },
  { name: "7% net", roundingCase: false, rates: ["vat007"], gross: "107.00" },
  { name: "mixed-rate net", roundingCase: false, rates: ["vat007", "vat019"], gross: "226.00" },
]) {
  const { roundingCase } = scenario;
  const scenarioLines = (price: string) => scenario.rates.flatMap((rate) => lines(price).map((line) => ({ ...line, Vat001: [rate] })));
  journeyTest(
    `billing actual invoice and ${roundingCase ? "complete residual" : "competing"} corrections respect ${scenario.name} capacity`,
    async () => {
      // Keep real profile input checks, amounts and XML generation.
      // The renderer release test owns XSD and actual PDF attachment checks.
      const profile = createGermanBillingProfile({
        render: async ({ xml }) => ({ pdf: new TextEncoder().encode(`%PDF-TEST\n${xml}`) }),
      });
      const render = spyOn(germanBillingProfile, "issue").mockImplementation((snapshot, context) => profile.issue(snapshot, context));
      try {
        const f = await fixture();
        const parties = await f.table("parties");
        const bills = await f.table("bills");
        const company = { street: "Test 1", postal_code: "89073", city: "Ulm", iban: "DE89370400440532013000", account_name: "Company" };
        await f.configureBusiness({
          legalName: "Issuer",
          vatId: "DE123456789",
          address: company.street,
          postalCode: company.postal_code,
          city: company.city,
          countryCode: "DE",
          iban: company.iban,
          accountName: company.account_name,
        });
        // Outgoing invoices do not need the buyer's bank account.
        const buyer = await parties.add({
          ...company,
          name: "Original buyer",
          vat_id: "DE987654321",
          iban: roundingCase ? company.iban : null,
          account_name: roundingCase ? "Refund account" : null,
        });
        const invoice = await bills.add({
          kind: ["invoice"],
          party: [buyer.id],
          invoice_date: "2026-09-14",
          service_date: "2026-09-01",
          due_date: "2026-09-28",
          buyer_reference: "Order 42",
          positions: scenarioLines(roundingCase ? "0.0600" : "100.0000"),
        });
        const invoiceRef = ref(bills.id, invoice.id);
        succeeded(await f.invoke("Issue invoice", { bill: invoiceRef }));
        if (!roundingCase) succeeded(await f.invoke("Issue invoice", { bill: invoiceRef }));
        const originals =
          await sql`SELECT id, document_number AS number, profile_output FROM grids.documents WHERE base_id = ${f.baseId}::uuid`;
        expect(originals).toHaveLength(1);
        expect(originals[0].profile_output.grossAmount).toBe(scenario.gross);
        expect(render).toHaveBeenCalledTimes(1);
        if (!roundingCase) {
          await parties.edit(buyer.id, { name: "Renamed buyer" });
          await f.configureBusiness({ legalName: "Renamed issuer" });
        }
        for (let index = 0; index < (roundingCase ? 1 : 2); index++) succeeded(await f.invoke("Prepare correction", { bill: invoiceRef }));
        const credits = await sql<
          Array<{ id: string }>
        >`SELECT id::text FROM grids.records WHERE table_id = ${bills.id}::uuid AND id != ${invoice.id}::uuid ORDER BY created_at`;
        expect(credits).toHaveLength(roundingCase ? 1 : 2);
        for (const credit of credits) {
          const before = await get(bills.id, credit.id);
          expect(before?.data[bills.ids.original_number!]).toBe(originals[0].number);
          expect(before?.data[bills.ids.original_company!]).toMatchObject({ legalName: "Issuer", countryCode: "DE" });
          expect(before?.data[bills.ids.invoice_date!]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          expect(before?.data[bills.ids.invoice_date!]).not.toBe("2026-01-15");
          expect(before?.data[bills.ids.due_date!] ?? null).toBeNull();
          expect(before?.data[bills.ids.positions!]).toBeArray();
          await bills.edit(credit.id, {
            positions: scenarioLines(roundingCase ? "0.0300" : "60.0000"),
            invoice_date: "2026-09-15",
            due_date: "2026-09-15",
            reason: "Partial refund",
            original_company: { legalName: "Forged draft issuer", countryCode: "FR" },
          });
        }
        if (!roundingCase) {
          const missingBank = await f.invoke("Issue correction", { bill: ref(bills.id, credits[0]!.id) });
          expect(missingBank.state).toBe("failed");
          expect(missingBank.error).toMatchObject({ code: "ATOMIC_CHECK_FAILED", retryable: false });
          expect(missingBank.error.message).toContain("IBAN");
          const [stillDraft] = await sql`SELECT finalized_at FROM grids.records WHERE id = ${credits[0]!.id}::uuid`;
          expect(stillDraft.finalized_at).toBeNull();
          await parties.edit(buyer.id, { iban: company.iban, account_name: "Refund account" });
        }
        if (roundingCase) {
          // Two 0.03 corrections each round VAT to 0.01, but the original has
          // only 0.01 VAT in total. Reject the first unsafe split, not the last.
          const split = await f.invoke("Issue correction", { bill: ref(bills.id, credits[0]!.id) });
          expect(split.state).toBe("failed");
          expect(split.error).toMatchObject({
            code: "ATOMIC_CHECK_FAILED",
            retryable: false,
            message: expect.stringContaining("rounding difference"),
          });
          expect(render).toHaveBeenCalledTimes(1);
          const [rejectedDraft] = await sql`SELECT finalized_at FROM grids.records WHERE id = ${credits[0]!.id}::uuid`;
          expect(rejectedDraft.finalized_at).toBeNull();
          for (const credit of credits) await bills.edit(credit.id, { positions: scenarioLines("0.0400") });
        }
        const results = await Promise.all(credits.map((credit) => f.invoke("Issue correction", { bill: ref(bills.id, credit.id) })));
        expect(results.map((run) => run.state).sort(), JSON.stringify(results)).toEqual(
          roundingCase ? ["succeeded"] : ["failed", "succeeded"],
        );
        if (!roundingCase)
          expect(results.find((run) => run.state === "failed")?.error).toMatchObject({
            code: "ATOMIC_CHECK_FAILED",
            retryable: false,
          });
        const [count] =
          await sql`SELECT count(*)::int AS value FROM grids.records WHERE table_id = ${bills.id}::uuid AND finalized_at IS NOT NULL`;
        expect(count.value).toBe(2);
        const documents =
          await sql`SELECT document_number AS number, render_data, profile_output FROM grids.documents WHERE base_id = ${f.baseId}::uuid ORDER BY created_at`;
        expect(documents).toHaveLength(2);
        expect(render).toHaveBeenCalledTimes(2);
        // Check the exact values that reached the real profile, not mutable live labels.
        const snapshot = render.mock.calls[1]![0];
        expect(snapshot.seller.name).toBe("Issuer");
        expect(snapshot.buyer.name).toBe("Original buyer");
        expect(snapshot.payment.accountName).toBe("Refund account");
        expect(snapshot.billing).toMatchObject({
          kind: "creditNote",
          original: { number: originals[0].number, invoiceDate: "2026-09-14" },
        });
        if (roundingCase) {
          succeeded(await f.invoke("Prepare correction", { bill: invoiceRef }));
          const [remaining] = await sql<
            Array<{ id: string }>
          >`SELECT id::text FROM grids.records WHERE table_id = ${bills.id}::uuid AND finalized_at IS NULL`;
          expect(remaining).toBeDefined();
          await bills.edit(remaining!.id, {
            positions: scenarioLines("0.0200"),
            invoice_date: "2026-09-15",
            due_date: "2026-09-15",
            reason: "Remaining refund",
          });
          succeeded(await f.invoke("Issue correction", { bill: ref(bills.id, remaining!.id) }));
          const totals = await sql<
            Array<{ profile_output: { netAmount: string; taxAmount: string; grossAmount: string } }>
          >`SELECT profile_output FROM grids.documents WHERE base_id = ${f.baseId}::uuid ORDER BY created_at`;
          expect(
            totals.map((entry) => [entry.profile_output.netAmount, entry.profile_output.taxAmount, entry.profile_output.grossAmount]),
          ).toEqual([
            ["0.06", "0.01", "0.07"],
            ["0.04", "0.01", "0.05"],
            ["0.02", "0.00", "0.02"],
          ]);
          expect(render).toHaveBeenCalledTimes(3);
        }
        if (scenario.name === "19% net") {
          const payments = await f.table("payments");
          const first = await payments.add({ bill: [invoice.id], date: "2026-09-16", amount: "10.00", reference: "Transfer A" });
          const second = await payments.add({ bill: [invoice.id], date: "2026-09-16", amount: "10.00", reference: "Transfer B" });
          const balance = async () => (await f.balanceRows()).find((row) => row.id === invoice.id)?.values;
          // Equal payments are distinct transactions. Draft corrections do not
          // consume credit, and multiple payments cannot multiply credit totals.
          expect(await balance()).toMatchObject({ Paid: "0", Corrected: "71.4", Outstanding: "47.6" });
          await payments.edit(first.id, { amount: "15.00" });
          succeeded(await f.invoke("Confirm payment", { payment: ref(payments.id, first.id) }));
          succeeded(await f.invoke("Confirm payment", { payment: ref(payments.id, second.id) }));
          expect(await balance()).toMatchObject({ Paid: "25", Corrected: "71.4", Outstanding: "22.6" });
          const overpayment = await payments.add({ bill: [invoice.id], date: "2026-09-16", amount: "100.00" });
          succeeded(await f.invoke("Confirm payment", { payment: ref(payments.id, overpayment.id) }));
          expect(await balance()).toMatchObject({ Paid: "125", Outstanding: "-77.4" });
          expect((await f.openBalanceRows()).find((row) => row.id === invoice.id)?.values).toMatchObject({
            Outstanding: "-77.4",
          });
          const refund = await payments.add({ bill: [invoice.id], date: "2026-09-17", amount: "60.00", refund: true });
          succeeded(await f.invoke("Confirm payment", { payment: ref(payments.id, refund.id) }));
          expect(await balance()).toMatchObject({ Paid: "65", Outstanding: "-17.4" });
          const contenders = await Promise.all(
            [1, 2].map((index) =>
              payments.add({ bill: [invoice.id], date: "2026-09-17", amount: "17.40", refund: true, reference: `Refund ${index}` }),
            ),
          );
          const results = await Promise.all(
            contenders.map((payment) => f.invoke("Confirm payment", { payment: ref(payments.id, payment.id) })),
          );
          expect(results.filter((result) => result.state === "succeeded")).toHaveLength(1);
          expect(results.filter((result) => result.state === "failed")).toHaveLength(1);
          expect(await balance()).toMatchObject({ Paid: "47.6", Corrected: "71.4", Outstanding: "0" });
          expect((await f.openBalanceRows()).some((row) => row.id === invoice.id)).toBe(false);
          const pendingRefund = contenders.find((_, index) => results[index]?.state === "failed")!;
          succeeded(await f.invoke("Discard pending payment", { payment: ref(payments.id, pendingRefund.id) }));
          expect(await get(payments.id, pendingRefund.id)).toBeNull();
          expect((await f.invoke("Discard pending payment", { payment: ref(payments.id, refund.id) })).state).toBe("failed");
          for (const origin of ["direct", "form", "workflow"] as const) {
            expect((await update(payments.id, first.id, { [payments.ids.amount!]: "999.00" }, null, origin)).ok).toBe(false);
            expect((await update(payments.id, first.id, { [payments.ids.bill!]: [credits[0]!.id] }, null, origin)).ok).toBe(false);
          }
          expect((await softDelete(payments.id, first.id, null, "direct")).ok).toBe(false);
          const [unissued] = await sql`SELECT id::text FROM grids.records WHERE table_id = ${bills.id}::uuid AND finalized_at IS NULL`;
          expect(unissued).toBeDefined();
          const pending = await payments.add({ bill: [unissued.id], date: "2026-09-16", amount: "7.00" });
          expect((await f.invoke("Confirm payment", { payment: ref(payments.id, pending.id) })).state).toBe("failed");
          expect((await get(payments.id, pending.id))?.finalizedAt).toBeNull();
          expect((await finalize({ tableId: payments.id, recordId: pending.id, actorId: null, origin: "direct" })).ok).toBe(false);
          expect((await f.appRows("balances", "pending-payments")).some((row) => row.id === pending.id)).toBe(true);
          expect(await balance()).toMatchObject({ Paid: "47.6", Corrected: "71.4", Outstanding: "0" });
          expect((await f.openBalanceRows()).some((row) => row.id === invoice.id)).toBe(false);
          expect((await get(bills.id, invoice.id))?.data[bills.ids.gross!]).toBe("119");
          expect(render).toHaveBeenCalledTimes(2);
        }
      } finally {
        render.mockRestore();
      }
      // The residual journey performs six real workflow runs and three profile
      // issuances, including XML validation, after installing the complete app.
      // Measured phases alone exceed 60s on a busy development host. Keep their
      // individual timings visible instead of removing the final residual proof.
    },
  );
}

journeyTest("billing worklists classify live payments by date and credit without changing invoices", async () => {
  const f = await fixture();
  const bills = await f.table("bills");
  const parties = await f.table("parties");
  const payments = await f.table("payments");
  const partner = await parties.add({ name: "Worklist customer" });
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const add = async (due: string, kind = "invoice", final = true) => {
    const bill = await bills.add({
      kind: [kind],
      party: [partner.id],
      invoice_date: yesterday,
      service_date: yesterday,
      due_date: due,
      buyer_reference: "New order",
      positions: lines("100.0000"),
    });
    if (final) expect((await finalize({ tableId: bills.id, recordId: bill.id, actorId: null, origin: "workflow" })).ok).toBe(true);
    return bill;
  };
  const overdue = await add(yesterday);
  const dueToday = await add(today);
  const future = await add(tomorrow);
  const settled = await add(yesterday);
  const credit = await add(yesterday);
  const commission = await add(tomorrow, "selfBilling");
  await add(yesterday, "creditNote");
  await add(yesterday, "invoice", false);
  const pay = async (bill: string, amount: string, confirm = true) => {
    const row = await payments.add({ bill: [bill], date: today, amount });
    if (confirm) succeeded(await f.invoke("Confirm payment", { payment: ref(payments.id, row.id) }));
  };
  await pay(overdue.id, "19.00");
  await pay(overdue.id, "100.00", false);
  await pay(settled.id, "119.00");
  await pay(credit.id, "130.00");
  const rows = async (group: string) => f.appRows("balances", group);
  expect((await rows("overdue")).map((row) => row.id)).toEqual([overdue.id]);
  expect((await rows("overdue"))[0]!.values.Outstanding).toBe("100");
  expect(new Set((await rows("upcoming")).map((row) => row.id))).toEqual(new Set([dueToday.id, future.id, commission.id]));
  expect((await rows("credits")).map((row) => row.id)).toEqual([credit.id]);
  expect((await rows("credits"))[0]!.values.Outstanding).toBe("-11");
  expect((await get(bills.id, overdue.id))?.data[bills.ids.gross!]).toBe("119");
});

journeyTest("billing reuses only invoice inputs in a fresh draft and rejects other source kinds", async () => {
  const f = await fixture();
  const bills = await f.table("bills");
  const parties = await f.table("parties");
  const partner = await parties.add({ name: "Original customer" });
  const anotherPartner = await parties.add({ name: "Other customer" });
  expect(partner.data[parties.ids.number!]).toBe("KD-00001");
  expect(anotherPartner.data[parties.ids.number!]).toBe("KD-00002");
  expect((await update(parties.id, partner.id, { [parties.ids.number!]: "KD-99999" }, null, "workflow")).ok).toBe(false);

  const original = await bills.add({
    kind: ["invoice"],
    party: [partner.id],
    invoice_date: "2025-01-01",
    service_date: "2025-01-01",
    due_date: "2025-01-15",
    buyer_reference: "Order 1",
    positions: lines("100.0000"),
    notes: "Private original note",
  });
  const inputs = { bill: ref(bills.id, original.id) };
  expect((await f.invoke("Use as new invoice", inputs)).state).toBe("failed");
  expect((await finalize({ tableId: bills.id, recordId: original.id, actorId: null, origin: "workflow" })).ok).toBe(true);
  const frozen = await get(bills.id, original.id);
  await parties.edit(partner.id, { name: "Current customer" });
  const invoiceDateBeforeRun = dates.formatDateKey(new Date(), { timeZone: "Europe/Berlin" });
  const run = await f.invoke("Use as new invoice", inputs);
  const invoiceDateAfterRun = dates.formatDateKey(new Date(), { timeZone: "Europe/Berlin" });
  succeeded(run);
  // Replaying a completed run must not create another draft.
  await runGridsWorkflowRun(run.runId);
  const drafts = await sql<
    Array<{ id: string }>
  >`SELECT id::text FROM grids.records WHERE table_id = ${bills.id}::uuid AND finalized_at IS NULL`;
  expect(drafts).toHaveLength(1);
  const copy = (await get(bills.id, drafts[0]!.id))!;
  expect(copy.finalizedAt).toBeNull();
  expect(copy.data[bills.ids.kind!]).toEqual(["invoice"]);
  expect(copy.data[bills.ids.party!]).toEqual([partner.id]);
  expect(copy.data[bills.ids.party_name!]).toBe("Current customer");
  expect(copy.data[bills.ids.positions!]).toEqual(frozen!.data[bills.ids.positions!]);
  expect(copy.data[bills.ids.buyer_reference!]).toBe("Order 1");
  expect([invoiceDateBeforeRun, invoiceDateAfterRun]).toContain(String(copy.data[bills.ids.invoice_date!]).slice(0, 10));
  expect(copy.data[bills.ids.service_date!] ?? null).toBeNull();
  expect(copy.data[bills.ids.due_date!] ?? null).toBeNull();
  expect((await f.invoke("Issue invoice", { bill: ref(bills.id, copy.id) })).state).toBe("failed");
  expect((await get(bills.id, copy.id))?.finalizedAt).toBeNull();
  expect(copy.data[bills.ids.reference!]).not.toBe(frozen!.data[bills.ids.reference!]);
  for (const key of ["original_company", "original_number", "original_date", "notes", "reason", "agreement"]) {
    expect(copy.data[bills.ids[key]!] ?? null).toBeNull();
  }
  expect(copy.data[bills.ids.original!]).toEqual([]);
  expect(copy.data[bills.ids.party_number!]).toBe(partner.data[parties.ids.number!]);
  expect(await get(bills.id, original.id)).toEqual(frozen);
  expect(await sql`SELECT id FROM grids.documents WHERE base_id = ${f.baseId}::uuid`).toHaveLength(0);
  for (const kind of ["creditNote", "selfBilling"]) {
    const other = await bills.add({
      kind: [kind],
      party: [partner.id],
      service_date: "2026-09-17",
      buyer_reference: "No reuse",
      positions: lines("1.0000"),
    });
    expect((await finalize({ tableId: bills.id, recordId: other.id, actorId: null, origin: "workflow" })).ok).toBe(true);
    expect((await f.invoke("Use as new invoice", { ...inputs, bill: ref(bills.id, other.id) })).state).toBe("failed");
  }
});
