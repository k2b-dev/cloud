import { expect, test } from "bun:test";
import { createSync } from "@k2b/sync";
import { connect } from "@nats-io/transport-node";
import { Hono } from "hono";
import type { AuthContext } from "../server/middleware/auth";
import { createSyncOpsRoutes } from "./sync-ops";

const integration = process.env.CLOUD_SYNC_NATS_TEST === "1" ? test : test.skip;
integration(
  "installed Sync recovers a topic failure through the audited Cloud route without republishing",
  async () => {
    const connection = await connect({ servers: process.env.SYNC_TEST_SERVERS ?? "nats://localhost:4222", ignoreClusterUpdates: true });
    const sync = createSync({ connection, namespace: `cloud-topic-ops-${crypto.randomUUID()}`, application: "test" });
    const topic = sync.topic<{ value: number }>({
      id: "events",
      dedupeWindowMs: 10_000,
      retention: { maxAgeMs: 60_000, maxBytes: 1_000_000 },
    });
    const user = { id: crypto.randomUUID(), uid: "admin", provider: "local", roles: ["admin"] } as AuthContext["Variables"]["user"];
    const actions: string[] = [];
    const app = new Hono<AuthContext>()
      .use("*", async (c, next) => {
        c.set("user", user);
        c.set("actor", { kind: "user", user });
        await next();
      })
      .route(
        "/",
        createSyncOpsRoutes(() => sync, {
          audit: {
            recordResultAfterSideEffect: async (input) => {
              actions.push(input.action);
              return input.result;
            },
          },
        }),
      );
    let fail = true;
    let handled = 0;
    const waitUntil = async (predicate: () => Promise<boolean>) => {
      const deadline = Date.now() + 5_000;
      while (!(await predicate())) {
        if (Date.now() > deadline) throw Error("Timed out waiting for topic settlement");
        await Bun.sleep(20);
      }
    };
    try {
      await sync.ready();
      await topic.process({ consumer: "sink", recoverDeadLetters: true, delivery: { maxAttempts: 1 } }, async (event) => {
        if (fail) throw Error("fixture sink unavailable");
        expect(event.data.value).toBe(7);
        handled++;
      });
      await topic.publish({ data: { value: 7 } });
      await waitUntil(async () => (await topic.deadLetters.list()).length === 1);
      const [entry] = await topic.deadLetters.list();
      const head = await topic.head();
      fail = false;
      const response = await app.request("/dead-letters/topic/events/replay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId: entry!.messageId, consumer: entry!.consumer, tenantId: entry!.tenantId }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ completed: true, eventId: entry!.eventId, consumer: "sink" });
      expect(handled).toBe(1);
      expect(await topic.head()).toEqual(head);
      expect(await topic.deadLetters.list()).toEqual([]);
      expect(actions).toEqual(["sync.dead_letter.replay"]);
    } finally {
      const resources = await sync.resources();
      await sync.drain();
      for (const name of new Set(resources.flatMap((resource) => resource.natsNames))) {
        const result = await connection.request(`$JS.API.STREAM.DELETE.${name}`);
        const data = result.json<{ success?: boolean; error?: { err_code?: number } }>();
        if (!data.success && data.error?.err_code !== 10059) throw Error(`Fixture stream cleanup failed: ${name}`);
      }
      await connection.drain();
    }
  },
  15_000,
);

integration(
  "installed Sync paginates queue failures after cursor deletion and reads exact details",
  async () => {
    const connection = await connect({ servers: process.env.SYNC_TEST_SERVERS ?? "nats://localhost:4222", ignoreClusterUpdates: true });
    const sync = createSync({ connection, namespace: `cloud-dlq-pages-${crypto.randomUUID()}`, application: "test" });
    const queue = sync.queue<{ value: number }>({ id: "work" });
    const app = createSyncOpsRoutes(() => sync);
    try {
      await sync.ready();
      const reader = await queue.reader();
      try {
        for (let value = 1; value <= 3; value++) {
          await queue.send({ data: { value } });
          const delivery = await reader.receive({ waitMs: 2_000 });
          expect(delivery).not.toBeNull();
          await delivery!.deadLetter({ reason: "fixture", error: "original error" });
        }
      } finally {
        await reader.close();
      }
      const firstResponse = await app.request("/dead-letters/queue/work?limit=2");
      expect(firstResponse.status).toBe(200);
      const first = (await firstResponse.json()) as {
        nextCursor: string;
        store: { entries: { messageId: string; streamSequence: number }[] };
      };
      expect(first.store.entries).toHaveLength(2);
      const entry = first.store.entries[1]!;
      const detail = await app.request(`/dead-letters/queue/work/${encodeURIComponent(entry.messageId)}?sequence=${entry.streamSequence}`);
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({ entry: { error: "original error", dataPreview: '{"value":2}' } });
      await queue.deadLetters.delete({ messageId: entry.messageId });
      const second = await app.request(`/dead-letters/queue/work?limit=2&cursor=${first.nextCursor}`);
      expect(await second.json()).toMatchObject({ nextCursor: null, store: { entries: [{ dataPreview: '{"value":3}' }] } });
      expect(
        (await app.request(`/dead-letters/queue/work/${encodeURIComponent(entry.messageId)}?sequence=${entry.streamSequence}`)).status,
      ).toBe(404);
    } finally {
      const resources = await sync.resources();
      await sync.drain();
      for (const name of new Set(resources.flatMap((resource) => resource.natsNames))) {
        const result = await connection.request(`$JS.API.STREAM.DELETE.${name}`);
        const data = result.json<{ success?: boolean; error?: { err_code?: number } }>();
        if (!data.success && data.error?.err_code !== 10059) throw Error(`Fixture stream cleanup failed: ${name}`);
      }
      await connection.drain();
    }
  },
  15_000,
);
