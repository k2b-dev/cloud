import { err, fail, ok, type Result } from "@k2b/stdlib";
import { escapeLikePattern } from "@k2b/cloud/services";
import { sql } from "bun";
import { z } from "zod";
import {
  type MailboxHealth,
  type MailboxOperatorOperations,
  mailboxOperatorOperationsSchema,
  type PlatformMailboxOperationSummary,
  type PlatformMailOperations,
  platformMailOperationsSchema,
  type SearchBackend,
} from "../contracts";
import { isCurrentPlatformAdmin, requireMailboxPermission } from "./access";
import type { MailRequestContext } from "./auth";
import {
  getOperatorActionEligibility,
  type OperatorTargetCommandState,
  operatorActionForCommand,
  operatorActionForFolder,
} from "./operator-actions";

const toIso = (value: Date | string | null): string | null =>
  value ? (value instanceof Date ? value : new Date(value)).toISOString() : null;

const stateRecord = (rows: Array<{ state: string; count: number | string }>): Record<string, number> =>
  Object.fromEntries(rows.map((row) => [row.state, Number(row.count)]));

const platformCursorSchema = z.object({ version: z.literal(1), createdAt: z.iso.datetime(), id: z.uuid() }).strict();
type PlatformCursor = z.infer<typeof platformCursorSchema>;
const attentionCursorSchema = z.object({ version: z.literal(1), updatedAt: z.iso.datetime(), id: z.uuid() }).strict();
type AttentionCursor = z.infer<typeof attentionCursorSchema>;

const encodePlatformCursor = (row: { id: string; cursor_created_at: string }): string =>
  Buffer.from(
    JSON.stringify({
      version: 1,
      createdAt: row.cursor_created_at,
      id: row.id,
    } satisfies PlatformCursor),
  ).toString("base64url");

const toSafeCount = (value: number | string): number => {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("Mail operations count exceeds the JSON integer range");
  return count;
};

const decodePlatformCursor = (value?: string): Result<PlatformCursor | null> => {
  if (!value) return ok(null);
  try {
    const parsed = platformCursorSchema.safeParse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    return parsed.success ? ok(parsed.data) : fail(err.badInput("Invalid Mail operations cursor"));
  } catch {
    return fail(err.badInput("Invalid Mail operations cursor"));
  }
};

const decodeAttentionCursor = (value?: string): Result<AttentionCursor | null> => {
  if (!value) return ok(null);
  try {
    const parsed = attentionCursorSchema.safeParse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    return parsed.success ? ok(parsed.data) : fail(err.badInput("Invalid Mail attention cursor"));
  } catch {
    return fail(err.badInput("Invalid Mail attention cursor"));
  }
};

type DbMailbox = {
  id: string;
  short_id: string;
  name: string;
  health: MailboxHealth;
  sync_enabled: boolean;
  search_backend: SearchBackend;
  last_sync_at: Date | string | null;
  lag_seconds: number | string | null;
};

