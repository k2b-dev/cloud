import { type SQL, sql } from "bun";
import { HTTPException } from "hono/http-exception";
import {
  GEO_MAX_CREDITS,
  GEO_MAX_KEY_LENGTH,
  GEO_MAX_RPS,
  GEO_USAGE_GROUPS,
  type GeoAdminPerson,
  type GeoAdminStatus,
  type GeoAdminUsage,
  type GeoBudgetField,
  type GeoBudgetFieldError,
  type GeoBudgetInput,
  type GeoKeyError,
  type GeoPlanId,
} from "../../contracts/geo-admin";
import { audit } from "../audit";
import { toPgTextArray } from "../postgres";
import * as settings from "../settings";
import { assertGeoBudgetPair } from "../settings/geo-budget";
import { GeoapifyAdapter, GeoProviderError } from "./geoapify";
import { geoPeriods } from "./ledger";
import { GEO_PLANS, readGeoConfig } from "./settings";

type Actor = { id: string; roles: readonly string[]; uid?: string; provider?: string };

const KEY = "geo.api_key";
const BUDGET_KEYS = {
  plan: "geo.plan",
  customRps: "geo.custom_rps",
  customDailyCredits: "geo.custom_daily_credits",
  monthlyCredits: "geo.monthly_budget_credits",
  personDailyCredits: "geo.person_daily_credits",
} as const satisfies Record<GeoBudgetField | "plan", string>;
const KEY_ACTION = "core.geo.key_set";
const BUDGET_ACTION = "core.geo.budget_changed";
/** A known place for the verification lookup; any answer that is not a key refusal proves the key works. */
const PROBE = { point: { lat: 48.3984, lon: 9.9916 } };

export class GeoAdminError extends Error {
  constructor(
    readonly body: GeoKeyError | { code: "geo_budget_invalid"; errors: Partial<Record<GeoBudgetField, GeoBudgetFieldError>> },
    readonly status: 400 | 422 | 502,
  ) {
    super(body.code); // Never carries the key or a provider body.
    this.name = "GeoAdminError";
  }
}

const requireAdmin = (actor: Actor) => {
  if (!actor.roles.includes("admin")) throw new HTTPException(403, { message: "Administrator access required." });
};
const invalidate = async (keys: readonly string[]) => {
  try {
    await settings.invalidateSettingsCache(keys);
  } catch (error) {
    console.error("[geo] committed settings but failed to invalidate the shared cache; TTL recovery remains active", error);
  }
};
const auditActor = (actor: Actor) => ({ userId: actor.id, uid: actor.uid, provider: actor.provider, roles: actor.roles });

/** Validate one budget number; `null` when it is acceptable. */
const checkNumber = (value: unknown, min: number, max: number): GeoBudgetFieldError | null => {
  if (typeof value !== "number" || !Number.isInteger(value)) return { code: "not_whole_number" };
  if (value < min) return { code: "too_small", min };
  if (value > max) return { code: "too_large", max };
  return null;
};

/** Check the whole form before anything is written; the same rules as the settings registry plus the pair rule. */
export const validateGeoBudget = (input: GeoBudgetInput) => {
  const errors: Partial<Record<GeoBudgetField, GeoBudgetFieldError>> = {};
  const fields: Array<[GeoBudgetField, number, number]> = [
    ["monthlyCredits", 0, GEO_MAX_CREDITS],
    ["personDailyCredits", 0, GEO_MAX_CREDITS],
    ...(input.plan === "custom"
      ? ([
          ["customRps", 1, GEO_MAX_RPS],
          ["customDailyCredits", 1, GEO_MAX_CREDITS],
        ] as Array<[GeoBudgetField, number, number]>)
      : []),
  ];
  for (const [field, min, max] of fields) {
    const error = checkNumber(input[field], min, max);
    if (error) errors[field] = error;
  }
  const month = input.monthlyCredits,
    day = input.personDailyCredits;
  if (!errors.monthlyCredits && !errors.personDailyCredits && typeof month === "number" && typeof day === "number" && day > month)
    errors.personDailyCredits = { code: "above_monthly", max: month };
  return errors;
};

