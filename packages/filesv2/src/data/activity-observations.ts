import { type SQL, sql, type TransactionSQL } from "bun";
import type { Binding } from "./bases";

type Database = SQL | TransactionSQL;
export type ObservationTarget = { serverUrl: string; root: string; baseId: string; path: string; stableId?: string };
export type KnownActivity = {
  id: string;
  server_url: string;
  root: string;
  base_id: string;
  path: string;
  item_id: string | null;
  directory: boolean;
  size: string | null;
  revision: string | null;
  observation_next_at: Date | null;
};
export type ObservationAction = "item.differs" | "item.missing" | "item.elsewhere";
export type ObservedState = { exists: false } | { exists: true; directory: boolean; id?: string; size: number; revision?: string };
export type Finding = { action: ObservationAction; path: string | null; state: ObservedState };

export function ancestors(path: string): string[] {
  const parts = path.split("/");
  return ["", ".", ...parts.map((_, i) => parts.slice(0, i + 1).join("/"))];
}

/** Effectful sides count, including an ancestor in the other root. Copy sources are unchanged. No SQL LIKE wildcards. */
export async function observationBlocked(target: ObservationTarget, db: Database = sql): Promise<boolean> {
  const paths = ancestors(target.path);
  const prefixes = paths.map((path) => [...path].slice(0, 400).join(""));
  const [row] = await db<{ blocked: boolean }[]>`SELECT
    EXISTS (SELECT 1 FROM filesv2.activity WHERE (server_url=${target.serverUrl} OR server_url='') AND state IN ('pending','unclear') AND
      ((root=${target.root} AND action NOT IN ('item.copy','version.restore_copy') AND left(path_before,400)=ANY(${db.array(prefixes, "TEXT")}) AND path_before=ANY(${db.array(paths, "TEXT")})) OR
       (coalesce(root_after,root)=${target.root} AND left(path_after,400)=ANY(${db.array(prefixes, "TEXT")}) AND path_after=ANY(${db.array(paths, "TEXT")})))) OR
    EXISTS (SELECT 1 FROM filesv2.uploads u JOIN filesv2.bases b ON b.id=u.base_id
      WHERE u.root=${target.root} AND (u.server_url=${target.serverUrl} OR u.server_url='') AND u.state='open'
      AND concat_ws('/',nullif(b.path,''),nullif(u.path,''))=ANY(${db.array(paths, "TEXT")})) OR
    EXISTS (SELECT 1 FROM filesv2.trash t JOIN filesv2.bases b ON b.id=t.base_id
      WHERE t.root=${target.root} AND (t.server_url=${target.serverUrl} OR t.server_url IS NULL)
      AND t.state IN ('pending','restoring') AND
      ((t.original IS NOT NULL AND concat_ws('/',nullif(b.path,''),nullif(t.original,''))=ANY(${db.array(paths, "TEXT")})) OR
       concat_ws('/',nullif(b.path,''),nullif(t.trashed,''))=ANY(${db.array(paths, "TEXT")}) OR
       (t.restore_path IS NOT NULL AND concat_ws('/',nullif(b.path,''),nullif(t.restore_path,''))=ANY(${db.array(paths, "TEXT")})))) OR
    EXISTS (SELECT 1 FROM filesv2.operations WHERE root=${target.root} AND (server_url=${target.serverUrl} OR server_url='') AND state='pending'
      AND (source=ANY(${db.array(paths, "TEXT")}) OR target=ANY(${db.array(paths, "TEXT")}))) AS blocked`;
  return row?.blocked ?? true;
}

export async function observationBinding(target: ObservationTarget, db: Database = sql): Promise<Binding | null> {
  return (
    (await db<Binding[]>`SELECT * FROM filesv2.bases WHERE id=${target.baseId}::uuid AND root=${target.root} AND lifecycle='active'`)[0] ??
    null
  );
}

