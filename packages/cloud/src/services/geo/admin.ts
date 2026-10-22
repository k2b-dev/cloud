import { type SQL, sql } from "bun";
import { HTTPException } from "hono/http-exception";
import {
  GEO_USAGE_GROUPS,
  type GeoAdminPerson,
  type GeoAdminStatus,
  type GeoAdminUsage,
  type GeoBudgetField,
  type GeoBudgetFieldError,
  type GeoBudgetInput,
  type GeoKeyError,
  geoKeyProblem,
  validateGeoBudget,
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
const PLAN_KEY = "geo.plan";
const BUDGET_FIELDS: ReadonlyArray<[GeoBudgetField, string]> = [
  ["customRps", "geo.custom_rps"],
  ["customDailyCredits", "geo.custom_daily_credits"],
  ["monthlyCredits", "geo.monthly_budget_credits"],
  ["personDailyCredits", "geo.person_daily_credits"],
];
const BUDGET_KEYS = [PLAN_KEY, ...BUDGET_FIELDS.map(([, name]) => name)];
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

  /**
   * The person behind the stored value: the audit event written in the same transaction as the newest of these rows
   * carries that transaction's exact timestamp. A later write without an audited person names nobody.
   */
  const changedBy = async (action: string, keys: readonly string[]): Promise<GeoAdminPerson | null> => {
    const [row] = await db<{ actor_user_id: string; name: string | null }[]>`
      SELECT e.actor_user_id, COALESCE(NULLIF(u.display_name, ''), u.uid) AS name
      FROM audit.events e LEFT JOIN auth.users u ON u.id = e.actor_user_id
      WHERE e.action = ${action} AND e.actor_user_id IS NOT NULL
        AND e.created_at = (SELECT max(updated_at) FROM settings.entries WHERE key = ANY(${toPgTextArray([...keys])}::text[]))
      ORDER BY e.id DESC LIMIT 1`;
    return row ? { id: row.actor_user_id, name: row.name ?? row.actor_user_id } : null;
  };

  const status = async (actor: Actor): Promise<GeoAdminStatus> => {
    requireAdmin(actor);
    const [config, states, rows, keyBy, budgetBy] = await Promise.all([
      readGeoConfig(),
      settings.readStates([KEY, ...BUDGET_KEYS]),
      db<{ key: string; updated_at: Date }[]>`
        SELECT key, updated_at FROM settings.entries WHERE key = ANY(${toPgTextArray([KEY, ...BUDGET_KEYS])}::text[])`,
      changedBy(KEY_ACTION, [KEY]),
      changedBy(BUDGET_ACTION, BUDGET_KEYS),
    ]);
    const updated = new Map(rows.map((row) => [row.key, new Date(row.updated_at)]));
    const key = states.get(KEY);
    const keyState = key?.stored === "unreadable" ? "unreadable" : key?.stored === "readable" && String(key.value).trim() ? "set" : "none";
    const keyAt = keyState === "none" ? null : (updated.get(KEY) ?? null);
    const budgetTimes = BUDGET_KEYS.flatMap((name) => updated.get(name)?.getTime() ?? []);
    const budgetAt = budgetTimes.length ? new Date(Math.max(...budgetTimes)) : null;
    return {
      key: { state: keyState, setAt: keyAt?.toISOString() ?? null, setBy: keyState === "set" ? keyBy : null },
      budget: {
        plan: config.plan,
        customRps: config.customRps,
        customDailyCredits: config.customDailyCredits,
        monthlyCredits: config.monthlyCredits,
        personDailyCredits: config.personDailyCredits,
        unreadable: BUDGET_FIELDS.flatMap(([field, name]) => (states.get(name)?.stored === "unreadable" ? [field] : [])),
        changedAt: budgetAt?.toISOString() ?? null,
        changedBy: budgetAt ? budgetBy : null,
      },
      plans: GEO_PLANS,
      timezone: config.timezone,
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
      const problem = geoKeyProblem(apiKey);
      if (problem) throw new GeoAdminError({ code: problem }, 400);
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
        [PLAN_KEY]: input.plan,
        ...Object.fromEntries(
          BUDGET_FIELDS.filter(([field]) => input.plan === "custom" || !field.startsWith("custom")).map(([field, name]) => [
            name,
            input[field],
          ]),
        ),
      };
      // Geo stays off while any geo setting is unreadable. A standard plan hides the custom fields, so saving it
      // resets their unreadable values to the defaults instead of leaving geo off behind a field nobody sees.
      const states = await settings.readStates(BUDGET_FIELDS.map(([, name]) => name));
      const resets = BUDGET_FIELDS.flatMap(([, name]) => (!(name in updates) && states.get(name)?.stored === "unreadable" ? [name] : []));
      await db.begin(async (tx) => {
        // Same lock and final-pair rule as every other writer of these settings.
        await assertGeoBudgetPair(tx, updates, resets);
        // Saving the form is the explicit replacement of a value this installation cannot read.
        for (const [name, value] of Object.entries(updates)) await settings.set(name, value, tx, { replaceUnreadable: true });
        for (const name of resets) await settings.remove(name, tx);
        await audit.record(
          {
            action: BUDGET_ACTION,
            outcome: "allowed",
            actor: auditActor(actor),
            metadata: {
              ...Object.fromEntries(Object.entries(updates).map(([name, value]) => [name.slice(4), value])),
              ...(resets.length ? { resets: resets.map((name) => name.slice(4)) } : {}),
            },
          },
          tx,
        );
      });
      await invalidate([...Object.keys(updates), ...resets]);
      return status(actor);
    },
  };
};

export const geoAdmin = createGeoAdmin();
