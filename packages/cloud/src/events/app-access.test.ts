import { afterEach, expect, setSystemTime, test } from "bun:test";
import type { Sync } from "@k2b/sync";
import { SQL } from "bun";
import { z } from "zod";
import { bindProcessSync, unbindProcessSync } from "../_internal/process-sync";
import { publishAppAccessChanged, subscribeAppAccessChanged } from "./app-access";
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
