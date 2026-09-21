import { afterEach, expect } from "bun:test";
import { closeSync, openSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindProcessSync, unbindProcessSync } from "@k2b/cloud";
import { WORKFLOW_RUN_LEASE_MS } from "@k2b/cloud/workflows/store";
import { createSync } from "@k2b/sync";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { type SQL, sql } from "bun";
import { testFor, testInfra } from "../../../../scripts/fixtures/test-infra";
import { localVerificationUrl } from "../../scripts/verification";
import { testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { compileAndBindGridsWorkflowSource } from "../workflows/binder";
import { readDocumentArtifact } from "./document-issuance";
import { createTemplate } from "./document-templates";
import { enable as enableHistory } from "./durable-history";
import { dispatchRecordEventOutbox } from "./record-event-outbox";
import { enable as enableFinalization } from "./record-finalization";
import { loadWorkflowCatalog } from "./workflow-catalog";
import { invokeGridsWorkflow } from "./workflow-runtime";
import { insertTestWorkflow } from "./workflow-test-fixture";

// This phase owns Sync and real child processes. Never run it in the standard
// shared-process suite, or against a development/production application database.
const crashTest = testFor("database", "nats", "gotenberg");
const budget = WORKFLOW_RUN_LEASE_MS + 5 * 90_000;
let active: Promise<void> | undefined;
afterEach(async () => {
  try {
    await active;
  } catch {
    /* already reported by the test */
  }
}, budget);

const eventually = async (label: string, check: () => Promise<boolean>, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(50);
  }
};

const fixture = async (name: string) => {
  const baseId = testUuid(),
    tableId = testUuid(),
    recordId = testUuid(),
    actorId = testUuid();
  await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn)
    VALUES (${actorId}::uuid, ${actorId}, 'local', 'user', 'Crash test', 'Crash', 'Test')`;
  await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${testShortId("B")}, ${name})`;
  await sql`INSERT INTO grids.tables (id, short_id, base_id, name) VALUES (${tableId}::uuid, ${testShortId("T")}, ${baseId}::uuid, 'Invoices')`;
  const recordShortId = testShortId("R");
  await sql`INSERT INTO grids.records (id, short_id, table_id, data) VALUES (${recordId}::uuid, ${recordShortId}, ${tableId}::uuid, '{}'::jsonb)`;
  const [access] = await sql`INSERT INTO auth.access (user_id, permission) VALUES (${actorId}::uuid, 'write') RETURNING id`;
  await sql`INSERT INTO grids.base_access (base_id, access_id) VALUES (${baseId}::uuid, ${access.id}::uuid)`;
  for (const result of [await enableHistory(tableId, actorId), await enableFinalization(tableId, { mode: "direct" }, actorId)]) {
    if (!result.ok) throw new Error(result.error.message);
  }
  const template = await createTemplate(
    tableId,
    {
      name: "Receipt",
      source: "from table Invoices",
      issuancePolicy: "oncePerFinalizedRecord",
      renderer: {
        kind: "html",
        body: "<h1>Crash recovery receipt</h1><p>{{ document.number }}</p>",
        numberTemplate: "CRASH-{{ series.value }}",
        filenameTemplate: "{{ document.number }}.pdf",
      },
    },
    actorId,
  );
  if (!template.ok) throw new Error(template.error.message);
  const source = `inputs:
  record: { type: record, table: Invoices, required: true }
steps:
  - finalizeRecord: { record: inputs.record }
  - generateDocument: { record: inputs.record, template: Receipt, saveAs: receipt }
  - httpRequest:
      method: POST
      url: http://receiver.example.com/${name}
`;
  const compiled = await compileAndBindGridsWorkflowSource(source, await loadWorkflowCatalog(baseId));
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  const workflowId = await insertTestWorkflow({
    baseId,
    name,
    source,
    plan: compiled.plan,
    enabled: true,
    ownerUserId: actorId,
    shortId: testShortId("W"),
  });
  const invoke = (key: string) =>
    invokeGridsWorkflow({
      workflowId,
      mode: "execute",
      channel: "api",
      idempotencyKey: key,
      inputs: { record: recordShortId },
      principal: { userId: actorId, groupIds: [], serviceAccountId: null },
      context: { locale: "en" },
    });
  const key = testUuid();
  const requests = await Promise.all([invoke(key), invoke(key)]);
  const first = requests[0];
  if (!first?.ok) throw new Error(JSON.stringify(first));
  for (const response of requests) expect(response.ok && response.data.runId).toBe(first.data.runId);
  return { name, baseId, tableId, recordId, workflowId, templateId: template.data.id, runId: first.data.runId, key, invoke };
};

