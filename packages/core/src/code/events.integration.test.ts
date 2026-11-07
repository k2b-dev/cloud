import { afterAll, beforeAll, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { bindProcessSync, sql, unbindProcessSync } from "@k2b/cloud";
import * as catalogProvider from "@k2b/cloud/capabilities/server";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import type { CodeRunTokenClaims } from "@k2b/cloud/code/run-token";
import { CloudResourceRefSchema, type CodeCheckedVersionManifest } from "@k2b/cloud/contracts";
import type { AppEventEnvelope } from "@k2b/cloud/contracts/app-events";
import type { CapabilityRegistryEntry } from "@k2b/cloud/contracts/registry";
import { appEventFixture } from "@k2b/cloud/events/testing";
import { accounts } from "@k2b/cloud/services";
import * as eventPlatform from "@k2b/cloud/services/app-events";
import { cancelResourceEventSubscriptions, createAppEventBroker, type ResourceEventBinding } from "@k2b/cloud/services/app-events";
import { nestedInvocationLeases } from "@k2b/cloud/services/identity";
import { resolveInvocationAuthority } from "@k2b/cloud/services/identity/invocation-actor";
import { createSync } from "@k2b/sync";
import { z } from "zod";
import { connectTestNats, suiteFor, testSyncNamespace, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { mailCapabilities } from "../../../mail/src/capabilities";
import { migrate as migrateAppApproval } from "../migrate/core/app-approval";
import { migrate as migrateAppEvents } from "../migrate/core/app-events";
import { migrate as migrateAudit } from "../migrate/core/audit";
import { migrate as migrateAuth } from "../migrate/core/auth";
import { migrate as migrateCode } from "../migrate/core/code";
import { migrate as migrateActivation } from "../migrate/core/code-activation";
import { migrate as migrateLifecycle } from "../migrate/core/code-lifecycle";
import { migrate as migratePolicy } from "../migrate/core/code-policy";
import { migrate as migrateScheduling } from "../migrate/core/code-scheduling";
import { migrate as migrateVersions } from "../migrate/core/code-versions";
import { migrate as migrateEvents } from "../migrate/core/events";
import { migrate as migrateRailPreferences } from "../migrate/core/rail-preferences";
import { migrate as migrateRailShortcuts } from "../migrate/core/rail-shortcuts";
import { migrate as migrateSettings } from "../migrate/core/settings";
import type { CodeContext } from "./access";
import {
  cancelCodeEventCatchup,
  codeEventCatchupPumpConfig,
  readCodeEventCatchup,
  resumeCodeEventCatchup,
  startCodeEventCatchup,
  startCodeEventCatchupRuntime,
} from "./event-catchup";
import { CODE_EVENT_CONSUMER, syncCodeEventSubscriptions } from "./event-subscriptions";
import { admitCodeEvent, listCodeRunsWithEvents, replayCodeEventDelivery, startCodeEventConsumer } from "./events";
import { processCodeOwnerDeleted } from "./lifecycle";
import { claimCodeRuns, completeCodeRun, reconcileCodeRuns, startCodeRun } from "./scheduling";
import { CODE_SETTINGS, codeSettings } from "./settings";
import { codeBundleHash, codeSourceHash, findCode } from "./store";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner = id(1),
  codeId = "c_event001",
  principal = id(2);
const place = { type: "fixture.collection", id: "collection-a" };
const declaration: CapabilityRegistryEntry = {
  appId: "fixture",
  appName: "Fixture",
  appDescription: "Fixture event app.",
  appIcon: "box",
  endpoint: "http://fixture",
  manifest: compileCapabilityManifest("fixture", {
    protocolVersion: 2,
    types: {
      item: { title: "Item", description: "Fixture item." },
      collection: { title: "Collection", description: "Fixture collection.", reader: "collection.read" },
    },
    queries: {
      "item.event": {
        title: "Resolve historical item",
        description: "Resolve an immutable fixture occurrence.",
        openWorld: false,
        input: z.strictObject({ id: CloudResourceRefSchema.shape.id.describe("Item ID.") }),
        data: z.object({}),
        run: async () => ({ ok: true, data: { data: {} } }),
      },
      "collection.read": {
        title: "Read collection",
        description: "Read fixture collection.",
        openWorld: false,
        input: z.strictObject({ id: CloudResourceRefSchema.shape.id.describe("Collection ID.") }),
        data: z.object({}),
        run: async () => ({ ok: true, data: { data: {} } }),
      },
    },
    events: {
      changed: {
        version: 1,
        title: "Changed",
        description: "An item changed.",
        subject: "item",
        place: "collection",
        catchup: "item.event",
        schema: z.strictObject({ id: CloudResourceRefSchema.shape.id }),
      },
    },
  }),
};

suiteFor("database", "nats")("Code event delivery to durable run admission", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  let connection: Awaited<ReturnType<typeof connectTestNats>>;
  let sync: ReturnType<typeof createSync>;
  let broker: ReturnType<typeof createAppEventBroker>;
  let stopConsumer: (() => void) | undefined;
  let settings: ReturnType<typeof spyOn<typeof codeSettings, "get">>;
  let editor: CodeContext;
  let versionId: string, mandateId: string, subscriptionId: string, binding: ResourceEventBinding, time: string;
  let readable = true,
    backlog = 100,
    sequence = 0,
    number = 0;
  const makeBroker = (loseAcknowledgement = false) =>
    createAppEventBroker({
      registry: async () => [declaration, { ...declaration, appId: "mail", manifest: compileCapabilityManifest("mail", mailCapabilities) }],
      // The fixture reader has ordinary live read permission. Resolve the production event-proof identity against SQL first.
      authorizeResource: async (appId, current, envelope) => {
        const authority = await resolveInvocationAuthority(
          {
            sub: principal,
            principal_type: "service_account",
            access_subject_type: "service_account",
            access_subject_id: principal,
            act: { sub: `app:${appId}` },
            credential_kind: "mandate",
            scopes: [],
            exp: 0,
            jti: id(999),
            mandate_id: current.mandateId,
            mandate_revision: current.mandateRevision,
            workload_type: "code.version",
            workload_id: versionId,
            workload_event: envelope.id,
          },
          sql,
          [],
        );
        return authority !== null && readable;
      },
      ...(loseAcknowledgement
        ? {
            resourceConsumer:
              () =>
              async (...args: Parameters<typeof admitCodeEvent>) => {
                await admitCodeEvent(...args);
                throw new Error("fixture_crash_after_commit");
              },
          }
        : {}),
    });
  async function activate() {
    await sql.begin(async (db) => {
      await db`SELECT id FROM code.codes WHERE id=${codeId} FOR UPDATE`;
      const code = await findCode(codeId, db);
      if (!code) throw new Error("Missing Code fixture");
      await syncCodeEventSubscriptions(code, versionId, db);
      await db`UPDATE code.codes SET state='active',active_version_id=${versionId}::uuid WHERE id=${codeId}`;
    });
    const [row] = await sql<{ id: string; resource_binding: ResourceEventBinding; cutoff: string }[]>`
      SELECT id,resource_binding,to_char(first_seen_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cutoff
      FROM events.app_subscriptions WHERE state='active' AND resource_binding->>'key'=${codeId}`;
    if (!row) throw new Error("Missing subscription");
    subscriptionId = row.id;
    binding = row.resource_binding;
    time = row.cutoff;
  }
  async function version(eventType = "fixture.changed", eventPlace = place) {
    number++;
    const files = { "code.ts": `fixture ${number}` },
      bundle = "export default {};";
    const manifest: CodeCheckedVersionManifest = {
      version: 1,
      entry: "code.ts",
      hashes: { source: codeSourceHash(files, "code.ts"), bundle: codeBundleHash(bundle), sdk: "a".repeat(64) },
      entrypoints: [
        {
          kind: "event",
          entrypoint: `event:${eventType}@1`,
          cron: null,
          file: "code.ts",
          line: 1,
          event: { type: eventType, version: 1, place: eventPlace },
        },
      ],
      permissions: [],
      ai: false,
      policyRows: ["read"],
    };
    const [row] = await sql<
      { id: string }[]
    >`INSERT INTO code.versions(code_id,number,source_files,bundle,source_hash,bundle_hash,manifest,source_bytes,bundle_bytes,created_by)
      VALUES(${codeId},${number},${JSON.stringify(files)}::text::jsonb,${bundle},${manifest.hashes.source},${manifest.hashes.bundle},${JSON.stringify(manifest)}::text::jsonb,16,18,${owner}::uuid) RETURNING id`;
    versionId = row!.id;
    await sql`INSERT INTO code.version_submissions(version_id,code_id,binding) VALUES(${versionId}::uuid,${codeId},'{}'::jsonb)`;
    const [mandate] = await sql<
      { id: string }[]
    >`INSERT INTO auth.mandates(subject_kind,subject_service_account_id,owner_app_id,workload_type,workload_id,policy)
      VALUES('service_account',${principal}::uuid,'runner','code.version',${versionId},'{"version":1,"apps":[],"operations":[],"actions":"deny"}'::jsonb) RETURNING id`;
    mandateId = mandate!.id;
  }
  const event = (n: number, subject = "item-a"): AppEventEnvelope<{ id: string }> => ({
    id: id(n),
    type: "fixture.changed",
    version: 1,
    source: "fixture",
    time,
    subject: { type: "fixture.item", id: subject },
    place,
    data: { id: subject },
  });
  async function publish(n: number, subject?: string) {
    const envelope = event(n, subject);
    await broker.accept(envelope, ++sequence);
    return envelope;
  }
  async function runs() {
    return sql<{ id: string; version_id: string; input: unknown; state: string }[]>`SELECT * FROM code.runs ORDER BY event_sequence`;
  }
  const readyRetries = () => sql`UPDATE events.app_deliveries SET next_attempt_at='2000-01-01T00:00:00Z' WHERE state='retrying'`;
  beforeAll(async () => {
    database = await useFreshDatabase("code_resource_events");
    connection = await connectTestNats();
    sync = createSync({ connection, namespace: testSyncNamespace("code-event-catchup"), application: "core", defaults: { replicas: 1 } });
    await sync.ready();
    bindProcessSync(sync, connection);
    await migrateAuth();
    await migrateRailPreferences();
    await migrateRailShortcuts();
    await migrateAppApproval();
    await migrateAudit();
    await migrateSettings();
    await migrateEvents();
    await migrateAppEvents();
    await migrateCode();
    await migratePolicy();
    await migrateVersions();
    await migrateActivation();
    await migrateScheduling();
    await migrateLifecycle();
    await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${owner}::uuid,'event-owner','local','user')`;
    const user = await accounts.users.get({ id: owner });
    if (!user) throw new Error("Missing event editor fixture");
    editor = {
      authority: { actor: { kind: "user", user }, accessSubject: { type: "user", userId: owner }, credentialKind: "session", scopes: [] },
    };
    settings = spyOn(codeSettings, "get").mockImplementation(async (key) =>
      key === "core.code.event_backlog" ? backlog : CODE_SETTINGS[key].default,
    );
    setSystemTime(new Date("2026-11-06T12:00:00Z"));
  });
  beforeEach(async () => {
    stopConsumer?.();
    stopConsumer = startCodeEventConsumer();
    await sql`TRUNCATE events.app_deliveries,events.app_subscriptions,events.app_events,events.app_declarations,events.app_manifests RESTART IDENTITY CASCADE`.simple();
    await sql`DELETE FROM code.codes`;
    await sql`DELETE FROM auth.mandates`;
    await sql`INSERT INTO auth.service_accounts(id,name,kind,created_by) VALUES(${principal}::uuid,${`code:${place.type}:${place.id}`},'code',${owner}::uuid)`;
    await sql`INSERT INTO code.codes(id,owner_kind,owner_type,owner_id,service_account_id,title,state,created_by)
      VALUES(${codeId},'resource',${place.type},${place.id},${principal}::uuid,'Events','draft',${owner}::uuid)`;
    await sql`INSERT INTO auth.access(id,user_id,permission) VALUES(${id(3)}::uuid,${owner}::uuid,'write')`;
    await sql`INSERT INTO code.shares(code_id,access_id) VALUES(${codeId},${id(3)}::uuid)`;
    readable = true;
    backlog = 100;
    sequence = 0;
    number = 0;
    broker = makeBroker();
    await version();
    await activate();
  });
  afterAll(async () => {
    stopConsumer?.();
    settings?.mockRestore();
    unbindProcessSync();
    await sync?.drain({ timeoutMs: 1000 });
    await connection?.drain();
    setSystemTime();
    await sql.close();
    await database?.drop();
  });

  test("duplicate delivery after admission committed but acknowledgement was lost reuses the receipt and run outbox", async () => {
    const envelope = await publish(10);
    await makeBroker(true).work();
    expect(await runs()).toHaveLength(1);
    expect(await sql`SELECT run_id FROM code.run_outbox`).toHaveLength(1);
    expect(await sql`SELECT run_id FROM code.run_requests WHERE request_key=${`event:${envelope.id}`}`).toHaveLength(1);
    await readyRetries();
    // Reconstructed broker models restart; no in-memory dedupe participates.
    broker = makeBroker();
    await broker.accept(envelope, ++sequence);
    await broker.work();
    expect(await runs()).toHaveLength(1);
    expect((await broker.deliveries()).items[0]).toMatchObject({ state: "done" });
    expect((await runs())[0]).toMatchObject({ version_id: versionId, input: envelope });
    // Receipts outlive detail retention and cannot recreate a deleted detail.
    await sql`DELETE FROM code.runs`;
    await admitCodeEvent(binding, envelope, { subscriptionId, eventId: envelope.id, attempt: 3, signal: new AbortController().signal });
    expect(await runs()).toHaveLength(0);
  });
  test("concurrent admission creates one receipt, one run and one wakeup", async () => {
    const envelope = await publish(24);
    await broker.claim();
    const context = { subscriptionId, eventId: envelope.id, attempt: 1, signal: new AbortController().signal };
    await Promise.all([admitCodeEvent(binding, envelope, context), admitCodeEvent(binding, envelope, context)]);
    expect(await runs()).toHaveLength(1);
    expect(await sql`SELECT run_id FROM code.run_outbox`).toHaveLength(1);
    expect(await sql`SELECT run_id FROM code.run_requests WHERE request_key LIKE 'event:%'`).toHaveLength(1);
  });
  test("a claimed event's nested reader dependency retains its proof and requires the matching parent lease", async () => {
    const envelope = await publish(29);
    await broker.claim();
    const proof = {
      sub: principal,
      principal_type: "service_account" as const,
      access_subject_type: "service_account" as const,
      access_subject_id: principal,
      act: { sub: "app:fixture" as const },
      credential_kind: "mandate" as const,
      scopes: [],
      exp: 0,
      jti: id(999),
      mandate_id: mandateId,
      mandate_revision: binding.mandateRevision,
      workload_type: "code.version",
      workload_id: versionId,
      workload_event: envelope.id,
      parent_invocation_id: id(998),
    };
    const lease = spyOn(nestedInvocationLeases, "read").mockResolvedValue({ appId: "fixture", deadline: 1, origin: "app" });
    try {
      expect(await resolveInvocationAuthority(proof, sql, [])).not.toBeNull();
      lease.mockResolvedValue(null);
      expect(await resolveInvocationAuthority(proof, sql, [])).toBeNull();
      lease.mockResolvedValue({ appId: "foreign", deadline: 1, origin: "app" });
      expect(await resolveInvocationAuthority(proof, sql, [])).toBeNull();
    } finally {
      lease.mockRestore();
    }
  });
  test("disabling the Code account after the read check still fences admission", async () => {
    const envelope = await publish(25);
    await broker.claim();
    await sql`UPDATE auth.service_accounts SET status='disabled' WHERE id=${principal}::uuid`;
    expect(
      await admitCodeEvent(binding, envelope, { subscriptionId, eventId: envelope.id, attempt: 1, signal: new AbortController().signal }),
    ).toEqual({ cancelled: true });
    expect(await runs()).toHaveLength(0);
  });
  test("foreign places and unavailable read permission never reach a Code run", async () => {
    await broker.accept({ ...event(11), place: { ...place, id: "other" } }, ++sequence);
    await publish(12);
    readable = false;
    await broker.work();
    expect(await runs()).toHaveLength(0);
    expect((await broker.deliveries()).items).toHaveLength(1);
    expect((await broker.deliveries()).items[0]).toMatchObject({ state: "cancelled", code: "resource_access_revoked" });
  });
  test("pause and version switch fence claimed deliveries; resume skips events from the pause", async () => {
    const before = await publish(13);
    const claims = await broker.claim();
    await sql.begin(async (db) => {
      await db`SELECT id FROM code.codes WHERE id=${codeId} FOR UPDATE`;
      await cancelResourceEventSubscriptions(db, CODE_EVENT_CONSUMER, codeId);
      await db`UPDATE code.codes SET state='paused' WHERE id=${codeId}`;
    });
    for (const claim of claims) await broker.deliver(claim);
    const pauseTime = time;
    await activate();
    await broker.accept({ ...event(14), time: pauseTime }, ++sequence);
    await broker.work();
    expect(await runs()).toHaveLength(0);
    const old = await publish(15);
    const oldClaims = await broker.claim();
    const oldVersion = versionId;
    await version();
    await activate();
    for (const claim of oldClaims) await broker.deliver(claim);
    await publish(16);
    await broker.work();
    expect(await runs()).toHaveLength(1);
    expect((await runs())[0]?.version_id).not.toBe(oldVersion);
    expect(await sql`SELECT * FROM code.run_requests WHERE request_key IN (${`event:${before.id}`},${`event:${old.id}`})`).toHaveLength(0);
  });
  test("revocation after authorization still cancels admission", async () => {
    const envelope = await publish(17);
    const claims = await broker.claim();
    await sql`UPDATE auth.mandates SET state='revoked',revision=revision+1,
      revoked_at=clock_timestamp(),revoked_by_app_id='runner',revoke_reason='Fixture revocation'
      WHERE id=${mandateId}::uuid`;
    for (const claim of claims) await broker.deliver(claim);
    expect(await runs()).toHaveLength(0);
    expect(
      await admitCodeEvent(binding, envelope, { subscriptionId, eventId: envelope.id, attempt: 1, signal: new AbortController().signal }),
    ).toEqual({ cancelled: true });
  });
  test("owner deletion cancels an already claimed event before any run is admitted", async () => {
    await publish(26);
    const claims = await broker.claim();
    await sql`SELECT events.enqueue(${id(27)}::uuid,'fixture','code_owner_deleted','collection-a',${JSON.stringify(place)}::text::jsonb)`;
    const [report] = await sql<Parameters<typeof processCodeOwnerDeleted>[0][]>`SELECT * FROM events.outbox WHERE id=${id(27)}::uuid`;
    await processCodeOwnerDeleted(report!);
    for (const claim of claims) await broker.deliver(claim);
    expect(await runs()).toHaveLength(0);
    expect(await findCode(codeId)).toMatchObject({ state: "deleting" });
    expect((await broker.deliveries()).items[0]).toMatchObject({ state: "cancelled" });
  });
  test("pause preserves admitted events and explicit recovery after version switch reuses the never-started run", async () => {
    await publish(28);
    await broker.work();
    const original = (await runs())[0]!;
    await sql.begin(async (db) => {
      await db`SELECT id FROM code.codes WHERE id=${codeId} FOR UPDATE`;
      await cancelResourceEventSubscriptions(db, CODE_EVENT_CONSUMER, codeId);
      await db`UPDATE code.codes SET state='paused' WHERE id=${codeId}`;
    });
    await reconcileCodeRuns();
    expect((await runs())[0]).toMatchObject({ id: original.id, state: "queued" });
    await version();
    await activate();
    await reconcileCodeRuns();
    expect((await runs())[0]).toMatchObject({ id: original.id, state: "failed" });
    const [recoverable] = (await listCodeRunsWithEvents({ codeId, limit: 20 }, editor)).eventDeliveries;
    expect(recoverable).toMatchObject({ eventId: id(28), state: "failed", code: "code_not_active" });
    await replayCodeEventDelivery(codeId, recoverable!.id, editor);
    await broker.work();
    expect(await runs()).toEqual([expect.objectContaining({ id: original.id, version_id: versionId, state: "queued" })]);
    expect(await sql`SELECT * FROM code.run_requests WHERE request_key LIKE 'event:%'`).toHaveLength(1);
    expect(await sql`SELECT * FROM code.run_outbox`).toHaveLength(1);
    // A started attempt is an effect boundary and must never be rebound by delivery replay.
    await sql`UPDATE code.runs SET generation=1,started_at=clock_timestamp(),state='failed',outcome='code_not_active',ended_at=clock_timestamp()`;
    const done = (await broker.deliveries()).items.find(
      (row: Record<string, unknown>) => row.state === "done" && row.code !== "workload_replayed",
    )!;
    await expect(replayCodeEventDelivery(codeId, String(done.id), editor)).rejects.toMatchObject({ code: "CONFLICT" });
  });
  test("backpressure stays failed and visible in the platform queue, then deliberate replay admits one run", async () => {
    backlog = 1;
    await publish(18, "one");
    await broker.work();
    await publish(19, "two");
    for (let i = 0; i < 8; i++) {
      await readyRetries();
      await broker.work();
    }
    const failed = (await broker.deliveries()).items.find((row: Record<string, unknown>) => row.eventId === id(19));
    expect(failed).toMatchObject({ state: "failed", attempts: 8 });
    expect(await runs()).toHaveLength(1);
    const list = await listCodeRunsWithEvents({ codeId, limit: 20 }, editor);
    expect(list.eventDeliveries).toEqual([
      expect.objectContaining({ id: failed!.id, eventId: id(19), state: "failed", code: "code_event_backlog_full" }),
    ]);
    expect(list.eventDeliveries[0]).not.toHaveProperty("data");
    await expect(
      replayCodeEventDelivery(codeId, String(failed!.id), {
        ...editor,
        authority: { ...editor.authority, credentialKind: "api_key", scopes: ["read"] },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(replayCodeEventDelivery(codeId, id(999), editor)).rejects.toMatchObject({ code: "CONFLICT" });
    await sql`UPDATE code.runs SET state='succeeded',ended_at=clock_timestamp()`;
    await version();
    await activate();
    expect((await listCodeRunsWithEvents({ codeId, limit: 20 }, editor)).eventDeliveries).toHaveLength(1);
    expect((await replayCodeEventDelivery(codeId, String(failed!.id), editor)).deliveryId).not.toBe(failed!.id);
    await broker.work();
    expect(await runs()).toHaveLength(2);
    expect((await listCodeRunsWithEvents({ codeId, limit: 20 }, editor)).eventDeliveries).toHaveLength(0);
    expect(await sql`SELECT * FROM code.run_requests WHERE request_key=${`event:${id(19)}`}`).toHaveLength(1);
  });
  const limits = { perCode: 3, perOwner: 10, wallMs: 30000, attempts: 3 };
  function claims(run: Awaited<ReturnType<typeof claimCodeRuns>>[number]): CodeRunTokenClaims {
    return {
      ver: 1,
      token_use: "code_run",
      iss: "https://cloud.test",
      aud: "cloud-code-bridge",
      iat: 0,
      nbf: 0,
      exp: Math.floor(run.deadline_at.getTime() / 1000) + 1,
      codeId: run.code_id,
      versionId: run.version_id,
      runId: run.id,
      entrypoint: run.entrypoint,
      generation: run.generation,
      mandateId: run.mandate_id,
      mandateRevision: run.mandate_revision,
      bundleHash: run.bundle_hash,
    };
  }
  test("different messages of one resource run in receipt order even with raised concurrency", async () => {
    await publish(20);
    await publish(21, "another-message");
    await publish(22, "third-message");
    // Generic resource delivery serializes admission too, including across distinct message subjects.
    for (let n = 0; n < 3; n++) await broker.work();
    for (const expected of [event(20), event(21, "another-message"), event(22, "third-message")]) {
      const next = await claimCodeRuns(3, limits);
      expect(next).toHaveLength(1);
      expect(next[0]!.input).toEqual(expected);
      await completeCodeRun(claims(next[0]!), "succeeded");
    }
  });
  test("bounded retries hold receipt order, then visible failure releases later messages and deliberate replay preserves input", async () => {
    await publish(30);
    await broker.work();
    await publish(31, "later");
    await broker.work();
    let failedId = "";
    for (let n = 0; n < 3; n++) {
      const [run] = await claimCodeRuns(3, limits);
      expect(run?.input).toEqual(event(30));
      failedId = run!.id;
      await completeCodeRun(claims(run!), "failed");
    }
    expect((await runs()).find((run) => run.id === failedId)).toMatchObject({ state: "failed", outcome: "retry_exhausted" });
    const [later] = await claimCodeRuns(3, limits);
    expect(later?.input).toEqual(event(31, "later"));
    await completeCodeRun(claims(later!), "succeeded");
    await expect(
      startCodeRun(
        { codeId, entrypoint: "event:fixture.changed@1", input: event(32), rerunOf: failedId, idempotencyKey: "changed-envelope" },
        editor,
      ),
    ).rejects.toMatchObject({ code: "BAD_INPUT" });
    const replay = await startCodeRun(
      { codeId, entrypoint: "event:fixture.changed@1", input: event(30), rerunOf: failedId, idempotencyKey: "deliberate-replay" },
      editor,
    );
    expect(replay.runId).not.toBe(failedId);
    const [again] = await claimCodeRuns(3, limits);
    expect(again?.input).toEqual(event(30));
    await sql`UPDATE code.runs SET effect_started=true WHERE id=${again!.id}::uuid`;
    await completeCodeRun(claims(again!), "failed");
    expect((await runs()).find((run) => run.id === again!.id)).toMatchObject({ state: "failed", generation: 1 });
    expect(await claimCodeRuns(3, limits)).toEqual([]);
  });
  test("an exhausted resource delivery remains visible without permanently blocking a later message", async () => {
    backlog = 1;
    await publish(40);
    await broker.work();
    await publish(41, "poison");
    await publish(42, "later");
    for (let n = 0; n < 8; n++) {
      await readyRetries();
      await broker.work();
    }
    expect((await broker.deliveries()).items.find((row: Record<string, unknown>) => row.eventId === id(41))).toMatchObject({
      state: "failed",
    });
    await sql`UPDATE code.runs SET state='succeeded',ended_at=clock_timestamp()`;
    await readyRetries();
    await broker.work();
    expect((await runs()).at(-1)?.input).toEqual(event(42, "later"));
  });
  test("the real Mail event reaches mailbox-owned Code through its generic app.on subscription exactly once", async () => {
    const mailbox = { type: "mail.mailbox", id: "Box123" };
    await sql`UPDATE code.codes SET owner_type=${mailbox.type},owner_id=${mailbox.id} WHERE id=${codeId}`;
    await version("mail.message.received", mailbox);
    await activate();
    const envelope = {
      ...appEventFixture(mailCapabilities, "message.received", { subject: "Msg123", place: mailbox.id, data: { receiptId: id(51) } }),
      id: id(50),
      time,
      data: { receiptId: id(51) },
    };
    await broker.accept(envelope, ++sequence);
    await broker.work();
    await broker.accept(envelope, ++sequence);
    await broker.work();
    expect(await runs()).toEqual([
      expect.objectContaining({ input: envelope, entrypoint: "event:mail.message.received@1", version_id: versionId }),
    ]);
    expect((await claimCodeRuns(3, limits))[0]?.input).toEqual(envelope);
  });
  test("catch-up cancels, resumes a pinned snapshot and recovers a dispatch committed before checkpoint without broadcast", async () => {
    const catalog = spyOn(catalogProvider, "getCapabilityCatalogApp").mockResolvedValue({
      ok: true,
      data: { appId: "fixture", appName: "Fixture", appIcon: "box", appDescription: "Fixture", manifest: declaration.manifest },
    });
    const resource = spyOn(eventPlatform, "authorizeResourceEvent").mockResolvedValue(true);
    const source = spyOn(catalogProvider, "invokeCapabilityWithDataSchema").mockImplementation(async (invocation, schema) => {
      const subject = z.object({ id: z.string() }).parse(invocation.input).id;
      const index = Number(subject.replace("message-", ""));
      return { ok: true, data: { data: schema.parse(event(100 + index, subject)) } };
    });
    let stop: (() => Promise<void>) | undefined;
    const input = { operationId: id(60), versionId, events: Array.from({ length: 45 }, (_, n) => event(100 + n, `message-${n}`)) };
    const dispatch = codeEventCatchupPumpConfig.dispatch;
    let lost = false;
    const crash = spyOn(codeEventCatchupPumpConfig, "dispatch").mockImplementation(async (request) => {
      await dispatch(request);
      if (!lost) {
        lost = true;
        throw new Error("fixture_crash_after_run_commit");
      }
    });
    try {
      expect(await startCodeEventCatchup(codeId, input, editor)).toMatchObject({ total: 45, dispatched: 0 });
      expect(await cancelCodeEventCatchup(codeId, input.operationId, editor)).toMatchObject({ status: "canceled", dispatched: 0 });
      expect(await runs()).toHaveLength(0);
      await resumeCodeEventCatchup(codeId, input.operationId, id(61), editor);
      stop = await startCodeEventCatchupRuntime();
      let state = await readCodeEventCatchup(codeId, id(61), editor);
      for (let n = 0; n < 150 && state.status !== "completed"; n++) {
        await Bun.sleep(50);
        state = await readCodeEventCatchup(codeId, id(61), editor);
      }
      expect(state).toMatchObject({ status: "completed", total: 45, dispatched: 45 });
      expect(lost).toBe(true);
      expect(await runs()).toHaveLength(45);
      expect(await sql`SELECT * FROM code.run_requests WHERE request_key LIKE 'catchup:%'`).toHaveLength(45);
      expect(await sql`SELECT * FROM events.app_events`).toHaveLength(0);
      expect(await sql`SELECT * FROM events.app_deliveries`).toHaveLength(0);
      // Lost responses use the exact operation receipt; a fresh operation still skips every admitted message.
      expect(await startCodeEventCatchup(codeId, { ...input, operationId: id(61) }, editor)).toMatchObject({
        status: "completed",
        dispatched: 45,
      });
      await startCodeEventCatchup(codeId, { ...input, operationId: id(62) }, editor);
      for (let n = 0; n < 100; n++) {
        if ((await readCodeEventCatchup(codeId, id(62), editor)).status === "completed") break;
        await Bun.sleep(30);
      }
      expect((await readCodeEventCatchup(codeId, id(62), editor)).status).toBe("completed");
      expect(await runs()).toHaveLength(45);
      // Catch-up first, then delayed generic delivery: one run and one live receipt.
      const delayed = input.events[0]!;
      await broker.accept(delayed, ++sequence);
      await broker.work();
      expect(await runs()).toHaveLength(45);
      expect(await sql`SELECT * FROM code.run_requests WHERE request_key=${`event:${delayed.id}`}`).toHaveLength(1);
      expect(source.mock.calls[0]?.[2]?.authority).toBe(editor.authority);
      source.mockResolvedValueOnce({ ok: false, error: { code: "FORBIDDEN", message: "unavailable", status: 403 } });
      await expect(startCodeEventCatchup(codeId, { ...input, operationId: id(63) }, editor)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await sql`UPDATE code.runs SET state='succeeded',ended_at=clock_timestamp()`;
      backlog = 2;
      const limited = { ...input, operationId: id(65), events: [event(400, "message-300"), event(401, "message-301")] };
      await startCodeEventCatchup(codeId, limited, editor);
      for (let n = 0; n < 100; n++) {
        if ((await readCodeEventCatchup(codeId, id(65), editor)).dispatched === 1) break;
        await Bun.sleep(30);
      }
      expect(await readCodeEventCatchup(codeId, id(65), editor)).toMatchObject({ status: "waiting", dispatched: 1, failureCount: 0 });
      await publish(402, "live-with-reserved-capacity");
      await broker.work();
      expect(await sql`SELECT * FROM code.run_requests WHERE request_key=${`event:${id(402)}`}`).toHaveLength(1);
      await cancelCodeEventCatchup(codeId, id(65), editor);
      await stop();
      stop = undefined;
      await sql`UPDATE code.runs SET state='succeeded',ended_at=clock_timestamp()`;
      const [historical] = await sql<{ id: string; input: AppEventEnvelope }[]>`SELECT id,input FROM code.runs
        WHERE code_id=${codeId} AND input->'subject'->>'id'='message-0'`;
      await sql`UPDATE code.runs SET state='failed',effect_started=true WHERE id=${historical!.id}::uuid`;
      const replay = await startCodeRun(
        {
          codeId,
          entrypoint: "event:fixture.changed@1",
          input: z.json().parse(historical!.input),
          rerunOf: historical!.id,
          idempotencyKey: "historical-deliberate-replay",
        },
        editor,
      );
      expect(
        await sql`SELECT * FROM code.run_requests WHERE run_id=${replay.runId}::uuid AND request_key LIKE 'historical:%'`,
      ).toHaveLength(1);
      await sql`UPDATE code.runs SET state='failed',ended_at=clock_timestamp() WHERE id=${replay.runId}::uuid`;
      await sql`UPDATE code.versions SET manifest=jsonb_set(manifest::jsonb,'{ai}','true'::jsonb) WHERE id=${versionId}::uuid`;
      await expect(
        startCodeRun(
          {
            codeId,
            entrypoint: "event:fixture.changed@1",
            input: z.json().parse(historical!.input),
            rerunOf: replay.runId,
            idempotencyKey: "historical-ai-replay",
          },
          editor,
        ),
      ).rejects.toMatchObject({ code: "BAD_INPUT" });
      await sql`UPDATE auth.service_accounts SET status='disabled' WHERE id=${principal}::uuid`;
      await expect(
        codeEventCatchupPumpConfig.dispatch({
          input: { ...input, codeId, requestDigest: "fixture", capacityDeadline: Date.parse(time) },
          item: { key: "disabled-account", event: event(999, "message-899") },
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    } finally {
      await stop?.();
      crash.mockRestore();
      catalog.mockRestore();
      source.mockRestore();
      resource.mockRestore();
    }
  }, 20000);
});