/** A later namespace event is a barrier, never a guessed child baseline after an ancestor move. */
export async function knownActivity(target: ObservationTarget, db: Database = sql): Promise<KnownActivity | null> {
  const paths = ancestors(target.path);
  const prefixes = paths.map((path) => [...path].slice(0, 400).join(""));
  const [row] = await db<
    {
      id: string;
      action: string;
      server_url: string;
      root: string;
      root_after: string | null;
      base_id: string | null;
      base_after_id: string | null;
      path_after: string | null;
      item_after_id: string | null;
      directory: boolean;
      size: string | null;
      revision_after: string | null;
      observation_next_at: Date | null;
    }[]
  >`SELECT id,action,server_url,root,root_after,base_id,base_after_id,path_after,item_after_id,directory,size::text,revision_after,observation_next_at
    FROM filesv2.activity WHERE server_url=${target.serverUrl} AND state='done' AND finished_at IS NOT NULL AND actor_kind<>'observed'
      AND action NOT IN ('admin.read','share.create','share.revoke','version.comment','version.delete')
      AND ((root=${target.root} AND action NOT IN ('item.copy','version.restore_copy') AND left(path_before,400)=ANY(${db.array(prefixes, "TEXT")}) AND path_before=ANY(${db.array(paths, "TEXT")})) OR
        (coalesce(root_after,root)=${target.root} AND left(path_after,400)=ANY(${db.array(prefixes, "TEXT")}) AND path_after=ANY(${db.array(paths, "TEXT")})))
    ORDER BY finished_at DESC NULLS LAST,id DESC LIMIT 1`;
  if (
    !row ||
    ![
      "folder.create",
      "item.rename",
      "item.move",
      "item.copy",
      "file.upload",
      "file.overwrite",
      "file.create",
      "file.edit",
      "version.restore",
      "version.restore_copy",
      "item.restore",
    ].includes(row.action)
  )
    return null;
  const root = row.root_after ?? row.root;
  const base = row.base_after_id ?? (root === row.root ? row.base_id : null);
  if (root !== target.root || base !== target.baseId || row.path_after !== target.path) return null;
  return {
    id: row.id,
    server_url: row.server_url,
    root,
    base_id: base,
    path: row.path_after,
    item_id: row.item_after_id,
    directory: row.directory,
    size: row.size,
    revision: row.revision_after,
    observation_next_at: row.observation_next_at,
  };
}

/** Only a caller-verified current identity may find an endpoint outside the contact binding.
 * Re-read its original namespace: later deletes, replacements and ancestor moves remain barriers. */
export async function knownIdentityActivity(target: ObservationTarget, db: Database = sql): Promise<KnownActivity | null> {
  if (!target.stableId) return knownActivity(target, db);
  const [endpoint] = await db<{ base_id: string; path: string }[]>`SELECT coalesce(base_after_id,base_id) AS base_id,path_after AS path
    FROM filesv2.activity WHERE server_url=${target.serverUrl} AND coalesce(root_after,root)=${target.root}
      AND item_after_id=${target.stableId} AND state='done' AND finished_at IS NOT NULL AND actor_kind<>'observed'
      AND action NOT IN ('admin.read','share.create','share.revoke','version.comment','version.delete')
    ORDER BY finished_at DESC,id DESC LIMIT 1`;
  if (!endpoint?.base_id || !endpoint.path) return null;
  const known = await knownActivity({ ...target, baseId: endpoint.base_id, path: endpoint.path }, db);
  return known?.item_id === target.stableId ? known : null;
}

export async function observationDestination(target: ObservationTarget, db: Database = sql): Promise<Binding | null> {
  return (
    (
      await db<Binding[]>`SELECT * FROM filesv2.bases WHERE root=${target.root} AND lifecycle='active'
    AND path=ANY(${db.array(ancestors(target.path), "TEXT")}) ORDER BY length(path) DESC LIMIT 1`
    )[0] ?? null
  );
}

