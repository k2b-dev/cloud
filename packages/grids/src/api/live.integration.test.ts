import { afterAll, beforeAll, expect, test } from "bun:test";
import type { LiveViewer } from "@k2b/cloud/events";
import type { RequestActor } from "@k2b/cloud/server";
import { serviceAccountCredentials } from "@k2b/cloud/services";
import { sql } from "bun";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { suiteFor, testInfra } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../integration-test-utils";
import { migrate } from "../migrate";
import { grantAccess } from "../service/access";
import { remove as removeBase } from "../service/bases";
import { gridsLiveKey } from "../service/live";
import { create as createRecord } from "../service/record-write";
import { create as createTable, remove as removeTable, update as updateTable } from "../service/tables";
import { publishWorkflowRunEvent } from "../service/workflow-run-events";
import { getWorkflowRun } from "../service/workflow-runs";
import { deleteTestWorkflowScope, insertTestWorkflow, insertTestWorkflowRun } from "../service/workflow-test-fixture";
import type { GridsWorkflowStepRun } from "../workflows/contracts";
import api from ".";
import { gridsLiveChannels } from "./live-channels";
import { gateBaseAtAccess } from "./permissions";

// Delivery, replay, and the session checks of the socket are covered by the platform's live
// routes test. This file checks what Grids decides: which key an update is written under, in
// which transaction, and who may follow a key. Sessions need Core's identity authority, which
// this process does not run, so people are checked against the API's own decision and API
// keys over the socket.
const suite = suiteFor("database", "nats", "valkey");
const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;

let server: ReturnType<typeof Bun.serve> | null = null;
const bases: string[] = [];
const users: string[] = [];
const accounts: string[] = [];
const grants: string[] = [];

beforeAll(async () => {
  if (!testInfra.database || !testInfra.nats || !testInfra.valkey) return;
  await migrate();
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: new Hono().route("/api/grids", api).fetch, websocket });
});

afterAll(async () => {
  await server?.stop(true);
  for (const baseId of bases) await deleteTestWorkflowScope(baseId);
  if (bases.length > 0) {
    await sql`DELETE FROM events.outbox WHERE app_id = 'grids' AND (
      ordering_key IN ${sql(bases.map(gridsLiveKey.base))}
      OR ordering_key IN (SELECT 'table:' || id::text FROM grids.tables WHERE base_id IN ${sql(bases)})
      OR ordering_key IN (SELECT 'workflow:' || id::text FROM grids.workflow_profile WHERE base_id IN ${sql(bases)}))`;
    await sql`DELETE FROM grids.bases WHERE id IN ${sql(bases)}`;
  }
  if (grants.length > 0) await sql`DELETE FROM auth.access WHERE id IN ${sql(grants)}`;
  if (accounts.length > 0) await sql`DELETE FROM auth.service_accounts WHERE id IN ${sql(accounts)}`;
  if (users.length > 0) await sql`DELETE FROM auth.users WHERE id IN ${sql(users)}`;
});

const base = async (name: string) => {
  const id = crypto.randomUUID();
  const shortId = testShortId();
  await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${id}::uuid, ${shortId}, ${name})`;
  bases.push(id);
  return { id, shortId };
};

const table = async (baseId: string, name: string) => {
  const created = await createTable({ baseId, name }, null);
  if (!created.ok) throw new Error(created.error.message);
  return created.data;
};

type Grantee = { user_id: string } | { service_account_id: string };

const grant = async (baseId: string, grantee: Grantee) => {
  const [access] =
    "user_id" in grantee
      ? await sql<{ id: string }[]>`INSERT INTO auth.access (user_id, permission) VALUES (${grantee.user_id}::uuid, 'read') RETURNING id`
      : await sql<{ id: string }[]>`
          INSERT INTO auth.access (service_account_id, permission) VALUES (${grantee.service_account_id}::uuid, 'read') RETURNING id`;
  grants.push(access!.id);
  await sql`INSERT INTO grids.base_access (base_id, access_id) VALUES (${baseId}::uuid, ${access!.id}::uuid)`;
};

const person = async (name: string): Promise<LiveViewer & { userId: string }> => {
  const id = crypto.randomUUID();
  await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name)
    VALUES (${id}::uuid, ${`grids-live-${id}`}, 'local', 'user', ${name})`;
  users.push(id);
  const actor = { kind: "user", user: { id, uid: `grids-live-${id}`, roles: ["user"], displayName: name } } as unknown as RequestActor;
  return { id: `user:${id}`, userId: id, actor, accessSubject: { type: "user", userId: id }, scopes: [] };
};

