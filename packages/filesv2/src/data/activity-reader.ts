import { logger, toPgTextArray, toPgUuidArray } from "@k2b/cloud/services";
import { type ReservedSQL, type SQL, sql } from "bun";
import {
  ACTIVITY_PAGE_LIMIT,
  ACTIVITY_SCAN_LIMIT,
  type ActivityEntry,
  HistoryAction,
  type ShareAccessCounts,
  ShareAccessInput,
  ShareAccessNetwork,
  type ShareAccessPeriod,
} from "../activity-contracts";
import { type ActivityReadBudget, withActivityReadBudget } from "../service/activity-read-budget";
import { FilesError } from "../service/errors";
import type { Binding } from "./bases";

/** Deliberately excludes raw detail, tokens, journal IDs and error messages. */
export type ActivityCandidate = {
  id: string;
  started_at: Date;
  finished_at: Date | null;
  /** SQL text preserves PostgreSQL microseconds across cursor round trips. */
  effective_time: string;
  state: ActivityEntry["state"];
  action: string;
  server_url: string;
  root: string;
  root_after: string | null;
  base_id: string | null;
  base_after_id: string | null;
  item_id: string | null;
  item_after_id: string | null;
  directory: boolean;
  share_expires_at: Date | null;
  /** Derived boolean only; raw detail never leaves SQL. */
  metadataUnknown: boolean;
  path_before: string | null;
  path_after: string | null;
  size: number | string | null;
  revision_before: string | null;
  revision_after: string | null;
  version_id: string | null;
  actor_kind: ActivityEntry["actor"]["kind"];
  actor_user_id: string | null;
  via: string;
  calling_app: string | null;
  origin: string | null;
  invocation_id: string | null;
  request_id: string | null;
  batch_id: string | null;
  observed_before: unknown;
  observed_after: unknown;
};
export type ActivityPosition = { time: string; id: string };
export type CandidateInput = {
  scope: { admin: boolean; userId: string; bindingIds: string[]; serverUrl: string };
  baseId?: string;
  /** Only supplied after projecting a visible anchor; peers exclude that already counted event. */
  batch?: { id: string; anchorId: string };
  chain?: { serverUrl: string; root: string; baseId: string | null; path: string };
  position: ActivityPosition | null;
  direction: "asc" | "desc";
  limit: number;
  from?: string;
  to?: string;
};

const log = logger("filesv2:activity-reader");

async function readQuery<T>(query: SQL.Query<T>, budget?: ActivityReadBudget): Promise<T> {
  if (!budget) return query;
  let connection: ReservedSQL | undefined;
  let backendPid: number | undefined;
  let cancellation: Promise<void> | undefined;
  return budget.run(
    async () => {
      connection = await sql.reserve({ signal: budget.signal });
      try {
        budget.check();
        return await connection.begin(async (db) => {
          budget.check();
          // A server-side bound remains if a cancellation connection cannot reach Postgres.
          // Keep an operator's stricter timeout, and restore the setting when this transaction ends.
          const [backend] = await db<{ pid: number }[]>`SELECT pg_backend_pid() AS pid,
            set_config('statement_timeout', (SELECT least(nullif(setting::bigint,0),${budget.remainingMs()})::text
              FROM pg_settings WHERE name='statement_timeout'), true)`;
          backendPid = backend!.pid;
          budget.check();
          const rows = await db<T>`${query}`;
          budget.check();
          return rows;
        });
      } finally {
        try {
          await cancellation;
        } finally {
          connection.release();
        }
      }
    },
    () => {
      const owned = connection;
      if (!owned) return;
      // Bun's PostgreSQL query.cancel() does not interrupt the server on all supported versions.
      // Keep this session reserved until its cancellation completes, so it cannot hit another request.
      cancellation = (async () => {
        try {
          if (backendPid !== undefined) {
            // Cancellation must not queue behind blocked reads in the application pool.
            const control = new Bun.SQL({ ...sql.options, max: 1 });
            try {
              await withActivityReadBudget(undefined, (cleanup) =>
                cleanup.run(
                  () => control`SELECT pg_cancel_backend(${backendPid})`,
                  () => {
                    void control
                      .close({ timeout: 0 })
                      .catch((error: unknown) => log.warn("History SQL cancellation connection close failed", { error }));
                  },
                ),
              );
            } finally {
              await control.close({ timeout: 0 });
            }
          }
        } finally {
          await owned.close({ timeout: 0 });
        }
      })().catch((error: unknown) => {
        // The request already rejected. Observe cleanup failures immediately,
        // even while the original data query is still waiting on socket I/O.
        log.warn("History SQL cancellation failed", { error });
      });
    },
  );
}