/** A destination touched by Cloud since the source evidence is no longer an unexplained move. */
async function destinationChanged(target: ObservationTarget, known: KnownActivity, db: Database): Promise<boolean> {
  const paths = ancestors(target.path);
  const prefixes = paths.map((path) => [...path].slice(0, 400).join(""));
  const [row] = await db<{ changed: boolean }[]>`SELECT EXISTS(SELECT 1 FROM filesv2.activity a
    JOIN filesv2.activity k ON k.id=${known.id}::uuid WHERE a.server_url=${target.serverUrl}
      AND a.state='done' AND a.actor_kind<>'observed'
      AND a.action NOT IN ('admin.read','share.create','share.revoke','version.comment','version.delete')
      AND (a.finished_at,a.id)>(k.finished_at,k.id)
      AND ((a.root=${target.root} AND a.action NOT IN ('item.copy','version.restore_copy')
        AND left(a.path_before,400)=ANY(${db.array(prefixes, "TEXT")}) AND a.path_before=ANY(${db.array(paths, "TEXT")}))
        OR (coalesce(a.root_after,a.root)=${target.root} AND left(a.path_after,400)=ANY(${db.array(prefixes, "TEXT")})
        AND a.path_after=ANY(${db.array(paths, "TEXT")})))) AS changed`;
  return row?.changed ?? true;
}

