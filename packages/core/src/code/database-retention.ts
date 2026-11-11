import { sql } from "@k2b/cloud";
import { audit, canRepairAppAccess, logger } from "@k2b/cloud/services";
import { createPgOutbox, type OutboxRow } from "@k2b/cloud/services/outbox";
import type { SQL } from "bun";
import { z } from "zod";
import type { CoreNotificationSender } from "../notifications";
import { type CodeContext, CodeDataError, codePerson, requireCodePermission } from "./access";
import { CodeIdSchema } from "./contracts";
import { lockNamespaceChange, readCodeDatabaseConfig } from "./database";
import { createCodeDatabaseClient } from "./database-client";
import { requireCodePolicyAdmin } from "./policy";
import { codeSettings } from "./settings";
import { findCode } from "./store";

export const unusedDatabaseInput = z
  .object({
    codeId: CodeIdSchema,
    // Bind confirmation to an incarnation and grace period, never a later replacement.
    namespace: z.string().min(1).max(100),
    since: z.iso.datetime(),
  })
  .strict();
export const databaseDeletionDate = (since: Date, days: number): Date | null =>
  days === 0 ? null : new Date(since.getTime() + days * 86_400_000);

/** Destructive maintenance never falls back over an unreadable operator setting. */
export async function readUnusedDatabaseDays() {
  const state = await codeSettings.read("core.code.database_unused_days");
  if (state.stored === "unreadable") throw new Error("code_database_retention_setting_unreadable");
  return state.value;
}

type DeletionRow = OutboxRow & { code_id: string; namespace: string; server_url: string };

/** Code-row lock linearizes deletion against activation, pause/resume and version saves.
 * Detach and audit before effects; a later activation can only provision a fresh incarnation.
 */
async function detach(db: SQL, codeId: string, now: Date, days: number, expected?: z.infer<typeof unusedDatabaseInput>, actor?: string) {
  const [code] = await db`SELECT id FROM code.codes WHERE id=${codeId} AND state IN ('draft','paused') FOR UPDATE`;
  if (!code) return false;
  const [lifecycle] = await db<{ acquired: boolean }[]>`
    SELECT pg_try_advisory_xact_lock(hashtextextended('core.code.database-lifecycle',0)) AS acquired`;
  if (!lifecycle?.acquired) return false;
  const [mapping] = await db<{ namespace: string; server_url: string; unused_since: Date }[]>`
    SELECT namespace,server_url,unused_since FROM code.databases WHERE code_id=${codeId}
      AND unused_since IS NOT NULL AND code.database_is_unused(code_id)
      AND NOT EXISTS(SELECT 1 FROM code.runs WHERE code_id=${codeId} AND state IN ('queued','running')) FOR UPDATE`;
  if (!mapping) return false;
  if (expected) {
    if (mapping.namespace !== expected.namespace || mapping.unused_since.toISOString() !== expected.since) return false;
  } else {
    const deadline = databaseDeletionDate(mapping.unused_since, days);
    if (!deadline || deadline > now) return false;
  }
  const [job] = await db<{ id: string }[]>`INSERT INTO code.database_deletions(code_id,namespace,server_url)
    VALUES(${codeId},${mapping.namespace},${mapping.server_url}) ON CONFLICT(namespace) DO NOTHING RETURNING id`;
  if (!job) return false;
  await db`DELETE FROM code.databases WHERE code_id=${codeId} AND namespace=${mapping.namespace}`;
  await audit.record(
    {
      action: "core.code.database.deletion_requested",
      outcome: "allowed",
      actor: actor ? { userId: actor } : null,
      target: { type: "code", id: codeId },
      requestId: job!.id,
      metadata: { namespace: mapping.namespace, unusedSince: mapping.unused_since.toISOString(), automatic: !expected },
    },
    db,
  );
  return true;
}