crashTest(
  "document workflow survives SIGKILL at durable boundaries and fences a suspended worker",
  () => (active = runAcceptance()),
  budget,
);

async function runAcceptance() {
  const database = localVerificationUrl("PostgreSQL", testInfra.database);
  if (!/^\/grids_verify_[a-f0-9]{16}_test$/.test(database.pathname)) throw new Error("Crash acceptance requires a grids_verify_ database");
  const gotenberg = localVerificationUrl("Gotenberg", testInfra.gotenberg);
  const nats = localVerificationUrl("NATS", testInfra.nats);
  await migrate();
  const reports = await mkdtemp(join(process.env.GRIDS_VERIFY_REPORTS_DIR ?? tmpdir(), "grids-crash-"));
  console.info(`Crash acceptance evidence: ${reports}`);
  const namespace = `grids-crash-${testUuid()}`;
  const connection = await connect({
    servers: nats.toString(),
    ignoreClusterUpdates: true,
  });
  const sync = createSync({ connection, namespace, application: "grids", defaults: { replicas: 1 } });
  bindProcessSync(sync);
  const accepted: { path: string; key: string | null; body: string }[] = [];
  let finishHttp: (() => void) | undefined;
  const receiver = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      accepted.push({ path, key: request.headers.get("idempotency-key"), body: await request.text() });
      if (path === "/http-accepted")
        await new Promise<void>((resolve) => {
          finishHttp = resolve;
        });
      return new Response("accepted");
    },
  });
  type Child = { child: Bun.Subprocess; events: unknown[]; log: string };
  const children: Child[] = [];
  function spawn(runId: string, checkpoint: string) {
    const events: unknown[] = [];
    const log = join(reports, `${runId}-${children.length}.log`);
    const fd = openSync(log, "wx");
    const childUrl = new URL(database);
    childUrl.searchParams.set("application_name", `grids-crash:${runId}`);
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "document-workflow-crash.worker.ts"), runId, checkpoint, namespace, String(receiver.port)],
      {
        env: { ...process.env, DATABASE_URL: childUrl.toString(), NATS_SERVERS: nats.toString(), GOTENBERG_URL: gotenberg.toString() },
        stdout: fd,
        stderr: fd,
        ipc: (message) => {
          events.push(message);
        },
      },
    );
    closeSync(fd);
    const stopped = { child, events, log };
    children.push(stopped);
    return stopped;
  }
  const event = (child: ReturnType<typeof spawn>, key: string, value: unknown) =>
    eventually(`child ${key}=${value}; ${child.log}`, async () => {
      if (child.child.exitCode !== null) throw new Error(`Child exited before ${key}; ${await Bun.file(child.log).text()}`);
      return child.events.some((event) => typeof event === "object" && event !== null && key in event && Reflect.get(event, key) === value);
    });
  const start = async (runId: string, checkpoint: string) => {
    const child = spawn(runId, checkpoint);
    await event(child, "ready", true);
    child.child.send("start");
    return child;
  };
  const joinChild = async (child: ReturnType<typeof spawn>) => {
    await eventually(`child exit; ${child.log}`, async () => child.child.exitCode !== null, 90_000);
    expect(await child.child.exited, await Bun.file(child.log).text()).toBe(0);
  };
  const frozenRecord = async (recordId: string) => {
    const [row] = await sql`SELECT to_jsonb(record) AS value FROM grids.records record WHERE id = ${recordId}::uuid`;
    expect(row.value.finalized_at).not.toBeNull();
    expect(row.value.final_revision_id).not.toBeNull();
    return row.value;
  };
  let lock: Awaited<ReturnType<SQL["reserve"]>> | undefined;
  let triggerCreated = false;
  const evidence: Record<string, unknown>[] = [];
  try {
    const initialFiles = new Set((await sql<Array<{ id: string }>>`SELECT id::text FROM grids.files`).map((row) => row.id));
    const cases: (Awaited<ReturnType<typeof fixture>> & {
      child: Child;
      record: unknown;
      receipt: { document_id: string | null; document_short_id: string };
      originalArtifact: Awaited<ReturnType<typeof readDocumentArtifact>> | undefined;
      leaseExpiresAt: Date;
    })[] = [];
    for (const name of ["receipt-reserved", "document-storage", "document-committed", "http-accepted", "stale-worker"] as const) {
      console.info(`Crash checkpoint: ${name}`);
      const f = await fixture(name);
      if (name === "document-storage") {
        lock = await sql.reserve();
        await lock`SELECT pg_advisory_lock(hashtextextended(${f.baseId}, 0))`;
        // The trigger blocks after file INSERTs but before document INSERT. Its
        // uncommitted work is rolled back by killing the owning OS process.
        await sql.unsafe(`CREATE FUNCTION grids.crash_acceptance_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF NEW.base_id = '${f.baseId}'::uuid THEN PERFORM pg_advisory_xact_lock(hashtextextended(NEW.base_id::text, 0)); END IF;
          RETURN NEW; END $$`);
        await sql`CREATE TRIGGER crash_acceptance_barrier BEFORE INSERT ON grids.documents FOR EACH ROW EXECUTE FUNCTION grids.crash_acceptance_barrier()`.simple();
        triggerCreated = true;
      }
      const child = await start(f.runId, name === "stale-worker" ? "receipt-reserved" : name);
      if (name === "document-storage") {
        await eventually(
          "document transaction blocked on storage barrier",
          async () =>
            (await sql`SELECT pid FROM pg_stat_activity WHERE application_name = ${`grids-crash:${f.runId}`} AND wait_event = 'advisory'`)
              .length === 1,
        );
      } else if (name === "http-accepted") {
        await eventually("HTTP receiver accepted the request", async () => accepted.some((entry) => entry.path === "/http-accepted"));
      } else await event(child, "checkpoint", name === "stale-worker" ? "receipt-reserved" : name);
      if (name === "stale-worker") process.kill(child.child.pid, "SIGSTOP");
      else {
        child.child.kill("SIGKILL");
        await child.child.exited;
        expect(child.child.signalCode).toBe("SIGKILL");
      }
      if (lock) {
        await lock`SELECT pg_advisory_unlock_all()`;
        lock.release();
        lock = undefined;
        await sql`DROP TRIGGER crash_acceptance_barrier ON grids.documents`.simple();
        await sql`DROP FUNCTION grids.crash_acceptance_barrier()`.simple();
        triggerCreated = false;
      }
      const record = await frozenRecord(f.recordId);
      const pendingEvent =
        await sql`SELECT status FROM grids.record_event_outbox WHERE base_id = ${f.baseId}::uuid AND payload->>'type' = 'record.finalized'`;
      expect(pendingEvent).toEqual([{ status: "pending" }]);
      const [receipt] =
        await sql`SELECT id::text, document_id::text, document_short_id, frozen_request FROM grids.document_issuances WHERE base_id = ${f.baseId}::uuid`;
      expect(receipt).toBeDefined();
      const persisted = name === "document-committed" || name === "http-accepted";
      expect(receipt.document_id !== null).toBe(persisted);
      if (!persisted) {
        expect(receipt.frozen_request.documentNumber).toBe("CRASH-1");
        expect(await sql`SELECT file_id FROM grids.file_protected_references WHERE base_id = ${f.baseId}::uuid`).toHaveLength(0);
      }
      const [run] = await sql`SELECT execution_generation::int, lease_expires_at FROM workflows.run WHERE id = ${f.runId}::uuid`;
      expect(run.execution_generation).toBe(1);
      const originalArtifact = persisted ? await readDocumentArtifact(receipt.document_id, "pdf") : undefined;
      if (originalArtifact) expect(originalArtifact.ok).toBe(true);
      cases.push({ ...f, child, record, receipt, originalArtifact, leaseExpiresAt: run.lease_expires_at });
    }

    console.info(`Waiting for the real ${WORKFLOW_RUN_LEASE_MS}ms workflow leases to expire`);
    await eventually(
      "original worker leases expired",
      async () => {
        const pending = await sql`SELECT id FROM workflows.run WHERE id IN ${sql(cases.map((f) => f.runId))} AND lease_expires_at >= now()`;
        return pending.length === 0;
      },
      WORKFLOW_RUN_LEASE_MS + 5_000,
    );

    for (const f of cases) {
      const startedAt = Date.now();
      console.info(`Recovering with two fresh workers: ${f.name}`);
      const checkpoint = f.name === "stale-worker" ? "receipt-reserved" : "none";
      const workers = [spawn(f.runId, checkpoint), spawn(f.runId, checkpoint)];
      await Promise.all(workers.map((worker) => event(worker, "ready", true)));
      for (const worker of workers) worker.child.send("start");
      if (f.name === "stale-worker") {
        await eventually("replacement worker owns the lease before rendering", async () =>
          workers.some((worker) =>
            worker.events.some(
              (event) => typeof event === "object" && event !== null && "checkpoint" in event && event.checkpoint === "receipt-reserved",
            ),
          ),
        );
        const [claimed] = await sql`SELECT execution_generation::int FROM workflows.run WHERE id = ${f.runId}::uuid`;
        expect(claimed.execution_generation).toBe(2);
        process.kill(f.child.child.pid, "SIGCONT");
        f.child.child.send("resume");
        await joinChild(f.child);
        // The replacement has not rendered yet. A stale worker must not win
        // the document commit merely because its PDF finishes first.
        expect(await sql`SELECT id FROM grids.documents WHERE base_id = ${f.baseId}::uuid`).toHaveLength(0);
        for (const worker of workers) if (worker.child.exitCode === null) worker.child.send("resume");
      }
      await Promise.all(workers.map(joinChild));
      const [run] = await sql`SELECT state, error, execution_generation::int FROM workflows.run WHERE id = ${f.runId}::uuid`;
      expect(run.state, JSON.stringify(run)).toBe(f.name === "http-accepted" ? "needs_attention" : "succeeded");
      expect(run.execution_generation).toBe(2);
      if (f.name === "http-accepted") expect(run.error.code).toBe("WORKFLOW_HTTP_OUTCOME_UNKNOWN");
      expect(await frozenRecord(f.recordId)).toEqual(f.record);
      const documents = await sql<
        Array<{ id: string; short_id: string; document_number: string }>
      >`SELECT id::text, short_id, document_number FROM grids.documents WHERE base_id = ${f.baseId}::uuid`;
      expect(documents).toHaveLength(1);
      const document = documents[0];
      if (!document) throw new Error(`Missing recovered document: ${f.name}`);
      expect(document.short_id).toBe(f.receipt.document_short_id);
      expect(document.document_number).toBe("CRASH-1");
      const allocations =
        await sql`SELECT allocation.consumer_id::text FROM grids.number_allocations allocation JOIN grids.number_series series ON series.id = allocation.series_id WHERE series.document_template_id = ${f.templateId}::uuid`;
      expect(allocations).toEqual([{ consumer_id: document.id }]);
      const artifact = await readDocumentArtifact(document.id, "pdf");
      if (!artifact.ok) throw new Error(artifact.error.message);
      if (f.originalArtifact?.ok) expect(artifact.data).toEqual(f.originalArtifact.data);
      const pdfPath = join(reports, `${f.name}.pdf`);
      await Bun.write(pdfPath, artifact.data.bytes);
      const extraction = Bun.spawn([process.env.PDFTOTEXT ?? "pdftotext", pdfPath, "-"], { stdout: "pipe", stderr: "pipe" });
      const text = await new Response(extraction.stdout).text();
      expect(await extraction.exited, await new Response(extraction.stderr).text()).toBe(0);
      expect(text).toContain("Crash recovery receipt");
      expect(text).toContain("CRASH-1");
      const replay = await f.invoke(f.key);
      expect(replay.ok && replay.data.runId).toBe(f.runId);
      const retried = await start(f.runId, "none");
      await joinChild(retried);
      const expectedEffectRuns = [f.runId];
      if (f.name === "receipt-reserved") {
        // A new invocation is a separate HTTP effect, but the template still
        // permits only one issued document for this finalized record.
        const independent = await f.invoke(testUuid());
        if (!independent.ok) throw new Error(independent.error.message);
        expect(independent.data.runId).not.toBe(f.runId);
        const contenders = [spawn(independent.data.runId, "none"), spawn(independent.data.runId, "none")];
        await Promise.all(contenders.map((worker) => event(worker, "ready", true)));
        for (const worker of contenders) worker.child.send("start");
        await Promise.all(contenders.map(joinChild));
        const [independentRun] = await sql`SELECT state FROM workflows.run WHERE id = ${independent.data.runId}::uuid`;
        expect(independentRun.state).toBe("succeeded");
        expect(await frozenRecord(f.recordId)).toEqual(f.record);
        const sameDocuments = await sql<Array<{ id: string }>>`SELECT id::text FROM grids.documents WHERE base_id = ${f.baseId}::uuid`;
        expect(sameDocuments).toEqual([{ id: document.id }]);
        expect(await readDocumentArtifact(document.id, "pdf")).toEqual(artifact);
        expect(
          await sql`SELECT allocation.consumer_id::text FROM grids.number_allocations allocation JOIN grids.number_series series ON series.id = allocation.series_id WHERE series.document_template_id = ${f.templateId}::uuid`,
        ).toEqual(allocations);
        expectedEffectRuns.push(independent.data.runId);
      }
      if (f.name === "stale-worker") {
        expect(await frozenRecord(f.recordId)).toEqual(f.record);
        expect(await readDocumentArtifact(document.id, "pdf")).toEqual(artifact);
        const [unchanged] = await sql`SELECT state, execution_generation::int FROM workflows.run WHERE id = ${f.runId}::uuid`;
        expect(unchanged).toEqual({ state: "succeeded", execution_generation: 2 });
      }
      expect(accepted.filter((entry) => entry.path === `/${f.name}`)).toEqual(
        expectedEffectRuns.map((runId) => ({ path: `/${f.name}`, key: `workflow:${runId}:step:steps.2`, body: "" })),
      );
      const persistedRuns = await sql<Array<{ id: string }>>`SELECT id::text FROM workflows.run WHERE workflow_id = ${f.workflowId}::uuid`;
      expect(persistedRuns.map((row) => row.id).sort()).toEqual([...expectedEffectRuns].sort());
      const outbox =
        await sql`SELECT id::text FROM grids.record_event_outbox WHERE base_id = ${f.baseId}::uuid AND payload->>'type' = 'record.finalized'`;
      expect(outbox).toHaveLength(1);
      expect(await dispatchRecordEventOutbox(outbox[0].id)).toBe("delivered");
      expect(await dispatchRecordEventOutbox(outbox[0].id)).toBe("already-delivered");
      evidence.push({
        checkpoint: f.name,
        runId: f.runId,
        state: run.state,
        generation: run.execution_generation,
        recoveryMs: Date.now() - startedAt,
        leaseExpiresAt: f.leaseExpiresAt,
        documentId: document.id,
        number: document.document_number,
        sha256: artifact.data.sha256,
      });
    }
    const orphanFiles = await sql<
      Array<{ id: string }>
    >`SELECT file.id::text FROM grids.files file LEFT JOIN grids.file_protected_references reference ON reference.file_id = file.id WHERE reference.file_id IS NULL`;
    expect(orphanFiles.filter((row) => !initialFiles.has(row.id))).toEqual([]);
    await Bun.write(join(reports, "acceptance.json"), JSON.stringify(evidence, null, 2));
  } finally {
    for (const { child } of children) if (child.exitCode === null) child.kill("SIGKILL");
    await Promise.all(children.map(({ child }) => child.exited));
    finishHttp?.();
    await receiver.stop(true);
    if (lock) {
      await lock`SELECT pg_advisory_unlock_all()`;
      lock.release();
    }
    if (triggerCreated) {
      await sql`DROP TRIGGER crash_acceptance_barrier ON grids.documents`.simple();
      await sql`DROP FUNCTION grids.crash_acceptance_barrier()`.simple();
    }
    await sync.drain({ timeoutMs: 5_000 });
    unbindProcessSync();
    const manager = await jetstreamManager(connection);
    for await (const stream of manager.streams.list())
      if (stream.config.metadata?.["sync.namespace"] === namespace) await manager.streams.delete(stream.config.name);
    await connection.drain();
  }
}