type Verify = (apiKey: string, signal?: AbortSignal) => Promise<void>;
export const verifyGeoapifyKey =
  (adapter = new GeoapifyAdapter()): Verify =>
  async (apiKey, signal) => {
    try {
      await adapter.reverse(PROBE, apiKey, "en", signal);
    } catch (error) {
      if (error instanceof GeoProviderError && error.keyRejected) throw new GeoAdminError({ code: "geo_key_rejected" }, 422);
      // Timeouts, rate limits, malformed answers and unreachable hosts prove nothing about the key.
      throw new GeoAdminError({ code: "geo_key_unverified" }, 502);
    }
  };

export const createGeoAdmin = (options: { db?: SQL; verify?: Verify; now?: () => Date } = {}) => {
  const db = options.db ?? sql;
  const verify = options.verify ?? verifyGeoapifyKey();
  const now = options.now ?? (() => new Date());

  const lastChange = async (action: string): Promise<{ at: Date; by: GeoAdminPerson | null } | null> => {
    const [row] = await db<{ created_at: Date; actor_user_id: string | null; name: string | null }[]>`
      SELECT e.created_at, e.actor_user_id, COALESCE(NULLIF(u.display_name, ''), u.uid) AS name
      FROM audit.events e LEFT JOIN auth.users u ON u.id = e.actor_user_id
      WHERE e.action = ${action} ORDER BY e.created_at DESC LIMIT 1`;
    if (!row) return null;
    return { at: new Date(row.created_at), by: row.actor_user_id ? { id: row.actor_user_id, name: row.name ?? row.actor_user_id } : null };
  };
  /** A person is named only when their audited change is the latest write; settings and audit share one transaction time. */
  const changedBy = (event: Awaited<ReturnType<typeof lastChange>>, at: Date | null) =>
    event && at && event.at.getTime() >= at.getTime() ? event.by : null;

  const status = async (actor: Actor): Promise<GeoAdminStatus> => {
    requireAdmin(actor);
    const budgetKeys = Object.values(BUDGET_KEYS);
    const [states, rows, keyEvent, budgetEvent] = await Promise.all([
      settings.readStates([KEY, ...budgetKeys, "app.timezone"]),
      db<{ key: string; updated_at: Date }[]>`
        SELECT key, updated_at FROM settings.entries WHERE key = ANY(${toPgTextArray([KEY, ...budgetKeys])}::text[])`,
      lastChange(KEY_ACTION),
      lastChange(BUDGET_ACTION),
    ]);
    const updated = new Map(rows.map((row) => [row.key, new Date(row.updated_at)]));
    const key = states.get(KEY);
    const keyState = key?.stored === "unreadable" ? "unreadable" : key?.stored === "readable" && String(key.value).trim() ? "set" : "none";
    const keyAt = keyState === "none" ? null : (updated.get(KEY) ?? null);
    const budgetTimes = budgetKeys.flatMap((name) => updated.get(name)?.getTime() ?? []);
    const budgetAt = budgetTimes.length ? new Date(Math.max(...budgetTimes)) : null;
    const value = <T>(name: string) => states.get(name)?.value as T;
    return {
      key: { state: keyState, setAt: keyAt?.toISOString() ?? null, setBy: keyState === "set" ? changedBy(keyEvent, keyAt) : null },
      budget: {
        plan: value<GeoPlanId>(BUDGET_KEYS.plan),
        customRps: value<number>(BUDGET_KEYS.customRps),
        customDailyCredits: value<number>(BUDGET_KEYS.customDailyCredits),
        monthlyCredits: value<number>(BUDGET_KEYS.monthlyCredits),
        personDailyCredits: value<number>(BUDGET_KEYS.personDailyCredits),
        unreadable: (Object.entries(BUDGET_KEYS) as Array<[GeoBudgetField | "plan", string]>).flatMap(([field, name]) =>
          field !== "plan" && states.get(name)?.stored === "unreadable" ? [field] : [],
        ),
        changedAt: budgetAt?.toISOString() ?? null,
        changedBy: changedBy(budgetEvent, budgetAt),
      },
      plans: GEO_PLANS,
      timezone: value<string>("app.timezone"),
    };
  };

  const usage = async (actor: Actor): Promise<GeoAdminUsage> => {
    requireAdmin(actor);
    const config = await readGeoConfig();
    const periods = geoPeriods(now(), config.timezone);
    const plan = config.plan === "custom" ? { dailyCredits: config.customDailyCredits } : GEO_PLANS[config.plan];
    const [[month], [today], shares] = await Promise.all([
      db<
        { used: number }[]
      >`SELECT used::float8 AS used FROM geo.usage WHERE scope = 'cloud' AND subject = '*' AND period = ${periods.cloud.period}`,
      db<{ used: number; at_limit: number }[]>`
        SELECT COALESCE(sum(used), 0)::float8 AS used, count(*) FILTER (WHERE used >= ${config.personDailyCredits * 1000})::int AS at_limit
        FROM geo.usage WHERE scope = 'person' AND period = ${periods.person.period}`,
      db<{ function_group: string; used: number }[]>`
        SELECT function_group, used::float8 AS used FROM geo.shares WHERE scope = 'cloud' AND subject = '*' AND period = ${periods.cloud.period}`,
    ]);
    return {
      month: {
        period: periods.cloud.period,
        used: (month?.used ?? 0) / 1000,
        limit: config.monthlyCredits,
        resetsAt: periods.cloud.resetsAt,
      },
      today: {
        period: periods.person.period,
        used: (today?.used ?? 0) / 1000,
        allowance: plan.dailyCredits,
        resetsAt: periods.person.resetsAt,
      },
      shares: GEO_USAGE_GROUPS.map((group) => ({
        group,
        credits: (shares.find((row) => row.function_group === group)?.used ?? 0) / 1000,
      })),
      peopleAtLimit: today?.at_limit ?? 0,
      timezone: config.timezone,
    };
  };

  return {
    status,
    usage,
    /** Store a key only after Geoapify accepted it; until then the previous key stays active. */
    async setKey(actor: Actor, raw: string, signal?: AbortSignal): Promise<GeoAdminStatus> {
      requireAdmin(actor);
      const apiKey = raw.trim();
      if (!apiKey) throw new GeoAdminError({ code: "geo_key_missing" }, 400);
      if (apiKey.length > GEO_MAX_KEY_LENGTH || !/^[\x21-\x7e]+$/.test(apiKey)) throw new GeoAdminError({ code: "geo_key_malformed" }, 400);
      await verify(apiKey, signal);
      signal?.throwIfAborted();
      const before = (await settings.readStates([KEY])).get(KEY)?.stored ?? "none";
      await db.begin(async (tx) => {
        // The person replaces whatever is stored, including a value this installation cannot read.
        await settings.set(KEY, apiKey, tx, { replaceUnreadable: true });
        await audit.record(
          { action: KEY_ACTION, outcome: "allowed", actor: auditActor(actor), metadata: { replaced: before !== "none" } },
          tx,
        );
      });
      await invalidate([KEY]);
      return status(actor);
    },
    async removeKey(actor: Actor): Promise<GeoAdminStatus> {
      requireAdmin(actor);
      await db.begin(async (tx) => {
        const [row] = await tx<{ key: string }[]>`DELETE FROM settings.entries WHERE key = ${KEY} RETURNING key`;
        if (row) await audit.record({ action: "core.geo.key_removed", outcome: "allowed", actor: auditActor(actor) }, tx);
      });
      await invalidate([KEY]);
      return status(actor);
    },
    async saveBudget(actor: Actor, input: GeoBudgetInput): Promise<GeoAdminStatus> {
      requireAdmin(actor);
      const errors = validateGeoBudget(input);
      if (Object.keys(errors).length) throw new GeoAdminError({ code: "geo_budget_invalid", errors }, 400);
      const updates: Record<string, unknown> = {
        [BUDGET_KEYS.plan]: input.plan,
        [BUDGET_KEYS.monthlyCredits]: input.monthlyCredits,
        [BUDGET_KEYS.personDailyCredits]: input.personDailyCredits,
        ...(input.plan === "custom"
          ? { [BUDGET_KEYS.customRps]: input.customRps, [BUDGET_KEYS.customDailyCredits]: input.customDailyCredits }
          : {}),
      };
      await db.begin(async (tx) => {
        // Same lock and final-pair rule as every other writer of these settings.
        await assertGeoBudgetPair(tx, updates, []);
        // Saving the form is the explicit replacement of a value this installation cannot read.
        for (const [name, value] of Object.entries(updates)) await settings.set(name, value, tx, { replaceUnreadable: true });
        await audit.record(
          {
            action: BUDGET_ACTION,
            outcome: "allowed",
            actor: auditActor(actor),
            metadata: Object.fromEntries(Object.entries(updates).map(([name, value]) => [name.slice(4), value])),
          },
          tx,
        );
      });
      await invalidate(Object.keys(updates));
      return status(actor);
    },
  };
};

export const geoAdmin = createGeoAdmin();