export async function deleteUnusedCodeDatabase(raw: z.input<typeof unusedDatabaseInput>, context: CodeContext) {
  const input = unusedDatabaseInput.parse(raw);
  const person = codePerson(context, true);
  const code = await findCode(input.codeId);
  if (!code) throw new CodeDataError("NOT_FOUND", "Code not found.");
  const admin = person.roles.includes("admin") && canRepairAppAccess(context.authority);
  // Admin management requires an admin-capable credential; editors retain the live owner check.
  if (!admin) await requireCodePermission(code, context, true);
  const removed = await sql.begin(async (tx) => {
    await tx`SELECT id FROM code.codes WHERE id=${input.codeId} FOR UPDATE`;
    if (!admin) await requireCodePermission(code, context, true, tx);
    // A repeated confirmation for an already detached incarnation is a successful no-op.
    const [old] = await tx`SELECT id FROM code.database_deletions WHERE code_id=${input.codeId} AND namespace=${input.namespace}`;
    const [current] = await tx<{ namespace: string }[]>`SELECT namespace FROM code.databases WHERE code_id=${input.codeId}`;
    if (!current || (old && current.namespace !== input.namespace)) return true;
    return detach(tx, input.codeId, new Date(), 0, input, person.id);
  });
  if (!removed) throw new CodeDataError("CONFLICT", "The database is in use, has changed, or is busy. Reload before trying again.");
  return { deleted: true as const };
}

/** One scheduled pass: at most 50 candidates and 10 seconds, no remote I/O under the admission transaction. */
export async function expireUnusedCodeDatabases(now: Date, signal: AbortSignal) {
  const days = await readUnusedDatabaseDays();
  if (!days) return 0;
  const deadline = performance.now() + 10_000;
  const candidates = await sql<{ code_id: string }[]>`SELECT code_id FROM code.databases
    WHERE unused_since<=${new Date(now.getTime() - days * 86400000)} ORDER BY unused_since,code_id LIMIT 50`;
  let count = 0;
  for (const { code_id } of candidates) {
    if (signal.aborted || performance.now() >= deadline) break;
    try {
      count += Number(
        await sql.begin(async (tx) => {
          await tx`SET LOCAL lock_timeout='100ms'`;
          await tx`SET LOCAL statement_timeout='2s'`;
          const [available] = await tx`SELECT id FROM code.codes WHERE id=${code_id} FOR UPDATE SKIP LOCKED`;
          return available ? detach(tx, code_id, now, days) : false;
        }),
      );
    } catch {
      // One busy or invalid candidate must not prevent other databases from progressing.
      // Keep raw database errors out of logs; the next bounded pass retries the candidate.
      logger("core:code-database-retention").warn("Code database expiry candidate deferred", {
        codeId: code_id,
        code: "code_database_expiry_retry",
      });
    }
  }
  return count;
}

/** Remote retries only ever address the detached namespace, including after a new incarnation exists. */
export async function processDatabaseDeletion(row: DeletionRow, factory: typeof createCodeDatabaseClient = createCodeDatabaseClient) {
  try {
    const [job] = await sql<DeletionRow[]>`SELECT * FROM code.database_deletions WHERE id=${row.id}::uuid`;
    if (!job) return;
    await sql.begin(async (tx) => {
      await lockNamespaceChange(tx);
      // Fence legacy replicas during a rolling upgrade as well as current provisioners.
      const [mapped] = await tx`SELECT code_id FROM code.databases WHERE namespace=${job.namespace}`;
      if (mapped) throw new Error("code_database_namespace_mapped");
      const config = await readCodeDatabaseConfig();
      if (config.url !== job.server_url) throw new Error("code_database_server_changed");
      // The five-second effect stays below the outbox lease; RSQL treats 404 as success.
      await factory(config, AbortSignal.timeout(5000)).remove(job.namespace);
    });
    await sql.begin(async (tx) => {
      const [pending] = await tx`SELECT id FROM code.database_deletions WHERE id=${job.id}::uuid FOR UPDATE`;
      if (!pending) return;
      await audit.record(
        {
          action: "core.code.database.deleted",
          outcome: "allowed",
          actor: null,
          target: { type: "code", id: job.code_id },
          requestId: job.id,
          metadata: { namespace: job.namespace },
        },
        tx,
      );
      await tx`DELETE FROM code.database_deletions WHERE id=${job.id}::uuid`;
    });
  } catch (error) {
    if (
      error instanceof Error &&
      ["code_database_namespace_mapped", "code_database_server_changed", "code_db_unavailable", "code_db_busy"].includes(error.message)
    )
      throw error;
    throw new Error("code_database_deletion_retry");
  }
}
export const codeDatabaseDeletionOutbox = createPgOutbox<DeletionRow>({
  table: "code.database_deletions",
  name: "core:code-database-deletion",
  orderBy: "code_id",
  sequence: "sequence",
  batchSize: 1,
  reconcileIntervalMs: 1000,
  publish: processDatabaseDeletion,
});

