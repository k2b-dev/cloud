import { sql } from "bun";
import { z } from "zod";
import { OverviewNumberSchema, readOverviewNumber } from "../overview-number";
import { sqlParameterNames } from "../sql-params";
import { type AccessScope, requireBaseAccess } from "./access-control";
import { LEASE_MS, sqlAdmission, WAIT_MS } from "./sql-admission";
import { SqlError } from "./sql-errors";
import { runBaseSql, type SqlIdentity, sqlFailure } from "./sql-service";
import { iso } from "./telemetry-values";

export const OVERVIEW_SLOT_MS = 300_000;
export const OVERVIEW_MAX_QUERIES = 4;
// One request can fill the four fast tiles, but cannot chain four slow profiles.
export const OVERVIEW_WORK_MS = WAIT_MS + LEASE_MS;
// Reserve KILL (5s), admission cleanup (2s), and the finishing transaction (10s).
const OVERVIEW_CLEANUP_MS = 17_000;
const OVERVIEW_LEASE_MS = OVERVIEW_WORK_MS + 15_000;
const Identity = z.object({
  queryId: z.uuid(),
  revision: z.number().int().positive(),
  generation: z.number().int().nonnegative(),
  timezone: z.string(),
});
const Attempt = Identity.extend({
  claimId: z.uuid(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  errorCode: z.string().nullable(),
});
const Snapshot = Identity.extend({
  claimId: z.uuid(),
  slot: z.string().datetime(),
  evaluatedAt: z.string().datetime(),
  windowFrom: z.string().datetime(),
  windowTo: z.string().datetime(),
  data: OverviewNumberSchema,
});
type Attempt = z.infer<typeof Attempt>;
type Snapshot = z.infer<typeof Snapshot>;
type Ledger = { slot_start: Date; attempts: Attempt[]; snapshots: Snapshot[]; lease_id: string | null; lease_until: Date | null };
type Base = { timezone: string; reset_generation: number; state: string; deletion_started_at: Date | null };
type Pin = { id: string; short_id: string; name: string; revision: number; sql: string; params: Record<string, string> };
type Input = SqlIdentity & { baseId: string; scope: AccessScope; signal?: AbortSignal; available?: boolean };
export type OverviewTile = {
  queryId: string;
  name: string;
  revision: number;
  status: "ready" | "refreshing" | "deferred" | "no_data" | "error";
  errorCode: string | null;
  lastAttemptAt: string | null;
  nextRefreshAt: string;
  lastGood: { evaluatedAt: string; windowFrom: string; windowTo: string; data: z.infer<typeof OverviewNumberSchema> } | null;
};
const matches = (item: z.infer<typeof Identity>, pin: Pin, base: Base) =>
  item.queryId === pin.id && item.revision === pin.revision && item.generation === base.reset_generation && item.timezone === base.timezone;
const readLedger = async (baseId: string, db: typeof sql): Promise<Ledger | null> => {
  const [row] = await db<
    Ledger[]
  >`SELECT slot_start,attempts,snapshots,lease_id,lease_until FROM pulse.overview_state WHERE base_id=${baseId}::uuid`;
  return row
    ? { ...row, attempts: z.array(Attempt).max(4).parse(row.attempts), snapshots: z.array(Snapshot).max(4).parse(row.snapshots) }
    : null;
};
const pins = (baseId: string, db: typeof sql) => db<Pin[]>`SELECT id,short_id,name,revision,sql,params FROM pulse.saved_queries
  WHERE base_id=${baseId}::uuid AND pinned ORDER BY created_at,id LIMIT ${OVERVIEW_MAX_QUERIES}`;
const loadBase = async (baseId: string, db: typeof sql): Promise<Base | null> => {
  const [base] = await db<
    (Omit<Base, "reset_generation"> & { reset_generation: number | string })[]
  >`SELECT b.timezone,b.deletion_started_at,s.state,s.reset_generation
    FROM pulse.bases b JOIN pulse.base_stores s ON s.base_id=b.id WHERE b.id=${baseId}::uuid`;
  return base
    ? { ...base, reset_generation: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(base.reset_generation) }
    : null;
};
const cacheKey = (baseId: string, item: z.infer<typeof Identity>, slot: string) =>
  `overview:v1:${baseId}:${item.generation}:${item.queryId}:${item.revision}:${item.timezone}:${slot}`;
export const overviewParameters = (pin: Pick<Pin, "sql" | "params">, slot: Date) => {
  const params = { ...pin.params };
  const automatic: Record<string, string> = {
    from: new Date(slot.getTime() - 86_400_000).toISOString(),
    to: slot.toISOString(),
    bucket: "5m",
  };
  for (const name of sqlParameterNames(pin.sql)) if (Object.hasOwn(automatic, name)) params[name] = automatic[name]!;
  return params;
};

/** Request identity is preserved. Postgres owns the budget and last good data;
 * eviction or failure of the existing Valkey cache cannot authorize more SQL. */
export const createOverviewQueries = (
  dependencies: {
    run?: typeof runBaseSql;
    cache?: Pick<typeof sqlAdmission, "cached" | "cache">;
    testOnly?: { now: () => Date; monotonicNow?: () => number };
  } = {},
) => {
  const run = dependencies.run ?? runBaseSql,
    cache = dependencies.cache ?? sqlAdmission;
  const monotonicNow = dependencies.testOnly?.monotonicNow ?? (() => performance.now());
  const setRemaining = async (tx: typeof sql, until: number) => {
    const remaining = Math.floor(until - monotonicNow());
    if (remaining <= 0) throw new SqlError("TIME_LIMIT", "Overview completion deadline reached");
    await tx`SELECT set_config('statement_timeout',${String(Math.min(10_000, remaining))},true)`;
  };
  const now = async (db: typeof sql) => {
    const [row] = await db<{ at: Date }[]>`SELECT coalesce(${dependencies.testOnly?.now() ?? null}::timestamptz,clock_timestamp()) AS at`;
    return row!.at;
  };
  const claim = async (input: Input) =>
    sql.begin(async (tx) => {
      await tx`SET LOCAL statement_timeout='5s'`.simple();
      await tx`SELECT id FROM pulse.bases WHERE id=${input.baseId}::uuid FOR UPDATE`;
      const access = await requireBaseAccess(input.baseId, input.scope, "read", tx);
      if (!access.ok) return null;
      const base = await loadBase(input.baseId, tx);
      if (!base || base.deletion_started_at || base.state !== "active" || input.available === false || input.signal?.aborted) return null;
      const at = await now(tx),
        slot = new Date(Math.floor(at.getTime() / OVERVIEW_SLOT_MS) * OVERVIEW_SLOT_MS);
      await tx`INSERT INTO pulse.overview_state(base_id,slot_start) VALUES(${input.baseId}::uuid,${slot}) ON CONFLICT DO NOTHING`;
      const ledger = (await readLedger(input.baseId, tx))!;
      if (ledger.lease_until && ledger.lease_until > at) return null;
      if (slot < ledger.slot_start) return null; // A backwards clock cannot refill a slot.
      const attempts = slot > ledger.slot_start ? [] : ledger.attempts;
      if (attempts.length >= OVERVIEW_MAX_QUERIES) return null;
      const current = await pins(input.baseId, tx);
      // An edit does not buy the same query another attempt in this slot.
      const pin = current.find((pin) => !attempts.some((attempt) => attempt.queryId === pin.id));
      if (!pin) return null;
      const item: Attempt = {
        queryId: pin.id,
        revision: pin.revision,
        generation: base.reset_generation,
        timezone: base.timezone,
        claimId: crypto.randomUUID(),
        startedAt: at.toISOString(),
        finishedAt: null,
        errorCode: null,
      };
      const snapshots = ledger.snapshots.filter((snapshot) => current.some((pin) => matches(snapshot, pin, base)));
      const leaseUntil = new Date(at.getTime() + OVERVIEW_LEASE_MS);
      await tx`UPDATE pulse.overview_state SET slot_start=${slot},
      attempts=(${JSON.stringify([...attempts, item])}::jsonb #>> '{}')::jsonb,
      snapshots=(${JSON.stringify(snapshots)}::jsonb #>> '{}')::jsonb,
      lease_id=${item.claimId}::uuid,lease_until=${leaseUntil} WHERE base_id=${input.baseId}::uuid`;
      return { item, pin, slot, workMs: Math.min(OVERVIEW_WORK_MS, slot.getTime() + OVERVIEW_SLOT_MS - at.getTime()) };
    });
  type Claim = NonNullable<Awaited<ReturnType<typeof claim>>>;
  const finish = async (input: Input, owned: Claim, result: Awaited<ReturnType<typeof runBaseSql>>, until: number) =>
    sql.begin(async (tx) => {
      await setRemaining(tx, until);
      await tx`SELECT id FROM pulse.bases WHERE id=${input.baseId}::uuid FOR UPDATE`;
      await setRemaining(tx, until);
      const base = await loadBase(input.baseId, tx);
      await setRemaining(tx, until);
      const ledger = await readLedger(input.baseId, tx);
      await setRemaining(tx, until);
      const at = await now(tx);
      if (!base || !ledger || ledger.lease_id !== owned.item.claimId || !ledger.lease_until || ledger.lease_until <= at) return null;
      await setRemaining(tx, until);
      const current = await pins(input.baseId, tx);
      const valid = !base.deletion_started_at && base.state === "active" && current.some((pin) => matches(owned.item, pin, base));
      const projected = valid && result.ok ? readOverviewNumber(result.data) : null;
      const errorCode = !valid ? "CANCELLED" : !result.ok ? result.error.code : projected?.ok ? null : (projected?.code ?? "INVALID_VALUE");
      const snapshot: Snapshot | null = projected?.ok
        ? {
            ...owned.item,
            slot: owned.slot.toISOString(),
            evaluatedAt: at.toISOString(),
            windowFrom: new Date(owned.slot.getTime() - 86_400_000).toISOString(),
            windowTo: owned.slot.toISOString(),
            data: projected.data,
          }
        : null;
      const attempts = ledger.attempts.map((item) =>
        item.claimId === owned.item.claimId ? { ...item, finishedAt: at.toISOString(), errorCode } : item,
      );
      const snapshots = ledger.snapshots.filter(
        (old) => current.some((pin) => matches(old, pin, base)) && (!snapshot || old.queryId !== snapshot.queryId),
      );
      if (snapshot) snapshots.push(snapshot);
      await setRemaining(tx, until);
      await tx`UPDATE pulse.overview_state SET attempts=(${JSON.stringify(attempts)}::jsonb #>> '{}')::jsonb,
      snapshots=(${JSON.stringify(snapshots)}::jsonb #>> '{}')::jsonb,lease_id=NULL,lease_until=NULL WHERE base_id=${input.baseId}::uuid`;
      return snapshot;
    });
  return async (input: Input): Promise<OverviewTile[]> => {
    const access = await requireBaseAccess(input.baseId, input.scope, "read");
    if (!access.ok) return [];
    const until = monotonicNow() + OVERVIEW_WORK_MS;
    const deadline = AbortSignal.timeout(OVERVIEW_WORK_MS - OVERVIEW_CLEANUP_MS);
    const signal = AbortSignal.any([deadline, ...(input.signal ? [input.signal] : [])]);
    for (let index = 0; index < OVERVIEW_MAX_QUERIES && !signal.aborted && monotonicNow() < until - OVERVIEW_CLEANUP_MS; index++) {
      const owned = await claim({ ...input, signal });
      if (!owned) break;
      const slotSignal = AbortSignal.timeout(Math.max(1, owned.workMs));
      let result: Awaited<ReturnType<typeof runBaseSql>>;
      try {
        result = await run({
          ...input,
          sql: owned.pin.sql,
          params: overviewParameters(owned.pin, owned.slot),
          via: "overview",
          signal: AbortSignal.any([signal, slotSignal]),
        });
      } catch (error) {
        result = sqlFailure(error);
      }
      const snapshot = await finish(input, owned, result, Math.min(until, monotonicNow() + 10_000)).catch((error: unknown) => {
        if (
          (error instanceof SqlError && error.code === "TIME_LIMIT") ||
          (typeof error === "object" &&
            error !== null &&
            (("errno" in error && error.errno === "57014") || ("code" in error && error.code === "57014")))
        )
          return null;
        throw error;
      });
      // Durable commit precedes optional caching. A failed cache write cannot
      // discard the last good result or refund an already consumed attempt.
      if (snapshot) await cache.cache(cacheKey(input.baseId, snapshot, snapshot.slot), JSON.stringify(snapshot)).catch(() => {});
      if (slotSignal.aborted) break;
    }
    // Recheck rights after SQL, including permission revocation during execution.
    if (!(await requireBaseAccess(input.baseId, input.scope, "read")).ok) return [];
    const base = await loadBase(input.baseId, sql);
    if (!base || base.deletion_started_at) return [];
    const at = await now(sql),
      current = await pins(input.baseId, sql),
      ledger = await readLedger(input.baseId, sql);
    const slot = new Date(Math.floor(at.getTime() / OVERVIEW_SLOT_MS) * OVERVIEW_SLOT_MS).toISOString();
    const tiles: OverviewTile[] = [];
    for (const pin of current) {
      const attempt = ledger && iso(ledger.slot_start) === slot ? ledger.attempts.find((item) => matches(item, pin, base)) : undefined;
      let snapshot = ledger?.snapshots.find((item) => matches(item, pin, base));
      if (snapshot?.slot === slot && attempt?.finishedAt && !attempt.errorCode) {
        try {
          const raw = await cache.cached(cacheKey(input.baseId, snapshot, slot));
          const cached = raw ? Snapshot.safeParse(JSON.parse(raw)) : null;
          if (cached?.success && cached.data.claimId === snapshot.claimId && cached.data.slot === slot && matches(cached.data, pin, base))
            snapshot = cached.data;
        } catch {
          /* The durable, identity-checked snapshot remains available. */
        }
      }
      const active =
        !!attempt && !attempt.finishedAt && ledger?.lease_id === attempt.claimId && !!ledger.lease_until && ledger.lease_until > at;
      const errorCode =
        base.state !== "active" || input.available === false
          ? "STORE_UNAVAILABLE"
          : attempt && !attempt.finishedAt && !active
            ? "OVERDUE"
            : (attempt?.errorCode ?? null);
      tiles.push({
        queryId: pin.short_id,
        name: pin.name,
        revision: pin.revision,
        status:
          errorCode === "NO_DATA"
            ? "no_data"
            : errorCode
              ? "error"
              : active
                ? "refreshing"
                : snapshot?.slot === slot
                  ? "ready"
                  : "deferred",
        errorCode,
        lastAttemptAt: attempt?.startedAt ?? null,
        nextRefreshAt: new Date(Date.parse(slot) + OVERVIEW_SLOT_MS).toISOString(),
        lastGood: snapshot
          ? { evaluatedAt: snapshot.evaluatedAt, windowFrom: snapshot.windowFrom, windowTo: snapshot.windowTo, data: snapshot.data }
          : null,
      });
    }
    return tiles;
  };
};
export const readOverviewQueries = createOverviewQueries();