type DbAttentionCommand = OperatorTargetCommandState & {
  attempt: number;
  last_error_code: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const encodeAttentionCursor = (row: DbAttentionCommand): string =>
  Buffer.from(
    JSON.stringify({
      version: 1,
      updatedAt: toIso(row.updated_at)!,
      id: row.id,
    } satisfies AttentionCursor),
  ).toString("base64url");

type DbFolder = {
  id: string;
  short_id: string;
  name: string;
  discovery_state: "active" | "missing" | "ambiguous";
  sync_status: string;
  selected_for_sync: boolean;
};

const loadMailboxOperations = async (
  mailboxId: string,
  options: {
    attentionCursor?: AttentionCursor | null;
    attentionLimit?: number;
    includeFolderActions?: boolean;
  } = {},
): Promise<MailboxOperatorOperations | null> => {
  const [mailbox] = await sql<DbMailbox[]>`
    SELECT
      mailbox.id,
      mailbox.short_id,
      mailbox.name,
      mailbox.health,
      mailbox.sync_enabled,
      mailbox.search_backend,
      resource.last_sync_at,
      CASE WHEN resource.last_sync_at IS NULL THEN NULL
        ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - resource.last_sync_at))))::bigint
      END AS lag_seconds
    FROM mail.mailboxes mailbox
    LEFT JOIN mail.remote_resources resource ON resource.mailbox_id = mailbox.id
    WHERE mailbox.id = ${mailboxId}::uuid AND mailbox.deleted_at IS NULL
  `;
  if (!mailbox) return null;

  const syncStates = await sql<{ state: string; count: number }[]>`
    SELECT run.state, COUNT(*)::int AS count
    FROM mail.sync_runs run
    JOIN mail.remote_resources resource ON resource.id = run.remote_resource_id
    WHERE resource.mailbox_id = ${mailboxId}::uuid
      AND (run.state IN ('running', 'failed') OR run.started_at > now() - interval '24 hours')
    GROUP BY run.state
  `;
  const [coverage] = await sql<
    {
      messages: number;
      hydrated: number;
      search_total: number;
      indexed: number;
      threaded: number;
    }[]
  >`
    SELECT
      COUNT(*)::int AS messages,
      COUNT(*) FILTER (WHERE message.hydration_status = 'complete')::int AS hydrated,
      COUNT(*) FILTER (WHERE message.plain_text IS NOT NULL AND message.plain_text <> '')::int AS search_total,
      COUNT(*) FILTER (
        WHERE message.plain_text IS NOT NULL AND message.plain_text <> ''
          AND EXISTS (
            SELECT 1 FROM mail.message_search_chunks chunk
            WHERE chunk.message_id = message.id AND chunk.source_kind = 'body'
          )
      )::int AS indexed,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM mail.conversation_messages link WHERE link.message_id = message.id))::int AS threaded
    FROM mail.message_contents message
    WHERE message.mailbox_id = ${mailboxId}::uuid
  `;
  const commandStates = await sql<{ state: string; count: number }[]>`
    SELECT state, COUNT(*)::int AS count FROM mail.commands WHERE mailbox_id = ${mailboxId}::uuid GROUP BY state
  `;
  const outboxStates = await sql<{ state: string; count: number }[]>`
    SELECT state, COUNT(*)::int AS count FROM mail.outbox_submissions WHERE mailbox_id = ${mailboxId}::uuid GROUP BY state
  `;
  const workflowStates = await sql<{ state: string; count: number }[]>`
    SELECT run.state, COUNT(*)::int AS count
    FROM workflows.run run
    JOIN mail.workflow_profile profile ON profile.id = run.workflow_id
    WHERE profile.mailbox_id = ${mailboxId}::uuid
    GROUP BY run.state
  `;
  const automaticReplyStates = await sql<{ state: string; count: number }[]>`
    SELECT state, COUNT(*)::int AS count FROM mail.automatic_reply_effects WHERE mailbox_id = ${mailboxId}::uuid GROUP BY state
  `;
  const automaticReplySuppressions = await sql<{ state: string; count: number }[]>`
    SELECT reason AS state, COUNT(*)::int AS count
    FROM mail.automatic_reply_effects effect
    CROSS JOIN LATERAL unnest(effect.suppression_reasons) reason
    WHERE effect.mailbox_id = ${mailboxId}::uuid AND effect.state = 'suppressed'
    GROUP BY reason
  `;
  const [bindings] = await sql<
    {
      active: number;
      degraded: number;
      capabilities: Record<string, number> | string;
    }[]
  >`
    SELECT
      COUNT(*) FILTER (WHERE binding.state = 'active')::int AS active,
      COUNT(*) FILTER (WHERE binding.state = 'degraded')::int AS degraded,
      jsonb_build_object(
        'idle', COUNT(*) FILTER (WHERE binding.state = 'active' AND binding.capabilities ->> 'idle' = 'true'),
        'condstore', COUNT(*) FILTER (WHERE binding.state = 'active' AND binding.capabilities ->> 'condstore' = 'true'),
        'qresync', COUNT(*) FILTER (WHERE binding.state = 'active' AND binding.capabilities ->> 'qresync' = 'true'),
        'move', COUNT(*) FILTER (WHERE binding.state = 'active' AND binding.capabilities ->> 'move' = 'true'),
        'uidplus', COUNT(*) FILTER (WHERE binding.state = 'active' AND binding.capabilities ->> 'uidplus' = 'true'),
        'namespace', COUNT(*) FILTER (WHERE binding.state = 'active' AND binding.capabilities ->> 'namespace' = 'true'),
        'listExtended', COUNT(*) FILTER (WHERE binding.state = 'active' AND binding.capabilities ->> 'listExtended' = 'true'),
        'specialUse', COUNT(*) FILTER (WHERE binding.state = 'active' AND binding.capabilities ->> 'specialUse' = 'true'),
        'acl', COUNT(*) FILTER (WHERE binding.state = 'active' AND binding.capabilities ->> 'acl' = 'true'),
        'notify', COUNT(*) FILTER (WHERE binding.state = 'active' AND binding.capabilities ->> 'notify' = 'true'),
        'quota', COUNT(*) FILTER (WHERE binding.state = 'active' AND binding.capabilities ->> 'quota' = 'true'),
        'gmailExtensions', COUNT(*) FILTER (WHERE binding.state = 'active' AND binding.capabilities ->> 'gmailExtensions' = 'true')
      ) AS capabilities
    FROM mail.provider_bindings binding
    JOIN mail.remote_resources resource ON resource.id = binding.remote_resource_id
    WHERE resource.mailbox_id = ${mailboxId}::uuid
  `;
  const pushModes = await sql<{ state: string; count: number }[]>`
    SELECT health.mode AS state, COUNT(*)::int AS count
    FROM mail.imap_push_listener_health health
    JOIN mail.provider_bindings binding ON binding.id = health.binding_id
    JOIN mail.remote_resources resource ON resource.id = binding.remote_resource_id
    WHERE resource.mailbox_id = ${mailboxId}::uuid GROUP BY health.mode
  `;
  const pushStates = await sql<{ state: string; count: number }[]>`
    SELECT health.state, COUNT(*)::int AS count
    FROM mail.imap_push_listener_health health
    JOIN mail.provider_bindings binding ON binding.id = health.binding_id
    JOIN mail.remote_resources resource ON resource.id = binding.remote_resource_id
    WHERE resource.mailbox_id = ${mailboxId}::uuid GROUP BY health.state
  `;
  const draftProjectionStates = await sql<{ state: string; count: number }[]>`
    SELECT state, COUNT(*)::int AS count FROM mail.draft_provider_snapshots WHERE mailbox_id = ${mailboxId}::uuid GROUP BY state
  `;
  const [search] = await sql<{ bm25_ready: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM pg_class index_class
      JOIN pg_am access_method ON access_method.oid = index_class.relam
      JOIN pg_index index_state ON index_state.indexrelid = index_class.oid
      WHERE index_class.oid = to_regclass('mail.message_contents_bm25_idx')
        AND access_method.amname = 'bm25'
        AND index_state.indisvalid AND index_state.indisready AND index_state.indislive
        AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_textsearch')
    ) AS bm25_ready
  `;
  const [references] = await sql<{ configured: boolean; allocated: number }[]>`
    SELECT
      EXISTS (SELECT 1 FROM mail.reference_number_configurations WHERE mailbox_id = ${mailboxId}::uuid AND enabled) AS configured,
      (SELECT COUNT(*)::int FROM mail.conversation_references WHERE mailbox_id = ${mailboxId}::uuid) AS allocated
  `;
  const folders =
    options.includeFolderActions === false
      ? []
      : await sql<DbFolder[]>`
          SELECT folder.id, folder.short_id, folder.name, folder.discovery_state, folder.sync_status, folder.selected_for_sync
          FROM mail.folders folder
          JOIN mail.remote_resources resource ON resource.id = folder.remote_resource_id
          WHERE resource.mailbox_id = ${mailboxId}::uuid
          ORDER BY lower(folder.name), folder.id
        `;
  const attentionLimit = Math.min(Math.max(options.attentionLimit ?? 100, 1), 200);
  const attentionCommandsPage = await sql<DbAttentionCommand[]>`
    SELECT id, kind, state, attempt, last_error_code, provider_effect_started_at, created_at, updated_at
    FROM mail.commands
    WHERE mailbox_id = ${mailboxId}::uuid AND state IN ('failed', 'ambiguous', 'needs_attention')
      AND (${options.attentionCursor?.updatedAt ?? null}::timestamptz IS NULL
        OR (updated_at, id) < (${options.attentionCursor?.updatedAt ?? null}::timestamptz, ${options.attentionCursor?.id ?? null}::uuid))
    ORDER BY updated_at DESC, id DESC
    LIMIT ${attentionLimit + 1}
  `;
  const hasMoreAttention = attentionCommandsPage.length > attentionLimit;
  const attentionCommands = attentionCommandsPage.slice(0, attentionLimit);
  const recentCommands = await sql<DbAttentionCommand[]>`
    SELECT id, kind, state, attempt, last_error_code, provider_effect_started_at, created_at, updated_at
    FROM mail.commands
    WHERE mailbox_id = ${mailboxId}::uuid
      AND kind IN (
        'sync_mailbox',
        'sync_folder',
        'discover_folders',
        'verify_binding',
        'rebuild_folder',
        'hydrate_missing',
        'rebuild_search',
        'rebuild_threads',
        'reconcile_effect',
        'retry_command',
        'cancel_command'
      )
    ORDER BY updated_at DESC, id DESC
    LIMIT 6
  `;
  const activeActions = await sql<{ kind: string; target: Record<string, string> | string }[]>`
    SELECT kind, target FROM mail.commands
    WHERE mailbox_id = ${mailboxId}::uuid
      AND state IN ('queued', 'executing')
      AND (
        kind IN ('sync_mailbox', 'discover_folders', 'hydrate_missing', 'rebuild_search', 'rebuild_threads')
        OR (${options.includeFolderActions !== false} AND kind IN ('sync_folder', 'rebuild_folder') AND target ->> 'folderId' IN (
          SELECT folder.id::text
          FROM mail.folders folder
          JOIN mail.remote_resources resource ON resource.id = folder.remote_resource_id
          WHERE resource.mailbox_id = ${mailboxId}::uuid
        ))
        OR (
          kind IN ('reconcile_effect', 'retry_command', 'cancel_command')
          AND target ->> 'commandId' = ANY(${sql.array(
            attentionCommands.map((command) => command.id),
            "TEXT",
          )})
        )
      )
  `;
  const activeKeys = new Set(
    activeActions.map((action) => {
      const target = typeof action.target === "string" ? (JSON.parse(action.target) as Record<string, string>) : action.target;
      return `${action.kind}:${JSON.stringify(target)}`;
    }),
  );
  const duplicate = (kind: string, target: Record<string, string>) => activeKeys.has(`${kind}:${JSON.stringify(target)}`);

  const actions = await Promise.all(
    (["sync_mailbox", "discover_folders", "hydrate_missing", "rebuild_search", "rebuild_threads"] as const).map((kind) =>
      getOperatorActionEligibility({
        mailboxId,
        input: { kind, idempotencyKey: "operator-read-model" },
      }),
    ),
  );
  const parsedCapabilities = bindings?.capabilities
    ? typeof bindings.capabilities === "string"
      ? (JSON.parse(bindings.capabilities) as Record<string, number>)
      : bindings.capabilities
    : {};
  const bm25Ready = search?.bm25_ready ?? false;
  const effectiveBackend = mailbox.search_backend !== "postgres" && bm25Ready ? "pg_textsearch" : "postgres";

  return mailboxOperatorOperationsSchema.parse({
    mailboxId: mailbox.short_id,
    mailboxName: mailbox.name,
    health: mailbox.health,
    syncEnabled: mailbox.sync_enabled,
    sync: {
      lastAt: toIso(mailbox.last_sync_at),
      lagSeconds: mailbox.lag_seconds == null ? null : Number(mailbox.lag_seconds),
      states: stateRecord(syncStates),
    },
    coverage: {
      hydration: {
        total: Number(coverage?.messages ?? 0),
        covered: Number(coverage?.hydrated ?? 0),
      },
      search: {
        total: Number(coverage?.search_total ?? 0),
        covered: Number(coverage?.indexed ?? 0),
      },
      threads: {
        total: Number(coverage?.messages ?? 0),
        covered: Number(coverage?.threaded ?? 0),
      },
    },
    queues: {
      commands: stateRecord(commandStates),
      outbox: stateRecord(outboxStates),
      workflows: stateRecord(workflowStates),
      automaticReplies: stateRecord(automaticReplyStates),
      automaticReplySuppressions: stateRecord(automaticReplySuppressions),
    },
    connectors: {
      activeBindings: Number(bindings?.active ?? 0),
      degradedBindings: Number(bindings?.degraded ?? 0),
      capabilities: Object.fromEntries(Object.entries(parsedCapabilities).map(([key, count]) => [key, Number(count)])),
      pushModes: stateRecord(pushModes),
      pushStates: stateRecord(pushStates),
      draftProjectionStates: stateRecord(draftProjectionStates),
    },
    search: {
      configuredBackend: mailbox.search_backend,
      effectiveBackend,
      fallbackActive: mailbox.search_backend === "pg_textsearch" && effectiveBackend === "postgres",
    },
    references: {
      configured: references?.configured ?? false,
      allocated: Number(references?.allocated ?? 0),
    },
    folders: folders.map((folder) => ({
      id: folder.short_id,
      name: folder.name,
      discoveryState: folder.discovery_state,
      syncStatus: folder.sync_status,
      selectedForSync: folder.selected_for_sync,
      actions: (["sync_folder", "rebuild_folder"] as const).map((kind) =>
        operatorActionForFolder(
          { kind, folderId: folder.id, idempotencyKey: "operator-read-model" },
          folder,
          duplicate(kind, { folderId: folder.id }),
        ),
      ),
    })),
    recentCommands: recentCommands.map((command) => ({
      id: command.id,
      kind: command.kind,
      state: command.state,
      attempt: Number(command.attempt),
      errorCode: command.last_error_code,
      providerEffectStarted: command.provider_effect_started_at !== null,
      createdAt: toIso(command.created_at),
      updatedAt: toIso(command.updated_at),
      actions: [],
    })),
    attentionCommands: attentionCommands.map((command) => ({
      id: command.id,
      kind: command.kind,
      state: command.state,
      attempt: Number(command.attempt),
      errorCode: command.last_error_code,
      providerEffectStarted: command.provider_effect_started_at !== null,
      createdAt: toIso(command.created_at),
      updatedAt: toIso(command.updated_at),
      actions: (["reconcile_effect", "retry_command", "cancel_command"] as const).map((kind) =>
        operatorActionForCommand(
          {
            kind,
            commandId: command.id,
            idempotencyKey: "operator-read-model",
          },
          command,
          duplicate(kind, { commandId: command.id }),
        ),
      ),
    })),
    attentionCount: commandStates
      .filter((row) => row.state === "failed" || row.state === "ambiguous" || row.state === "needs_attention")
      .reduce((count, row) => count + Number(row.count), 0),
    nextAttentionCursor: hasMoreAttention && attentionCommands.at(-1) ? encodeAttentionCursor(attentionCommands.at(-1)!) : null,
    actions,
    generatedAt: new Date().toISOString(),
  });
};

export const getMailboxOperations = async (
  context: MailRequestContext,
  mailboxId: string,
  query: { attentionCursor?: string; attentionLimit?: number } = {},
): Promise<Result<MailboxOperatorOperations>> => {
  const allowed = await requireMailboxPermission(context, mailboxId, "admin");
  if (!allowed.ok) return allowed;
  const attentionCursor = decodeAttentionCursor(query.attentionCursor);
  if (!attentionCursor.ok) return attentionCursor;
  try {
    const value = await loadMailboxOperations(mailboxId, {
      attentionCursor: attentionCursor.data,
      attentionLimit: query.attentionLimit,
    });
    return value ? ok(value) : fail(err.notFound("Mailbox"));
  } catch {
    return fail(err.internal("Failed to load Mail operator status"));
  }
};

export const getPlatformMailOperations = async (
  context: MailRequestContext,
  query: { cursor?: string; limit?: number; q?: string; internalMailboxId?: string } = {},
): Promise<Result<PlatformMailOperations>> => {
  if (!(await isCurrentPlatformAdmin(context))) return fail(err.forbidden("Cloud administration access is required"));
  const cursor = decodePlatformCursor(query.cursor);
  if (!cursor.ok) return cursor;
  try {
    const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
    const rawSearch = query.q?.trim() || null;
    const search = rawSearch ? `%${escapeLikePattern(rawSearch)}%` : null;
    const [global, rows] = await Promise.all([
      sql<
        {
          count: number | string;
          without_administrator_count: number | string;
          attention_count: number | string;
        }[]
      >`
        SELECT
          COUNT(*) AS count,
          COUNT(*) FILTER (
            WHERE NOT EXISTS (
              SELECT 1
              FROM mail.mailbox_access mailbox_access
              JOIN auth.access access ON access.id = mailbox_access.access_id
              WHERE mailbox_access.mailbox_id = mailbox.id AND access.permission = 'admin'
            )
          ) AS without_administrator_count,
          COALESCE(SUM((
            SELECT COUNT(*)
            FROM mail.commands command
            WHERE command.mailbox_id = mailbox.id
              AND command.state IN ('failed', 'ambiguous', 'needs_attention')
          )), 0) AS attention_count
        FROM mail.mailboxes mailbox
        WHERE mailbox.deleted_at IS NULL
      `,
      sql<
        Array<{
          id: string;
          short_id: string;
          name: string;
          created_at: Date | string;
          cursor_created_at: string;
          health: MailboxHealth;
          sync_enabled: boolean;
          last_sync_at: Date | string | null;
          lag_seconds: number | string | null;
          messages: number | string;
          hydrated: number | string;
          search_total: number | string;
          indexed: number | string;
          threaded: number | string;
          access_count: number | string;
          administrator_count: number | string;
          storage_message_count: number | string | null;
          logical_total_bytes: number | string | null;
          storage_calculated_at: Date | string | null;
          attention_count: number | string;
        }>
      >`
        WITH mailbox_page AS (
          SELECT id, short_id, name, created_at, health, sync_enabled
          FROM mail.mailboxes
          WHERE deleted_at IS NULL
            AND (${query.internalMailboxId ?? null}::uuid IS NULL OR id = ${query.internalMailboxId ?? null}::uuid)
            AND (
              ${search}::text IS NULL
              OR LOWER(name) LIKE LOWER(${search}) ESCAPE '\\'
              OR short_id = ${rawSearch}
            )
            AND (${cursor.data?.createdAt ?? null}::timestamptz IS NULL
              OR (created_at, id) > (${cursor.data?.createdAt ?? null}::timestamptz, ${cursor.data?.id ?? null}::uuid))
          ORDER BY created_at, id
          LIMIT ${limit + 1}
        )
        SELECT
          mailbox.id,
          mailbox.short_id,
          mailbox.name,
          mailbox.created_at,
          to_char(mailbox.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at,
          mailbox.health,
          mailbox.sync_enabled,
          sync.last_sync_at,
          CASE WHEN sync.last_sync_at IS NULL THEN NULL
            ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - sync.last_sync_at))))::bigint
          END AS lag_seconds,
          COALESCE(coverage.messages, 0) AS messages,
          COALESCE(coverage.hydrated, 0) AS hydrated,
          COALESCE(coverage.search_total, 0) AS search_total,
          COALESCE(coverage.indexed, 0) AS indexed,
          COALESCE(coverage.threaded, 0) AS threaded,
          COALESCE(access_summary.access_count, 0) AS access_count,
          COALESCE(access_summary.administrator_count, 0) AS administrator_count,
          storage.message_count AS storage_message_count,
          storage.logical_total_bytes,
          storage.calculated_at AS storage_calculated_at,
          COALESCE(commands.attention_count, 0) AS attention_count
        FROM mailbox_page mailbox
        LEFT JOIN LATERAL (
          SELECT MAX(resource.last_sync_at) AS last_sync_at
          FROM mail.remote_resources resource
          WHERE resource.mailbox_id = mailbox.id
        ) sync ON true
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*) AS messages,
            COUNT(*) FILTER (WHERE message.hydration_status = 'complete') AS hydrated,
            COUNT(*) FILTER (WHERE message.plain_text IS NOT NULL AND message.plain_text <> '') AS search_total,
            COUNT(*) FILTER (
              WHERE message.plain_text IS NOT NULL AND message.plain_text <> ''
                AND EXISTS (
                  SELECT 1 FROM mail.message_search_chunks chunk
                  WHERE chunk.message_id = message.id AND chunk.source_kind = 'body'
                )
            ) AS indexed,
            COUNT(*) FILTER (
              WHERE EXISTS (SELECT 1 FROM mail.conversation_messages link WHERE link.message_id = message.id)
            ) AS threaded
          FROM mail.message_contents message
          WHERE message.mailbox_id = mailbox.id
        ) coverage ON true
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*) AS access_count,
            COUNT(*) FILTER (WHERE access.permission = 'admin') AS administrator_count
          FROM mail.mailbox_access mailbox_access
          JOIN auth.access access ON access.id = mailbox_access.access_id
          WHERE mailbox_access.mailbox_id = mailbox.id
        ) access_summary ON true
        LEFT JOIN mail.storage_usage_snapshots storage ON storage.mailbox_id = mailbox.id
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS attention_count
          FROM mail.commands command
          WHERE command.mailbox_id = mailbox.id
            AND command.state IN ('failed', 'ambiguous', 'needs_attention')
        ) commands ON true
        ORDER BY mailbox.created_at, mailbox.id
      `,
    ]);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const values = page.map((mailbox) => ({
      mailboxId: mailbox.short_id,
      mailboxName: mailbox.name,
      health: mailbox.health,
      syncEnabled: mailbox.sync_enabled,
      sync: {
        lastAt: toIso(mailbox.last_sync_at),
        lagSeconds: mailbox.lag_seconds == null ? null : Number(mailbox.lag_seconds),
      },
      coverage: {
        hydration: {
          total: toSafeCount(mailbox.messages),
          covered: toSafeCount(mailbox.hydrated),
        },
        search: {
          total: toSafeCount(mailbox.search_total),
          covered: toSafeCount(mailbox.indexed),
        },
        threads: {
          total: toSafeCount(mailbox.messages),
          covered: toSafeCount(mailbox.threaded),
        },
      },
      access: {
        total: toSafeCount(mailbox.access_count),
        administrators: toSafeCount(mailbox.administrator_count),
      },
      storage:
        mailbox.storage_calculated_at == null
          ? null
          : {
              messageCount: toSafeCount(mailbox.storage_message_count ?? 0),
              logicalTotalBytes: toSafeCount(mailbox.logical_total_bytes ?? 0),
              calculatedAt: toIso(mailbox.storage_calculated_at)!,
            },
      attentionCount: toSafeCount(mailbox.attention_count),
    }));
    const last = page.at(-1);
    return ok(
      platformMailOperationsSchema.parse({
        mailboxes: values,
        mailboxCount: toSafeCount(global[0]?.count ?? 0),
        withoutAdministratorCount: toSafeCount(global[0]?.without_administrator_count ?? 0),
        attentionCount: toSafeCount(global[0]?.attention_count ?? 0),
        generatedAt: new Date().toISOString(),
        nextCursor: hasMore && last ? encodePlatformCursor(last) : null,
      }),
    );
  } catch {
    return fail(err.internal("Failed to load platform Mail operator status"));
  }
};

export const getPlatformMailboxOperation = async (
  context: MailRequestContext,
  mailboxId: string,
): Promise<Result<PlatformMailboxOperationSummary>> => {
  const result = await getPlatformMailOperations(context, { internalMailboxId: mailboxId, limit: 1 });
  if (!result.ok) return result;
  const mailbox = result.data.mailboxes[0];
  return mailbox ? ok(mailbox) : fail(err.notFound("Mailbox"));
};
