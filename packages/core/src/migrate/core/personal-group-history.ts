import { sql } from "bun";

const identifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

/** Startup installs only the review schema; application data inspection runs after startup. */
export const migratePersonalGroupHistory = async (db: typeof sql = sql): Promise<void> => {
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('core.personal_group_history.schema', 0))`;
    await tx`
      CREATE TABLE IF NOT EXISTS auth.personal_group_review (
        group_id UUID PRIMARY KEY,
        reason TEXT NOT NULL,
        details JSONB NOT NULL,
        checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        completed_at TIMESTAMPTZ
      )
    `.simple();
    const [column] = await tx`SELECT 1 FROM pg_attribute WHERE attrelid = 'auth.personal_group_review'::regclass
      AND attname = 'completed_at' AND NOT attisdropped`;
    if (!column) await tx`ALTER TABLE auth.personal_group_review ADD COLUMN completed_at TIMESTAMPTZ`.simple();
  });
};

/**
 * One background pass per boot, never a startup prerequisite. Finished cases require an
 * explicit operator retry. The write-blocking inspection has a ten-second total budget,
 * two seconds per statement, and never waits for an application writer.
 */
export const scanPersonalGroupHistory = async (db: typeof sql = sql, signal?: AbortSignal): Promise<void> => {
  await db.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '250ms'`.simple();
    await tx`SET LOCAL statement_timeout = '2s'`.simple();
    const [lock] = await tx`SELECT pg_try_advisory_xact_lock(hashtextextended('core.personal_group_history.migrations', 0)) AS acquired`;
    if (!lock?.acquired || signal?.aborted) return;
    await tx`DELETE FROM auth.personal_group_review r
      WHERE NOT EXISTS (SELECT 1 FROM auth.groups g WHERE g.id = r.group_id)
        OR EXISTS (SELECT 1 FROM auth.personal_groups p WHERE p.group_id = r.group_id)
        OR EXISTS (SELECT 1 FROM auth.user_posix p WHERE p.primary_group_id = r.group_id)`;
    // Materialize the whole candidate set once. A bare GID is not ownership evidence.
    await tx`
      CREATE TEMP TABLE personal_group_candidates ON COMMIT DROP AS
      WITH provisioning AS MATERIALIZED (
        SELECT group_id, jsonb_agg(to_jsonb(e) - 'group_id') AS rows FROM (
          SELECT DISTINCT metadata->>'primaryGroupId' AS group_id, target_id AS owner_id,
            metadata->>'uidNumber' AS uid_number, metadata->>'gidNumber' AS gid_number
          FROM audit.events WHERE action = 'accounts.linux.provision' AND outcome = 'allowed' AND target_type = 'user'
        ) e GROUP BY group_id
      ), ordinary_groups AS MATERIALIZED (
        SELECT DISTINCT target_id, metadata->>'gidNumber' AS gid_number FROM audit.events
        WHERE action = 'accounts.linux.provision_group' AND outcome = 'allowed' AND target_type = 'group'
      )
      SELECT g.id, g.name, g.gid_number, evidence.rows AS evidence,
        CASE WHEN jsonb_array_length(evidence.rows) = 1 AND NOT ordinary.present THEN (
          SELECT uid.owner_id FROM auth.posix_allocations uid
          JOIN auth.posix_allocations gid ON gid.kind = 'gid' AND gid.owner_id = g.id
          WHERE uid.kind = 'uid' AND uid.owner_id::text = evidence.rows->0->>'owner_id'
            AND uid.number::text = evidence.rows->0->>'uid_number'
            AND gid.number::text = evidence.rows->0->>'gid_number' AND gid.number = g.gid_number
            AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = uid.owner_id)
        ) END AS owner_id,
        ordinary.present AS ordinary,
        ARRAY[]::text[] AS reference_tables
      FROM auth.groups g
      LEFT JOIN provisioning ON provisioning.group_id = g.id::text
      LEFT JOIN ordinary_groups ON ordinary_groups.target_id = g.id::text AND ordinary_groups.gid_number = g.gid_number::text
      CROSS JOIN LATERAL (SELECT COALESCE(provisioning.rows, '[]'::jsonb) AS rows) evidence
      CROSS JOIN LATERAL (SELECT ordinary_groups.target_id IS NOT NULL AS present) ordinary
      WHERE g.provider = 'local'
        AND NOT EXISTS (SELECT 1 FROM auth.personal_groups p WHERE p.group_id = g.id)
        AND NOT EXISTS (SELECT 1 FROM auth.user_posix p WHERE p.primary_group_id = g.id)
        AND NOT EXISTS (SELECT 1 FROM auth.personal_group_review r WHERE r.group_id = g.id AND r.completed_at IS NOT NULL)
        AND (jsonb_array_length(evidence.rows) > 0 OR (NOT ordinary.present AND EXISTS (
          SELECT 1 FROM auth.posix_allocations gid WHERE gid.kind = 'gid' AND gid.owner_id = g.id
        )))
    `.simple();
    const [pending] = await tx`SELECT 1 FROM personal_group_candidates LIMIT 1`;
    if (!pending) return;
    let inspectionError: string | null = null;
    const [proven] = await tx`SELECT 1 FROM personal_group_candidates WHERE owner_id IS NOT NULL LIMIT 1`;
    if (proven) {
      try {
        await tx.savepoint(async (scan) => {
          const deadline = performance.now() + 10_000;
          const budget = async () => {
            signal?.throwIfAborted();
            const remaining = Math.floor(deadline - performance.now());
            if (remaining <= 0) throw new Error("Historical reference inspection budget exhausted");
            await scan`SELECT set_config('statement_timeout', ${String(Math.min(2000, remaining))}, true)`;
          };
          // Freeze candidates and all reference writers before a single inspection, rather
          // than scanning first and repeating every JSON scan under write-blocking locks.
          await budget();
          await scan`LOCK TABLE auth.groups, auth.users, auth.user_posix, auth.posix_allocations IN SHARE MODE NOWAIT`.simple();
          // Revalidate ownership under locks: provisioning or account restoration may have raced collection.
          await budget();
          await scan`UPDATE personal_group_candidates c SET owner_id = NULL WHERE owner_id IS NOT NULL AND (
            NOT EXISTS (SELECT 1 FROM auth.groups g WHERE g.id = c.id AND g.name = c.name AND g.gid_number = c.gid_number AND g.provider = 'local')
            OR EXISTS (SELECT 1 FROM auth.users u WHERE u.id = c.owner_id)
            OR EXISTS (SELECT 1 FROM auth.user_posix p WHERE p.primary_group_id = c.id)
            OR EXISTS (SELECT 1 FROM auth.personal_groups p WHERE p.group_id = c.id)
            OR NOT EXISTS (
              SELECT 1 FROM auth.posix_allocations uid JOIN auth.posix_allocations gid ON gid.kind = 'gid' AND gid.owner_id = c.id
              WHERE uid.kind = 'uid' AND uid.owner_id = c.owner_id AND uid.number::text = c.evidence->0->>'uid_number'
                AND gid.number = c.gid_number AND gid.number::text = c.evidence->0->>'gid_number'
            )

          )`;
          const tables = new Map<string, { schema: string; table: string; ids: string[]; json: string[] }>();
          const tableFor = (schema: string, table: string) => {
            const key = `${identifier(schema)}.${identifier(table)}`;
            let entry = tables.get(key);
            if (!entry) {
              entry = { schema, table, ids: [], json: [] };
              tables.set(key, entry);
            }
            return entry;
          };
          await budget();
          const constraints = await scan<{ schema_name: string; table_name: string; column_name: string; simple: boolean }[]>`
            SELECT n.nspname AS schema_name, c.relname AS table_name, a.attname AS column_name,
              cardinality(f.conkey) = 1 AND cardinality(f.confkey) = 1 AND target.attname = 'id' AS simple
            FROM pg_constraint f JOIN pg_class c ON c.oid = f.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = f.conkey[1]
            JOIN pg_attribute target ON target.attrelid = f.confrelid AND target.attnum = f.confkey[1]
            WHERE f.contype = 'f' AND f.confrelid = 'auth.groups'::regclass
          `;
          for (const ref of constraints) {
            if (!ref.simple) {
              await budget();
              await scan`UPDATE personal_group_candidates SET reference_tables = array_append(reference_tables,
                ${`${ref.schema_name}.${ref.table_name}.${ref.column_name} (non-id or composite constraint)`}) WHERE owner_id IS NOT NULL`;
            } else tableFor(ref.schema_name, ref.table_name).ids.push(`t.${identifier(ref.column_name)}`);
          }
          for (const [schema, table, column] of [
            ["filesv2", "bases", "CASE WHEN t.kind = 'groups' THEN t.identity_id END"],
            ["grids", "table_finalization_activations", "t.approver_group_id"],
          ] as const) {
            await budget();
            const [present] = await scan`SELECT to_regclass(${`${schema}.${table}`}) AS relation`;
            if (present?.relation) tableFor(schema, table).ids.push(column);
          }
          await budget();
          const jsonColumns = await scan<{ schema_name: string; table_name: string; column_name: string }[]>`
            SELECT n.nspname AS schema_name, c.relname AS table_name, a.attname AS column_name
            FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname IN ('grids', 'workflows', 'notifications') AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
              AND a.atttypid IN ('json'::regtype, 'jsonb'::regtype)
          `;
          for (const column of jsonColumns)
            tableFor(column.schema_name, column.table_name).json.push(`t.${identifier(column.column_name)}::text`);
          // NOWAIT and savepoint rollback release every acquired lock on deferral.
          for (const table of tables.keys()) {
            await budget();
            await scan.unsafe(`LOCK TABLE ${table} IN SHARE MODE NOWAIT`);
          }
          for (const [table, entry] of tables) {
            await budget();
            // Pure FK tables retain indexed equality lookups. A table with JSON is
            // read once, extracting whole hex/hyphen runs so overlapping or embedded
            // UUIDs cannot hide a conservative substring reference.
            const matched =
              entry.json.length === 0
                ? `SELECT DISTINCT c.id FROM ONLY ${table} t JOIN personal_group_candidates c
                  ON c.owner_id IS NOT NULL AND (${entry.ids.map((column) => `${column} = c.id`).join(" OR ")})`
                : `WITH tokens AS MATERIALIZED (
                  SELECT m.value[1] AS token FROM ONLY ${table} t
                  CROSS JOIN LATERAL regexp_matches(lower(concat_ws(' ', ${[
                    ...entry.ids.map((column) => `(${column})::text`),
                    ...entry.json,
                  ].join(", ")})), '[0-9a-f-]{36,}', 'g') AS m(value)
                )
                SELECT c.id FROM tokens JOIN personal_group_candidates c
                  ON c.owner_id IS NOT NULL AND tokens.token = c.id::text
                UNION
                SELECT c.id FROM tokens JOIN personal_group_candidates c
                  ON c.owner_id IS NOT NULL AND length(tokens.token) > 36 AND strpos(tokens.token, c.id::text) > 0`;
            await scan.unsafe(
              `
              WITH matched AS MATERIALIZED (${matched})
              UPDATE personal_group_candidates c SET reference_tables = array_append(c.reference_tables, $1)
              FROM matched WHERE c.id = matched.id
            `,
              [`${entry.schema}.${entry.table}`],
            );
          }
          await budget();
          await scan`INSERT INTO auth.personal_groups(group_id, owner_id, group_name, gid_number, retired_at)
            SELECT id, owner_id, name, gid_number, now() FROM personal_group_candidates WHERE owner_id IS NOT NULL AND cardinality(reference_tables) = 0`;
          await budget();
          await scan`INSERT INTO audit.events(action,outcome,target_type,target_id,target_label,metadata)
            SELECT 'accounts.linux.retire_personal_group','allowed','group',id::text,name,
              jsonb_build_object('ownerId',owner_id,'gidNumber',gid_number,'source','historical_migration','evidence',evidence,'references',reference_tables)
            FROM personal_group_candidates WHERE owner_id IS NOT NULL AND cardinality(reference_tables) = 0`;
          await budget();
          await scan`DELETE FROM auth.groups WHERE id IN (
            SELECT id FROM personal_group_candidates WHERE owner_id IS NOT NULL AND cardinality(reference_tables) = 0)`;
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        if (
          !(error instanceof Error) ||
          (error.message !== "Historical reference inspection budget exhausted" &&
            !("errno" in error && ["55P03", "40P01", "42501", "57014"].includes(String(error.errno))))
        )
          throw error;
        inspectionError = error.message;
      }
    }
    signal?.throwIfAborted();
    await tx`SET LOCAL statement_timeout = '2s'`.simple();
    await tx`DELETE FROM auth.personal_group_review r WHERE EXISTS (SELECT 1 FROM auth.personal_groups p WHERE p.group_id = r.group_id)`;
    // Completion includes deferred checks: they remain visible for deliberate operator action,
    // rather than retrying a large or busy table on every restart.
    const reports = await tx<{ group_id: string; reason: string }[]>`
      INSERT INTO auth.personal_group_review(group_id, reason, details, completed_at)
      SELECT c.id, CASE WHEN c.owner_id IS NULL THEN 'ownership_unproven'
        WHEN ${inspectionError !== null} THEN 'references_unchecked' ELSE 'remaining_references' END,
        jsonb_build_object('evidence',c.evidence,'ordinaryProvisioning',c.ordinary,'references',c.reference_tables,'inspectionError',${inspectionError}::text), now()
      FROM personal_group_candidates c JOIN auth.groups g ON g.id = c.id
      ON CONFLICT (group_id) DO UPDATE SET reason = EXCLUDED.reason, details = EXCLUDED.details, checked_at = now(), completed_at = now()
      RETURNING group_id, reason
    `;
    signal?.throwIfAborted();
    for (const report of reports)
      console.warn("Personal Linux group requires operator review", { groupId: report.group_id, reason: report.reason });
  });
};

/** Schedule after startup returns, and drain the bounded SQL work on shutdown. */
export const startPersonalGroupHistory = (db: typeof sql = sql): (() => Promise<void>) => {
  const controller = new AbortController();
  let task: Promise<void> | undefined;
  const timer = setTimeout(() => {
    task = scanPersonalGroupHistory(db, controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted) console.error("Personal Linux group history inspection failed; restart Core to retry", error);
    });
  }, 0);
  return async () => {
    clearTimeout(timer);
    controller.abort();
    await task;
  };
};