export const activityReaderData = {
  /** All recorded locations; no lifecycle or public-ID deduplication may discard historical bindings. */
  async activityBases(
    after: string | undefined,
    limit: number,
    budget: ActivityReadBudget,
    filter: { baseId?: string; bindingIds?: string[] } = {},
  ): Promise<{
    items: Pick<Binding, "id" | "area" | "kind" | "identity_id" | "identity_name" | "root" | "path">[];
    next: string | null;
  }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > ACTIVITY_PAGE_LIMIT) throw new RangeError("Invalid base page limit");
    budget.check();
    const identities = filter.baseId ? sql`area || ':' || kind || ':' || identity_id::text = ${filter.baseId}` : sql`TRUE`;
    const bindings = filter.bindingIds ? sql`id=ANY(${toPgUuidArray(filter.bindingIds)}::uuid[])` : sql`TRUE`;
    const query = sql<Pick<Binding, "id" | "area" | "kind" | "identity_id" | "identity_name" | "root" | "path">[]>`
    SELECT id,area,kind,identity_id,identity_name,root,path FROM filesv2.bases
    WHERE (${after ?? null}::uuid IS NULL OR id>${after ?? null}::uuid) AND area='cloud' AND ${identities} AND ${bindings}
    ORDER BY id LIMIT ${limit + 1}`;
    const rows = await readQuery(query, budget);
    return { items: rows.slice(0, limit), next: rows.length > limit ? rows[limit - 1]!.id : null };
  },
  /** Uses the activity migration's effective-time index; LIMIT bounds returned candidates. */
  async candidates(input: CandidateInput, budget?: ActivityReadBudget): Promise<ActivityCandidate[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > ACTIVITY_SCAN_LIMIT)
      throw new RangeError("Invalid activity scan limit");
    const columns = sql`id,started_at,finished_at,coalesce(finished_at,started_at)::text AS effective_time,
      state,action,server_url,root,root_after,base_id,base_after_id,item_id,item_after_id,directory,path_before,path_after,
      size,revision_before,revision_after,version_id,actor_kind,actor_user_id,via,calling_app,origin,invocation_id,request_id,batch_id,
      detail->'observed_before' AS observed_before,detail->'observed_after' AS observed_after,
      s.share_expires_at,
      (detail @> '{"metadata_unknown":true}'::jsonb OR detail @> '{"snapshot_unknown":true}'::jsonb
        OR detail @> '{"directory_unknown":true}'::jsonb) AS "metadataUnknown"`;
    // Local areas have one Cloud grant boundary for the whole tree. Scope BOTH sides
    // before LIMIT, including historical bindings for administrators. Neither authorship
    // nor a readable other side grants access to this side.
    const visibleSide = (after: boolean) => {
      const id = after
        ? sql`coalesce(activity.base_after_id,CASE WHEN coalesce(activity.root_after,activity.root)=activity.root THEN activity.base_id END)`
        : sql`activity.base_id`;
      const root = after ? sql`coalesce(activity.root_after,activity.root)` : sql`activity.root`;
      const path = after ? sql`activity.path_after` : sql`activity.path_before`;
      return sql`EXISTS (SELECT 1 FROM filesv2.bases b WHERE b.id=${id} AND b.area='cloud'
        AND b.root=${root} AND ${path} IS NOT NULL
        AND (${path}=b.path OR starts_with(${path},b.path || '/'))
        AND (${input.scope.admin} OR (b.lifecycle='active' AND b.id=ANY(${toPgUuidArray(input.scope.bindingIds)}::uuid[])
          AND activity.server_url=${input.scope.serverUrl}))
        AND (${input.baseId ?? null}::text IS NULL OR b.area || ':' || b.kind || ':' || b.identity_id::text=${input.baseId ?? null}))`;
    };
    const indexedScope = input.scope.admin
      ? sql`TRUE`
      : sql`server_url=${input.scope.serverUrl} AND (base_id=ANY(${toPgUuidArray(input.scope.bindingIds)}::uuid[])
          OR base_after_id=ANY(${toPgUuidArray(input.scope.bindingIds)}::uuid[]))`;
    const scope = sql`${indexedScope} AND (${visibleSide(false)} OR ${visibleSide(true)})
      AND action=ANY(${toPgTextArray(HistoryAction.options)}::text[])`;
    const ancestors = input.chain ? input.chain.path.split("/").map((_, index, parts) => parts.slice(0, index + 1).join("/")) : [];
    ancestors.unshift("");
    const chain = !input.chain
      ? sql`TRUE`
      : sql`state='done'
      AND server_url=${input.chain.serverUrl}
      AND ((root=${input.chain.root} AND base_id IS NOT DISTINCT FROM ${input.chain.baseId}::uuid
        AND left(path_before,400)=ANY(${toPgTextArray(ancestors.map((path) => [...path].slice(0, 400).join("")))}::text[])
        AND path_before=ANY(${toPgTextArray(ancestors)}::text[])
        AND (path_before=${input.chain.path} OR directory
          OR detail @> '{"metadata_unknown":true}'::jsonb OR detail @> '{"directory_unknown":true}'::jsonb
          OR detail @> '{"snapshot_unknown":true}'::jsonb)
        AND action NOT IN ('folder.create','item.copy','file.upload','file.overwrite','file.create','file.edit',
          'version.comment','version.restore','version.restore_copy','version.delete','share.create','share.revoke',
          'item.restore','place.provision','admin.read','item.differs','item.elsewhere','item.missing'))
      OR (coalesce(root_after,root)=${input.chain.root}
        AND coalesce(base_after_id,CASE WHEN coalesce(root_after,root)=root THEN base_id END) IS NOT DISTINCT FROM ${input.chain.baseId}::uuid
        AND left(path_after,400)=ANY(${toPgTextArray(ancestors.map((path) => [...path].slice(0, 400).join("")))}::text[])
        AND path_after=ANY(${toPgTextArray(ancestors)}::text[])
        AND (path_after=${input.chain.path} OR directory
          OR detail @> '{"metadata_unknown":true}'::jsonb OR detail @> '{"directory_unknown":true}'::jsonb
          OR detail @> '{"snapshot_unknown":true}'::jsonb)
        AND action IN ('folder.create','file.create','file.upload','file.overwrite','item.copy','item.restore',
          'version.restore_copy','place.provision','item.rename','item.move','place.archive','place.restore')))`;
    // Actor/action filters follow projection in the service; a sparse match must not make SQL walk an unbounded range.
    const batch = input.batch ? sql`batch_id=${input.batch.id}::uuid AND activity.id<>${input.batch.anchorId}::uuid` : sql`TRUE`;
    const filters = sql`${scope} AND ${chain} AND ${batch} AND (${input.from ?? null}::timestamptz IS NULL OR coalesce(finished_at,started_at)>=${input.from ?? null}::timestamptz)
      AND (${input.to ?? null}::timestamptz IS NULL OR coalesce(finished_at,started_at)<=${input.to ?? null}::timestamptz)`;
    budget?.check();
    const query =
      input.direction === "asc"
        ? sql<ActivityCandidate[]>`SELECT ${columns} FROM filesv2.activity
          LEFT JOIN (SELECT id AS share_join_id,expires_at AS share_expires_at FROM filesv2.shares) s
            ON s.share_join_id=activity.share_id AND activity.action IN ('share.create','share.revoke')
          WHERE ${filters}
          AND (${input.position?.time ?? null}::timestamptz IS NULL OR (coalesce(finished_at,started_at),id)>(${input.position?.time ?? null}::timestamptz,${input.position?.id ?? null}::uuid))
          ORDER BY coalesce(finished_at,started_at),id LIMIT ${input.limit}`
        : sql<ActivityCandidate[]>`SELECT ${columns} FROM filesv2.activity
          LEFT JOIN (SELECT id AS share_join_id,expires_at AS share_expires_at FROM filesv2.shares) s
            ON s.share_join_id=activity.share_id AND activity.action IN ('share.create','share.revoke')
          WHERE ${filters}
          AND (${input.position?.time ?? null}::timestamptz IS NULL OR (coalesce(finished_at,started_at),id)<(${input.position?.time ?? null}::timestamptz,${input.position?.id ?? null}::uuid))
          ORDER BY coalesce(finished_at,started_at) DESC,id DESC LIMIT ${input.limit}`;
    return readQuery(query, budget);
  },
  async byId(id: string, budget?: ActivityReadBudget): Promise<ActivityCandidate | null> {
    // Same projection as candidates, with an exact-key read and no raw detail.
    budget?.check();
    const query = sql<ActivityCandidate[]>`SELECT id,started_at,finished_at,coalesce(finished_at,started_at)::text AS effective_time,
      state,action,server_url,root,root_after,base_id,base_after_id,item_id,item_after_id,directory,path_before,path_after,
      size,revision_before,revision_after,version_id,actor_kind,actor_user_id,via,calling_app,origin,invocation_id,request_id,batch_id,
      detail->'observed_before' AS observed_before,detail->'observed_after' AS observed_after,
      s.share_expires_at,
      (detail @> '{"metadata_unknown":true}'::jsonb OR detail @> '{"snapshot_unknown":true}'::jsonb
        OR detail @> '{"directory_unknown":true}'::jsonb) AS "metadataUnknown"
      FROM filesv2.activity
      LEFT JOIN (SELECT id AS share_join_id,expires_at AS share_expires_at FROM filesv2.shares) s
        ON s.share_join_id=activity.share_id AND activity.action IN ('share.create','share.revoke')
      WHERE activity.id=${id}::uuid`;
    const rows = await readQuery(query, budget);
    return rows[0] ?? null;
  },
  /** One statement keeps totals and networks on the same snapshot during concurrent rollup.
   * The internal clock is deliberately separate from the transport input. */
  async shareAccess(rawInput: ShareAccessInput, options: { now?: Date; budget?: ActivityReadBudget } = {}): Promise<ShareAccessCounts> {
    const input = ShareAccessInput.parse(rawInput);
    const now = options.now ?? new Date();
    const cutoff = new Date(now.getTime() - 30 * 86_400_000);
    const from = `${input.from}T00:00:00.000Z`;
    const until = new Date(Date.parse(`${input.to}T00:00:00.000Z`) + 86_400_000).toISOString();
    type Counters = { pages: string; downloads: string; password_failed: string };
    type Network = Counters & { network: string; first_seen: string; last_seen: string; usage: string };
    type Period = Counters & {
      date: string;
      granularity: ShareAccessPeriod["granularity"];
      page_networks: string | null;
      known_networks: string | null;
      overflow: boolean;
    };
    options.budget?.check();
    const query = sql<
      (Counters & {
        page_networks: string | null;
        known: string;
        incomplete: boolean;
        overflow: boolean;
        rolled_up: boolean;
        cursor_exists: boolean;
        items: Network[];
        timeline: Period[];
      })[]
    >`
      WITH hourly AS (
        SELECT hour,network,pages,downloads,password_failed FROM filesv2.share_access
        WHERE share_id=${input.shareId}::uuid AND hour>=${from}::timestamptz AND hour<${until}::timestamptz
      ), daily AS (
        SELECT day,pages,downloads,password_failed FROM filesv2.share_access_daily
        WHERE share_id=${input.shareId}::uuid AND day BETWEEN ${input.from}::date AND ${input.to}::date
      ), recent AS (
        SELECT * FROM hourly WHERE hour>=${cutoff}::timestamptz AND hour<=${now}::timestamptz
      ), networks AS (
        SELECT network,sum(pages)::text AS pages,sum(downloads)::text AS downloads,
          sum(password_failed)::text AS password_failed,min(hour)::text AS first_seen,max(hour)::text AS last_seen,
          (sum(pages)+sum(downloads)) AS usage
        FROM recent WHERE network NOT IN ('*','unknown') GROUP BY network
      ), anchor AS (
        SELECT usage,network FROM networks WHERE network=${input.networkAfter ?? null}
      ), page AS (
        SELECT * FROM networks WHERE ${input.networkAfter ?? null}::text IS NULL OR
          usage<(SELECT usage FROM anchor) OR
          (usage=(SELECT usage FROM anchor) AND network COLLATE "C">${input.networkAfter ?? null}::text COLLATE "C")
        ORDER BY usage DESC,network COLLATE "C" LIMIT ${input.networkLimit + 1}
      ), day_keys AS (
        SELECT day FROM daily UNION SELECT (hour AT TIME ZONE 'UTC')::date FROM hourly WHERE hour<${cutoff}::timestamptz
      ), day_counts AS (
        SELECT day,pages,downloads,password_failed FROM daily
        UNION ALL SELECT (hour AT TIME ZONE 'UTC')::date,pages,downloads,password_failed FROM hourly
          WHERE (hour AT TIME ZONE 'UTC')::date IN (SELECT day FROM day_keys)
      ), periods AS (
        SELECT day::timestamp AT TIME ZONE 'UTC' AS date,'day' AS granularity,
          sum(pages)::text AS pages,sum(downloads)::text AS downloads,sum(password_failed)::text AS password_failed,
          NULL::text AS page_networks,NULL::text AS known_networks,false AS overflow
        FROM day_counts GROUP BY day
        UNION ALL
        SELECT hour AS date,'hour' AS granularity,sum(pages)::text,sum(downloads)::text,sum(password_failed)::text,
          CASE WHEN bool_or(pages>0 AND network IN ('*','unknown')) THEN NULL::text
            ELSE count(DISTINCT network) FILTER (WHERE pages>0)::text END,
          CASE WHEN bool_or(network='unknown') THEN NULL::text ELSE count(DISTINCT network) FILTER (WHERE network NOT IN ('*','unknown'))::text END,bool_or(network='*')
        FROM recent WHERE (hour AT TIME ZONE 'UTC')::date NOT IN (SELECT day FROM day_keys) GROUP BY hour
      ), timeline_page AS (
        SELECT * FROM periods WHERE (${input.timelineAfter ?? null}::timestamptz IS NULL OR date<${input.timelineAfter ?? null}::timestamptz)
        ORDER BY date DESC LIMIT ${ACTIVITY_PAGE_LIMIT + 1}
      ) SELECT
        coalesce(sum(pages),0)::text AS pages,coalesce(sum(downloads),0)::text AS downloads,
        coalesce(sum(password_failed),0)::text AS password_failed,
        CASE WHEN EXISTS(SELECT 1 FROM daily WHERE pages>0) OR EXISTS(SELECT 1 FROM hourly
          WHERE pages>0 AND (hour<${cutoff}::timestamptz OR hour>${now}::timestamptz OR network IN ('*','unknown')))
          THEN NULL::text ELSE (SELECT count(DISTINCT network)::text FROM recent WHERE pages>0) END AS page_networks,
        (SELECT count(*)::text FROM networks) AS known,
        (EXISTS(SELECT 1 FROM daily) OR EXISTS(SELECT 1 FROM hourly
          WHERE hour<${cutoff}::timestamptz OR hour>${now}::timestamptz OR network IN ('*','unknown'))) AS incomplete,
        EXISTS(SELECT 1 FROM recent WHERE network='*') AS overflow,
        EXISTS(SELECT 1 FROM daily) AS rolled_up,
        (${input.networkAfter ?? null}::text IS NULL OR EXISTS(SELECT 1 FROM anchor)) AS cursor_exists,
        coalesce((SELECT jsonb_agg(page ORDER BY usage DESC,network COLLATE "C") FROM page),'[]'::jsonb) AS items,
        coalesce((SELECT jsonb_agg(timeline_page ORDER BY date DESC) FROM timeline_page),'[]'::jsonb) AS timeline
      FROM (SELECT pages,downloads,password_failed FROM hourly UNION ALL SELECT pages,downloads,password_failed FROM daily) counts`;
    const [row] = await readQuery(query, options.budget);
    if (!row) throw new Error("Missing share access aggregate");
    if (!row.cursor_exists) throw new FilesError("share_access_cursor_expired", 409);
    const count = (value: string): number => {
      const result = Number(value);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(result) || result < 0)
        throw new RangeError("Share access counter exceeds safe integer range");
      return result;
    };
    const counters = (value: Counters) => ({
      pages: count(value.pages),
      downloads: count(value.downloads),
      passwordFailed: count(value.password_failed),
    });
    const items = row.items.slice(0, input.networkLimit).map((item) => ({
      network: ShareAccessNetwork.parse(item.network),
      ...counters(item),
      firstSeen: new Date(item.first_seen).toISOString(),
      lastSeen: new Date(item.last_seen).toISOString(),
    }));
    const periods = row.timeline.slice(0, ACTIVITY_PAGE_LIMIT).map((period) => ({
      date: new Date(period.date).toISOString(),
      granularity: period.granularity,
      ...counters(period),
      pageNetworks: period.page_networks === null ? null : count(period.page_networks),
      knownNetworks: period.known_networks === null ? null : count(period.known_networks),
      overflow: period.overflow,
    }));
    return {
      pageNetworks: row.page_networks === null ? null : count(row.page_networks),
      from: input.from,
      to: input.to,
      timeline: { items: periods, next: row.timeline.length > ACTIVITY_PAGE_LIMIT ? periods.at(-1)!.date : null },
      ...counters(row),
      networks: {
        known: count(row.known),
        incomplete: row.incomplete,
        overflow: row.overflow,
        items,
        next: row.items.length > input.networkLimit ? items.at(-1)!.network : null,
        rolledUp: row.rolled_up,
      },
    };
  },
};
