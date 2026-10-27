import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import type { AppEventEnvelope } from "@k2b/cloud/contracts/app-events";
import type { CapabilityRegistryEntry } from "@k2b/cloud/contracts/registry";
import { createAppEventBroker } from "@k2b/cloud/services/app-events";
import { createSync, type TopicDeadLetter } from "@k2b/sync";
import { sql } from "bun";
import { z } from "zod";
import { connectTestNats, suiteFor, testFor, testInfra, testSyncNamespace, useFreshDatabase } from "../../../scripts/fixtures/test-infra";
import { migrate as migrateAppEvents } from "./migrate/core/app-events";
import { migrate as migrateAudit } from "./migrate/core/audit";
import { migrate as migrateEvents } from "./migrate/core/events";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const schema = z.strictObject({ id: z.uuid() });
const entry = (appId: string, subscriptions = false): CapabilityRegistryEntry => ({
  appId,
  appName: appId,
  appDescription: "Test event application.",
  appIcon: "box",
  endpoint: `http://${appId}:3000/api/_internal/capabilities/v1`,
  manifest: compileCapabilityManifest(
    appId,
    subscriptions
      ? { protocolVersion: 2, subscribes: { "eventsource.changed": { version: 1, schema, run: async () => {} } } }
      : {
          protocolVersion: 2,
          types: { item: { title: "Item", description: "An item." } },
          events: { changed: { version: 1, title: "Changed", description: "An item changed.", subject: "item", schema } },
        },
  ),
});
const event = (n: number, subject = id(100)): AppEventEnvelope => ({
  id: id(n),
  type: "eventsource.changed",
  version: 1,
  source: "eventsource",
  time: "2000-01-01T00:00:00.000Z",
  subject: { type: "eventsource.item", id: subject },
  data: { id: subject },
});
let database: Awaited<ReturnType<typeof useFreshDatabase>> | undefined;
beforeAll(async () => {
  if (!testInfra.database) return;
  database = await useFreshDatabase("app_event_broker");
  await migrateEvents();
  await migrateAppEvents();
  await migrateAudit();
});
afterAll(async () => {
  if (database) {
    await sql.close();
    await database.drop();
  }
});

