import assert from "node:assert/strict";
import { loadavg } from "node:os";
import { join } from "node:path";
import { bindProcessSync, unbindProcessSync } from "@k2b/cloud";
import { set as setSetting } from "@k2b/cloud/services/settings";
import { createSync } from "@k2b/sync";
import { connect } from "@nats-io/transport-node";
import { sql } from "bun";
import { app } from "../src/config";
import type { GqlRuntimeTraceEnd } from "../src/api/gql-observability";
import { executeGqlSourceForContext } from "../src/api/gql-runtime";
import { readDocumentArtifact } from "../src/service/document-issuance";
import { create } from "../src/service/records";
import { update as updateBase } from "../src/service/bases";
import { refreshLocalCalculations } from "../src/service/local-calculation-storage";
import { instantiateDefinition } from "../src/service/templates";
import { invokeGridsWorkflow, startWorkflowRuntime, stopWorkflowRuntime } from "../src/service/workflow-runtime";
import { createBillingTemplate } from "../src/templates/billing";
import { createInventoryTemplate } from "../src/templates/inventory";
import type { GridTemplate } from "../src/templates/types";
import { type DiagnosticReport, type DiagnosticSample, writeDiagnosticReport } from "./diagnostics-report";
import { localVerificationUrl } from "./verification";

const db = localVerificationUrl("PostgreSQL", process.env.DATABASE_URL);
assert.match(db.pathname, /^\/grids_verify_[a-f0-9]{32}$/);
const directory = process.env.GRIDS_DIAGNOSTICS_REPORT;
assert(directory, "Run diagnostics.ts, not its worker directly");
const pdfUrl = localVerificationUrl("Gotenberg", process.env.GRIDS_PDF_URL);
const report: DiagnosticReport = {
  environment: await Bun.file(join(directory, "environment.json")).json(),
  samples: [],
  status: "running",
};
const save = () => writeDiagnosticReport(directory, report);
const must = <T>(result: { ok: true; data: T } | { ok: false; error: { message: string } }): T => {
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
};
const namespace = process.env.GRIDS_DIAGNOSTICS_NAMESPACE;
assert(namespace && namespace.startsWith("grids-diagnostics-"));
const connection = await connect({
  servers: localVerificationUrl("NATS", process.env.SYNC_TEST_SERVERS).toString(),
  ignoreClusterUpdates: true,
});
const sync = createSync({ connection, namespace, application: "grids", defaults: { replicas: 1 } });
bindProcessSync(sync);
let started = 0;
let runtimeStarted = false;
const originalFetch = globalThis.fetch;
const pdfRequests: Array<{ path: string; ms: number }> = [];
let onPdfRequest: (() => void) | undefined;
// Observe the real renderer transport inside this disposable process. No
// response substitution, extra request, or production instrumentation.
globalThis.fetch = Object.assign(
  async (...args: Parameters<typeof fetch>) => {
    const url = new URL(args[0] instanceof Request ? args[0].url : args[0].toString());
    const track = url.origin === pdfUrl.origin && url.pathname.startsWith("/forms/");
    if (track) onPdfRequest?.();
    const begin = performance.now();
    const response = await originalFetch(...args);
    if (track) pdfRequests.push({ path: url.pathname, ms: performance.now() - begin });
    return response;
  },
  { preconnect: originalFetch.preconnect },
);

