import { sql } from "@k2b/cloud";
import type { AccessSubject, RequestActor } from "@k2b/cloud/contracts";
import { err, fail, ok, type Result } from "@k2b/cloud/server";
import { z } from "zod";
import type { PulseStoreOutage } from "../contracts";
import { pulseStoreConfigured } from "../store/service";
import { accessScopeFor, requireBaseAccess } from "./access-control";
import { resolvePublicId } from "./public-resources";
import { iso, isoNullable } from "./telemetry-values";

/** Alerts the Sources tab lists at most; a base keeps 20 rules by default, so this cap only bounds a raised limit. */
export const BASE_ATTENTION_ALERT_LIMIT = 50;

/** A fired or unchecked alert of one base, as the attention list and the alert detail show it. */
export type AlertAttention = {
  reference: string;
  name: string;
  state: "firing" | "error" | "no_data";
  severity: "warn" | "critical" | null;
  since: string;
  lastCheckedAt: string | null;
  errorCode: string | null;
  /** One series that is in the rule's state, with its value. */
  key: string | null;
  value: number | null;
  comparison: "above" | "below";
  /** The critical threshold while critical, otherwise the warning threshold (null when only critical is set). */
  threshold: number | null;
};

/** What needs a person on the Sources tab besides the sources themselves: alerts and the data store. */
export type BaseAttention = {
  readAt: string;
  store: PulseStoreOutage;
  alerts: AlertAttention[];
};

/**
 * Whether the data store of one base can take and answer data, as of `readAt`. Unavailable means no store is
 * configured, the instance store has an outage, or the base store failed; `since` is the outage start, else the failed
 * store's last error. A running provision, clear or delete is not an outage; base settings follow it. Null for an
 * unknown or deleted base. Callers check access first; the Sources tab and the base read route share this.
 */
export const readStoreOutage = async (baseId: string): Promise<{ readAt: string; store: PulseStoreOutage } | null> => {
  const [row] = await sql<{ state: string; error_at: Date | null; outage_at: Date | null; read_at: Date }[]>`
    SELECT s.state,s.last_error_at AS error_at,i.outage_started_at AS outage_at,clock_timestamp() AS read_at
    FROM pulse.bases b JOIN pulse.base_stores s ON s.base_id=b.id LEFT JOIN pulse.store_instance i ON i.singleton
    WHERE b.id=${baseId}::uuid AND b.deletion_started_at IS NULL`;
  if (!row) return null;
  const failed = row.state === "failed";
  const unavailable = !(await pulseStoreConfigured()) || row.outage_at !== null || failed;
  return {
    readAt: iso(row.read_at),
    store: { unavailable, since: unavailable ? isoNullable(row.outage_at ?? (failed ? row.error_at : null)) : null },
  };
};

type AlertRow = Omit<AlertAttention, "since" | "lastCheckedAt"> & { since: Date; lastCheckedAt: Date | null };

/**
 * The attention of one base for its Sources tab, read on the server. Requires read access to the base; a person
 * without it gets 403 and an unknown or deleted base 404. Internal: no HTTP route or capability reads it.
 */
export const readBaseAttention = async (input: {
  actor: RequestActor;
  accessSubject: AccessSubject;
  baseId: string;
}): Promise<Result<BaseAttention>> => {
  const scope = accessScopeFor(input.actor, input.accessSubject);
  if (!scope.ok) return scope;
  const baseId = z.uuid().safeParse(input.baseId).success ? input.baseId : await resolvePublicId("bases", input.baseId);
  if (!baseId) return fail(err.notFound("Pulse base"));
  const access = await requireBaseAccess(baseId, scope.data, "read");
  if (!access.ok) return access;
  const store = await readStoreOutage(baseId);
  if (!store) return fail(err.notFound("Pulse base"));
  const rows = await sql<AlertRow[]>`
    SELECT r.short_id AS reference,r.name,r.state,r.severity,r.since,r.last_checked_at AS "lastCheckedAt",
      r.last_error AS "errorCode",sample.key,sample.value,r.comparison,
      CASE WHEN r.severity='critical' THEN r.critical ELSE r.warn END AS threshold
    FROM pulse.alert_rules r LEFT JOIN LATERAL (
      SELECT key,value FROM pulse.alert_states WHERE rule_id=r.id AND state=r.state AND severity IS NOT DISTINCT FROM r.severity
      ORDER BY key LIMIT 1
    ) sample ON true
    WHERE r.base_id=${baseId}::uuid AND r.state IN ('firing','error','no_data')
    ORDER BY CASE WHEN r.state='firing' AND r.severity='critical' THEN 0 WHEN r.state='firing' THEN 1 WHEN r.state='error' THEN 2 ELSE 3 END,
      r.since,r.short_id
    LIMIT ${BASE_ATTENTION_ALERT_LIMIT}`;
  return ok({
    ...store,
    alerts: rows.map(({ since, lastCheckedAt, ...alert }) => ({ ...alert, since: iso(since), lastCheckedAt: isoNullable(lastCheckedAt) })),
  });
};