/** DB uniqueness serializes concurrent contacts, while rechecks reject stale evidence and open journals. */
export async function recordObservation(
  target: ObservationTarget,
  known: KnownActivity,
  finding: Finding,
  key: string,
  now: Date,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))`;
    signal?.throwIfAborted();
    if (await observationBlocked(target, tx)) return false;
    const binding = await observationBinding(target, tx);
    if (!binding || (await knownActivity(target, tx))?.id !== known.id) return false;
    // The resolved endpoint can be in a different binding. Records stay private until reader projection.
    const endpoint = finding.path ? { ...target, path: finding.path } : null;
    if (endpoint && ((await observationBlocked(endpoint, tx)) || (await destinationChanged(endpoint, known, tx)))) return false;
    const destination = endpoint ? await observationDestination(endpoint, tx) : null;
    if (endpoint && !destination) return false;
    signal?.throwIfAborted();
    const id = Bun.randomUUIDv7();
    const rows = await tx`INSERT INTO filesv2.activity
      (id,state,action,server_url,root,base_id,base_after_id,item_id,item_after_id,directory,name,path_before,path_after,size,
       revision_before,revision_after,actor_kind,via,started_at,finished_at,heartbeat_at,observation_key,detail)
      VALUES (${id}::uuid,'done',${finding.action},${target.serverUrl},${target.root},${target.baseId}::uuid,
        ${destination?.id ?? null}::uuid,
        ${known.item_id},${finding.state.exists ? (finding.state.id ?? null) : null},${known.directory},${target.path.split("/").at(-1)!},
        ${target.path},${finding.path},${finding.state.exists ? finding.state.size : known.size},${known.revision},
        ${finding.state.exists ? (finding.state.revision ?? null) : null},'observed','observed',${now},${now},${now},${key},
        ${{
          known_activity_id: known.id,
          observed_before:
            finding.action === "item.missing"
              ? finding.state
              : {
                  exists: true,
                  directory: known.directory,
                  ...(known.item_id ? { id: known.item_id } : {}),
                  ...(known.size !== null ? { size: Number(known.size) } : {}),
                  ...(known.revision ? { revision: known.revision } : {}),
                },
          ...(finding.path ? { observed_after: finding.state } : {}),
        }}::jsonb)
      ON CONFLICT (observation_key) WHERE observation_key IS NOT NULL DO NOTHING RETURNING id`;
    signal?.throwIfAborted();
    return rows.length > 0;
  });
}

/** Three retries (1m, 5m, 30m); another real contact may explicitly try again after exhaustion. */
export async function observationFailed(id: string, now: Date): Promise<void> {
  await sql`UPDATE filesv2.activity SET observation_error='observation_unavailable',
    observation_next_at=CASE observation_checks WHEN 0 THEN ${now}::timestamptz+interval '1 minute'
      WHEN 1 THEN ${now}::timestamptz+interval '5 minutes' WHEN 2 THEN ${now}::timestamptz+interval '30 minutes' ELSE NULL END
    WHERE id=${id}::uuid AND state='done' AND actor_kind<>'observed'`;
}
/** Contention is deferred work, not a failed observation or a spent retry. Update only due evidence. */
export async function observationDeferred(id: string, now: Date): Promise<void> {
  await sql`UPDATE filesv2.activity SET observation_next_at=${now}::timestamptz+interval '1 minute'
    WHERE id=${id}::uuid AND state='done' AND actor_kind<>'observed'
      AND coalesce(observation_next_at,'-infinity'::timestamptz)<=${now}`;
}
export async function observationChecked(id: string, now: Date, claimed = false): Promise<void> {
  await sql`UPDATE filesv2.activity SET observation_next_at=${now}::timestamptz+interval '1 minute',observation_error=NULL,observation_checks=0
    WHERE id=${id}::uuid AND state='done' AND actor_kind<>'observed'
      AND (${claimed} OR coalesce(observation_next_at,'-infinity'::timestamptz)<=${now})`;
}
export async function observationObsolete(id: string): Promise<void> {
  await sql`UPDATE filesv2.activity SET observation_next_at='infinity',observation_error=NULL,observation_checks=0
    WHERE id=${id}::uuid AND state='done' AND actor_kind<>'observed'`;
}

/** Fifty rows per cadence, oldest due evidence first (including pre-rollout NULL schedules).
 * Healthy evidence rotates; obsolete evidence is retired. Only failed retries spend the three-attempt budget.
 * Claim leases survive a worker crash without changing the operation heartbeat. */
export async function claimObservationRetries(now: Date, root?: { serverUrl: string; root: string }): Promise<KnownActivity[]> {
  // Separate query shapes let the global and root-specific ordered indexes serve both callers.
  const scope = root ? sql`AND server_url=${root.serverUrl} AND coalesce(root_after,root)=${root.root}` : sql``;
  const due = root
    ? sql`coalesce(observation_next_at,'-infinity'::timestamptz)<'infinity'::timestamptz
        AND (observation_error IS NULL OR observation_next_at<=${now})`
    : sql`coalesce(observation_next_at,'-infinity'::timestamptz)<=${now}`;
  return sql<KnownActivity[]>`UPDATE filesv2.activity a SET
    observation_checks=observation_checks+CASE WHEN observation_error IS NULL THEN 0 ELSE 1 END,
    observation_next_at=CASE WHEN observation_error IS NULL THEN ${now}::timestamptz+interval '1 minute'
      WHEN observation_checks=0 THEN ${now}::timestamptz+interval '5 minutes'
      WHEN observation_checks=1 THEN ${now}::timestamptz+interval '30 minutes' ELSE NULL END
    WHERE id IN (SELECT id FROM filesv2.activity WHERE state='done' AND actor_kind<>'observed'
      AND action IN ('folder.create','item.rename','item.move','item.copy','file.upload','file.overwrite','file.create','file.edit',
        'version.restore','version.restore_copy','item.restore') AND path_after IS NOT NULL AND coalesce(base_after_id,base_id) IS NOT NULL
      AND (observation_next_at IS NOT NULL OR (observation_error IS NULL AND observation_checks=0))
      AND (observation_error IS NULL OR observation_checks<3)
      AND (${due}) ${scope}
      ORDER BY coalesce(observation_next_at,'-infinity'::timestamptz),id LIMIT 50 FOR UPDATE SKIP LOCKED)
    RETURNING id,server_url,coalesce(root_after,root) AS root,
      coalesce(base_after_id,base_id) AS base_id,path_after AS path,item_after_id AS item_id,directory,size::text,revision_after AS revision,observation_next_at`;
}