/** A service account with an API key; a bound account belongs to the Base `boundTo`. */
const keyFor = async (scopes: string[], boundTo?: string) => {
  const name = `Grids live ${testShortId()}`;
  const [created] = boundTo
    ? await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
        VALUES (${name}, 'resource_bound', 'grids', 'base', ${boundTo}) RETURNING id`
    : await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind) VALUES (${name}, 'standalone') RETURNING id`;
  accounts.push(created!.id);
  const key = await serviceAccountCredentials.createApiToken({ serviceAccountId: created!.id, name: "live", scopes });
  if (!key.ok) throw new Error(key.error.message);
  return { id: created!.id, headers: { authorization: `Bearer ${key.data.token}`, "x-forwarded-for": uniqueCallerAddress() } };
};

/** Opens the Grids live socket, sends one subscription, and returns its first answer. */
const firstAnswer = async (headers: Record<string, string>, channel: string, scope: unknown) => {
  const socket = new BunWebSocket(`ws://127.0.0.1:${server?.port}/api/grids/live`, { headers });
  try {
    return await new Promise<{ t: string; id?: string; code?: string }>((resolve, reject) => {
      socket.onopen = () => socket.send(JSON.stringify({ t: "sub", id: "g", channel, scope }));
      socket.onmessage = (message) => {
        const frame = JSON.parse(String(message.data)) as { t: string; id?: string; code?: string };
        if (frame.t !== "progress") resolve(frame);
      };
      socket.onerror = () => reject(new Error("The Grids live socket failed"));
    });
  } finally {
    socket.close();
  }
};

type Envelope = { v: 1; k: string; a?: true; r?: true; d?: Record<string, unknown> };

/** The live updates waiting under `key`; nothing publishes them in this process. */
const pending = async (key: string) =>
  (
    await sql<{ payload: Envelope }[]>`
    SELECT payload FROM events.outbox WHERE app_id = 'grids' AND kind = 'live' AND ordering_key = ${key} ORDER BY seq`
  ).map((row) => row.payload);

const notFound = { t: "revoked", id: "g", code: "not_found" };

