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
    if (text.startsWith("UPDATE gateway.registered_apps SET last_seen_at")) {
      const row = rows.find((row) => row.id === values[1]);
      if (row) row.last_seen_at = values[0];
    }
    return text.includes("SELECT *") ? rows : [];
  },
}));
const { upsertRegisteredApps, listRegisteredApps, listRegisteredAppStatus } = await import("./registered-apps");
try {
  if (process.argv.includes("--restart")) {
    // Read only the durable snapshot in a fresh process, without observed heartbeat state.
    rows = await Bun.stdin.json();
    setSystemTime(epoch + 899_000);
    const statuses = await listRegisteredAppStatus([]);
    assert.ok(statuses.length > 0);
    for (const status of statuses) {
      assert.equal(status.isOnline, false);
      assert.equal(status.lastSeenAt, epoch + 600_000);
      assert.equal(status.offlineForMs, 299_000, "restart keeps the app inside the ten-minute audit grace");
    }
  } else
    for (const count of [5, 20]) {
      setSystemTime(epoch);
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
        setSystemTime(epoch + second * 1000);
        await upsertRegisteredApps(apps.map((app) => ({ ...app, updatedAt: Date.now() })));
      }
      assert.equal(calls.length, 0, `${count} apps cost zero SQL calls before the first checkpoint`);
      assert.equal(
        (await listRegisteredApps()).at(-1)!.lastSeenAt,
        epoch + 60_000,
        "status readers see live heartbeat without SQL persistence",
      );
      calls.length = 0;
      for (let second = 61; second <= 899; second++) {
        setSystemTime(epoch + second * 1000);
        await upsertRegisteredApps(apps.map((app) => ({ ...app, updatedAt: Date.now() })));
        assert.equal(calls.length, Math.floor(second / 300) * count, "one checkpoint per app per five minutes");
      }
      assert.equal(calls.length, 2 * count, "two checkpoints per app in ten idle minutes, none before minute fifteen");
      assert.ok(calls.every((call) => /^UPDATE gateway.registered_apps SET last_seen_at = \? WHERE id = \?$/.test(call.text)));
      const restart = Bun.spawn([process.execPath, "--no-env-file", import.meta.path, "--restart"], {
        stdin: new Blob([JSON.stringify(rows)]),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [restartCode, restartError] = await Promise.all([restart.exited, new Response(restart.stderr).text()]);
      assert.equal(restartCode, 0, restartError);
      calls.length = 0;
      setSystemTime(epoch + 900_000);
      fail = true;
      await assert.rejects(upsertRegisteredApps(apps.map((app) => ({ ...app, updatedAt: Date.now() }))));
      fail = false;
      await upsertRegisteredApps(apps.map((app) => ({ ...app, updatedAt: Date.now() })));
      assert.equal(calls.length, count, "failed checkpoints retry without skipping or duplicating apps");
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
      // Departure flushes the latest heartbeat after the checkpoint retry.
      const lastSeen = calls.at(-1)!.values[0];
      assert.ok(lastSeen instanceof Date);
      assert.equal(lastSeen.getTime(), epoch + 900_000);
      calls.length = 0;
      await upsertRegisteredApps([]);
      assert.equal(calls.length, 0, "offline apps do not keep writing");
      await upsertRegisteredApps(apps);
      assert.equal(calls.length, count, "reappearing apps restore their durable record");
      await upsertRegisteredApps([]);
      calls.length = 0;
    }
  if (!process.argv.includes("--restart"))
    console.log("5 and 20 apps: 0 content writes; 1 and 4 liveness writes/min; restart grace preserved");
} finally {
  mock.restore();
  setSystemTime();
}