export type UnusedCodeDatabase = {
  codeId: string;
  title: string;
  owner: string;
  bytes: number | null;
  since: string;
  deleteAt: string | null;
  lastAccess: string | null;
  namespace: string;
};
export async function listUnusedCodeDatabases(context: CodeContext, cursor?: string) {
  requireCodePolicyAdmin(context);
  const after = cursor ? CodeIdSchema.parse(cursor) : null;
  const days = await readUnusedDatabaseDays();
  const rows = await sql<
    {
      code_id: string;
      title: string;
      owner: string;
      last_size_bytes: string | null;
      unused_since: Date;
      last_access_at: Date | null;
      namespace: string;
    }[]
  >`
    SELECT d.code_id,c.title,COALESCE(NULLIF(u.display_name,''),u.uid,c.owner_type || ':' || c.owner_id,c.owner_app_id) AS owner,
      d.last_size_bytes::text,d.unused_since,d.last_access_at,d.namespace
    FROM code.databases d JOIN code.codes c ON c.id=d.code_id LEFT JOIN auth.users u ON u.id=c.owner_user_id
    WHERE d.unused_since IS NOT NULL AND (${after}::text IS NULL OR d.code_id>${after}) ORDER BY d.code_id LIMIT 21`;
  return {
    items: rows.slice(0, 20).map(
      (row): UnusedCodeDatabase => ({
        codeId: row.code_id,
        title: row.title,
        owner: row.owner,
        bytes: row.last_size_bytes === null ? null : Number(row.last_size_bytes),
        since: row.unused_since.toISOString(),
        deleteAt: databaseDeletionDate(row.unused_since, days)?.toISOString() ?? null,
        lastAccess: row.last_access_at?.toISOString() ?? null,
        namespace: row.namespace,
      }),
    ),
    nextCursor: rows.length > 20 ? rows[19]!.code_id : null,
  };
}

/** The existing user notification path covers personal owners. Resource/app owners have no single recipient. */
export async function notifyUnusedCodeDatabases(
  sender: Pick<CoreNotificationSender, "sendCodeDatabaseExpiry">,
  now: Date,
  signal: AbortSignal,
) {
  const days = await readUnusedDatabaseDays();
  if (!days) return;
  const rows = await sql<
    { code_id: string; namespace: string; unused_since: Date; unused_stamp: string; owner_user_id: string; title: string }[]
  >`
    SELECT d.code_id,d.namespace,d.unused_since,d.unused_since::text AS unused_stamp,c.owner_user_id,c.title FROM code.databases d JOIN code.codes c ON c.id=d.code_id
    WHERE c.owner_kind='person' AND d.unused_since>${new Date(now.getTime() - days * 86400000)}
      AND d.unused_since<=${new Date(now.getTime() - (days - 7) * 86400000)}
      AND d.unused_notice_key IS DISTINCT FROM d.namespace || ':' || d.unused_since::text || ':' || ${days}::text
    ORDER BY d.unused_since,d.code_id LIMIT 20`;
  const budget = performance.now() + 10_000;
  for (const row of rows) {
    if (signal.aborted || performance.now() >= budget) break;
    const deleteAt = databaseDeletionDate(row.unused_since, days)!.toISOString();
    await sender.sendCodeDatabaseExpiry({
      userId: row.owner_user_id,
      codeId: row.code_id,
      title: row.title,
      deleteAt,
      key: `code-db-expiry:${row.namespace}:${row.unused_stamp}:${days}`,
    });
    await sql`UPDATE code.databases SET unused_notice_key=namespace || ':' || unused_since::text || ':' || ${days}::text
      WHERE code_id=${row.code_id} AND namespace=${row.namespace} AND unused_since=${row.unused_stamp}::timestamptz`;
  }
}
