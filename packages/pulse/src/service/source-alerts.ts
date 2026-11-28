import { sql } from "@k2b/cloud";
import { err, fail, ok, type Result } from "@k2b/cloud/server";
import type { SourceAlert } from "../contracts";
import { type AccessScope, requireBaseAccess } from "./access-control";
import { isoNullable } from "./telemetry-values";

/** Alerts an open source lists at most: its own rules, firing ones first. */
export const SOURCE_ALERTS_MAX = 20;

/**
 * The alerts that concern one source. An alert rule is free SQL and names no source by itself, so the link is derived
 * from what the data says, never guessed: a rule concerns the source when its SQL or parameters name the source's id
 * (as a whole word), or when one of its keys is the source's target (the endpoint's host, which Pulse records as the
 * resource of every series it fetches that names no instance of its own). One bounded read; the caller's access to
 * the base is checked here.
 */
export const sourceAlerts = async (params: { baseId: string; sourceId: string; user: AccessScope }): Promise<Result<SourceAlert[]>> => {
  const access = await requireBaseAccess(params.baseId, params.user, "read");
  if (!access.ok) return fail(access.error);
  const [source] = await sql<{ id: string; short_id: string; kind: string; endpoint_url: string | null }[]>`
    SELECT id::text AS id, short_id, kind, endpoint_url FROM pulse.sources
    WHERE id = ${params.sourceId}::uuid AND base_id = ${params.baseId}::uuid AND NOT deleted`;
  if (!source) return fail(err.notFound("Source"));
  const instance = source.kind === "metrics" && source.endpoint_url ? hostOf(source.endpoint_url) : null;
  const rows = await sql<
    { id: string; name: string; state: SourceAlert["state"]; severity: SourceAlert["severity"]; since: Date | string | null }[]
  >`
    SELECT r.short_id AS id, r.name, r.state, r.severity, r.since
    FROM pulse.alert_rules r
    WHERE r.base_id = ${params.baseId}::uuid
      AND (
        position(${source.id} IN r.sql) > 0
        OR position(${source.id} IN r.params::text) > 0
        OR r.sql ~ ${`\\m${source.short_id}\\M`}
        OR r.params::text ~ ${`\\m${source.short_id}\\M`}
        OR (${instance}::text IS NOT NULL AND EXISTS (
          SELECT 1 FROM pulse.alert_states s WHERE s.rule_id = r.id AND s.key = ${instance}::text
        ))
      )
    ORDER BY CASE r.state WHEN 'firing' THEN 0 WHEN 'error' THEN 1 WHEN 'no_data' THEN 2 WHEN 'pending' THEN 3 ELSE 4 END, r.name
    LIMIT ${SOURCE_ALERTS_MAX}
  `;
  return ok(rows.map((row) => ({ id: row.id, name: row.name, state: row.state, severity: row.severity, since: isoNullable(row.since) })));
};

/** The host (with its port) of an endpoint, as the fetch records it as the target of its series. */
const hostOf = (url: string) => {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
};
