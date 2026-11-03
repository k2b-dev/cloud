import { mock, setSystemTime } from "bun:test";
import assert from "node:assert/strict";
import type { AppRegistryEntry } from "@k2b/cloud/contracts";

const epoch = Date.UTC(2030, 0, 1);
setSystemTime(epoch);
const calls: { text: string; values: unknown[] }[] = [];
let fail = false;
let rows: Record<string, unknown>[] = [];
mock.module("@k2b/cloud", () => ({
  sql: async (parts: TemplateStringsArray, ...values: unknown[]) => {
    if (fail) throw new Error("database unavailable");
    const text = parts.join("?");
    calls.push({ text, values });
    return text.includes("SELECT *") ? rows : [];
  },
}));
const { upsertRegisteredApps, listRegisteredApps } = await import("./registered-apps");
try {
  for (const count of [5, 20]) {
    const apps: (AppRegistryEntry & { updatedAt: number })[] = Array.from({ length: count }, (_, i) => ({
      id: `app-${i}`,
      name: `App ${i}`,
      icon: "box",
      description: "Fixture",
      routes: [],
      baseUrl: `http://app-${i}:3000`,
      updatedAt: epoch,
    }));
    rows = apps.map((app) => ({
      id: app.id,
      name: app.name,
      icon: app.icon,
      description: app.description,
      base_url: app.baseUrl,
      routes: [],
      last_seen_at: new Date(epoch),
      first_seen_at: new Date(epoch),
      updated_at: new Date(epoch),
      removed_at: null,
      last_offline_logged_at: null,
    }));
    await upsertRegisteredApps(apps);
    calls.length = 0;
    // One deterministic minute of heartbeat notifications, including registry-only metadata.
    for (let second = 1; second <= 60; second++) {
      await upsertRegisteredApps(apps.map((app) => ({ ...app, updatedAt: epoch + second * 1000 })));
    }
    assert.equal(calls.length, 0, `${count} apps cost zero SQL calls while idle`);
    assert.equal(
      (await listRegisteredApps()).at(-1)!.lastSeenAt,
      epoch + 60_000,
      "status readers see live heartbeat without SQL persistence",
    );
    calls.length = 0;
    fail = true;
    await assert.rejects(upsertRegisteredApps(apps.map((app, i) => (i === 0 ? { ...app, name: "Changed" } : app))));
    fail = false;
    await upsertRegisteredApps(apps.map((app, i) => (i === 0 ? { ...app, name: "Changed" } : app)));
    assert.equal(calls.length, 1, "failed content writes are retried");
    assert.match(calls[0]!.text, /INSERT INTO gateway.registered_apps/);
    calls.length = 0;
    await upsertRegisteredApps([]);
    assert.equal(calls.length, count, "persist one final heartbeat per departure");
    assert.ok(calls.every((call) => /UPDATE gateway.registered_apps/.test(call.text)));
    // Unchanged apps last renewed at the end of the minute.
    const lastSeen = calls.at(-1)!.values[0];
    assert.ok(lastSeen instanceof Date);
    assert.equal(lastSeen.getTime(), epoch + 60_000);
    calls.length = 0;
    await upsertRegisteredApps([]);
    assert.equal(calls.length, 0, "offline apps do not keep writing");
    await upsertRegisteredApps(apps);
    assert.equal(calls.length, count, "reappearing apps restore their durable record");
    await upsertRegisteredApps([]);
    calls.length = 0;
  }
  console.log("5 and 20 apps: 0 idle SQL writes");
} finally {
  mock.restore();
  setSystemTime();
}
