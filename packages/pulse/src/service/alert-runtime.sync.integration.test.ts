import { expect, spyOn } from "bun:test";
import { notifications, settings } from "@k2b/cloud/services";
import { createSync, type ScheduleDefinition, type Worker } from "@k2b/sync";
import { sql } from "bun";
import { z } from "zod";
import { connectTestNats, testFor, testSyncNamespace, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { app } from "../config";
import { migrate } from "../migrate";
import { AlertNoticeSchema, SourceStaleNoticeSchema } from "../notifications";
import { registerAlertSchedules } from "./alert-runtime";
import { seedActiveBaseStore } from "./base-store.test-fixture";
import * as sqlService from "./sql-service";

testFor("database", "nats")(
  "scheduled checks persist installation locale across fanout and failed delivery retries",
  async () => {
    const database = await useFreshDatabase("pulse_alert_schedule");
    // Outbox construction creates SQL fragments and binds Bun's default client.
    // Select the fixture database before loading that runtime dependency.
    const { notificationOutbox } = await import("./store-health").catch(async (error) => {
      await sql.close();
      await database.drop();
      throw error;
    });
    const connection = await connectTestNats({ ignoreClusterUpdates: true }).catch(async (error) => {
      await sql.close();
      await database.drop();
      throw error;
    });
    const sync = createSync({ connection, namespace: testSyncNamespace("pulse-alerts"), application: "pulse", defaults: { replicas: 1 } });
    const scheduler = sync.scheduler({ id: "pulse", delivery: { maxAttempts: 3, backoffMs: [100, 200] } });
    let worker: Worker | undefined;
    const stopping = new AbortController();
    const at = new Date("2026-10-21T12:00:00Z");
    // Freeze only domain time: NATS keeps its real clock for leases and runNow.
    const due = new Date(at.getTime() - 60_000);
    const baseId = "957f31ac-d628-4505-bfd4-b5ff86ec8a98";
    const getSetting = spyOn(settings, "get");
    const runSql = spyOn(sqlService, "runAlertSql").mockResolvedValue({
      ok: false,
      error: { code: "SQL_ERROR", message: "Fixture query failure", status: 400 },
    });
    const send = spyOn(notifications, "send").mockRejectedValue(new Error("Fixture delivery unavailable"));
    const renderAttempts = async () =>
      Promise.all(
        send.mock.calls.map(async (call) => {
          const input = z.object({ data: z.unknown(), locale: z.string(), idempotencyKey: z.string() }).parse(call.at(1));
          const metadata = { locale: input.locale };
          const alert = AlertNoticeSchema.safeParse(input.data);
          const source = SourceStaleNoticeSchema.safeParse(input.data);
          if (!alert.success && !source.success) throw new Error("Unexpected notification payload");
          const rendered = alert.success
            ? await app.notifications.alert.render(alert.data, metadata)
            : await app.notifications.sourceStale.render(source.data!, metadata);
          const email = alert.success
            ? await app.notifications.alert.email!(alert.data, metadata)
            : await app.notifications.sourceStale.email!(source.data!, metadata);
          expect(email).toMatchObject({ subject: rendered.title, content: rendered.body });
          expect(input.data).not.toHaveProperty("locale");
          return { id: input.idempotencyKey, locale: input.locale, title: rendered.title, body: rendered.body };
        }),
      );
    try {
      const { runCoreSetup } = await import("../../../core/src/runtime-helpers");
      await runCoreSetup();
      await migrate("Europe/Berlin");
      getSetting.mockClear();
      getSetting.mockResolvedValue("de");
      await sql`INSERT INTO pulse.bases(id,short_id,name,timezone) VALUES(${baseId}::uuid,'Sched5','Scheduled','Europe/Berlin')`;
      await seedActiveBaseStore(baseId);
      const [admin] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,display_name)
      VALUES('pulse_schedule_admin','local','user','Schedule admin') RETURNING id`;
      const [grant] = await sql<
        { id: string }[]
      >`INSERT INTO auth.access(user_id,permission) VALUES(${admin!.id}::uuid,'admin') RETURNING id`;
      await sql`INSERT INTO pulse.base_access(base_id,access_id) VALUES(${baseId}::uuid,${grant!.id}::uuid)`;
      await sql`INSERT INTO pulse.alert_rules(short_id,base_id,name,sql,comparison,warn,min_duration_seconds,interval_seconds,next_check_at,since)
      VALUES('SchedR',${baseId}::uuid,'Scheduled SQL','SELECT 1','above',80,0,300,${due},${due})`;
      await sql`INSERT INTO pulse.sources(short_id,base_id,name,kind,expect_every_seconds,last_data_at,created_at,next_freshness_check_at)
      VALUES('SchedS',${baseId}::uuid,'Scheduled source','http_ingest',300,${due},${due},${due})`;
      // Preserve the actual scheduler and PostgreSQL paths, with only the already
      // separately proven SQL transport replaced for this lifecycle/locale test.
      const alertEvaluator = await import("./alert-evaluator");
      const freshness = await import("./source-freshness");
      const evaluate = alertEvaluator.evaluateDueAlerts;
      const check = freshness.checkSourceFreshness;
      const clockedAlerts = spyOn(alertEvaluator, "evaluateDueAlerts").mockImplementation((locale, options) =>
        evaluate(locale, { ...options, now: () => at }),
      );
      const clockedFreshness = spyOn(freshness, "checkSourceFreshness").mockImplementation((locale, options) =>
        check(locale, { ...options, now: new Date(at.getTime() + 600_000) }),
      );
      try {
        // Keep real broker time and durable runNow, but move automatic ticks to
        // a distant month so minute boundaries cannot race fixture assertions.
        const brokerMonth = ((new Date().getUTCMonth() + 6) % 12) + 1;
        const definitions = new Map<string, ScheduleDefinition>();
        const registration = {
          create: async (definition: ScheduleDefinition) => {
            definitions.set(definition.id, definition);
            return scheduler.create({ ...definition, cron: `0 0 1 ${brokerMonth} *` });
          },
        };
        await registerAlertSchedules(registration, stopping.signal);
        await registerAlertSchedules(registration, stopping.signal);
        expect(
          [...definitions.values()]
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((entry) => ({ id: entry.id, cron: entry.cron, misfire: entry.misfire })),
        ).toEqual(
          ["pulse:alerts:evaluate-due", "pulse:notifications:fanout", "pulse:sources:freshness"].map((id) => ({
            id,
            cron: "* * * * *",
            misfire: "latest",
          })),
        );
        worker = await scheduler.process({ concurrency: 4 });
        const run = async (id: string, requestId: string) => {
          const { runId } = await scheduler.runNow({ id, requestId });
          expect(await scheduler.awaitRun({ id, runId, timeoutMs: 10_000 })).toEqual({ completed: true });
        };
        await run("pulse:alerts:evaluate-due", "alert-de");
        await run("pulse:sources:freshness", "freshness-de");
        expect(runSql).toHaveBeenCalledTimes(1);
        expect(
          await sql<
            { kind: string; locale: string; dispatch_kind: string }[]
          >`SELECT kind,locale,dispatch_kind FROM pulse.notification_outbox ORDER BY seq`,
        ).toEqual([
          { kind: "alert", locale: "de", dispatch_kind: "fanout" },
          { kind: "source_stale", locale: "de", dispatch_kind: "fanout" },
        ]);
        getSetting.mockResolvedValue("en");
        await run("pulse:notifications:fanout", "fanout-after-language-change");
        await notificationOutbox.reconcile();
        const firstAttempt = (await renderAttempts())[0]!;
        expect(firstAttempt).toMatchObject({ locale: "de", title: "Scheduled SQL: Prüfung fehlgeschlagen" });
        expect(
          await sql<{ locale: string; attempts: number }[]>`SELECT locale,attempts FROM pulse.notification_outbox ORDER BY seq`,
        ).toEqual([
          { locale: "de", attempts: 1 },
          { locale: "de", attempts: 0 },
        ]);
        send.mockResolvedValue({ id: "90000000-0000-4000-8000-000000000001", status: "pending" });
        await sql`UPDATE pulse.notification_outbox SET next_attempt_at=${due}`;
        await notificationOutbox.reconcile();
        const seen = await renderAttempts();
        expect(seen[1]).toEqual(firstAttempt);
        expect(seen.at(-1)).toMatchObject({ locale: "de", title: "Scheduled source: Daten veraltet" });
        expect(await sql`SELECT id FROM pulse.notification_outbox`).toHaveLength(0);
        // A later recovery uses the new installation language, not the old event's.
        await sql`UPDATE pulse.sources SET last_data_at=${new Date(at.getTime() + 600_000)},next_freshness_check_at=${due}`;
        await run("pulse:sources:freshness", "freshness-en-recovery");
        await run("pulse:notifications:fanout", "fanout-en-recovery");
        await notificationOutbox.reconcile();
        expect((await renderAttempts()).at(-1)).toMatchObject({ locale: "en", title: "Scheduled source: Data current again" });
        expect(await sql`SELECT id FROM pulse.notification_outbox`).toHaveLength(0);
        await run("pulse:alerts:evaluate-due", "alert-repeat");
        expect(runSql).toHaveBeenCalledTimes(1);
        // The runtime stop signal wins even while the broker context is live.
        await sql`UPDATE pulse.alert_rules SET next_check_at=${due} WHERE base_id=${baseId}::uuid`;
        await sql`UPDATE pulse.sources SET last_data_at=${due},next_freshness_check_at=${due} WHERE base_id=${baseId}::uuid`;
        const stoppedRules = await sql`SELECT * FROM pulse.alert_rules WHERE base_id=${baseId}::uuid`;
        const stoppedSources = await sql`SELECT * FROM pulse.sources WHERE base_id=${baseId}::uuid`;
        expect(getSetting.mock.calls.length).toBeGreaterThan(0);
        expect(getSetting.mock.calls.every(([key]) => key === "app.locale")).toBe(true);
        stopping.abort();
        await run("pulse:alerts:evaluate-due", "alert-after-stop");
        await run("pulse:sources:freshness", "freshness-after-stop");
        expect(runSql).toHaveBeenCalledTimes(1);
        expect(await sql`SELECT * FROM pulse.alert_rules WHERE base_id=${baseId}::uuid`).toEqual(stoppedRules);
        expect(await sql`SELECT * FROM pulse.sources WHERE base_id=${baseId}::uuid`).toEqual(stoppedSources);
        expect(await sql`SELECT id FROM pulse.notification_outbox`).toHaveLength(0);
      } finally {
        try {
          await worker?.drain();
        } finally {
          clockedAlerts.mockRestore();
          clockedFreshness.mockRestore();
        }
      }
    } finally {
      const cleanupErrors: unknown[] = [];
      for (const cleanup of [
        () => notificationOutbox.stop(),
        async () => {
          for (const schedule of await scheduler.list()) await scheduler.delete({ id: schedule.id });
        },
        () => sync.drain({ timeoutMs: 5_000 }),
        () => connection.drain(),
        async () => {
          send.mockRestore();
          runSql.mockRestore();
          getSetting.mockRestore();
        },
        () => sql.close(),
        () => database.drop(),
      ]) {
        try {
          await cleanup();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Pulse scheduler fixture cleanup failed");
    }
  },
  45_000,
);