suite("Grids live channels", () => {
  test("a record change is written for its table only, and readers of the Base follow that table", async () => {
    const shared = await base("Live records");
    const orders = await table(shared.id, "Orders");
    const invoices = await table(shared.id, "Invoices");
    const created = await createRecord(invoices.id, {}, null, "direct");
    if (!created.ok) throw new Error(created.error.message);

    expect(await pending(gridsLiveKey.table(orders.id))).toEqual([]);
    expect((await pending(gridsLiveKey.table(invoices.id))).map((update) => update.d)).toEqual([
      { type: "record.created", tableId: invoices.shortId, recordId: created.data.shortId, version: 1 },
    ]);
    expect(await gridsLiveChannels.records.keys({ table: orders.shortId })).toEqual([gridsLiveKey.table(orders.id)]);

    const reader = await keyFor(["read"]);
    await grant(shared.id, { service_account_id: reader.id });
    const other = await base("Live other");
    const bound = await keyFor(["read"], other.id);
    await grant(shared.id, { service_account_id: bound.id });
    expect(await firstAnswer(reader.headers, "records", { table: orders.shortId })).toMatchObject({ t: "ready" });
    // A key bound to another Base reads nothing here, even with a grant.
    expect(await firstAnswer(bound.headers, "records", { table: orders.shortId })).toEqual(notFound);
    expect(await firstAnswer(reader.headers, "records", { table: "Zz9999" })).toEqual(notFound);
  });

  test("tables, workflows, and the Base admit exactly the readers the Grids API admits", async () => {
    const shared = await base("Live access");
    const orders = await table(shared.id, "Orders");
    const workflowId = await insertTestWorkflow({ baseId: shared.id });
    const reader = await person("Ada Example");
    const stranger = await person("Bob Example");
    await grant(shared.id, { user_id: reader.userId });
    const viewers = [reader, stranger];

    for (const key of [gridsLiveKey.base(shared.id), gridsLiveKey.table(orders.id), gridsLiveKey.workflow(workflowId)]) {
      const admitted = await gridsLiveChannels.metadata.authorize(key, viewers);
      const allowedByApi = new Set<string>();
      for (const viewer of viewers) {
        const level = await gateBaseAtAccess({ actor: viewer.actor, accessSubject: viewer.accessSubject }, shared.id, "read");
        if (level.ok) allowedByApi.add(viewer.id);
      }
      expect([...admitted]).toEqual([...allowedByApi]);
      expect([...admitted]).toEqual([reader.id]);
    }

    // A deleted table admits nobody, so its open views are revoked.
    expect((await removeTable(orders.id, null)).ok).toBe(true);
    expect([...(await gridsLiveChannels.records.authorize(gridsLiveKey.table(orders.id), viewers))]).toEqual([]);
  });

  test("structure and access changes are written in the transaction that makes them", async () => {
    const shared = await base("Live structure");
    const orders = await table(shared.id, "Orders");
    const invoices = await table(shared.id, "Invoices");
    const workflowId = await insertTestWorkflow({ baseId: shared.id });
    const key = gridsLiveKey.base(shared.id);
    const children = [gridsLiveKey.table(orders.id), gridsLiveKey.table(invoices.id), gridsLiveKey.workflow(workflowId)];
    await sql`DELETE FROM events.outbox WHERE app_id = 'grids' AND ordering_key IN ${sql([key, ...children])}`;

    expect((await updateTable(orders.id, { name: "Purchase orders" }, null)).ok).toBe(true);
    // A rejected rename writes nothing.
    expect((await updateTable(orders.id, { name: "Invoices" }, null)).ok).toBe(false);
    const newReader = await person("Cleo Example");
    expect(
      (
        await grantAccess({
          resourceType: "base",
          resourceId: shared.id,
          principal: { type: "user", userId: newReader.userId },
          permission: "read",
        })
      ).ok,
    ).toBe(true);

    expect(await pending(key)).toEqual([
      { v: 1, k: key, d: { type: "table.updated" } },
      { v: 1, k: key, a: true },
      { v: 1, k: key, d: { type: "access.changed" } },
    ]);
    // Readers of the Base follow its tables and workflows too, so their keys are checked again as well.
    for (const child of children) expect(await pending(child)).toEqual([{ v: 1, k: child, a: true }]);

    // A deleted Base takes its tables and workflows along.
    expect((await removeBase(shared.id, null)).ok).toBe(true);
    for (const child of children)
      expect(await pending(child)).toEqual([
        { v: 1, k: child, a: true },
        { v: 1, k: child, a: true },
      ]);
  });

  test("a run update names public IDs, and one above 32 KiB asks pages to read the run again", async () => {
    const shared = await base("Live runs");
    const workflowId = await insertTestWorkflow({ baseId: shared.id });
    const runId = await insertTestWorkflowRun({ workflowId, baseId: shared.id, state: "succeeded", finishedAt: new Date() });
    const run = await getWorkflowRun(runId);
    if (!run) throw new Error("test run is missing");
    const step = (outcome: string): GridsWorkflowStepRun => ({
      runId,
      key: "steps.0",
      sourcePath: ["steps", 0],
      iterationPath: [],
      kind: "action",
      action: "grids.updateRecord",
      status: "completed",
      outcome: { note: outcome },
      executionGeneration: 1,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    });
    const key = gridsLiveKey.workflow(workflowId);
    const [ids] = await sql<{ workflow: string; run: string }[]>`
      SELECT (SELECT short_id FROM grids.workflow_profile WHERE id = ${workflowId}::uuid) AS workflow,
             (SELECT short_id FROM grids.workflow_run_profile WHERE run_id = ${runId}::uuid) AS run`;

    await publishWorkflowRunEvent(run, [step("Approved")]);
    await publishWorkflowRunEvent(run, [step("x".repeat(40 * 1024))]);

    const [small, large] = await pending(key);
    expect(small?.d).toMatchObject({
      v: 1,
      baseId: shared.shortId,
      workflowId: ids!.workflow,
      run: { id: ids!.run, workflowId: ids!.workflow, status: "succeeded" },
      steps: [{ runId: ids!.run, key: "steps.0", outcome: { note: "Approved" } }],
    });
    expect(large).toEqual({ v: 1, k: key, r: true });
  });

  test("a tab from before the move to /live is told that live updates stopped", async () => {
    const socket = new BunWebSocket(`ws://127.0.0.1:${server?.port}/api/grids/ws`, {
      headers: { "x-forwarded-for": uniqueCallerAddress() },
    });
    const closed = await new Promise<{ code: number; reason: string }>((resolve) => {
      socket.onclose = (event) => resolve({ code: event.code, reason: event.reason });
    });
    expect(closed).toEqual({ code: 1008, reason: "reload_required" });
  });
});
