import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import type { Sync } from "@k2b/sync";
import { SQL } from "bun";
import { z } from "zod";
import { bindProcessSync, unbindProcessSync } from "../_internal/process-sync";
import * as identityConfig from "../services/identity/runtime-config";
import { publishAppAccessChanged, subscribeAppAccessChanged, subscribeIdentityAccessChanged } from "./app-access";
import { defineLive } from "./live";
import { createMemoryLiveTopic } from "./testing";

afterEach(() => {
  unbindProcessSync();
  setSystemTime();
});

test("one shared follower targets the changed app and releases subscriptions", async () => {
  setSystemTime(new Date("2026-10-22T12:00:00Z"));
  const topic = createMemoryLiveTopic();
  let declarations = 0;
  // Only the topic factory is needed; no external transport or schema is replaced.
  bindProcessSync({
    topic: () => {
      declarations++;
      return topic;
    },
  } as unknown as Sync);
  let first = 0,
    second = 0;
  const stopFirst = subscribeAppAccessChanged("first", () => {
    first++;
  });
  const stopSecond = subscribeAppAccessChanged("second", () => {
    second++;
  });
  try {
    await Bun.sleep(0); // the initial cursor capture revalidates every listener once
    expect(first).toBe(1);
    expect(second).toBe(1);
    const coreLive = defineLive({ appId: "core", event: z.object({ text: z.string() }) });
    expect(await coreLive.cursor()).toBe(await topic.head());
    expect(declarations).toBe(1);
    topic.publish({ v: 1, k: "app.access:first", d: { type: "app.access.changed", appId: "first" } });
    await Bun.sleep(0);
    expect(first).toBe(2);
    expect(second).toBe(1);
    stopFirst();
    topic.publish({ v: 1, k: "app.access:first", d: { type: "app.access.changed", appId: "first" } });
    await Bun.sleep(0);
    expect(first).toBe(2);
    expect(second).toBe(1);
  } finally {
    stopFirst();
    stopSecond();
  }
});

test("app access changes and application live events enqueue through the same transaction in access-before-data order", async () => {
  const client = new SQL("postgres://localhost/unused_test");
  const statements: { query: string; values: unknown[] }[] = [];
  const tx = new Proxy(client, {
    apply(_target, _receiver, [strings, ...values]) {
      statements.push({ query: strings.join("?"), values });
      return Promise.resolve([]);
    },
  });
  try {
    await publishAppAccessChanged(tx, "inventory");
    const coreLive = defineLive({ appId: "core", event: z.object({ text: z.string() }) });
    await coreLive.publish(tx, { key: "item:one", data: { text: "Changed" }, access: true });
    expect(statements).toHaveLength(4);
    expect(new Set(statements.map(({ values }) => values[0])).size).toBe(4);
    for (const { query, values } of statements) {
      expect(query).toBe("SELECT events.enqueue(?::uuid, ?, 'live', ?, ?::text::jsonb)");
      expect(values[1]).toBe("core");
    }
    expect(statements.map(({ values }) => [values[2], JSON.parse(String(values[3]))])).toEqual([
      ["app.access:inventory", { v: 1, k: "app.access:inventory", a: true }],
      ["app.access:inventory", { v: 1, k: "app.access:inventory", d: { type: "app.access.changed", appId: "inventory" } }],
      ["item:one", { v: 1, k: "item:one", a: true }],
      ["item:one", { v: 1, k: "item:one", d: { text: "Changed" } }],
    ]);
    const dated = defineLive({ appId: "core", event: z.object({ at: z.date() }) });
    await expect(dated.publish(tx, { key: "item:one", data: { at: new Date("2026-10-22T12:00:00Z") } })).rejects.toThrow();
    expect(statements).toHaveLength(4);
  } finally {
    await client.close();
  }
});

test("identity source events notify application and room listeners on the existing Core follower", async () => {
  setSystemTime(new Date("2026-11-12T12:00:00Z"));
  const topic = createMemoryLiveTopic();
  bindProcessSync({ topic: () => topic } as unknown as Sync);
  let app = 0,
    room = 0;
  const reset = spyOn(identityConfig, "invalidateIdentityRuntimeConfig");
  const stopApp = subscribeAppAccessChanged("notebooks", () => {
    app++;
  });
  const stopRoom = subscribeIdentityAccessChanged(() => {
    room++;
  });
  try {
    await Bun.sleep(0);
    const initial = { app, room, resets: reset.mock.calls.length };
    topic.publish({ v: 1, k: "identity.access", d: { type: "identity.access.changed" } });
    await Bun.sleep(0);
    expect(app - initial.app).toBe(1);
    expect(room - initial.room).toBe(1);
    expect(reset.mock.calls.length - initial.resets).toBe(1);
  } finally {
    stopRoom();
    stopApp();
    reset.mockRestore();
  }
});

test("application accessChanges filters data hints and releases its shared follower on abort", async () => {
  setSystemTime(new Date("2026-11-12T12:00:00Z"));
  const topic = createMemoryLiveTopic();
  bindProcessSync({ topic: () => ({ ...topic, hub: () => ({ subscribe: topic.follow }) }) } as unknown as Sync);
  const live = defineLive({ appId: "roomhints", event: z.object({ text: z.string() }) });
  const signal = new AbortController();
  const seen: string[] = [];
  const reading = (async () => {
    for await (const event of live.accessChanges({ after: await live.cursor(), signal: signal.signal })) {
      seen.push(event.key);
      signal.abort();
    }
  })();
  await Bun.sleep(0);
  topic.publish({ v: 1, k: "data-only", d: { text: "Preview changed" } });
  topic.publish({ v: 1, k: "mailbox", a: true });
  await reading;
  expect(seen).toEqual(["mailbox"]);
});

test("a scoped session/account event never revalidates another user's sockets", async () => {
  const topic = createMemoryLiveTopic();
  bindProcessSync({ topic: () => topic } as unknown as Sync);
  let a = 0,
    b = 0;
  const delivered = Promise.withResolvers<void>();
  const stopA = subscribeIdentityAccessChanged(
    () => {
      a++;
      if (a > 1) delivered.resolve();
    },
    { userId: "a", sid: "session-a" },
  );
  const stopB = subscribeIdentityAccessChanged(
    () => {
      b++;
    },
    { userId: "b", sid: "session-b" },
  );
  try {
    await Bun.sleep(0);
    const beforeB = b;
    topic.publish({ v: 1, k: "identity.access:a", d: { type: "identity.access.changed", userId: "a", sid: "session-a" } });
    await delivered.promise;
    expect(b).toBe(beforeB);
    expect(a).toBe(2);
  } finally {
    stopA();
    stopB();
  }
});
