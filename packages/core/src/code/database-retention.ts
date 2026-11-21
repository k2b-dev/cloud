import { sql } from "@k2b/cloud";
import { audit, canRepairAppAccess, logger } from "@k2b/cloud/services";
import { createPgOutbox, type OutboxRow } from "@k2b/cloud/services/outbox";
import type { SQL } from "bun";
import { z } from "zod";
import type { CoreNotificationSender } from "../notifications";
import { type CodeContext, CodeDataError, codePerson, requireCodePermission } from "./access";
import { CodeIdSchema } from "./contracts";
import { lockNamespaceChange, readCodeDatabaseConfig } from "./database";
import { DATABASE_EXPIRY_NOTICE_MS, lockDatabaseRetentionPolicy, refreshDatabaseDeadline } from "./database-deadline";

export { databaseDeletionDate, readUnusedDatabaseDays } from "./database-deadline";

import { createCodeDatabaseClient } from "./database-client";
import { requireCodePolicyAdmin } from "./policy";
import { findCode } from "./store";

export const unusedDatabaseInput = z
  .object({
    codeId: CodeIdSchema,
    // Bind confirmation to an incarnation and grace period, never a later replacement.
    namespace: z.string().min(1).max(100),
    since: z.iso.datetime(),
  })
  .strict();
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
  const [mapping] = await db<
    {
      namespace: string;
      server_url: string;
      unused_since: Date;
      unused_delete_at: Date | null;
      unused_shown_at: Date | null;
    }[]
  >`
    SELECT namespace,server_url,unused_since,unused_delete_at,unused_shown_at FROM code.databases WHERE code_id=${codeId}
      AND unused_since IS NOT NULL AND code.database_is_unused(code_id)
      AND (${Boolean(expected)} OR (unused_delete_at<=${now} AND unused_shown_at<=${new Date(now.getTime() - DATABASE_EXPIRY_NOTICE_MS)}))
      AND NOT EXISTS(SELECT 1 FROM code.runs WHERE code_id=${codeId} AND state IN ('queued','running')) FOR UPDATE`;
  if (!mapping) return false;
  if (expected) {
    if (mapping.namespace !== expected.namespace || mapping.unused_since.toISOString() !== expected.since) return false;
  } else {
    if (
      !days ||
      !mapping.unused_delete_at ||
      mapping.unused_delete_at > now ||
      !mapping.unused_shown_at ||
      mapping.unused_shown_at.getTime() + DATABASE_EXPIRY_NOTICE_MS > now.getTime()
    )
      return false;
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
      metadata: {
        namespace: mapping.namespace,
        unusedSince: mapping.unused_since.toISOString(),
        automatic: !expected,
        deleteAt: mapping.unused_delete_at?.toISOString() ?? null,
        shownAt: mapping.unused_shown_at?.toISOString() ?? null,
      },
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
  const deadline = performance.now() + 10_000;
  const candidates = await sql.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout='100ms'`;
    await tx`SET LOCAL statement_timeout='2s'`;
    const policy = await lockDatabaseRetentionPolicy(tx);
    // Paused event runs can remain queued indefinitely. Exclude them only from expiry,
    // so changes to the visible deadline still reach these databases.
    return tx<{ code_id: string }[]>`SELECT code_id FROM code.databases
      WHERE unused_since IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM code.database_deletions x WHERE x.namespace=code.databases.namespace)
        AND (unused_policy_revision IS DISTINCT FROM ${policy.revision}::bigint
        OR unused_days IS DISTINCT FROM ${policy.days} OR (${policy.days}>0 AND (unused_shown_at IS NULL OR (unused_delete_at<=${now}
          AND NOT EXISTS(SELECT 1 FROM code.runs r WHERE r.code_id=code.databases.code_id AND r.state IN ('queued','running'))))))
      ORDER BY unused_since,code_id LIMIT 50`;
  });
  let count = 0;
  for (const { code_id } of candidates) {
    if (signal.aborted || performance.now() >= deadline) break;
    try {
      count += Number(
        await sql.begin(async (tx) => {
          await tx`SET LOCAL lock_timeout='100ms'`;
          await tx`SET LOCAL statement_timeout='2s'`;
          const policy = await lockDatabaseRetentionPolicy(tx);
          const [available] = await tx`SELECT id FROM code.codes WHERE id=${code_id} FOR UPDATE SKIP LOCKED`;
          if (!available) return false;
          await refreshDatabaseDeadline(tx, code_id, now, policy);
          return detach(tx, code_id, now, policy.days);
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
  const rows = await sql.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout='100ms'`;
    await tx`SET LOCAL statement_timeout='2s'`;
    const policy = await lockDatabaseRetentionPolicy(tx);
    const selected = await tx<{ code_id: string }[]>`SELECT code_id FROM code.databases
      WHERE unused_since IS NOT NULL AND (${after}::text IS NULL OR code_id>${after}) ORDER BY code_id LIMIT 21`;
    for (const row of selected) await refreshDatabaseDeadline(tx, row.code_id, new Date(), policy);
    return tx<
      {
        code_id: string;
        title: string;
        owner: string;
        last_size_bytes: string | null;
        unused_since: Date;
        unused_delete_at: Date | null;
        last_access_at: Date | null;
        namespace: string;
      }[]
    >`
    SELECT d.code_id,c.title,COALESCE(NULLIF(u.display_name,''),u.uid,c.owner_type || ':' || c.owner_id,c.owner_app_id) AS owner,
      d.last_size_bytes::text,d.unused_since,d.unused_delete_at,d.last_access_at,d.namespace
    FROM code.databases d JOIN code.codes c ON c.id=d.code_id LEFT JOIN auth.users u ON u.id=c.owner_user_id
    WHERE d.unused_since IS NOT NULL AND d.code_id=ANY(${tx.array(
      selected.map((row) => row.code_id),
      "text",
    )}) ORDER BY d.code_id LIMIT 21`;
  });
  return {
    items: rows.slice(0, 20).map(
      (row): UnusedCodeDatabase => ({
        codeId: row.code_id,
        title: row.title,
        owner: row.owner,
        bytes: row.last_size_bytes === null ? null : Number(row.last_size_bytes),
        since: row.unused_since.toISOString(),
        deleteAt: row.unused_delete_at?.toISOString() ?? null,
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
  const rows = await sql.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout='100ms'`;
    await tx`SET LOCAL statement_timeout='2s'`;
    const policy = await lockDatabaseRetentionPolicy(tx);
    if (!policy.days) return [];
    const selected = await tx<{ code_id: string }[]>`SELECT d.code_id FROM code.databases d JOIN code.codes c ON c.id=d.code_id
      WHERE c.owner_kind='person' AND d.unused_since IS NOT NULL
        AND (d.unused_policy_revision IS DISTINCT FROM ${policy.revision}::bigint OR d.unused_days IS DISTINCT FROM ${policy.days}
          OR d.unused_shown_at IS NULL OR (d.unused_delete_at>${now} AND d.unused_delete_at<=${new Date(now.getTime() + DATABASE_EXPIRY_NOTICE_MS)}
            AND d.unused_notice_key IS DISTINCT FROM d.namespace || ':' || d.unused_delete_at::text))
      ORDER BY d.unused_since,d.code_id LIMIT 20`;
    for (const row of selected.toSorted((a, b) => (a.code_id < b.code_id ? -1 : a.code_id > b.code_id ? 1 : 0)))
      await refreshDatabaseDeadline(tx, row.code_id, now, policy);
    return tx<
      {
        code_id: string;
        namespace: string;
        delete_at: Date;
        delete_stamp: string;
        owner_user_id: string;
        title: string;
      }[]
    >`SELECT d.code_id,d.namespace,d.unused_delete_at AS delete_at,d.unused_delete_at::text AS delete_stamp,c.owner_user_id,c.title
      FROM code.databases d JOIN code.codes c ON c.id=d.code_id
      WHERE d.code_id=ANY(${tx.array(
        selected.map((row) => row.code_id),
        "text",
      )}) AND d.unused_delete_at>${now}
        AND d.unused_delete_at<=${new Date(now.getTime() + DATABASE_EXPIRY_NOTICE_MS)}
        AND d.unused_notice_key IS DISTINCT FROM d.namespace || ':' || d.unused_delete_at::text
      ORDER BY d.unused_since,d.code_id LIMIT 20`;
  });
  const budget = performance.now() + 10_000;
  for (const row of rows) {
    if (signal.aborted || performance.now() >= budget) break;
    await sender.sendCodeDatabaseExpiry({
      userId: row.owner_user_id,
      codeId: row.code_id,
      title: row.title,
      deleteAt: row.delete_at.toISOString(),
      key: `code-db-expiry:${row.namespace}:${row.delete_stamp}`,
    });
    await sql`UPDATE code.databases SET unused_notice_key=namespace || ':' || unused_delete_at::text
      WHERE code_id=${row.code_id} AND namespace=${row.namespace} AND unused_delete_at=${row.delete_stamp}::timestamptz`;
  }
}
