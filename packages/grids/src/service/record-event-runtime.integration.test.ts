import { expect, spyOn, test } from "bun:test";
import { SQL } from "bun";

const enabled = process.env.GRIDS_RECORD_EVENTS_DB_TEST === "1";
const databaseName = process.env.GRIDS_RECORD_EVENTS_DB_CHILD;

if (!databaseName) {
  (enabled ? test : test.skip)(
    "record-event dispatcher preserves PostgreSQL recovery in an isolated database",
    async () => {
      const url = new URL(process.env.DATABASE_URL!);
      if (!["localhost", "127.0.0.1", "ipa_postgres"].includes(url.hostname)) throw new Error("Requires local Postgres");
      const database = `grids_events_${crypto.randomUUID().replaceAll("-", "")}`;
      const target = new URL(url);
      target.pathname = `/${database}`;
      url.pathname = "/postgres";
      const admin = new SQL(url);
      let created = false;
      try {
        await admin.unsafe(`CREATE DATABASE "${database}"`);
        created = true;
        const child = Bun.spawn([process.execPath, "test", import.meta.path], {
          env: { ...process.env, DATABASE_URL: target.toString(), GRIDS_RECORD_EVENTS_DB_CHILD: database },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect({ code, output: code === 0 ? "passed" : `${stdout}\n${stderr}` }).toEqual({ code: 0, output: "passed" });
      } finally {
        if (created) await admin.unsafe(`DROP DATABASE "${database}"`);
        await admin.close({ timeout: 5 });
      }
    },
    60_000,
  );
} else {
  test("PG dispatcher retries once, preserves record order, and drains publication on shutdown", async () => {
    if (!enabled || !/^grids_events_[a-f0-9]{32}$/.test(databaseName)) throw new Error("Unexpected isolated database");
    const { sql } = await import("bun");
    const { dispatchRecordEventOutboxBatch, enqueueRecordEvent, startRecordEventOutbox, stopRecordEventOutbox } = await import(
      "./record-event-outbox"
    );
    try {
      const [database] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
      expect(database?.name).toBe(databaseName);
      await sql`CREATE SCHEMA auth`.simple();
      await sql`CREATE TABLE auth.users (id UUID PRIMARY KEY)`.simple();
      await sql`CREATE TABLE auth.access (id UUID PRIMARY KEY)`.simple();
      await sql`CREATE TABLE auth.service_accounts (id UUID PRIMARY KEY)`.simple();
      const { migrate: migrateWorkflows } = await import("../../../core/src/migrate/core/workflows");
      const { migrate: migrateLogging } = await import("../../../core/src/migrate/core/logging");
      const { migrate } = await import("../migrate");
      await migrateWorkflows();
      await migrateLogging();
      await migrate();
      const baseId = crypto.randomUUID();
      const tableId = crypto.randomUUID();
      const recordId = crypto.randomUUID();
      const otherRecordId = crypto.randomUUID();
      await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, 'evt001', 'Event fixture')`;
      await sql`INSERT INTO grids.tables (id, short_id, base_id, name) VALUES (${tableId}::uuid, 'tbl001', ${baseId}::uuid, 'Records')`;
      const event = (id: string, version: number) => ({
        type: "record.updated" as const,
        baseId,
        tableId,
        recordId: id,
        version,
        changedFieldIds: [],
        actorId: null,
      });
      await expect(
        sql.begin(async (tx) => {
          await enqueueRecordEvent(tx, event(recordId, 100));
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      const [empty] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM grids.record_event_outbox`;
      expect(empty?.count).toBe(0);
      const first = await enqueueRecordEvent(sql, event(recordId, 1));
      await enqueueRecordEvent(sql, event(recordId, 2));
      await enqueueRecordEvent(sql, event(otherRecordId, 1));
      const published: string[] = [];
      expect(
        await dispatchRecordEventOutboxBatch(new AbortController().signal, async (value) => {
          if (value.recordId === recordId) throw new Error("temporary transport failure");
          published.push(`${value.recordId}:${value.version}`);
        }),
      ).toBe(2);
      const state = await sql<{ version: number; status: string; attempts: number }[]>`
        SELECT (payload->>'version')::int AS version, status, attempts
        FROM grids.record_event_outbox WHERE record_id = ${recordId}::uuid ORDER BY created_at, id
      `;
      expect(state).toEqual([
        { version: 1, status: "failed", attempts: 1 },
        { version: 2, status: "pending", attempts: 0 },
      ]);
      expect(published).toEqual([`${otherRecordId}:1`]);
      await sql`UPDATE grids.record_event_outbox SET next_attempt_at = now() WHERE id = ${first}::uuid`;
      expect(
        await dispatchRecordEventOutboxBatch(new AbortController().signal, async (value) => {
          published.push(`${value.recordId}:${value.version}`);
        }),
      ).toBe(2);
      expect(published).toEqual([`${otherRecordId}:1`, `${recordId}:1`, `${recordId}:2`]);
      expect(
        await dispatchRecordEventOutboxBatch(new AbortController().signal, async () => {
          throw new Error("must not repeat");
        }),
      ).toBe(0);

      await enqueueRecordEvent(sql, event(recordId, 3));
      await enqueueRecordEvent(sql, event(recordId, 4));
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const events = await import("./record-events");
      const publish = spyOn(events, "publishRecordEventWithFederatedTargets").mockImplementation(async () => {
        entered.resolve();
        await release.promise;
      });
      try {
        const starting = startRecordEventOutbox();
        expect(await Promise.race([starting.then(() => "started"), entered.promise.then(() => "publication")])).toBe("started");
        await entered.promise;
        let stopped = false;
        const stopping = stopRecordEventOutbox().then(() => {
          stopped = true;
        });
        await Bun.sleep(25);
        expect(stopped).toBe(false);
        release.resolve();
        await stopping;
        expect(publish).toHaveBeenCalledTimes(1);
      } finally {
        release.resolve();
        await stopRecordEventOutbox();
        publish.mockRestore();
      }
      const [pending] = await sql<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM grids.record_event_outbox WHERE status = 'pending'`;
      expect(pending?.count).toBe(1);

      await dispatchRecordEventOutboxBatch(new AbortController().signal, async () => undefined);
      // A stalled publication must not block every remaining resource's shutdown.
      // Exercise the actual 30-second deadline without pretending the I/O canceled.
      await enqueueRecordEvent(sql, event(recordId, 5));
      await enqueueRecordEvent(sql, event(recordId, 6));
      const stalledEntered = Promise.withResolvers<void>();
      const stalledRelease = Promise.withResolvers<void>();
      const stalledPublish = spyOn(events, "publishRecordEventWithFederatedTargets").mockImplementation(async () => {
        stalledEntered.resolve();
        await stalledRelease.promise;
      });
      try {
        await startRecordEventOutbox();
        await stalledEntered.promise;
        const { stopRuntimeResources } = await import("@valentinkolb/cloud/services");
        let nextResourceStopped = false;
        await expect(
          stopRuntimeResources([
            stopRecordEventOutbox,
            () => {
              nextResourceStopped = true;
            },
          ]),
        ).rejects.toThrow("Runtime tasks did not drain within 30000ms");
        expect(nextResourceStopped).toBe(true);
        expect(stalledPublish).toHaveBeenCalledTimes(1);
        const unfinished = await sql<{ status: string; attempts: number }[]>`
          SELECT status, attempts FROM grids.record_event_outbox
          WHERE record_id = ${recordId}::uuid AND (payload->>'version')::int IN (5, 6)
          ORDER BY created_at, id`;
        expect(unfinished).toEqual([
          { status: "pending", attempts: 0 },
          { status: "pending", attempts: 0 },
        ]);
      } finally {
        stalledRelease.resolve();
        await stopRecordEventOutbox();
        stalledPublish.mockRestore();
      }
      await dispatchRecordEventOutboxBatch(new AbortController().signal, async () => undefined);

      // A dispatch pass has a fixed memory/work budget even after a long outage.
      await sql`
        INSERT INTO grids.record_event_outbox (base_id, table_id, record_id, payload)
        SELECT ${baseId}::uuid, ${tableId}::uuid, source.record_id,
          jsonb_build_object('v', 1, 'type', 'record.updated', 'baseId', ${baseId}::text, 'tableId', ${tableId}::text,
            'recordId', source.record_id::text, 'version', 1, 'changedFieldIds', '[]'::jsonb, 'actorId', NULL, 'occurredAt', now())
        FROM (SELECT gen_random_uuid() AS record_id FROM generate_series(1, 501)) AS source
      `;
      expect(await dispatchRecordEventOutboxBatch(new AbortController().signal, async () => undefined)).toBe(500);
      expect(await dispatchRecordEventOutboxBatch(new AbortController().signal, async () => undefined)).toBe(1);

      // An individual workflow's snapshot failure must reach native retry rather
      // than being logged and silently acknowledged by the outer dispatcher.
      const { insertTestWorkflow } = await import("./workflow-test-fixture");
      await insertTestWorkflow({
        baseId,
        enabled: true,
        recordEventActiveSince: new Date(0),
        plan: {
          schemaVersion: 2,
          languageId: "grids",
          languageVersion: 1,
          sourceHash: "a".repeat(64),
          manifestHash: "b".repeat(64),
          catalogHash: "c".repeat(64),
          maxLoopItems: 10000,
          actionPolicies: {},
          inputs: [],
          steps: [],
          triggers: [{ kind: "recordEvent", config: { event: "updated" }, with: {} }],
          bindings: { "triggers.recordEvent.table": tableId },
        },
      });
      const { createWorkflowRecordEventRuntime } = await import("./workflow-record-events");
      const runtime = createWorkflowRecordEventRuntime(async () => {
        throw new Error("missing snapshot must prevent invocation");
      });
      await expect(runtime.dispatch({ v: 1, ...event(recordId, 1), occurredAt: new Date().toISOString() })).rejects.toMatchObject({
        message: "Workflow record event dispatch failed",
        errors: [expect.objectContaining({ message: "record event snapshot is missing or inconsistent" })],
      });

      // Pre-cutover application DLQ history remains readable and is not rewritten.
      const [legacy] = await sql<{ id: string }[]>`
        INSERT INTO grids.record_event_delivery_failures (base_id, consumer_group, event_id, payload, error, attempts, status, dead_at)
        VALUES (${baseId}::uuid, 'workflow-kernel-queue-v1', 'old-event', 'original payload', 'terminal error', 20, 'dead', now()) RETURNING id::text
      `;
      const { listRecordEventDeliveryFailures, getRecordEventDeliveryFailure } = await import("./record-event-delivery-failures");
      const legacyFailure = await getRecordEventDeliveryFailure(baseId, legacy!.id);
      if (!legacyFailure) throw new Error("Historical failure is missing");
      expect(await listRecordEventDeliveryFailures(baseId)).toEqual([legacyFailure]);
      expect(await getRecordEventDeliveryFailure(crypto.randomUUID(), legacy!.id)).toBeNull();
      const retryPayload = { v: 1, ...event(recordId, 1), occurredAt: new Date().toISOString() };
      const [unfinished] = await sql<{ id: string }[]>`
        INSERT INTO grids.record_event_delivery_failures (base_id, consumer_group, event_id, payload, error, attempts, status)
        VALUES (${baseId}::uuid, 'workflow-kernel-queue-v1', 'old-retry', ${JSON.stringify(retryPayload)}, 'old interruption', 3, 'retrying')
        RETURNING id::text
      `;
      expect(await getRecordEventDeliveryFailure(baseId, unfinished!.id)).toMatchObject({ status: "retrying", deadAt: null, attempts: 3 });
      expect(await listRecordEventDeliveryFailures(baseId)).toHaveLength(2);
      const { replayWorkflowRecordEventDeliveryFailure } = await import("./workflow-record-events");
      const replay = spyOn(events, "publishRecordEvent").mockResolvedValue(undefined);
      try {
        expect(await replayWorkflowRecordEventDeliveryFailure(baseId, unfinished!.id)).toBe(true);
        expect(replay).toHaveBeenCalledWith(retryPayload, { replayKey: expect.any(String) });
        expect(await getRecordEventDeliveryFailure(baseId, unfinished!.id)).toMatchObject({ status: "retrying", attempts: 3 });
      } finally {
        replay.mockRestore();
      }
    } finally {
      await stopRecordEventOutbox();
      await sql.close({ timeout: 5 });
    }
  }, 60_000);
}
