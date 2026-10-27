import { afterAll, beforeAll, expect, test } from "bun:test";
import { createSync } from "@k2b/sync";
import { type SQL, sql } from "bun";
import { z } from "zod";
import {
  connectTestNats,
  suiteFor,
  testFor,
  testInfra,
  testSyncNamespace,
  useFreshDatabase,
} from "../../../../scripts/fixtures/test-infra";
import { migrate } from "../../../core/src/migrate/core/events";
import { appEventJsonbBytes } from "../_internal/app-event-schemas";
import type { AppEventEnvelope } from "../contracts/app-events";
import { defineCapabilities } from "../contracts/capabilities";
import { appEventFromOutbox, appEventOutbox, appEventTopicConfig } from "./app-event-delivery";
import { appEvents, bindAppEvents } from "./app-events";

let database: Awaited<ReturnType<typeof useFreshDatabase>> | undefined;
let db: SQL;

beforeAll(async () => {
  if (!testInfra.database) return;
  database = await useFreshDatabase("app_events_contract");
  db = sql;
  await migrate(db);
});
afterAll(async () => {
  if (!database) return;
  await db.close();
  await database.drop();
});

suiteFor("database")("transactional app event publisher", () => {
  test("domain rollback leaves no event; commit stores the original envelope", async () => {
    const definitions = defineCapabilities({
      protocolVersion: 2,
      types: { item: { title: "Item", description: "An item." } },
      events: {
        changed: {
          version: 1,
          title: "Item changed",
          description: "An item changed.",
          subject: "item",
          schema: z.strictObject({ value: z.string().max(4000) }),
        },
      },
    });
    bindAppEvents("publisher", definitions);
    const publisher = appEvents(definitions);
    await expect(
      db.begin(async (tx) => {
        await publisher.publish(tx, "changed", { subject: "rollback", data: { value: "rolled back" } });
        throw new Error("domain rollback");
      }),
    ).rejects.toThrow("domain rollback");
    const [empty] = await db<{ count: number }[]>`SELECT count(*)::int AS count FROM events.outbox`;
    expect(empty?.count).toBe(0);
    const sent = await db.begin((tx) => publisher.publish(tx, "changed", { subject: "committed", data: { value: "committed" } }));
    const rows = await db<{ id: string; app_id: string; payload: unknown }[]>`SELECT id,app_id,payload FROM events.outbox`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ id: sent.id, app_id: "publisher", payload: sent });
    await expect(
      db.begin((tx) => publisher.publish(tx, "changed", { subject: "too-large", data: { value: "x".repeat(4000) } })),
    ).rejects.toThrow("4096");
    const [unchanged] = await db<{ count: number }[]>`SELECT count(*)::int AS count FROM events.outbox`;
    expect(unchanged?.count).toBe(1);
  });

  test("byte accounting agrees with PostgreSQL jsonb text, including exponent expansion", async () => {
    for (const value of [
      { a: 1, b: ["ä", true] },
      { small: 1e-7, large: 1e21 },
      { quotes: '"\\\n', control: "\b\f\r\t" },
    ]) {
      const [row] = await db<{ bytes: number }[]>`SELECT octet_length(${JSON.stringify(value)}::text::jsonb::text) AS bytes`;
      expect(row?.bytes).toBe(appEventJsonbBytes(z.json().parse(value)));
    }
  });
});

testFor("database", "nats")(
  "a disconnected NATS publisher retains committed rows and the durable consumer resumes once",
  async () => {
    await db`TRUNCATE events.outbox`;
    const definitions = defineCapabilities({
      protocolVersion: 2,
      types: { item: { title: "Item", description: "An item." } },
      events: {
        changed: {
          version: 1,
          title: "Changed",
          description: "An item changed.",
          subject: "item",
          schema: z.strictObject({ id: z.uuid() }),
        },
      },
    });
    bindAppEvents("outage", definitions);
    const envelope = await db.begin((tx) =>
      appEvents(definitions).publish(tx, "changed", { subject: "fixed-subject", data: { id: "00000000-0000-4000-8000-000000000001" } }),
    );
    const namespace = testSyncNamespace("app-event-outage");
    const connection = await connectTestNats({ ignoreClusterUpdates: true });
    const first = createSync({ connection, namespace, application: "cloud", defaults: { replicas: 1 } });
    const config = { ...appEventTopicConfig(), dedupeWindowMs: 10_000, retention: { maxAgeMs: 60_000, maxBytes: 1024 ** 2 } };
    let destination = first.topic<AppEventEnvelope>(config);
    await destination.ready();
    await connection.close();
    const outbox = appEventOutbox("outage", (row) =>
      destination.publish({ data: appEventFromOutbox(row), orderingKey: row.ordering_key, idempotencyKey: row.id }),
    );
    await outbox.reconcile();
    expect(Array.from(await db`SELECT id,attempts FROM events.outbox`)).toEqual([{ id: envelope.id, attempts: 1 }]);
    const recoveredConnection = await connectTestNats({ ignoreClusterUpdates: true });
    const recovered = createSync({ connection: recoveredConnection, namespace, application: "cloud", defaults: { replicas: 1 } });
    destination = recovered.topic<AppEventEnvelope>(config);
    let worker: Awaited<ReturnType<typeof destination.process>> | undefined;
    const seen: string[] = [];
    try {
      await destination.ready();
      worker = await destination.process(
        { consumer: "core-app-events-v1", start: "earliest", concurrency: 1, delivery: { maxInFlight: 1, maxAttempts: 2 } },
        async (event) => {
          seen.push(event.data.id);
        },
      );
      await db`UPDATE events.outbox SET next_attempt_at='2000-01-01T00:00:00Z'`;
      await outbox.reconcile();
      expect(await db`SELECT FROM events.outbox`).toHaveLength(0);
      await destination.publish({ data: envelope, idempotencyKey: envelope.id });
      const deadline = Date.now() + 5000;
      while (seen.length < 1) {
        if (Date.now() > deadline) throw Error("Event consumer did not resume");
        await Bun.sleep(20);
      }
      expect(seen).toEqual([envelope.id]);
      const retained = [];
      for await (const event of destination.replay()) retained.push(event.data.id);
      expect(retained).toEqual([envelope.id]);
    } finally {
      worker?.stop();
      await worker?.drain();
      await outbox.stop();
      await destination.destroy();
      await recovered.drain();
      await recoveredConnection.drain();
    }
  },
  15000,
);