suiteFor("database")("Core app event broker", () => {
  let entries: CapabilityRegistryEntry[];
  let statuses: Map<string, number>;
  const delivered: string[] = [];
  let broker: ReturnType<typeof createAppEventBroker>;
  let firstSequence: number;
  let deadLetters: TopicDeadLetter<AppEventEnvelope>[];
  const makeBroker = () =>
    createAppEventBroker({
      deadLetters: async (after) => deadLetters.filter(({ messageId }) => !after || Number(messageId) > Number(after)).slice(0, 100),
      streams: async function* () {
        yield { id: "cloud:app-events", firstSequence };
      },
      registry: async () => entries,
      getApp: async (appId) => entries.find((entry) => entry.appId === appId) ?? null,
      sign: async () => "fixture",
      fetch: Object.assign(
        async (input: RequestInfo | URL) => {
          const host = new URL(String(input)).hostname;
          delivered.push(host);
          return new Response(null, { status: statuses.get(host) ?? 200 });
        },
        { preconnect: fetch.preconnect },
      ),
    });
  beforeEach(async () => {
    await sql`TRUNCATE events.app_deliveries,events.app_subscriptions,events.app_events,events.app_declarations,events.app_manifests RESTART IDENTITY CASCADE`.simple();
    await sql`UPDATE events.app_broker_status SET last_sequence=0,state='ready',gap_from=NULL,gap_to=NULL`;
    await sql`DELETE FROM audit.events WHERE action LIKE 'app_events.%'`;
    entries = [entry("eventsource"), entry("receivera", true), entry("receiverb", true)];
    statuses = new Map();
    firstSequence = 1;
    deadLetters = [];
    delivered.length = 0;
    broker = makeBroker();
  });
  test("duplicate consumption creates one event and one row per independent subscriber", async () => {
    await broker.accept(event(1), 1);
    await broker.accept(event(1), 1);
    expect((await broker.deliveries()).items).toHaveLength(2);
    const subscriptions = await broker.subscriptions();
    expect(subscriptions.items).toHaveLength(2);
    const firstSeen = await sql`SELECT FROM audit.events WHERE action='app_events.subscription.first_seen'`;
    expect(firstSeen).toHaveLength(2);
    statuses.set("receivera", 503);
    await broker.work();
    expect((await broker.deliveries({ app: "receivera" })).items[0]?.state).toBe("retrying");
    expect((await broker.deliveries({ app: "receiverb" })).items[0]?.state).toBe("done");
  });
  test("removed subscription cancels pending deliveries permanently", async () => {
    await broker.accept(event(2), 1);
    entries = entries.map((receiver) =>
      receiver.appId === "receivera" ? { ...receiver, manifest: { ...receiver.manifest, subscribes: [] } } : receiver,
    );
    await broker.work();
    expect((await broker.deliveries({ app: "receivera" })).items[0]).toMatchObject({ state: "cancelled", code: "subscription_removed" });
    entries = entries.map((receiver) => (receiver.appId === "receivera" ? entry("receivera", true) : receiver));
    await broker.work();
    expect(delivered).not.toContain("receivera");
  });
  test("resource declarations block subscriptions visibly and never deliver", async () => {
    const source = entries[0]!;
    source.manifest.events![0]!.place = "item";
    await broker.accept({ ...event(3), place: { type: "eventsource.item", id: id(100) } }, 1);
    expect(
      (await broker.subscriptions()).items.every(
        (sub: Record<string, unknown>) => sub.state === "blocked" && sub.reason === "resource_events_unsupported",
      ),
    ).toBe(true);
    expect((await broker.deliveries()).items).toHaveLength(0);
    expect(await broker.work()).toBe(0);
  });
  test("bounded retry ends failed, audits it, redelivers the same ID and preserves subject order", async () => {
    entries = entries.filter((entry) => entry.appId !== "receiverb");
    statuses.set("receivera", 503);
    await broker.accept(event(4), 1);
    await broker.accept(event(5), 2);
    await broker.accept(event(6, id(101)), 3);
    for (let attempt = 0; attempt < 8; attempt++) {
      await sql`UPDATE events.app_deliveries SET next_attempt_at='2000-01-01T00:00:00Z'`;
      await broker.work();
    }
    const rows = (await broker.deliveries()).items;
    expect(rows.find((row: Record<string, unknown>) => row.eventId === id(4))).toMatchObject({ state: "failed", attempts: 8 });
    expect(rows.find((row: Record<string, unknown>) => row.eventId === id(5))).toMatchObject({
      state: "pending",
      attempts: 0,
      heldBy: expect.any(String),
    });
    expect(rows.find((row: Record<string, unknown>) => row.eventId === id(6))).toMatchObject({ state: "failed", attempts: 8 });
    const first = rows.find((row: Record<string, unknown>) => row.eventId === id(4))!;
    expect(await broker.redeliver(String(first.id), { uid: "operator" })).toMatchObject({ eventId: id(4) });
    statuses.set("receivera", 200);
    await broker.work();
    expect((await broker.deliveries()).items.find((row: Record<string, unknown>) => row.eventId === id(4))).toMatchObject({
      eventId: id(4),
      state: "done",
      attempts: 1,
    });
    expect((await broker.deliveries()).items.find((row: Record<string, unknown>) => row.eventId === id(5))?.state).toBe("done");
    expect(await sql`SELECT FROM audit.events WHERE action='app_events.delivery.failed'`).toHaveLength(2);
    expect(await sql`SELECT FROM audit.events WHERE action='app_events.delivery.redeliver'`).toHaveLength(1);
  });
  test("publisher offline uses persisted validation; an offline subscriber keeps and later drains all deliveries without spending attempts", async () => {
    await broker.accept(event(10), 1);
    entries = entries.filter(({ appId }) => appId !== "receivera" && appId !== "eventsource");
    broker = makeBroker();
    await broker.accept(event(11), 2);
    await broker.accept({ ...event(12), data: { id: "invalid" } }, 3);
    await broker.work();
    const held = (await broker.deliveries({ app: "receivera" })).items;
    expect(held).toHaveLength(2);
    expect(held.every((row: Record<string, unknown>) => row.attempts === 0 && row.state !== "cancelled")).toBe(true);
    expect((await broker.subscriptions("receivera")).items[0]).toMatchObject({ state: "active", reason: null });
    expect((await sql`SELECT state,code FROM events.app_events WHERE id=${id(12)}::uuid`)[0]).toMatchObject({
      state: "rejected",
      code: "schema_mismatch",
    });
    entries.push(entry("receivera", true));
    await sql`UPDATE events.app_deliveries SET next_attempt_at='2000-01-01T00:00:00Z'`;
    await broker.work();
    expect(
      (await broker.deliveries({ app: "receivera" })).items.every(
        (row: Record<string, unknown>) => row.state === "done" && row.attempts === 1,
      ),
    ).toBe(true);
  });
  test("a genuinely never-seen declaration retries twice then is rejected and does not stall subsequent ingestion", async () => {
    entries = entries.filter(({ appId }) => appId !== "eventsource");
    await expect(broker.accept(event(13), 1, 1)).rejects.toThrow("registration is not ready");
    await expect(broker.accept(event(13), 1, 2)).rejects.toThrow("registration is not ready");
    await broker.accept(event(13), 1, 3);
    expect((await sql`SELECT state,code FROM events.app_events`)[0]).toMatchObject({ state: "rejected", code: "event_not_declared" });
    entries.push(entry("eventsource"));
    await broker.accept(event(14), 2, 1);
    expect((await broker.deliveries()).items).toHaveLength(2);
    expect((await broker.subscriptions()).items.every((subscription: Record<string, unknown>) => subscription.state === "active")).toBe(
      true,
    );
  });
  test("dead-lettered and replayed sequences do not imply eviction; real eviction persists until an audited acknowledgement", async () => {
    deadLetters.push({
      messageId: "1",
      eventId: id(15),
      consumer: "core-app-events-v1",
      tenantId: "default",
      data: event(15),
      attempts: 8,
      failedAt: new Date("2000-01-01T00:00:00Z"),
      reason: "handler_failed",
      replayAvailable: true,
      event: {
        data: event(15),
        eventId: id(15),
        sequence: 1,
        cursor: "fixture",
        tenantId: "default",
        publishedAt: new Date("2000-01-01T00:00:00Z"),
      },
    });
    firstSequence = 2;
    await broker.checkGap();
    expect(await broker.status()).toMatchObject({ state: "ready", lastSequence: "1" });
    await broker.accept(event(16), 2);
    await broker.accept(event(15), 1);
    expect(await broker.status()).toMatchObject({ state: "ready", lastSequence: "2" });
    firstSequence = 5;
    await broker.accept(event(17), 5);
    expect(await broker.status()).toMatchObject({ state: "gap_detected", code: "reconcile_required", gapFrom: "3", gapTo: "4" });
    expect(await broker.acknowledgeGap({ uid: "operator" })).toMatchObject({ state: "ready" });
    await broker.checkGap();
    expect(await broker.status()).toMatchObject({ state: "ready", gapFrom: null, gapTo: null });
    expect(await sql`SELECT FROM audit.events WHERE action='app_events.gap.acknowledge'`).toHaveLength(1);
  });
  test("dead-letter progress spans more than one administration page without inventing a retention gap", async () => {
    deadLetters = Array.from({ length: 150 }, (_, index) => {
      const sequence = index + 1;
      return {
        messageId: String(sequence),
        eventId: id(sequence),
        consumer: "core-app-events-v1",
        tenantId: "default",
        data: event(sequence),
        attempts: 8,
        failedAt: new Date("2000-01-01T00:00:00Z"),
        reason: "handler_failed",
        replayAvailable: true,
        event: {
          data: event(sequence),
          eventId: id(sequence),
          sequence,
          cursor: "fixture",
          tenantId: "default",
          publishedAt: new Date("2000-01-01T00:00:00Z"),
        },
      };
    });
    firstSequence = 151;
    await broker.checkGap();
    expect(await broker.status()).toMatchObject({ state: "ready", lastSequence: "150" });
  });
  test("an expired eighth claim fails visibly without ever sending attempt nine", async () => {
    await broker.accept(event(18), 1);
    await sql`UPDATE events.app_deliveries SET attempts=8,claimed_until=now()-interval '1 second',claim_token=gen_random_uuid()`;
    await broker.work();
    expect(delivered).toHaveLength(0);
    expect(
      (await broker.deliveries()).items.every(
        (row: Record<string, unknown>) => row.state === "failed" && row.code === "attempts_exhausted" && row.attempts === 8,
      ),
    ).toBe(true);
    expect(await sql`SELECT FROM audit.events WHERE action='app_events.delivery.failed'`).toHaveLength(2);
  });
  test("subscription transitions are audited, persisted in the catalog, and unchanged manifests/read APIs do not write", async () => {
    entries = [entry("receivera", true)];
    await broker.reconcileSubscriptions();
    expect((await broker.subscriptions()).items[0]).toMatchObject({ state: "blocked", reason: "event_not_declared" });
    entries.push(entry("eventsource"));
    await broker.reconcileSubscriptions();
    const first = (await broker.subscriptions()).items[0]!;
    const [before] = await sql`SELECT xmin::text AS revision,updated_at FROM events.app_subscriptions`;
    await broker.reconcileSubscriptions();
    await broker.subscriptions();
    expect((await sql`SELECT xmin::text AS revision,updated_at FROM events.app_subscriptions`)[0]).toEqual(before);
    const source = entries.find(({ appId }) => appId === "eventsource")!;
    source.manifest.events![0]!.place = "item";
    await broker.reconcileSubscriptions();
    source.manifest.events![0]!.place = undefined;
    await broker.reconcileSubscriptions();
    entries[0]!.manifest.subscribes = [];
    await broker.reconcileSubscriptions();
    const subscriber = (await broker.catalog()).events[0]!.subscribers[0]!;
    expect(subscriber).toMatchObject({ state: "cancelled", reason: "subscription_removed", firstSeenAt: first.firstSeenAt.toISOString() });
    expect(await sql`SELECT FROM audit.events WHERE action='app_events.subscription.state_changed'`).toHaveLength(4);
  });
  test("an offline backlog still ends visibly at the 30-day retention bound", async () => {
    await broker.accept(event(19), 1);
    entries = [];
    await sql`UPDATE events.app_deliveries SET created_at=now()-interval '31 days'`;
    await broker.retain();
    expect(
      (await broker.deliveries()).items.every(
        (row: Record<string, unknown>) => row.state === "cancelled" && row.code === "retention_expired",
      ),
    ).toBe(true);
  });
  testFor("database", "nats")(
    "actual JetStream byte eviction raises a persistent gap from the stream's first sequence",
    async () => {
      const connection = await connectTestNats({ ignoreClusterUpdates: true });
      const sync = createSync({
        connection,
        application: "cloud",
        namespace: testSyncNamespace("event-eviction"),
        defaults: { replicas: 1 },
      });
      let topic: ReturnType<typeof sync.topic<AppEventEnvelope>> | undefined;
      try {
        topic = sync.topic<AppEventEnvelope>({
          id: "cloud:app-events",
          maxPayloadBytes: 1024,
          dedupeWindowMs: 10_000,
          retention: { maxAgeMs: 60_000, maxBytes: 2048 },
          deadLetterRetention: { maxAgeMs: 60_000, maxBytes: 8192 },
        });
        await topic.ready();
        for (let number = 20; number < 40; number++) await topic.publish({ data: event(number) });
        let firstRetained = 0;
        for await (const stream of sync.listTopics({ idPrefix: "cloud:app-events" })) firstRetained = stream.firstSequence;
        expect(firstRetained).toBeGreaterThan(1);
        const retainedBroker = createAppEventBroker({
          registry: async () => [],
          deadLetters: async () => [],
          streams: () => sync.listTopics({ idPrefix: "cloud:app-events" }),
        });
        await retainedBroker.checkGap();
        expect(await retainedBroker.status()).toMatchObject({ state: "gap_detected", gapFrom: "1", gapTo: String(firstRetained - 1) });
        await retainedBroker.acknowledgeGap({ uid: "operator" });
        await retainedBroker.checkGap();
        expect(await retainedBroker.status()).toMatchObject({ state: "ready" });
      } finally {
        await topic?.destroy();
        await sync.drain();
        await connection.drain();
      }
    },
    30_000,
  );
});
