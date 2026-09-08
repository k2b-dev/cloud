import { expect, test } from "bun:test";

test("scheduled lifecycle scans coalesce on a stable key, retry in minutes, and share the Sync run span", async () => {
  const script = `
    import { mock } from "bun:test";
    import { strict as assert } from "node:assert";
    const declarations = new Map();
    const schedules = new Map();
    const submitted = [];
    const spanKeys = [];
    const worker = { stop() {}, drain: async () => {}, active: 0, capacity: 1 };
    const handlers = new Map();
    const job = id => ({
      submit: async input => { submitted.push({ id, ...input }); return { jobId: id + "-job" }; },
      process: async (_options, handler) => { handlers.set(id, handler); return worker; },
    });
    const sync = {
      job: config => { declarations.set(config.id, config); return job(config.id); },
      mutex: () => ({ acquire: async () => ({ token: "lock" }), extend: async () => true, release: async () => {} }),
      scheduler: () => ({
        create: async config => { schedules.set(config.id, config); return { created: true, updated: false }; },
        process: async () => worker,
        list: async () => [],
      }),
    };
    const modulePath = relative => new URL(relative, ${JSON.stringify(import.meta.url)}).pathname;
    mock.module(modulePath("../../_internal/process-sync.ts"), () => ({
      lazySync: factory => { let handle; return () => handle ??= factory(sync); },
    }));
    mock.module(modulePath("../logging/index.ts"), () => ({
      logger: () => ({ info() {}, warn() {}, error() {} }),
      logging: { cleanup: async () => ({ deleted: 0 }) },
      trace: {
        withSpan: (options, callback) => { spanKeys.push(options.spanKey); return callback(); },
        syncSpanKey: (kind, resource, runId) => kind + ":" + resource + ":" + runId,
      },
    }));
    mock.module(modulePath("../providers/index.ts"), () => ({ providers: { ipa: { sync: { run: async () => {} } } } }));
    mock.module(modulePath("../settings/index.ts"), () => ({ get: async () => null }));
    mock.module(modulePath("./index.ts"), () => ({
      accountLifecycle: {
        demoteExpiredIpaUsers: async () => ({ scanned: 1, changed: 0, skipped: 0, failed: 0 }),
        sendExpiryReminders: async () => ({ scanned: 0, changed: 0, skipped: 0, failed: 0 }),
        cleanupExpiredGuests: async () => ({ scanned: 0, changed: 0, skipped: 0, failed: 0 }),
        cleanupExpiredLocalUsers: async () => ({ scanned: 0, changed: 0, skipped: 0, failed: 0 }),
        cleanupLifecycleAudit: async () => ({ scanned: 0, changed: 0, skipped: 0, failed: 0 }),
        runGuestBackfill: async () => ({ scanned: 0, changed: 0, skipped: 0, failed: 0 }),
        runLocalUserBackfill: async () => ({ scanned: 0, changed: 0, skipped: 0, failed: 0 }),
      },
    }));
    mock.module(modulePath("./ipa-backfill.ts"), () => ({
      declareIpaBackfill: () => ({ accounts: { process: async () => worker }, pump: { process: async () => worker, start: async () => {} } }),
      prepareIpaBackfill: async () => null,
      processIpaBackfillAccount: async () => {},
    }));
    const { lifecycleJobs } = await import(modulePath("./scheduler.ts"));
    await lifecycleJobs.start({ notificationSender: {} });

    const scheduled = ["auth:ipa:sync", "auth:reminder:daily", "auth:guest:cleanup", "auth:local-user:cleanup", "auth:lifecycle:audit:cleanup", "app:logs:cleanup"];
    for (const id of scheduled) {
      assert.deepEqual(declarations.get(id).delivery.maxAttempts, 3, id);
      assert.deepEqual(declarations.get(id).delivery.backoffMs, [60000, 300000], id);
      assert.equal(schedules.get(id).misfire, "latest", id);
    }
    for (const slot of [1000, 2000]) {
      for (const id of scheduled) await schedules.get(id).process({ slot: new Date(slot) });
    }
    assert.equal(submitted.length, scheduled.length * 2);
    for (const entry of submitted) {
      assert.equal(entry.key, "scheduled", entry.id);
      assert.equal(entry.coalesce, true, entry.id);
    }

    await handlers.get("auth:ipa:sync")({ jobId: "run-1", attempt: 1, signal: new AbortController().signal, heartbeat: async () => {} });
    await handlers.get("app:logs:cleanup")({ jobId: "run-2", attempt: 1, signal: new AbortController().signal, heartbeat: async () => {} });
    assert.deepEqual(spanKeys, ["job:auth:ipa:sync:run-1", "job:app:logs:cleanup:run-2"]);

    assert.deepEqual(lifecycleJobs.metrics(), { started: true, registered: true, active: 0, capacity: 11 });
    await lifecycleJobs.stop();
    assert.equal(lifecycleJobs.metrics().started, false);
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "", stderr: "" });
});
