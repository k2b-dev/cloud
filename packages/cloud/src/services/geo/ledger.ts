import { type SQL, sql } from "bun";
import type { AccessSubject, CapabilityExecutionContext } from "../../contracts";
import { audit } from "../audit";
import { GeoError } from "./errors";
import type { GeoConfig } from "./settings";

export type GeoBudgetConfig = Pick<GeoConfig, "timezone" | "monthlyCredits" | "personDailyCredits">;
export type GeoPeriod = { period: string; resetsAt: string };
export const geoPeriods = (now: Date, timezone: string): { person: GeoPeriod; cloud: GeoPeriod } => {
  const format = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  const local = (at: number) => {
    const parts = format.formatToParts(new Date(at));
    return ["year", "month", "day"].map((type) => parts.find((p) => p.type === type)!.value).join("-");
  };
  const day = local(now.getTime());
  const boundary = (width: number, length: number): string => {
    const current = day.slice(0, length);
    let low = now.getTime(),
      high = low + width;
    while (high - low > 1) {
      const mid = Math.floor((low + high) / 2);
      if (local(mid).slice(0, length) === current) low = mid;
      else high = mid;
    }
    return new Date(high).toISOString();
  };
  return {
    person: { period: day, resetsAt: boundary(2 * 86400_000, 10) },
    cloud: { period: day.slice(0, 7), resetsAt: boundary(32 * 86400_000, 7) },
  };
};
export const geoSubjectKey = (subject: AccessSubject) =>
  subject.type === "user" ? `user:${subject.userId}` : `service_account:${subject.serviceAccountId}`;
export type GeoReservation = {
  cost: number;
  group: string;
  rows: Array<{ scope: "cloud" | "person"; subject: string; period: string; resetsAt: string; limit: number }>;
};
const rowsFor = (subject: AccessSubject, config: GeoBudgetConfig, now: Date) => {
  const periods = geoPeriods(now, config.timezone);
  return [
    { scope: "cloud", subject: "*", ...periods.cloud, limit: config.monthlyCredits * 1000 },
    { scope: "person", subject: geoSubjectKey(subject), ...periods.person, limit: config.personDailyCredits * 1000 },
  ] satisfies GeoReservation["rows"];
};
export const createGeoLedger = (db: SQL = sql) => ({
  async reserve(subject: AccessSubject, config: GeoBudgetConfig, cost: number, group: string, now: Date): Promise<GeoReservation> {
    if (!Number.isSafeInteger(cost) || cost < 0) throw new Error("Invalid geo reservation");
    const rows = rowsFor(subject, config, now);
    await db.begin(async (tx) => {
      // Fixed order across upserts, updates, shares and settlement: Cloud first, person second.
      for (const row of rows)
        await tx`INSERT INTO geo.usage(scope,subject,period) VALUES(${row.scope},${row.subject},${row.period}) ON CONFLICT DO NOTHING`;
      for (const row of rows) {
        const changed = await tx`UPDATE geo.usage SET used=used+${cost} WHERE scope=${row.scope} AND subject=${row.subject}
          AND period=${row.period} AND used+${cost}<=${row.limit} RETURNING used`;
        if (!changed.length) throw new GeoError("GEO_BUDGET_EXHAUSTED", { scope: row.scope, resetsAt: row.resetsAt });
      }
      for (const row of rows)
        await tx`INSERT INTO geo.shares(scope,subject,period,function_group,used)
        VALUES(${row.scope},${row.subject},${row.period},${group},${cost})
        ON CONFLICT(scope,subject,period,function_group) DO UPDATE SET used=geo.shares.used+EXCLUDED.used`;
    });
    return { cost, group, rows };
  },
  async settle(reservation: GeoReservation, referenceCost: number) {
    const refund = reservation.cost - referenceCost;
    if (!Number.isSafeInteger(referenceCost) || referenceCost < 0 || !Number.isSafeInteger(refund))
      throw new Error("Invalid geo settlement");
    if (!refund) return;
    // Negative refunds truthfully debit known routing overruns. Admission still uses the original
    // bounded CAS transaction; future reservations see the overdrawn counters and are refused.
    // Settle once per reservation, in the same fixed row order as admission.
    await db.begin(async (tx) => {
      for (const row of reservation.rows) {
        await tx`UPDATE geo.usage SET used=used-${refund} WHERE scope=${row.scope} AND subject=${row.subject} AND period=${row.period}`;
        await tx`UPDATE geo.shares SET used=used-${refund} WHERE scope=${row.scope} AND subject=${row.subject} AND period=${row.period} AND function_group=${reservation.group}`;
      }
    });
  },
  async availability(subject: AccessSubject, config: GeoBudgetConfig, now: Date) {
    const balances = [];
    for (const row of rowsFor(subject, config, now)) {
      const [used] = await db<{ used: number }[]>`SELECT used::float8 AS used FROM geo.usage
        WHERE scope=${row.scope} AND subject=${row.subject} AND period=${row.period}`;
      balances.push({ exhausted: (used?.used ?? 0) >= row.limit, resetsAt: row.resetsAt });
    }
    return { cloud: balances[0]!, person: balances[1]! };
  },
  async recordTransition(
    event: "provider_key_rejected" | "monthly_budget_exhausted",
    timezone: string,
    context: Pick<CapabilityExecutionContext, "actor"> & Partial<Pick<CapabilityExecutionContext, "requestId">>,
    now: Date,
  ) {
    const period = geoPeriods(now, timezone).cloud.period;
    await db.begin(async (tx) => {
      const inserted =
        await tx`INSERT INTO geo.audit_transitions(event,period) VALUES(${event},${period}) ON CONFLICT DO NOTHING RETURNING event`;
      if (!inserted.length) return;
      const actor =
        context.actor.kind === "user"
          ? {
              userId: context.actor.user.id,
              uid: context.actor.user.uid,
              provider: context.actor.user.provider,
              roles: context.actor.user.roles,
            }
          : { uid: `service-account:${context.actor.serviceAccount.id}`, provider: "service_account", roles: context.actor.scopes };
      await audit.record(
        {
          action: `core.geo.${event}`,
          outcome: event === "provider_key_rejected" ? "failed" : "denied",
          actor,
          requestId: context.requestId,
          metadata: { period },
        },
        tx,
      );
    });
  },
});
