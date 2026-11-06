import { afterAll, beforeAll, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import type { CodeCheckedVersionManifest } from "@k2b/cloud/contracts";
import type { AppEventEnvelope } from "@k2b/cloud/contracts/app-events";
import type { CapabilityRegistryEntry } from "@k2b/cloud/contracts/registry";
import { accounts } from "@k2b/cloud/services";
import { cancelResourceEventSubscriptions, createAppEventBroker, type ResourceEventBinding } from "@k2b/cloud/services/app-events";
import { resolveInvocationAuthority } from "@k2b/cloud/services/identity/invocation-actor";
import { z } from "zod";
import { databaseSuite, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { migrate as migrateAppApproval } from "../migrate/core/app-approval";
import { migrate as migrateAppEvents } from "../migrate/core/app-events";
import { migrate as migrateAudit } from "../migrate/core/audit";
import { migrate as migrateAuth } from "../migrate/core/auth";
import { migrate as migrateCode } from "../migrate/core/code";
import { migrate as migrateLifecycle } from "../migrate/core/code-lifecycle";
import { migrate as migratePolicy } from "../migrate/core/code-policy";
import { migrate as migrateScheduling } from "../migrate/core/code-scheduling";
import { migrate as migrateVersions } from "../migrate/core/code-versions";
import { migrate as migrateEvents } from "../migrate/core/events";
import { migrate as migrateSettings } from "../migrate/core/settings";
import type { CodeContext } from "./access";
import { CODE_EVENT_CONSUMER, syncCodeEventSubscriptions } from "./event-subscriptions";
import { admitCodeEvent, listCodeRunsWithEvents, replayCodeEventDelivery, startCodeEventConsumer } from "./events";
import { processCodeOwnerDeleted } from "./lifecycle";
import { claimCodeRuns } from "./scheduling";
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
      collection: { title: "Collection", description: "Fixture collection." },
    },
    events: {
      changed: {
        version: 1,
        title: "Changed",
        description: "An item changed.",
        subject: "item",
        place: "collection",
        schema: z.strictObject({ id: z.string() }),
      },
    },
  }),
};

databaseSuite()("Code event delivery to durable run admission", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
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
      registry: async () => [declaration],
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
  async function version() {
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
          entrypoint: "event:fixture.changed@1",
          cron: null,
          file: "code.ts",
          line: 1,
          event: { type: "fixture.changed", version: 1, place },
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
    await migrateAuth();
    await migrateAppApproval();
    await migrateAudit();
    await migrateSettings();
    await migrateEvents();
    await migrateAppEvents();
    await migrateCode();
    await migratePolicy();
    await migrateVersions();
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
    expect(await sql`SELECT run_id FROM code.run_requests`).toHaveLength(1);
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
    await sql`UPDATE auth.mandates SET state='revoked',revision=revision+1 WHERE id=${mandateId}::uuid`;
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
    expect(await replayCodeEventDelivery(codeId, String(failed!.id), editor)).toEqual({ deliveryId: failed!.id });
    await broker.work();
    expect(await runs()).toHaveLength(2);
    expect((await listCodeRunsWithEvents({ codeId, limit: 20 }, editor)).eventDeliveries).toHaveLength(0);
    expect(await sql`SELECT * FROM code.run_requests WHERE request_key=${`event:${id(19)}`}`).toHaveLength(1);
  });
  test("one subject runs in admission order even when per-Code concurrency is increased", async () => {
    await publish(20);
    await publish(21);
    await publish(22, "independent");
    await broker.work();
    const limits = { perCode: 3, perOwner: 10, wallMs: 30000, attempts: 3 };
    const first = await claimCodeRuns(3, limits);
    expect(first).toHaveLength(2);
    expect(first.map((run) => run.input)).toEqual(expect.arrayContaining([event(20), event(22, "independent")]));
    await sql`UPDATE code.runs SET state='succeeded',ended_at=clock_timestamp() WHERE id=${(await runs())[0]!.id}::uuid`;
    const next = await claimCodeRuns(3, limits);
    expect(next).toHaveLength(1);
    expect(next[0]?.input).toEqual(event(21));
  });
});
