import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import { type MailboxHealth, type MailboxOperationalHealth, mailboxOperationalHealthSchema, type SearchBackend } from "../contracts";
import { requireMailboxPermission } from "./access";
import type { MailRequestContext } from "./auth";

const toIso = (value: Date | string | null): string | null =>
  value ? (value instanceof Date ? value : new Date(value)).toISOString() : null;

const stateRecord = (rows: Array<{ state: string; count: number }>): Record<string, number> =>
  Object.fromEntries(rows.map((row) => [row.state, Number(row.count)]));

// The stored mailbox health describes the provider transport. Messages whose
// hydration failed are invisible there, so an active transport must not read
// as fully synchronized while message bodies are missing.
export const deriveOperationalHealth = (
  stored: { health: MailboxHealth; healthReason: string | null },
  failedHydrations: number,
): { health: MailboxHealth; healthReason: string | null } => {
  if (stored.health !== "active" || failedHydrations <= 0) return stored;
  return {
    health: "degraded",
    healthReason: `${failedHydrations} message${failedHydrations === 1 ? "" : "s"} failed hydration; run \`mail repair hydration\` to retry`,
  };
};

export const getMailboxOperationalHealth = async (
  context: MailRequestContext,
  mailboxId: string,
): Promise<Result<MailboxOperationalHealth>> => {
  const access = await requireMailboxPermission(context, mailboxId, "read");
  if (!access.ok) return access;
  try {
    const value = await sql.begin(async (tx) => {
      const [mailbox] = await tx<
        {
          id: string;
          short_id: string;
          health: MailboxHealth;
          health_reason: string | null;
          sync_enabled: boolean;
          search_backend: SearchBackend;
          remote_resource_id: string | null;
          discovery_generation: string | number | null;
          last_discovery_at: Date | string | null;
          last_sync_at: Date | string | null;
          lag_seconds: string | number | null;
        }[]
      >`
        SELECT
          mailbox.id,
          mailbox.short_id,
          mailbox.health,
          mailbox.health_reason,
          mailbox.sync_enabled,
          mailbox.search_backend,
          resource.id AS remote_resource_id,
          resource.discovery_generation,
          resource.last_discovery_at,
          resource.last_sync_at,
          CASE
            WHEN resource.last_sync_at IS NULL THEN NULL
            ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - resource.last_sync_at))))::bigint
          END AS lag_seconds
        FROM mail.mailboxes mailbox
        LEFT JOIN mail.remote_resources resource ON resource.mailbox_id = mailbox.id
        WHERE mailbox.id = ${mailboxId}::uuid AND mailbox.deleted_at IS NULL
      `;
      if (!mailbox) return null;
      const [bindingCounts] = await tx<
        {
          total: number;
          active: number;
          degraded: number;
          pending: number;
          revoked: number;
          last_verified_at: Date | string | null;
        }[]
      >`
        SELECT
          COUNT(binding.id)::int AS total,
          COUNT(binding.id) FILTER (WHERE binding.state = 'active')::int AS active,
          COUNT(binding.id) FILTER (WHERE binding.state = 'degraded')::int AS degraded,
          COUNT(binding.id) FILTER (WHERE binding.state IN ('pending', 'verifying'))::int AS pending,
          COUNT(binding.id) FILTER (WHERE binding.state = 'revoked')::int AS revoked,
          MAX(binding.last_verified_at) AS last_verified_at
        FROM mail.provider_bindings binding
        JOIN mail.remote_resources resource ON resource.id = binding.remote_resource_id
        JOIN mail.provider_connections connection ON connection.id = binding.connection_id
        WHERE resource.mailbox_id = ${mailboxId}::uuid
          AND connection.owner_mailbox_id = ${mailboxId}::uuid
      `;
      const rightsSources = await tx<{ state: string; count: number }[]>`
        SELECT ref.rights_source AS state, COUNT(*)::int AS count
        FROM mail.binding_folder_refs ref
        JOIN mail.provider_bindings binding ON binding.id = ref.binding_id
        JOIN mail.remote_resources resource ON resource.id = binding.remote_resource_id
        JOIN mail.provider_connections connection ON connection.id = binding.connection_id
        WHERE resource.mailbox_id = ${mailboxId}::uuid
          AND connection.owner_mailbox_id = ${mailboxId}::uuid
          AND binding.state = 'active'
          AND ref.missing_since IS NULL
        GROUP BY ref.rights_source
      `;
      const [folderCounts] = await tx<{ active: number; missing: number; ambiguous: number; subscribed: number }[]>`
        SELECT
          COUNT(*) FILTER (WHERE folder.discovery_state = 'active')::int AS active,
          COUNT(*) FILTER (WHERE folder.discovery_state = 'missing')::int AS missing,
          COUNT(*) FILTER (WHERE folder.discovery_state = 'ambiguous')::int AS ambiguous,
          COUNT(*) FILTER (
            WHERE EXISTS (
              SELECT 1
              FROM mail.binding_folder_refs ref
              JOIN mail.provider_bindings binding ON binding.id = ref.binding_id
              JOIN mail.provider_connections connection ON connection.id = binding.connection_id
              WHERE ref.folder_id = folder.id
                AND ref.subscribed
                AND ref.missing_since IS NULL
                AND binding.state = 'active'
                AND connection.owner_mailbox_id = ${mailboxId}::uuid
            )
          )::int AS subscribed
        FROM mail.folders folder
        JOIN mail.remote_resources resource ON resource.id = folder.remote_resource_id
        WHERE resource.mailbox_id = ${mailboxId}::uuid
      `;
      const syncRuns = await tx<{ state: string; count: number }[]>`
        SELECT run.state, COUNT(*)::int AS count
        FROM mail.sync_runs run
        JOIN mail.remote_resources resource ON resource.id = run.remote_resource_id
        WHERE resource.mailbox_id = ${mailboxId}::uuid
          AND (run.state = 'running' OR (run.state = 'failed' AND run.started_at > now() - interval '24 hours'))
        GROUP BY run.state
      `;
      const folderStates = await tx<{ state: string; count: number }[]>`
        SELECT folder.sync_status AS state, COUNT(*)::int AS count
        FROM mail.folders folder
        JOIN mail.remote_resources resource ON resource.id = folder.remote_resource_id
        WHERE resource.mailbox_id = ${mailboxId}::uuid
        GROUP BY folder.sync_status
      `;
      const [hydration] = await tx<{ complete: number; pending: number; failed: number }[]>`
        SELECT
          COUNT(*) FILTER (WHERE hydration_status = 'complete')::int AS complete,
          COUNT(*) FILTER (WHERE hydration_status IN ('envelope', 'headers', 'hydrating', 'body'))::int AS pending,
          COUNT(*) FILTER (WHERE hydration_status = 'failed')::int AS failed
        FROM mail.message_contents
        WHERE mailbox_id = ${mailboxId}::uuid
      `;
      const commandStates = await tx<{ state: string; count: number }[]>`
        SELECT state, COUNT(*)::int AS count
        FROM mail.commands
        WHERE mailbox_id = ${mailboxId}::uuid
        GROUP BY state
      `;
      const [maintenance] = await tx<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM mail.commands
        WHERE mailbox_id = ${mailboxId}::uuid
          AND state IN ('queued', 'executing')
          AND kind IN (
            'sync_mailbox', 'sync_folder', 'discover_folders', 'verify_binding', 'rebuild_folder', 'hydrate_missing',
            'rebuild_search', 'rebuild_threads', 'reconcile_effect', 'retry_command', 'cancel_command'
          )
      `;
      const outboxStates = await tx<{ state: string; count: number }[]>`
        SELECT state, COUNT(*)::int AS count
        FROM mail.outbox_submissions
        WHERE mailbox_id = ${mailboxId}::uuid
        GROUP BY state
      `;
      const [search] = await tx<{ installed: boolean; ready: boolean }[]>`
        SELECT
          EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_textsearch') AS installed,
          EXISTS (
            SELECT 1
            FROM pg_class index_class
            JOIN pg_am access_method ON access_method.oid = index_class.relam
            JOIN pg_index index_state ON index_state.indexrelid = index_class.oid
            WHERE index_class.oid = to_regclass('mail.message_contents_bm25_idx')
              AND access_method.amname = 'bm25'
              AND index_state.indisvalid
              AND index_state.indisready
              AND index_state.indislive
          ) AS ready
      `;
      const runStates = stateRecord(syncRuns);
      const failedHydrations = Number(hydration?.failed ?? 0);
      const operational = deriveOperationalHealth({ health: mailbox.health, healthReason: mailbox.health_reason }, failedHydrations);
      return mailboxOperationalHealthSchema.parse({
        mailboxId: mailbox.short_id,
        health: operational.health,
        healthReason: operational.healthReason,
        syncEnabled: mailbox.sync_enabled,
        bindings: {
          total: Number(bindingCounts?.total ?? 0),
          active: Number(bindingCounts?.active ?? 0),
          degraded: Number(bindingCounts?.degraded ?? 0),
          pending: Number(bindingCounts?.pending ?? 0),
          revoked: Number(bindingCounts?.revoked ?? 0),
          lastVerifiedAt: toIso(bindingCounts?.last_verified_at ?? null),
          rightsSources: stateRecord(rightsSources),
        },
        discovery: {
          generation: Number(mailbox.discovery_generation ?? 0),
          lastAt: toIso(mailbox.last_discovery_at),
          activeFolders: Number(folderCounts?.active ?? 0),
          missingFolders: Number(folderCounts?.missing ?? 0),
          ambiguousFolders: Number(folderCounts?.ambiguous ?? 0),
          subscribedFolders: Number(folderCounts?.subscribed ?? 0),
        },
        sync: {
          lastAt: toIso(mailbox.last_sync_at),
          lagSeconds: mailbox.lag_seconds == null ? null : Number(mailbox.lag_seconds),
          runningRuns: runStates["running"] ?? 0,
          failedRuns: runStates["failed"] ?? 0,
          folderStates: stateRecord(folderStates),
        },
        hydration: {
          complete: Number(hydration?.complete ?? 0),
          pending: Number(hydration?.pending ?? 0),
          failed: failedHydrations,
        },
        commands: {
          states: stateRecord(commandStates),
          maintenanceQueued: Number(maintenance?.count ?? 0),
        },
        outbox: { states: stateRecord(outboxStates) },
        search: {
          configuredBackend: mailbox.search_backend,
          pgTextsearchInstalled: search?.installed ?? false,
          bm25Ready: search?.ready ?? false,
        },
      });
    });
    return value ? ok(value) : fail(err.notFound("Mailbox"));
  } catch {
    return fail(err.internal("Failed to load mailbox operational health"));
  }
};
