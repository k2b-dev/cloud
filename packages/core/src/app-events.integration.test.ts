import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import type { AppEventEnvelope } from "@k2b/cloud/contracts/app-events";
import type { CapabilityRegistryEntry } from "@k2b/cloud/contracts/registry";
import { createAppEventBroker } from "@k2b/cloud/services/app-events";
import { createSync, type TopicDeadLetter } from "@k2b/sync";
import { z } from "zod";
import { connectTestNats, suiteFor, testFor, testInfra, testSyncNamespace, useFreshDatabase } from "../../../scripts/fixtures/test-infra";
import { migrate as migrateAppEvents } from "./migrate/core/app-events";
import { migrate as migrateAudit } from "./migrate/core/audit";
import { migrate as migrateEvents } from "./migrate/core/events";
import { migrate as migrateLogging } from "./migrate/core/logging";

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
  await migrateLogging();
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
  let fetchError: Error | undefined;
  let registryUnavailable: boolean;
  let streamReads: number;
  let deadLetters: TopicDeadLetter<AppEventEnvelope>[];
  const makeBroker = () =>
    createAppEventBroker({
      deadLetters: async (after) => deadLetters.filter(({ messageId }) => !after || Number(messageId) > Number(after)).slice(0, 100),
      streams: async function* () {
        streamReads++;
        yield { id: "cloud:app-events", firstSequence };
      },
      registry: async () => {
        if (registryUnavailable) throw new Error("Registry unavailable");
        return entries;
      },
      getApp: async (appId) => entries.find((entry) => entry.appId === appId) ?? null,
      sign: async () => "fixture",
      fetch: Object.assign(
        async (input: RequestInfo | URL) => {
          const host = new URL(String(input)).hostname;
          delivered.push(host);
          if (fetchError) throw fetchError;
          return new Response(null, { status: statuses.get(host) ?? 200 });
        },
        { preconnect: fetch.preconnect },
      ),
    });
  beforeEach(async () => {
    await sql`TRUNCATE events.app_deliveries,events.app_subscriptions,events.app_events,events.app_declarations,events.app_manifests RESTART IDENTITY CASCADE`.simple();
    await sql`UPDATE events.app_broker_status SET last_sequence=0,state='ready',gap_from=NULL,gap_to=NULL,unseen_sequences='{}'::int8multirange`;
    await sql`DELETE FROM audit.events WHERE action LIKE 'app_events.%'`;
    entries = [entry("eventsource"), entry("receivera", true), entry("receiverb", true)];
    statuses = new Map();
    firstSequence = 1;
    fetchError = undefined;
    registryUnavailable = false;
    streamReads = 0;
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
    await broker.checkGap();
    expect(await broker.status()).toMatchObject({ state: "gap_detected", code: "reconcile_required", gapFrom: "3", gapTo: "4" });
    expect(await broker.acknowledgeGap({ uid: "operator" })).toMatchObject({ state: "ready" });
    await broker.checkGap();
    expect(await broker.status()).toMatchObject({ state: "ready", gapFrom: null, gapTo: null });
    expect(await sql`SELECT FROM audit.events WHERE action='app_events.gap.acknowledge'`).toHaveLength(1);
  });
  test("periodic gap detection preserves holes until out-of-order replay or DLQ progress accounts for them", async () => {
    await broker.accept(event(80), 1);
    await broker.accept(event(84), 5);
    await broker.accept(event(82), 3);
    await broker.accept(event(81), 2);
    await broker.markSeen(4); // Malformed messages without an ID still count as observed.
    firstSequence = 5;
    await broker.checkGap();
    expect(await broker.status()).toMatchObject({ state: "ready", lastSequence: "5" });
    expect((await sql`SELECT unseen_sequences::text AS holes FROM events.app_broker_status`)[0]!.holes).toBe("{}");
    await broker.accept(event(87), 8);
    deadLetters = [6, 7].map((sequence) => ({
      messageId: String(sequence),
      eventId: id(80 + sequence),
      consumer: "core-app-events-v1",
      tenantId: "default",
      data: event(80 + sequence),
      attempts: 8,
      failedAt: new Date("2000-01-01T00:00:00Z"),
      reason: "handler_failed",
      replayAvailable: true,
      event: {
        data: event(80 + sequence),
        eventId: id(80 + sequence),
        sequence,
        cursor: "fixture",
        tenantId: "default",
        publishedAt: new Date("2000-01-01T00:00:00Z"),
      },
    }));
    firstSequence = 8;
    await broker.checkGap();
    expect(await broker.status()).toMatchObject({ state: "ready", lastSequence: "8" });
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
  test("migration backfills retention from creation and indexes the event foreign key", async () => {
    await broker.accept(event(91), 1);
    await sql`UPDATE events.app_deliveries SET created_at='2000-01-01T00:00:00Z'`;
    await sql`ALTER TABLE events.app_deliveries DROP COLUMN retained_from`.simple();
    await migrateAppEvents();
    expect(await sql`SELECT FROM events.app_deliveries WHERE retained_from <> created_at`).toHaveLength(0);
    expect(
      (await sql`SELECT indexdef FROM pg_indexes WHERE schemaname='events' AND indexname='app_deliveries_event'`)[0]!.indexdef,
    ).toContain("(event_id)");
  });
  test("an offline backlog still ends visibly at the 30-day retention bound", async () => {
    await broker.accept(event(19), 1);
    entries = [];
    await sql`UPDATE events.app_deliveries SET created_at=now()-interval '31 days',retained_from=now()-interval '31 days'`;
    await broker.retain();
    expect(
      (await broker.deliveries()).items.every(
        (row: Record<string, unknown>) => row.state === "cancelled" && row.code === "retention_expired",
      ),
    ).toBe(true);
  });
  test.each([
    ["timeout", () => new DOMException("Handler timed out", "TimeoutError"), "handler_timeout"],
    ["reset after send", () => Object.assign(new Error("Connection reset"), { code: "ECONNRESET" }), "connection_lost"],
  ])("%s consumes attempts and ends failed after eight requests", async (_label, error, code) => {
    entries = entries.filter(({ appId }) => appId !== "receiverb");
    await broker.accept(event(40), 1);
    fetchError = error();
    for (let attempt = 1; attempt <= 8; attempt++) {
      await sql`UPDATE events.app_deliveries SET next_attempt_at='2000-01-01T00:00:00Z'`;
      await broker.work();
      expect((await broker.deliveries()).items[0]).toMatchObject({
        attempts: attempt,
        state: attempt === 8 ? "failed" : "retrying",
        code,
      });
    }
    await broker.work();
    expect(delivered).toHaveLength(8);
    expect(await sql`SELECT FROM audit.events WHERE action='app_events.delivery.failed'`).toHaveLength(1);
  });
  test.each(["ECONNREFUSED", "ConnectionRefused"])("connect refusal (%s) postpones without spending handler attempts", async (code) => {
    await broker.accept(event(41), 1);
    fetchError = Object.assign(new Error("Connection refused"), { code });
    await broker.work();
    expect((await broker.deliveries()).items).toHaveLength(2);
    for (const row of (await broker.deliveries()).items) {
      expect(row).toMatchObject({ attempts: 0, state: "retrying", code: "subscriber_unreachable" });
    }
  });
  test("Core waits longer than the subscriber deadline and stale HTTP 410 responses spend attempts", async () => {
    await broker.accept(event(88), 1);
    const timeout = spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      expect(milliseconds).toBe(45_000);
      return new AbortController().signal;
    });
    statuses.set("receivera", 410);
    try {
      await broker.work();
      expect((await broker.deliveries({ app: "receivera" })).items[0]).toMatchObject({
        state: "retrying",
        attempts: 1,
        code: "subscription_unavailable",
      });
    } finally {
      timeout.mockRestore();
    }
  });
  test("a PostgreSQL envelope CHECK failure is rejected and the next valid event is accepted", async () => {
    await broker.reconcileSubscriptions();
    await sql`ALTER TABLE events.app_events ADD CONSTRAINT test_envelope_budget CHECK(octet_length(envelope::text) <= 256)`.simple();
    try {
      await broker.accept(event(89), 1, 1);
    } finally {
      await sql`ALTER TABLE events.app_events DROP CONSTRAINT test_envelope_budget`.simple();
    }
    await broker.accept(event(90), 2, 1);
    expect((await sql`SELECT state,code FROM events.app_events WHERE id=${id(89)}::uuid`)[0]).toMatchObject({
      state: "rejected",
      code: "event_too_large",
    });
    expect((await sql`SELECT state FROM events.app_events WHERE id=${id(90)}::uuid`)[0]!.state).toBe("accepted");
  });
  test("poison envelopes, stored schemas and PostgreSQL data errors do not stall the next event", async () => {
    await broker.accept({ ...event(42), futureMetadata: "compatible" }, 1, 1);
    expect((await sql`SELECT state,envelope FROM events.app_events WHERE id=${id(42)}::uuid`)[0]).toMatchObject({ state: "accepted" });
    expect((await sql`SELECT envelope FROM events.app_events WHERE id=${id(42)}::uuid`)[0]!.envelope).not.toHaveProperty("futureMetadata");
    await broker.accept({ ...event(43), subject: null }, 2, 1);
    await broker.accept({ ...event(44), data: { huge: "x".repeat(5000) } }, 3, 1);
    await sql`UPDATE events.app_declarations SET data_schema='{"$ref":"#/missing"}'::jsonb`;
    await broker.accept(event(45), 4, 1);
    await sql`UPDATE events.app_declarations SET data_schema=${JSON.stringify(z.toJSONSchema(schema))}::text::jsonb`;
    await broker.accept({ ...event(46), subject: { type: "eventsource.item", id: "invalid\u0000postgres" } }, 5, 1);
    await broker.accept({ ...event(47), id: "not-a-uuid" }, 6, 1);
    await broker.accept(event(48), 7, 1);
    expect((await sql`SELECT state,code FROM events.app_events WHERE id=${id(43)}::uuid`)[0]).toMatchObject({
      state: "rejected",
      code: "invalid_envelope",
    });
    expect((await sql`SELECT state,code FROM events.app_events WHERE id=${id(44)}::uuid`)[0]).toMatchObject({
      state: "rejected",
      code: "event_too_large",
    });
    expect((await sql`SELECT state,code FROM events.app_events WHERE id=${id(45)}::uuid`)[0]).toMatchObject({
      state: "rejected",
      code: "invalid_declaration_schema",
    });
    expect((await sql`SELECT state,code FROM events.app_events WHERE id=${id(46)}::uuid`)[0]).toMatchObject({
      state: "rejected",
      code: "invalid_envelope",
    });
    expect((await sql`SELECT state FROM events.app_events WHERE id=${id(48)}::uuid`)[0]!.state).toBe("accepted");
    expect(await broker.status()).toMatchObject({ lastSequence: "7", rejectedCount: 4 });
    expect(streamReads).toBe(0);
  });
  test("ingestion continues with stored declarations when registry refresh fails and does not inspect the DLQ", async () => {
    await broker.reconcileSubscriptions();
    registryUnavailable = true;
    await broker.accept(event(49), 1, 1);
    expect((await sql`SELECT state FROM events.app_events`)[0]!.state).toBe("accepted");
    expect((await broker.deliveries()).items).toHaveLength(2);
    expect(streamReads).toBe(0);
  });
  test("redelivery renews the retention window and preserves the old referenced event", async () => {
    await broker.accept(event(50), 1);
    await sql`UPDATE events.app_events SET received_at=now()-interval '40 days'`;
    await sql`UPDATE events.app_deliveries SET state='failed',created_at=now()-interval '40 days',retained_from=now()-interval '40 days'`;
    const first = (await broker.deliveries()).items[0]!;
    await broker.redeliver(String(first.id), { uid: "operator" });
    await sql`UPDATE events.app_deliveries SET state='cancelled',updated_at=now()-interval '8 days' WHERE id <> ${String(first.id)}::uuid`;
    await broker.retain();
    expect((await broker.deliveries()).items).toHaveLength(1);
    expect((await broker.deliveries()).items.find((row: Record<string, unknown>) => row.id === first.id)).toMatchObject({
      state: "pending",
      code: null,
    });
    expect(await sql`SELECT FROM events.app_events WHERE id=${id(50)}::uuid`).toHaveLength(1);
    await broker.work();
    expect((await broker.deliveries()).items.find((row: Record<string, unknown>) => row.id === first.id)!.state).toBe("done");
  });
  test("live removal retires declarations, blocks subscriptions with audit and visibly rejects subsequent events", async () => {
    await broker.accept(event(51), 1);
    entries[0]!.manifest.events = [];
    await broker.reconcileSubscriptions();
    await broker.accept(event(52), 2, 1);
    expect((await sql`SELECT retired_at FROM events.app_declarations`)[0]!.retired_at).toBeInstanceOf(Date);
    expect((await broker.catalog()).events).toHaveLength(0);
    expect(
      (await broker.subscriptions()).items.every(
        (row: Record<string, unknown>) => row.state === "blocked" && row.reason === "event_not_declared",
      ),
    ).toBe(true);
    expect(
      await sql`SELECT FROM audit.events WHERE action='app_events.subscription.state_changed' AND metadata->>'reason'='event_not_declared'`,
    ).toHaveLength(2);
    expect((await sql`SELECT state,code FROM events.app_events WHERE id=${id(52)}::uuid`)[0]).toMatchObject({
      state: "rejected",
      code: "event_not_declared",
    });
    entries[0] = entry("eventsource");
    await broker.reconcileSubscriptions();
    expect((await sql`SELECT retired_at FROM events.app_declarations`)[0]!.retired_at).toBeNull();
    expect((await broker.subscriptions()).items.every((row: Record<string, unknown>) => row.state === "active")).toBe(true);
  });
  test("a subscription blocked after claim releases it without labeling the live subscriber unreachable", async () => {
    await broker.accept(event(92), 1);
    const rows = await broker.claim();
    entries[0]!.manifest.events = [];
    await broker.reconcileSubscriptions();
    for (const row of rows) await broker.deliver(row);
    expect(delivered).toHaveLength(0);
    expect(
      (await broker.deliveries()).items.every(
        (row: Record<string, unknown>) => row.state === "retrying" && row.code === "event_not_declared" && row.attempts === 0,
      ),
    ).toBe(true);
  });
  test("unchanged snapshots across replicas do not rewrite declarations or lock unchanged subscriptions", async () => {
    await broker.reconcileSubscriptions();
    const before = await sql`SELECT xmin::text AS revision FROM events.app_declarations`;
    await sql.begin(async (tx) => {
      await tx`SELECT FROM events.app_subscriptions FOR UPDATE`;
      // A second replica must finish while the first transaction holds every unchanged subscription.
      const replica = makeBroker();
      await replica.reconcileSubscriptions();
    });
    expect(await sql`SELECT xmin::text AS revision FROM events.app_declarations`).toEqual(before);
  });
  test("a successful request wakes unreachable rows for that app, including blocked subject predecessors", async () => {
    entries = entries.filter(({ appId }) => appId !== "receiverb");
    await broker.accept(event(53), 1);
    await broker.accept(event(54), 2);
    await broker.accept(event(55, id(102)), 3);
    await sql`UPDATE events.app_deliveries SET state='retrying',code='subscriber_unreachable',unreachable_count=7,next_attempt_at=now()+interval '1 hour' WHERE event_id IN (${id(53)}::uuid,${id(54)}::uuid)`;
    await broker.work();
    expect((await broker.deliveries()).items.every((row: Record<string, unknown>) => row.state === "done" && row.attempts === 1)).toBe(
      true,
    );
  });
  test("status reports retained rejection count and latest ten metadata-only rejections", async () => {
    for (let number = 60; number < 72; number++) await broker.accept({ ...event(number), data: { id: "private-invalid-value" } }, number);
    const status = await broker.status();
    expect(status).toMatchObject({ rejectedCount: 12, rejectionLimit: 10 });
    expect(status.rejections).toHaveLength(10);
    expect(Object.keys(status.rejections[0]!).sort()).toEqual(["code", "source", "time", "type"]);
    expect(status.rejections[0]).toMatchObject({
      type: "eventsource.changed",
      source: "eventsource",
      code: "schema_mismatch",
      time: expect.any(Date),
    });
    expect(JSON.stringify(status)).not.toContain("private-invalid-value");
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