try {
  report.environment.workflowConcurrency = await app.settings.get("grids.workflow_concurrency");
  await setSetting("gotenberg.url", pdfUrl.toString());
  await setSetting("gotenberg.timeout_ms", 30_000);
  const [actor] = await sql<Array<{ id: string }>>`SELECT id::text FROM auth.users LIMIT 1`;
  assert(actor);
  const actorId = actor.id;
  const principal = { userId: actorId, groupIds: [], serviceAccountId: null };
  const runtime = {
    access: { actor: undefined, accessSubject: { type: "user" as const, userId: actorId } },
    dateConfig: { locale: "en", timeZone: "UTC" },
    signal: new AbortController().signal,
  };
  const install = async (definition: GridTemplate) => {
    const base = must(await instantiateDefinition(definition, { withSampleData: false }, actorId, "en"));
    const tables = await sql<
      Array<{ id: string; short_id: string; name: string }>
    >`SELECT id::text, short_id, name FROM grids.tables WHERE base_id = ${base.id}::uuid`;
    const resolve = async (key: string) => {
      const spec = definition.tables.find((table) => table.key === key);
      assert(spec, key);
      const table = tables.find((table) => table.name === spec.name);
      assert(table, key);
      const fields = await sql<
        Array<{ id: string; short_id: string; name: string }>
      >`SELECT id::text, short_id, name FROM grids.fields WHERE table_id = ${table.id}::uuid`;
      const field = (key: string) => {
        const entry = spec.fields.find((entry) => entry.key === key);
        const result = fields.find((field) => field.name === entry?.name);
        assert(result, `Unknown field ${key}`);
        return result;
      };
      return {
        ...table,
        field,
        values: (input: Record<string, unknown>) => Object.fromEntries(Object.entries(input).map(([key, value]) => [field(key).id, value])),
      };
    };
    const workflow = async (key: string) => {
      const spec = definition.workflows?.find((workflow) => workflow.key === key);
      assert(spec, key);
      const [row] = await sql<
        Array<{ id: string }>
      >`SELECT w.id::text FROM workflows.workflow w JOIN grids.workflow_profile p ON p.id = w.id WHERE p.base_id = ${base.id}::uuid AND w.name = ${spec.name}`;
      assert(row, key);
      return row.id;
    };
    return { base, resolve, workflow };
  };
  const inventory = await install(createInventoryTemplate("en"));
  const items = await inventory.resolve("items"),
    categories = await inventory.resolve("categories");
  const loans = await inventory.resolve("loans"),
    positions = await inventory.resolve("loan_positions");
  const category = must(await create(categories.id, categories.values({ name: "Diagnostic category" }), actorId, "workflow"));
  const seed = async (first: number, last: number) => {
    await sql`INSERT INTO grids.records (id, short_id, table_id, data)
      SELECT gen_random_uuid(), 'D' || lpad(i::text, 5, '0'), ${items.id}::uuid,
      jsonb_build_object(${items.field("asset_id").id}::text, 'DIAG-' || i::text,
      ${items.field("name").id}::text, 'Diagnostic item ' || lpad(i::text, 5, '0'),
      ${items.field("status").id}::text, jsonb_build_array('available'),
      ${items.field("condition").id}::text, jsonb_build_array('good'),
      ${items.field("quantity").id}::text, '1', ${items.field("replacement_value").id}::text, '10.00')
      FROM generate_series(${first}, ${last}) i`;
    await sql`INSERT INTO grids.record_links (from_record_id, from_field_id, to_record_id, position)
      SELECT id, ${items.field("category").id}::uuid, ${category.id}::uuid, 0 FROM grids.records
      WHERE table_id = ${items.id}::uuid AND short_id BETWEEN ${`D${String(first).padStart(5, "0")}`} AND ${`D${String(last).padStart(5, "0")}`}`;
    // Bulk fixture inserts bypass record writes; populate their stored formulas before measuring reads.
    await refreshLocalCalculations(sql, items.id);
    await sql`ANALYZE grids.records`;
    await sql`ANALYZE grids.record_links`;
  };
  await seed(1, 100);
  const selectedItems = await sql<
    Array<{ id: string }>
  >`SELECT id::text FROM grids.records WHERE table_id = ${items.id}::uuid ORDER BY short_id LIMIT 6`;
  const kits = await inventory.resolve("kits");
  const kit = must(
    await create(
      kits.id,
      kits.values({
        name: "Diagnostic kit",
        items: selectedItems.map((item) => item.id),
        category: [category.id],
        status: ["available"],
        requestable: true,
      }),
      actorId,
      "workflow",
    ),
  );
  const loan = must(
    await create(
      loans.id,
      loans.values({
        requester_name: "Diagnostic borrower",
        requester_email: "diagnostic@example.test",
        kits: [kit.id],
        agreement_sent: ["ready"],
        start_date: "2026-09-01",
        due_date: "2026-09-30",
        status: ["active"],
      }),
      actorId,
      "workflow",
    ),
  );
  const positionRecords: Array<{ id: string; shortId: string }> = [];
  for (const item of selectedItems)
    positionRecords.push(
      must(await create(positions.id, positions.values({ loan: [loan.id], item: [item.id], status: ["planned"] }), actorId, "workflow")),
    );
  const issuePosition = await inventory.workflow("issue_position");

  const billing = await install(createBillingTemplate("en"));
  const parties = await billing.resolve("parties"),
    bills = await billing.resolve("bills");
  const address = { street: "Test 1", postal_code: "89073", city: "Ulm", iban: "DE89370400440532013000", account_name: "Company" };
  must(await updateBase(billing.base.id, {
    documentDefaults: {
      legalName: "Diagnostic issuer",
      vatId: "DE123456789",
      address: address.street,
      postalCode: address.postal_code,
      city: address.city,
      countryCode: "DE",
      iban: address.iban,
      accountName: address.account_name,
    },
  }, actorId));
  const party = must(
    await create(parties.id, parties.values({ ...address, name: "Diagnostic buyer", vat_id: "DE987654321" }), actorId, "workflow"),
  );
  const invoices = [];
  for (let i = 0; i < 3; i++)
    invoices.push(
      must(
        await create(
          bills.id,
          bills.values({
            kind: ["invoice"],
            party: [party.id],
            invoice_date: "2026-09-16",
            service_date: "2026-09-01",
            due_date: "2026-09-30",
            buyer_reference: `DIAG-${i}`,
            positions: [{ Label1: "Diagnostic service", Unit01: ["C62"], Qty001: "2", Price1: "19.99", Vat001: ["vat007"] }],
          }),
          actorId,
          "workflow",
        ),
      ),
    );
  const issueInvoice = await billing.workflow("issue_invoice");

  const field = (key: string) => `{${items.field(key).short_id}}`;
  const queries = [
    {
      name: "GQL Liste",
      source: `from table {${items.short_id}}\nselect ${field("name")} as export_name\nwhere ${field("status")} = 'Available'\nsort ${field("name")} asc\nlimit 50`,
    },
    {
      name: "GQL Relation + Formel",
      source: `from table {${items.short_id}}\nleft join table {${categories.short_id}} as category on ${field("category")} = category.id\nselect ${field("name")} as export_name, category.{${categories.field("name").short_id}} as export_category, ${field("total_value")} as export_total\nsort ${field("name")} asc\nlimit 50`,
    },
    {
      name: "GQL Gruppierung",
      source: `from table {${items.short_id}}\ngroup by ${field("status")}\naggregate count(*) as rows, sum(${field("replacement_value")}) as value`,
    },
  ];
  const query = async (index: number, rows: number, warmup = false, suffix = "") => {
    const spec = queries[index]!;
    let timings: NonNullable<GqlRuntimeTraceEnd["timings"]> = {};
    const begin = performance.now();
    const result = await executeGqlSourceForContext(
      runtime,
      inventory.base.id,
      { query: spec.source, surface: "api", limit: 50 },
      {
        operation: "execute",
        tracer: async () => ({
          end: async (event) => {
            timings = event.timings ?? {};
          },
        }),
      },
    );
    const totalMs = performance.now() - begin;
    assert(result.ok, JSON.stringify(result));
    assert(result.response.ok, JSON.stringify(result.response));
    const columns = result.response.columns;
    const output = result.response.rows.map((row) => Object.fromEntries(columns.map((column) => [column.label, row.values[column.key]])));
    assert.equal(output.length, index === 2 ? 1 : 50);
    if (index === 2) {
      assert.equal(Number(output[0]?.rows), rows);
      assert.equal(Number(output[0]?.value), rows * 10);
    } else {
      assert.equal(output[0]?.export_name, "Diagnostic item 00001");
      if (index === 1) {
        assert.equal(output[0]?.export_category, "Diagnostic category");
        assert.equal(Number(output[0]?.export_total), 10);
      }
    }
    const sample: DiagnosticSample = { scenario: spec.name + suffix, rows, warmup, totalMs, timings, resultRows: output.length };
    report.samples.push(sample);
    await save();
    return sample;
  };
  // Check compilation and result contracts before the measured window.
  for (let i = 0; i < queries.length; i++) await query(i, 100, true);
  await startWorkflowRuntime();
  runtimeStarted = true;
  started = performance.now();
  process.send?.("measuring");
  for (const size of [100, 1000]) {
    if (size === 1000) await seed(101, 1000);
    for (let i = 0; i < queries.length; i++) {
      await query(i, size, true);
      for (let sample = 0; sample < 5; sample++) await query(i, size);
    }
  }
  const workflow = async (scenario: string, workflowId: string, inputs: Record<string, string>) => {
    const begin = performance.now();
    const receipt = must(
      await invokeGridsWorkflow({
        workflowId,
        mode: "execute",
        channel: "api",
        inputs,
        idempotencyKey: crypto.randomUUID(),
        principal,
        context: { locale: "en" },
      }),
    );
    const admissionMs = performance.now() - begin;
    const deadline = performance.now() + 60_000;
    while (true) {
      const [run] = await sql<Array<{ state: string; error: unknown; queue_ms: number; execution_ms: number }>>`SELECT state, error,
        EXTRACT(EPOCH FROM (started_at - created_at)) * 1000 AS queue_ms,
        EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000 AS execution_ms
        FROM workflows.run WHERE id = ${receipt.runId}::uuid`;
      assert(run);
      if (["succeeded", "failed", "needs_attention", "canceled"].includes(run.state)) {
        assert.equal(run.state, "succeeded", JSON.stringify(run.error));
        const steps = await sql<
          Array<{ step_key: string; action: string | null; ms: number }>
        >`SELECT step_key, action, EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000 AS ms FROM workflows.step_outcome WHERE run_id = ${receipt.runId}::uuid ORDER BY step_key`;
        const timings = {
          admissionMs,
          queueMs: Number(run.queue_ms),
          executionMs: Number(run.execution_ms),
          ...Object.fromEntries(steps.map((step) => [`${step.step_key}:${step.action ?? "control"}`, Number(step.ms)])),
        };
        const sample: DiagnosticSample = { scenario, totalMs: performance.now() - begin, timings };
        report.samples.push(sample);
        await save();
        return { runId: receipt.runId, sample };
      }
      assert(performance.now() < deadline, "Workflow exceeded its 60-second observation budget");
      await Bun.sleep(25);
    }
  };
  const verifyInventoryItem = async (index: number) => {
    const position = positionRecords[index]!;
    const [item] = await sql<
      Array<{ data: Record<string, unknown> }>
    >`SELECT data FROM grids.records WHERE id = ${selectedItems[index]!.id}::uuid`;
    assert.deepEqual(item?.data[items.field("status").id], ["in_use"]);
    const [link] =
      await sql`SELECT to_record_id::text AS id FROM grids.record_links WHERE from_record_id = ${selectedItems[index]!.id}::uuid AND from_field_id = ${items.field("current_position").id}::uuid`;
    assert.equal(link?.id, position.id);
  };
  for (const [index, position] of positionRecords.slice(0, 5).entries()) {
    await workflow("Inventar ausgeben", issuePosition, { position: position.shortId });
    await verifyInventoryItem(index);
  }
  for (const [index, invoice] of invoices.entries()) {
    const before = pdfRequests.length;
    let overlap: Promise<DiagnosticSample> | undefined;
    let inventoryOverlap: ReturnType<typeof workflow> | undefined;
    onPdfRequest =
      index === 2
        ? () => {
            overlap ??= query(1, 1000, false, " während PDF");
            inventoryOverlap ??= workflow("Inventar ausgeben während PDF", issuePosition, { position: positionRecords[5]!.shortId });
          }
        : undefined;
    const result = await workflow(
      index === 0 ? "Rechnung + PDF · erster Lauf" : index === 1 ? "Rechnung + PDF · zweiter Lauf" : "Rechnung + PDF · Überlappung",
      issueInvoice,
      { bill: invoice.shortId },
    );
    onPdfRequest = undefined;
    if (index === 2) {
      assert(overlap, "Renderer request was not observed");
      await overlap;
      assert(inventoryOverlap, "Concurrent Inventory workflow was not started");
      await inventoryOverlap;
      await verifyInventoryItem(5);
    }
    result.sample.timings.pdfHttpMs = pdfRequests.slice(before).reduce((sum, request) => sum + request.ms, 0);
    const documents = await sql<
      Array<{ id: string; primary_artifact_key: string; snapshot_id: string | null; profile_output: { grossAmount: string } }>
    >`SELECT id::text, primary_artifact_key, snapshot_id::text, profile_output FROM grids.documents WHERE workflow_run_id = ${result.runId}::uuid`;
    assert.equal(documents.length, 1);
    assert(documents[0]!.snapshot_id);
    assert.equal(documents[0]!.profile_output.grossAmount, "42.78");
    const artifact = must(await readDocumentArtifact(documents[0]!.id, documents[0]!.primary_artifact_key));
    const path = join(directory, `invoice-${index + 1}.pdf`);
    await Bun.write(path, artifact.bytes);
    const extraction = Bun.spawn([process.env.PDFTOTEXT ?? "pdftotext", path, "-"], { stdout: "pipe", stderr: "pipe" });
    const text = await new Response(extraction.stdout).text();
    assert.equal(await extraction.exited, 0);
    for (const expected of ["Diagnostic service", "Diagnostic buyer", "Diagnostic issuer"]) assert(text.includes(expected), expected);
    await save();
  }
  report.status = "complete";
  report.measuredMs = performance.now() - started;
  report.environment.loadAverageAfter = loadavg();
  report.environment.pdfRequests = pdfRequests;
} catch (error) {
  report.status = "failed";
  report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  globalThis.fetch = originalFetch;
  await save();
  if (runtimeStarted) await stopWorkflowRuntime();
  await sync.drain({ timeoutMs: 5_000 });
  unbindProcessSync();
  await connection.drain();
  await sql.close({ timeout: 5 });
}
