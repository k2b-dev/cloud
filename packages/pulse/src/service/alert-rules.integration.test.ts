import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { sql } from "bun";
import { suiteFor, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { adminFixtureIdentity } from "../store/admin-identity.test-fixture";

let migrate: typeof import("../migrate")["migrate"];
let baseStore: typeof import("../store/base-store")["baseStore"];
let applyAlertEvaluation: typeof import("./alert-evaluator")["applyAlertEvaluation"];
let claimDueAlert: typeof import("./alert-evaluator")["claimDueAlert"];
let evaluateDueAlerts: typeof import("./alert-evaluator")["evaluateDueAlerts"];
let releaseCancelledAlert: typeof import("./alert-evaluator")["releaseCancelledAlert"];
let alertRules: typeof import("./alert-rules")["alertRules"];
let enqueueBaseNotice: typeof import("./base-notifications")["enqueueBaseNotice"];
let fanoutBaseNotices: typeof import("./base-notifications")["fanoutBaseNotices"];
let seedActiveBaseStore: typeof import("./base-store.test-fixture")["seedActiveBaseStore"];
let checkSourceFreshnessBatch: typeof import("./source-freshness")["checkSourceFreshnessBatch"];
let createSource: typeof import("./source-management")["createSource"];
let removeSource: typeof import("./source-management")["removeSource"];
let updateSource: typeof import("./source-management")["updateSource"];
let sqlService: typeof import("./sql-service");

suiteFor("database")("alert rules preserve rights, revisions and bounded control data", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>> | undefined;
  beforeAll(async () => {
    database = await useFreshDatabase("pulse_alert_rules");
    // Domain singletons bind only after this suite owns its disposable database.
    ({ migrate } = await import("../migrate"));
    ({ baseStore } = await import("../store/base-store"));
    ({ applyAlertEvaluation, claimDueAlert, evaluateDueAlerts, releaseCancelledAlert } = await import("./alert-evaluator"));
    ({ alertRules } = await import("./alert-rules"));
    ({ enqueueBaseNotice, fanoutBaseNotices } = await import("./base-notifications"));
    ({ seedActiveBaseStore } = await import("./base-store.test-fixture"));
    ({ checkSourceFreshnessBatch } = await import("./source-freshness"));
    ({ createSource, removeSource, updateSource } = await import("./source-management"));
    sqlService = await import("./sql-service");
    const { runCoreSetup } = await import("../../../core/src/runtime-helpers");
    await runCoreSetup();
    await migrate("Europe/Berlin");
  }, 30_000);
  afterAll(async () => {
    if (database) {
      await sql.close();
      await database.drop();
    }
  });
  test("interrupted alert SQL preserves PG state and outbox, releases its lease and restores the due time", async () => {
    const baseId = "a47f31ac-d628-4505-bfd4-b5ff86ec8a98";
    const ruleId = "b47f31ac-d628-4505-bfd4-b5ff86ec8a98";
    const at = new Date("2000-01-01T12:00:00Z");
    await sql`INSERT INTO pulse.bases(id,short_id,name) VALUES(${baseId}::uuid,'Cancel','Cancellation')`;
    await seedActiveBaseStore(baseId);
    await sql`INSERT INTO pulse.alert_rules(id,short_id,base_id,name,sql,comparison,warn,min_duration_seconds,interval_seconds,next_check_at,since)
      VALUES(${ruleId}::uuid,'Cancel',${baseId}::uuid,'CPU','SELECT 1','above',80,0,300,${at},${at})`;
    await sql`INSERT INTO pulse.alert_states(rule_id,key,state,value,since,last_checked_at)
      VALUES(${ruleId}::uuid,'cpu','ok',50,${at},${at})`;
    const snapshot = async () => ({
      rules: await sql`SELECT * FROM pulse.alert_rules WHERE id=${ruleId}::uuid`,
      states: await sql`SELECT * FROM pulse.alert_states WHERE rule_id=${ruleId}::uuid`,
      outbox: await sql`SELECT * FROM pulse.notification_outbox WHERE base_id=${baseId}::uuid`,
      activity: await sql`SELECT * FROM pulse.base_activity WHERE base_id=${baseId}::uuid`,
    });
    const before = await snapshot();
    // Only external SQL is substituted: claims, fencing, state and outbox use PG.
    const run = spyOn(sqlService, "runAlertSql");
    try {
      const preAborted = new AbortController();
      preAborted.abort();
      expect(await evaluateDueAlerts("en", { now: () => at, signal: preAborted.signal })).toEqual({ attempted: 0, applied: 0 });
      expect(run).not.toHaveBeenCalled();
      expect(await snapshot()).toEqual(before);
      for (const rejects of [false, true]) {
        const abort = new AbortController();
        run.mockImplementation(async (input) => {
          expect(input.ruleId).toBe(ruleId);
          const [leased] = await sql<{ lease_id: string; next_check_at: Date }[]>`
            SELECT lease_id,next_check_at FROM pulse.alert_rules WHERE id=${ruleId}::uuid`;
          expect(leased?.lease_id).toBe(input.leaseId);
          expect(leased?.next_check_at.toISOString()).toBe("2000-01-01T12:05:00.000Z");
          abort.abort();
          if (rejects) throw abort.signal.reason;
          return { ok: false, error: { code: "CANCELLED", message: "Fixture interruption", status: 400 } };
        });
        expect(await evaluateDueAlerts("en", { now: () => at, signal: abort.signal })).toEqual({ attempted: 1, applied: 0 });
        expect(await snapshot()).toEqual(before);
      }
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      run.mockRestore();
      await sql`DELETE FROM pulse.bases WHERE id=${baseId}::uuid`;
    }
  });
  test("cancelled claim release preserves superseded leases, revision and lifecycle fences, and reclaimed overdue work", async () => {
    const baseId = "c47f31ac-d628-4505-bfd4-b5ff86ec8a98";
    const ruleId = "d47f31ac-d628-4505-bfd4-b5ff86ec8a98";
    const at = new Date("2000-01-01T12:00:00Z");
    await sql`INSERT INTO pulse.bases(id,short_id,name) VALUES(${baseId}::uuid,'FenceC','Cancellation fences')`;
    await seedActiveBaseStore(baseId);
    await sql`INSERT INTO pulse.alert_rules(id,short_id,base_id,name,sql,comparison,warn,min_duration_seconds,interval_seconds,next_check_at,since)
      VALUES(${ruleId}::uuid,'FenceC',${baseId}::uuid,'CPU','SELECT 1','above',80,0,300,${at},${at})`;
    const rule = () => sql`SELECT * FROM pulse.alert_rules WHERE id=${ruleId}::uuid`;
    try {
      const claim = await claimDueAlert(at);
      expect(claim?.id).toBe(ruleId);
      if (!claim) throw new Error("Missing cancellation claim");
      const claimed = await rule();
      await releaseCancelledAlert({ ...claim, revision: claim.revision + 1 });
      expect(await rule()).toEqual(claimed);
      const replacementLease = "e47f31ac-d628-4505-bfd4-b5ff86ec8a98";
      await sql`UPDATE pulse.alert_rules SET lease_id=${replacementLease}::uuid WHERE id=${ruleId}::uuid`;
      const superseded = await rule();
      await releaseCancelledAlert(claim);
      expect(await rule()).toEqual(superseded);
      await sql`UPDATE pulse.alert_rules SET lease_id=${claim.lease_id}::uuid WHERE id=${ruleId}::uuid`;
      await sql`UPDATE pulse.base_stores SET state='clearing' WHERE base_id=${baseId}::uuid`;
      await releaseCancelledAlert(claim);
      expect(await rule()).toEqual(claimed);
      await sql`UPDATE pulse.base_stores SET state='active',reset_generation=reset_generation+1 WHERE base_id=${baseId}::uuid`;
      await releaseCancelledAlert(claim);
      expect(await rule()).toEqual(claimed);
      await sql`UPDATE pulse.base_stores SET reset_generation=${claim.reset_generation} WHERE base_id=${baseId}::uuid`;
      await sql`UPDATE pulse.bases SET deletion_started_at=${at} WHERE id=${baseId}::uuid`;
      await releaseCancelledAlert(claim);
      expect(await rule()).toEqual(claimed);
      await sql`UPDATE pulse.bases SET deletion_started_at=NULL WHERE id=${baseId}::uuid`;
      // Reclaim a lease which expired before its advanced due time. Cancelling
      // the new owner must not make that previously lost check look healthy.
      await sql`UPDATE pulse.alert_rules SET lease_until=${at} WHERE id=${ruleId}::uuid`;
      const reclaimed = await claimDueAlert(at);
      expect(reclaimed?.overdue).toBe(true);
      if (!reclaimed) throw new Error("Missing reclaimed claim");
      await releaseCancelledAlert(reclaimed);
      expect(
        await sql<
          { lease_id: string | null; lease_until: Date | null }[]
        >`SELECT lease_id,lease_until FROM pulse.alert_rules WHERE id=${ruleId}::uuid`,
      ).toEqual([{ lease_id: null, lease_until: null }]);
      const retry = await claimDueAlert(at);
      expect(retry?.id).toBe(ruleId);
      expect(retry?.overdue).toBe(true);
    } finally {
      await sql`DELETE FROM pulse.bases WHERE id=${baseId}::uuid`;
    }
  });
  test("source expectations preserve revisions, rights and transactional activity", async () => {
    const baseId = "947f31ac-d628-4505-bfd4-b5ff86ec8a98";
    const [writer] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,display_name)
      VALUES('pulse_expectation_writer','local','user','Source writer') RETURNING id`;
    await sql`INSERT INTO pulse.bases(id,short_id,name,timezone) VALUES(${baseId}::uuid,'Expect','Expectations','Europe/Berlin')`;
    await seedActiveBaseStore(baseId);
    const [grant] = await sql<{ id: string }[]>`INSERT INTO auth.access(user_id,permission)
      VALUES(${writer!.id}::uuid,'write') RETURNING id`;
    await sql`INSERT INTO pulse.base_access VALUES(${baseId}::uuid,${grant!.id}::uuid)`;
    const input = {
      baseId,
      user: { id: writer!.id },
      actor: adminFixtureIdentity(writer!.id, false).actor,
      requestId: "source-expectation",
    };
    // This PG contract deliberately leaves a durable pending mirror; it performs no store I/O.
    const prepare = spyOn(baseStore, "prepare").mockRejectedValue(new Error("Fixture store offline"));
    try {
      expect(
        await createSource({ ...input, kind: "http_ingest", name: "Invalid", expectEverySeconds: 60, expectDailyBy: "04:00" }),
      ).toMatchObject({ ok: false, error: { status: 400 } });
      const created = await createSource({ ...input, kind: "http_ingest", name: "Nightly", expectDailyBy: "04:00" });
      expect(created).toMatchObject({ ok: true, data: { revision: 1, expectEverySeconds: null, expectDailyBy: "04:00" } });
      if (!created.ok) throw new Error("Missing expectation fixture");
      const sourceId = created.data.id;
      const update = { ...input, sourceId, expectedRevision: 1, expectDailyBy: null, expectEverySeconds: 300 };
      const attempts = await Promise.all([updateSource(update), updateSource(update)]);
      expect(attempts.filter((result) => result.ok)).toHaveLength(1);
      expect(attempts.filter((result) => !result.ok)).toEqual([
        expect.objectContaining({ error: expect.objectContaining({ status: 409 }) }),
      ]);
      expect(
        await sql<
          { revision: number; expect_daily_by: string | null; expect_every_seconds: number | null }[]
        >`SELECT revision,expect_daily_by,expect_every_seconds FROM pulse.sources WHERE id=${sourceId}::uuid`,
      ).toEqual([{ revision: 2, expect_daily_by: null, expect_every_seconds: 300 }]);
      await sql`CREATE FUNCTION pulse.reject_source_activity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'source activity rollback'; END $$`.simple();
      await sql`CREATE TRIGGER reject_source_activity BEFORE INSERT ON pulse.base_activity FOR EACH ROW EXECUTE FUNCTION pulse.reject_source_activity()`.simple();
      try {
        await expect(updateSource({ ...input, sourceId, expectedRevision: 2, name: "Must roll back" })).rejects.toThrow(
          "source activity rollback",
        );
      } finally {
        await sql`DROP TRIGGER reject_source_activity ON pulse.base_activity`.simple();
        await sql`DROP FUNCTION pulse.reject_source_activity()`.simple();
      }
      expect(await sql<{ name: string; revision: number }[]>`SELECT name,revision FROM pulse.sources WHERE id=${sourceId}::uuid`).toEqual([
        { name: "Nightly", revision: 2 },
      ]);
      expect(await updateSource({ ...input, sourceId, expectedRevision: 2, expectEverySeconds: null })).toMatchObject({
        ok: true,
        data: { revision: 3, expectEverySeconds: null, expectDailyBy: null },
      });
      await sql`UPDATE auth.access SET permission='read' WHERE id=${grant!.id}::uuid`;
      expect(await updateSource({ ...input, sourceId, expectedRevision: 3, name: "Forbidden" })).toMatchObject({
        ok: false,
        error: { status: 403 },
      });
      expect(await removeSource({ ...input, sourceId })).toMatchObject({ ok: false, error: { status: 403 } });
      await sql`UPDATE auth.access SET permission='write' WHERE id=${grant!.id}::uuid`;
      expect(await removeSource({ ...input, sourceId })).toMatchObject({ ok: true });
      const activity = await sql<{ kind: string; actor: { id: string }; request_id: string }[]>`
        SELECT kind,actor,request_id FROM pulse.base_activity WHERE base_id=${baseId}::uuid ORDER BY at,id`;
      expect(activity.map((entry) => entry.kind)).toEqual(["source.created", "source.updated", "source.updated", "source.removed"]);
      expect(activity.every((entry) => entry.actor.id === writer!.id && entry.request_id === input.requestId)).toBe(true);
    } finally {
      prepare.mockRestore();
    }
  }, 30_000);
  test("concurrent creates cannot exceed 20; replay writes no duplicate activity; conflicts preserve evaluation state", async () => {
    const baseId = "147f31ac-d628-4505-bfd4-b5ff86ec8a98";
    const [writer] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,display_name)
      VALUES('pulse_alert_writer','local','user','Alert writer') RETURNING id`;
    const [reader] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,display_name)
      VALUES('pulse_alert_reader','local','user','Alert reader') RETURNING id`;
    await sql`INSERT INTO pulse.bases(id,short_id,name,created_at,updated_at)
      VALUES(${baseId}::uuid,'Alert5','Alerts','2026-10-20T10:00:00Z','2026-10-20T10:00:00Z')`;
    await seedActiveBaseStore(baseId);
    for (const [id, permission] of [
      [writer!.id, "write"],
      [reader!.id, "read"],
    ]) {
      const [entry] = await sql<
        { id: string }[]
      >`INSERT INTO auth.access(user_id,permission) VALUES(${id}::uuid,${permission}::auth.permission_level) RETURNING id`;
      await sql`INSERT INTO pulse.base_access VALUES(${baseId}::uuid,${entry!.id}::uuid)`;
    }
    const input = {
      ...adminFixtureIdentity(writer!.id, false),
      baseId,
      name: "CPU",
      sql: "SELECT 'cpu' AS key, :load AS value",
      params: { load: "90" },
      comparison: "above" as const,
      warn: 80,
      critical: 95,
      minDurationSeconds: 300,
      intervalSeconds: 300,
      idempotencyKey: "save-1",
      requestId: "req-alert-1",
    };
    const read = { ...adminFixtureIdentity(reader!.id, false), baseId: "Alert5" };
    expect(await alertRules.save({ ...input, ...read })).toMatchObject({ ok: false, error: { status: 403 } });
    const created = await alertRules.save(input);
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("Cannot create alert fixture");
    expect(await alertRules.save(input)).toEqual(created);
    expect(await alertRules.save({ ...input, warn: 81 })).toMatchObject({ ok: false, error: { status: 409 } });
    expect(await alertRules.get({ ...read, ruleId: created.data.id })).toEqual(created);
    const activity = await sql<
      { kind: string; actor: { id: string }; request_id: string }[]
    >`SELECT kind,actor,request_id FROM pulse.base_activity WHERE base_id=${baseId}::uuid`;
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ kind: "alert_saved", actor: { id: writer!.id }, request_id: "req-alert-1" });
    const [internal] = await sql<{ id: string }[]>`SELECT id FROM pulse.alert_rules WHERE short_id=${created.data.id}`;
    await sql`INSERT INTO pulse.alert_states(rule_id,key,state,severity,value,since,pending_since,last_checked_at)
      VALUES(${internal!.id}::uuid,'cpu','pending','warn',90,'2026-10-20T10:00:00Z','2026-10-20T10:00:00Z','2026-10-20T10:00:00Z')`;
    expect(
      await alertRules.save({ ...input, ruleId: created.data.id, expectedRevision: 2, idempotencyKey: "wrong-revision" }),
    ).toMatchObject({ ok: false, error: { status: 409 } });
    expect(await sql`SELECT key FROM pulse.alert_states WHERE rule_id=${internal!.id}::uuid`).toHaveLength(1);
    const changed = await alertRules.save({ ...input, ruleId: created.data.id, expectedRevision: 1, idempotencyKey: "save-2", warn: 85 });
    expect(changed).toMatchObject({ ok: true, data: { revision: 2, warn: 85 } });
    expect(await sql`SELECT key FROM pulse.alert_states WHERE rule_id=${internal!.id}::uuid`).toHaveLength(0);
    const attempts = await Promise.all(
      Array.from({ length: 20 }, (_, index) => alertRules.save({ ...input, name: `Rule ${index}`, idempotencyKey: `cap-${index}` })),
    );
    expect(attempts.filter((result) => result.ok)).toHaveLength(19);
    expect(attempts.filter((result) => !result.ok)).toHaveLength(1);
    expect(await alertRules.list({ ...read, limit: 20 })).toMatchObject({ ok: true, data: { total: 20, nextOffset: null } });
    expect(await alertRules.save({ ...input, name: "Too fast", intervalSeconds: 299, idempotencyKey: "fast" })).toMatchObject({
      ok: false,
      error: { status: 400 },
    });
    expect(
      await alertRules.save({ ...input, name: "SQL invalid", sql: "DELETE FROM samples", idempotencyKey: "delete-sql" }),
    ).toMatchObject({ ok: false, error: { status: 400 } });
    const removal = { ...input, ruleId: created.data.id, expectedRevision: 2, idempotencyKey: "remove" };
    expect(await alertRules.remove({ ...removal, ...read })).toMatchObject({ ok: false, error: { status: 403 } });
    expect(await alertRules.remove({ ...removal, expectedRevision: 1 })).toMatchObject({ ok: false, error: { status: 409 } });
    expect(await alertRules.remove(removal)).toMatchObject({ ok: true });
    expect(await alertRules.remove(removal)).toMatchObject({ ok: true });
    expect(await sql`SELECT id FROM pulse.base_activity WHERE base_id=${baseId}::uuid AND kind='alert_deleted'`).toHaveLength(1);
    // Removing write access must also stop receipt replay, not just new writes.
    await sql`UPDATE auth.access SET permission='read' WHERE user_id=${writer!.id}::uuid`;
    expect(await alertRules.save(input)).toMatchObject({ ok: false, error: { status: 403 } });
  }, 30_000);
  test("evaluation is fenced, keeps missing keys, and commits notifications atomically", async () => {
    const baseId = "247f31ac-d628-4505-bfd4-b5ff86ec8a98",
      ruleId = "347f31ac-d628-4505-bfd4-b5ff86ec8a98";
    const start = new Date("2026-10-20T12:00:00Z");
    await sql`INSERT INTO pulse.bases(id,short_id,name) VALUES(${baseId}::uuid,'Eval05','Evaluation')`;
    await seedActiveBaseStore(baseId);
    await sql`INSERT INTO pulse.alert_rules(id,short_id,base_id,name,sql,comparison,warn,critical,min_duration_seconds,interval_seconds,next_check_at)
      VALUES(${ruleId}::uuid,'Rule05',${baseId}::uuid,'CPU','SELECT 1','above',80,90,300,300,${start})`;
    const result = (rows: unknown[][]) => ({
      ok: true as const,
      data: {
        columns: [
          { name: "key", type: "String" },
          { name: "value", type: "Float64" },
        ],
        rows,
        rowCount: rows.length,
        truncated: false,
        stats: { elapsedMs: 1, readRows: rows.length, readBytes: 0 },
        runId: "447f31ac-d628-4505-bfd4-b5ff86ec8a98",
        limits: {
          profile: "normal" as const,
          memoryBytes: 2_000_000_000,
          timeSeconds: 10,
          maxRows: 10000,
          maxResultBytes: 4194304,
          queriesUsed: 0,
          queriesPerHour: 600,
          resetAt: "2026-10-20T13:00:00Z",
          baseSlots: 1,
          cloudSlots: 3,
          maxWaiting: 20,
          waitMs: 5000,
        },
      },
    });
    const claim = async (seconds: number) => {
      const at = new Date(start.getTime() + seconds * 1000);
      const value = await claimDueAlert(at);
      expect(value?.id).toBe(ruleId);
      if (!value) throw new Error("Alert was not claimed");
      return { value, at };
    };
    // The prior test's other base is outside this frozen time window.
    const first = await claim(0);
    expect(await claimDueAlert(start)).toBeNull();
    expect(await applyAlertEvaluation({ ...first.value, revision: 99 }, result([["cpu", 85]]), first.at, "de")).toBe(false);
    expect(await applyAlertEvaluation(first.value, result([["cpu", 85]]), first.at, "de")).toBe(true);
    expect(await sql`SELECT id FROM pulse.notification_outbox WHERE base_id=${baseId}::uuid`).toHaveLength(0);
    const firing = await claim(300);
    await sql`CREATE FUNCTION pulse.reject_fixture_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture rollback'; END $$`.simple();
    await sql`CREATE TRIGGER reject_fixture_outbox BEFORE INSERT ON pulse.notification_outbox FOR EACH ROW EXECUTE FUNCTION pulse.reject_fixture_outbox()`.simple();
    await expect(applyAlertEvaluation(firing.value, result([["cpu", 85]]), firing.at, "de")).rejects.toThrow("fixture rollback");
    expect(await sql<{ state: string }[]>`SELECT state FROM pulse.alert_states WHERE rule_id=${ruleId}::uuid`).toEqual([
      { state: "pending" },
    ]);
    await sql`DROP TRIGGER reject_fixture_outbox ON pulse.notification_outbox`.simple();
    await sql`DROP FUNCTION pulse.reject_fixture_outbox()`.simple();
    expect(await applyAlertEvaluation(firing.value, result([["cpu", 85]]), firing.at, "de")).toBe(true);
    expect(await applyAlertEvaluation(firing.value, result([["cpu", 85]]), firing.at, "de")).toBe(false);
    const [notice] = await sql<
      { data: { state: string }; locale: string }[]
    >`SELECT data,locale FROM pulse.notification_outbox WHERE base_id=${baseId}::uuid`;
    expect(notice).toMatchObject({ data: { state: "firing" }, locale: "de" });
    const missing = await claim(600);
    await applyAlertEvaluation(missing.value, result([]), missing.at, "en");
    expect(
      await sql<
        { state: string; incident_open: boolean }[]
      >`SELECT state,incident_open FROM pulse.alert_states WHERE rule_id=${ruleId}::uuid`,
    ).toEqual([{ state: "no_data", incident_open: true }]);
    const pending = await claim(900);
    await applyAlertEvaluation(pending.value, result([["cpu", 85]]), pending.at, "en");
    const recovered = await claim(1200);
    await applyAlertEvaluation(recovered.value, result([["cpu", 50]]), recovered.at, "en");
    expect(await sql<{ state: string }[]>`SELECT state FROM pulse.alert_states WHERE rule_id=${ruleId}::uuid`).toEqual([{ state: "ok" }]);
    expect(
      await sql<
        { state: string }[]
      >`SELECT data->>'state' AS state FROM pulse.notification_outbox WHERE base_id=${baseId}::uuid ORDER BY seq`,
    ).toEqual([{ state: "firing" }, { state: "no_data" }, { state: "ok" }]);
    const invalid = await claim(1500);
    await applyAlertEvaluation(
      invalid.value,
      result([
        ["cpu", 1],
        ["cpu", 2],
      ]),
      invalid.at,
      "en",
    );
    expect(
      await sql<{ state: string; last_error: string }[]>`SELECT state,last_error FROM pulse.alert_rules WHERE id=${ruleId}::uuid`,
    ).toEqual([{ state: "error", last_error: "DUPLICATE_KEY" }]);
    const badKey = await claim(1800);
    await applyAlertEvaluation(badKey.value, result([["bad\0key", 99]]), badKey.at, "en");
    expect(await sql<{ last_error: string }[]>`SELECT last_error FROM pulse.alert_rules WHERE id=${ruleId}::uuid`).toEqual([
      { last_error: "INVALID_KEY" },
    ]);
    // Long, poorly compressible keys must not become PostgreSQL index entries.
    const longKey = Array.from({ length: 1200 }, (_, i) => `${i.toString(36)}-${(i * 104729).toString(36)}`).join(":");
    const large = await claim(2100);
    await applyAlertEvaluation(large.value, result([[longKey, 50]]), large.at, "en");
    expect(await sql<{ key: string }[]>`SELECT key FROM pulse.alert_states WHERE rule_id=${ruleId}::uuid AND key=${longKey}`).toEqual([
      { key: longKey },
    ]);
    const overdue = await claim(2700);
    expect(overdue.value.overdue).toBe(true);
    const oldStates = await sql`SELECT * FROM pulse.alert_states WHERE rule_id=${ruleId}::uuid ORDER BY key`;
    const oldEvents = await sql`SELECT id FROM pulse.notification_outbox WHERE base_id=${baseId}::uuid ORDER BY seq`;
    await sql`UPDATE pulse.base_stores SET state='clearing',reset_generation=reset_generation+1 WHERE base_id=${baseId}::uuid`;
    expect(await applyAlertEvaluation(overdue.value, result([["cpu", 99]]), overdue.at, "en")).toBe(false);
    // Even after reset completes, an earlier result must remain fenced out.
    await sql`UPDATE pulse.base_stores SET state='active' WHERE base_id=${baseId}::uuid`;
    expect(await applyAlertEvaluation(overdue.value, result([["cpu", 99]]), overdue.at, "en")).toBe(false);
    expect(await sql`SELECT * FROM pulse.alert_states WHERE rule_id=${ruleId}::uuid ORDER BY key`).toEqual(oldStates);
    expect(await sql`SELECT id FROM pulse.notification_outbox WHERE base_id=${baseId}::uuid ORDER BY seq`).toEqual(oldEvents);
    // No recipients: the persisted fanout event still completes, without sending anything.
    await fanoutBaseNotices();
    expect(await sql`SELECT id FROM pulse.notification_outbox WHERE base_id=${baseId}::uuid AND user_id IS NOT NULL`).toHaveLength(0);
  }, 30_000);
  test("freshness uses only PG data timestamps and atomically records one transition across replicas", async () => {
    const baseId = "547f31ac-d628-4505-bfd4-b5ff86ec8a98",
      sourceId = "647f31ac-d628-4505-bfd4-b5ff86ec8a98";
    const at = new Date("2026-10-25T03:00:00Z");
    await sql`INSERT INTO pulse.bases(id,short_id,name,timezone) VALUES(${baseId}::uuid,'Fresh5','Freshness','Europe/Berlin')`;
    await seedActiveBaseStore(baseId);
    await sql`INSERT INTO pulse.sources(id,short_id,base_id,name,kind,expect_daily_by,last_data_at,last_seen_at,created_at,next_freshness_check_at)
      VALUES(${sourceId}::uuid,'FreshS',${baseId}::uuid,'Nightly','http_ingest','04:00','2026-10-24T01:00:00Z',${at},'2026-01-01T00:00:00Z',${at})`;
    const query = spyOn(baseStore, "query").mockImplementation(async () => {
      throw new Error("Freshness must not query ClickHouse");
    });
    const prepare = spyOn(baseStore, "prepare").mockImplementation(async () => {
      throw new Error("Freshness must not prepare ClickHouse");
    });
    try {
      await sql`CREATE FUNCTION pulse.reject_freshness_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'freshness rollback'; END $$`.simple();
      await sql`CREATE TRIGGER reject_freshness_outbox BEFORE INSERT ON pulse.notification_outbox FOR EACH ROW EXECUTE FUNCTION pulse.reject_freshness_outbox()`.simple();
      await expect(checkSourceFreshnessBatch("de", at)).rejects.toThrow("freshness rollback");
      expect(await sql<{ stale_since: Date | null }[]>`SELECT stale_since FROM pulse.sources WHERE id=${sourceId}::uuid`).toEqual([
        { stale_since: null },
      ]);
      await sql`DROP TRIGGER reject_freshness_outbox ON pulse.notification_outbox`.simple();
      await sql`DROP FUNCTION pulse.reject_freshness_outbox()`.simple();
      expect(
        (await Promise.all([checkSourceFreshnessBatch("de", at), checkSourceFreshnessBatch("de", at)])).reduce((a, b) => a + b, 0),
      ).toBe(1);
      expect(
        await sql<
          { data: { stale: boolean }; locale: string }[]
        >`SELECT data,locale FROM pulse.notification_outbox WHERE base_id=${baseId}::uuid`,
      ).toEqual([{ data: expect.objectContaining({ sourceId: "FreshS", stale: true }), locale: "de" }]);
      const originalSince = await sql`SELECT stale_since FROM pulse.sources WHERE id=${sourceId}::uuid`;
      const after = new Date(at.getTime() + 24 * 60 * 60_000);
      await checkSourceFreshnessBatch("de", after);
      expect(await sql`SELECT stale_since FROM pulse.sources WHERE id=${sourceId}::uuid`).toEqual(originalSince);
      await checkSourceFreshnessBatch("de", after);
      expect(await sql`SELECT id FROM pulse.notification_outbox WHERE base_id=${baseId}::uuid`).toHaveLength(1);
      await sql`UPDATE pulse.sources SET last_data_at=${after} WHERE id=${sourceId}::uuid`;
      await checkSourceFreshnessBatch("en", new Date(after.getTime() + 60_000));
      expect(
        await sql<
          { stale: boolean }[]
        >`SELECT (data->>'stale')::boolean AS stale FROM pulse.notification_outbox WHERE base_id=${baseId}::uuid ORDER BY seq`,
      ).toEqual([{ stale: true }, { stale: false }]);
      expect(await sql`SELECT id FROM pulse.base_activity WHERE base_id=${baseId}::uuid AND kind='source_freshness'`).toHaveLength(2);
      expect(query).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      query.mockRestore();
      prepare.mockRestore();
    }
  }, 30_000);
  test("fanout covers multiple user pages, general and nested-group admin grants without duplicate recipients", async () => {
    const baseId = "747f31ac-d628-4505-bfd4-b5ff86ec8a98";
    await sql`INSERT INTO pulse.bases(id,short_id,name) VALUES(${baseId}::uuid,'Fanout','Fanout')`;
    await sql`INSERT INTO auth.users(id,uid,provider,profile,display_name)
      SELECT ('80000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'pulse_fanout_'||n,'local','user','Fanout '||n
      FROM generate_series(1,501) AS n`;
    const [all] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM auth.users`;
    const [grant] = await sql<{ id: string }[]>`INSERT INTO auth.access(authenticated_only,permission) VALUES(true,'admin') RETURNING id`;
    await sql`INSERT INTO pulse.base_access VALUES(${baseId}::uuid,${grant!.id}::uuid)`;
    const event = async (name: string, expected: number) => {
      await enqueueBaseNotice(
        sql,
        baseId,
        {
          kind: "source_stale",
          data: {
            baseId: "Fanout",
            baseName: "Fanout",
            sourceId: "Source",
            sourceName: name,
            stale: true,
            newestDataAt: null,
          },
        },
        "de",
      );
      // Earlier fixtures can precede this event. Bound this drain, checking progress
      // in persistent rows rather than relying on recipient count (a page can be empty).
      for (let attempt = 0; attempt < 20; attempt++) {
        await Promise.all([fanoutBaseNotices(), fanoutBaseNotices()]);
        if (!(await sql`SELECT id FROM pulse.notification_outbox WHERE base_id=${baseId}::uuid AND dispatch_kind='fanout'`).length) break;
      }
      expect(await sql`SELECT id FROM pulse.notification_outbox WHERE base_id=${baseId}::uuid AND dispatch_kind='fanout'`).toHaveLength(0);
      const [count] = await sql<{ n: number; unique_users: number; locales: string[] }[]>`
        SELECT count(*)::int AS n,count(DISTINCT user_id)::int AS unique_users,array_agg(DISTINCT locale) AS locales
        FROM pulse.notification_outbox WHERE base_id=${baseId}::uuid AND data->>'sourceName'=${name}`;
      expect(count).toEqual({ n: expected, unique_users: expected, locales: ["de"] });
    };
    await event("Authenticated", all!.n);
    await sql`UPDATE auth.access SET authenticated_only=false WHERE id=${grant!.id}::uuid`;
    await event("Public", all!.n);
    await sql`DELETE FROM auth.access WHERE id=${grant!.id}::uuid`;
    const groups = await sql<{ id: string; cn: string }[]>`INSERT INTO auth.groups(cn,provider,name)
      VALUES('pulse-fanout-parent','local','Fanout parent'),('pulse-fanout-child','local','Fanout child') RETURNING id,cn`;
    const parent = groups.find((group) => group.cn.endsWith("parent"))!.id,
      child = groups.find((group) => group.cn.endsWith("child"))!.id;
    await sql`INSERT INTO auth.group_groups_v2(parent_group_id,child_group_id) VALUES(${parent}::uuid,${child}::uuid)`;
    await sql`INSERT INTO auth.user_groups_v2(user_id,group_id) SELECT id,${child}::uuid FROM auth.users WHERE uid LIKE 'pulse_fanout_%'`;
    const grants = await sql<{ id: string }[]>`INSERT INTO auth.access(group_id,user_id,permission)
      VALUES(${parent}::uuid,NULL,'admin'),(NULL,'80000000-0000-4000-8000-000000000001'::uuid,'admin') RETURNING id`;
    for (const row of grants) await sql`INSERT INTO pulse.base_access VALUES(${baseId}::uuid,${row.id}::uuid)`;
    await event("Nested group and direct", 501);
    // Revoke after fanout, before delivery. Previously queued notices must not
    // leak to a former admin, including earlier general-grant events.
    const revoked = "80000000-0000-4000-8000-000000000002";
    await sql`DELETE FROM auth.user_groups_v2 WHERE user_id=${revoked}::uuid`;
    const { notifications } = await import("@k2b/cloud/services");
    const { notificationOutbox } = await import("./store-health");
    const send = spyOn(notifications, "send").mockResolvedValue({ id: "90000000-0000-4000-8000-000000000001", status: "pending" });
    try {
      await Promise.all([notificationOutbox.reconcile(), notificationOutbox.reconcile()]);
      expect(send).toHaveBeenCalledTimes(500 * 3);
      expect(send).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ recipient: { userId: revoked } }));
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ id: "pulse.sourceStale" }),
        expect.objectContaining({
          recipient: { userId: "80000000-0000-4000-8000-000000000001" },
          locale: "de",
          idempotencyKey: expect.any(String),
        }),
      );
      expect(await sql`SELECT id FROM pulse.notification_outbox WHERE base_id=${baseId}::uuid`).toHaveLength(0);
      await notificationOutbox.reconcile();
      expect(send).toHaveBeenCalledTimes(500 * 3);
    } finally {
      send.mockRestore();
      await notificationOutbox.stop();
    }
  }, 30_000);
});
