import { expect, test } from "bun:test";
import { createSync } from "@k2b/sync";
import { connect } from "@nats-io/transport-node";
import { Hono } from "hono";
import type { AuthContext } from "../server/middleware/auth";
import { createSyncOpsRoutes } from "./sync-ops";

const integration = process.env.CLOUD_SYNC_NATS_TEST === "1" ? test : test.skip;
integration(
  "installed Sync patch recovers a topic failure through the audited Cloud route without republishing",
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
