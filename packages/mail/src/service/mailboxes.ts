import { err, fail, ok, type Result, tryCatch, unwrap } from "@k2b/stdlib";
import { createAccess, type PermissionLevel } from "@k2b/cloud/server";
import { audit } from "@k2b/cloud/services";
import { sql } from "bun";
import { z } from "zod";
import {
  type CreateMailboxInput,
  composeSafetyConfigSchema,
  type DeletedMailbox,
  type DeletedMailboxPage,
  defaultComposeSafetyConfig,
  type Mailbox,
} from "../contracts";
import { withShortIdDb } from "../lib/short-id";
import {
  getMailboxPermission,
  isCurrentActorActive,
  isCurrentPlatformAdmin,
  mailboxAccessPrincipalCondition,
  requireMailboxLifecycleAdmin,
  requireMailboxPermission,
} from "./access";
import {
  actorRefFromRequest,
  auditActorFromRequest,
  capByCredentialScopes,
  isResourceBoundToMailbox,
  type MailRequestContext,
  userBackedActor,
} from "./auth";
import { publishMailMailboxEvent } from "./events";
import { validateDestructiveIncomingAutomationsForMailbox } from "./incoming-automations";
import { pauseDeletedMailboxExecution, pauseMailboxTransport } from "./mailbox-lifecycle";
import { withMailboxProviderOperationBarrier } from "./provider-operation-lock";

type DbMailbox = {
  id: string;
  name: string;
  description: string | null;
  health: Mailbox["health"];
  health_reason: string | null;
  sync_enabled: boolean;
  search_backend: Mailbox["searchBackend"];
  automatic_reply_management_permission: Mailbox["automaticReplyManagementPermission"];
  compose_safety: unknown;
  deleted_at: Date | string | null;
  deleted_cursor_us: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type DbMailboxListItem = DbMailbox & {
  permission: PermissionLevel;
  receiving_address: string | null;
};

export type MailboxListItem = Mailbox & {
  permission: PermissionLevel;
  receivingAddress: string | null;
};

const toIso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();

const mapMailbox = (row: DbMailbox): Mailbox => ({
  id: row.id,
  name: row.name,
  description: row.description,
  health: row.health,
  healthReason: row.health_reason,
  syncEnabled: row.sync_enabled,
  searchBackend: row.search_backend,
  automaticReplyManagementPermission: row.automatic_reply_management_permission,
  composeSafety: composeSafetyConfigSchema.catch(defaultComposeSafetyConfig()).parse(row.compose_safety),
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
});

const mapDeletedMailbox = (row: DbMailbox): DeletedMailbox => {
  if (!row.deleted_at) throw new Error("Deleted mailbox row has no deletion timestamp");
  return { ...mapMailbox(row), deletedAt: toIso(row.deleted_at) };
};

const getMailboxReceivingAddress = async (mailboxId: string): Promise<string | null> => {
  const [row] = await sql<{ email: string }[]>`
    SELECT email
    FROM mail.provider_connections
    WHERE owner_mailbox_id = ${mailboxId}::uuid
      AND status <> 'revoked'
  `;
  return row?.email ?? null;
};

const mailboxColumns = sql`
  m.id, m.name, m.description, m.health, m.health_reason,
  m.sync_enabled, m.search_backend, m.automatic_reply_management_permission, m.deleted_at,
  m.compose_safety,
  CASE
    WHEN m.deleted_at IS NULL THEN NULL
    ELSE (extract(epoch FROM m.deleted_at) * 1000000)::bigint::text
  END AS deleted_cursor_us,
  m.created_at, m.updated_at
`;

const deletedMailboxCursorSchema = z
  .object({ version: z.literal(2), deletedAtMicros: z.string().regex(/^\d+$/), id: z.string().uuid() })
  .strict();
type DeletedMailboxCursor = z.infer<typeof deletedMailboxCursorSchema>;

const decodeDeletedMailboxCursor = (value?: string): Result<DeletedMailboxCursor | null> => {
  if (!value) return ok(null);
  try {
    const parsed = deletedMailboxCursorSchema.safeParse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    return parsed.success ? ok(parsed.data) : fail(err.badInput("Invalid deleted mailbox cursor"));
  } catch {
    return fail(err.badInput("Invalid deleted mailbox cursor"));
  }
};

const deletedMailboxPage = (rows: DbMailbox[], limit: number): DeletedMailboxPage => {
  const pageRows = rows.slice(0, limit);
  const last = pageRows.at(-1);
  return {
    items: pageRows.map((row) => ({ ...mapDeletedMailbox(row), permission: "admin" })),
    nextCursor:
      rows.length > limit && last
        ? Buffer.from(
            JSON.stringify({
              version: 2,
              deletedAtMicros: last.deleted_cursor_us,
              id: last.id,
            }),
          ).toString("base64url")
        : null,
  };
};

const recordMailboxLifecycleActivity = async (params: {
  db: typeof sql;
  context: MailRequestContext;
  mailboxId: string;
  action: "mailbox.deleted" | "mailbox.restored";
  metadata: Record<string, unknown>;
}): Promise<string> => {
  const actor = actorRefFromRequest(params.context);
  const [activity] = await params.db<{ id: string | number }[]>`
    INSERT INTO mail.activity_events (
      mailbox_id, actor_kind, actor_id, action, outcome, target_type, target_id, metadata
    ) VALUES (
      ${params.mailboxId}::uuid,
      ${actor.kind},
      ${actor.kind === "user" ? actor.userId : actor.kind === "service_account" ? actor.serviceAccountId : null}::uuid,
      ${params.action},
      'confirmed',
      'mailbox',
      ${params.mailboxId}::uuid,
      ${params.metadata}::jsonb
    )
    RETURNING id
  `;
  if (!activity) throw new Error("Mailbox lifecycle activity insert returned no row");
  return String(activity.id);
};

const listMailboxRemoteResourceIds = async (mailboxId: string, db: typeof sql = sql): Promise<string[]> => {
  const rows = await db<{ id: string }[]>`
    SELECT id
    FROM mail.remote_resources
    WHERE mailbox_id = ${mailboxId}::uuid
    ORDER BY id
  `;
  return rows.map((row) => row.id);
};

export const createMailbox = async (context: MailRequestContext, input: CreateMailboxInput): Promise<Result<Mailbox>> => {
  const owner = userBackedActor(context);
  if (!owner) return fail(err.forbidden("Creating a mailbox requires a user-backed actor"));

  const actorRef = actorRefFromRequest(context);
  return tryCatch(
    () =>
      sql.begin(async (tx) => {
        const rows = await withShortIdDb(
          tx,
          "mailbox",
          (db, shortId) => db<DbMailbox[]>`
          INSERT INTO mail.mailboxes (
            short_id,
            name,
            description,
            created_by_user_id,
            created_by_service_account_id
          )
          VALUES (
            ${shortId},
            ${input.name.trim()},
            ${input.description?.trim() || null},
            ${owner.id}::uuid,
            ${context.actor.kind === "service_account" ? context.actor.serviceAccount.id : null}::uuid
          )
          RETURNING id, name, description, health, health_reason, sync_enabled, search_backend,
            automatic_reply_management_permission, compose_safety, deleted_at, created_at, updated_at
        `,
        );
        const [row] = rows;
        if (!row) throw new Error("Mailbox insert returned no row");

        await tx`INSERT INTO mail.compose_styles (mailbox_id) VALUES (${row.id}::uuid)`;
        const access = unwrap(await createAccess({ principal: { type: "user", userId: owner.id }, permission: "admin" }, tx));
        await tx`
          INSERT INTO mail.mailbox_access (mailbox_id, access_id)
          VALUES (${row.id}::uuid, ${access.id}::uuid)
        `;
        await tx`
          INSERT INTO mail.activity_events (
            mailbox_id, actor_kind, actor_id, action, outcome, target_type, target_id, metadata
          )
          VALUES (
            ${row.id}::uuid,
            ${actorRef.kind},
            ${actorRef.kind === "user" ? actorRef.userId : actorRef.kind === "service_account" ? actorRef.serviceAccountId : null}::uuid,
            'mailbox.created',
            'confirmed',
            'mailbox',
            ${row.id}::uuid,
            '{}'::jsonb
          )
        `;
        await audit.record(
          {
            action: "mail.mailbox.create",
            outcome: "allowed",
            actor: auditActorFromRequest(context),
            target: { type: "mailbox", id: row.id, label: row.name },
            requestId: context.requestId,
            metadata: {},
          },
          tx,
        );
        return mapMailbox(row);
      }),
    () => err.internal("Failed to create mailbox"),
  );
};

export const getMailbox = async (context: MailRequestContext, mailboxId: string): Promise<Result<Mailbox>> => {
  const allowed = await requireMailboxPermission(context, mailboxId, "read");
  if (!allowed.ok) return allowed;
  const [row] = await sql<DbMailbox[]>`
    SELECT ${mailboxColumns}
    FROM mail.mailboxes m
    WHERE m.id = ${mailboxId}::uuid AND m.deleted_at IS NULL
  `;
  return row ? ok(mapMailbox(row)) : fail(err.notFound("Mailbox"));
};

export const getDeletedMailbox = async (context: MailRequestContext, mailboxId: string): Promise<Result<DeletedMailbox>> => {
  const allowed = await requireMailboxLifecycleAdmin(context, mailboxId);
  if (!allowed.ok) return allowed;
  const [row] = await sql<DbMailbox[]>`
    SELECT ${mailboxColumns}
    FROM mail.mailboxes m
    WHERE m.id = ${mailboxId}::uuid AND m.deleted_at IS NOT NULL
  `;
  return row ? ok(mapDeletedMailbox(row)) : fail(err.notFound("Deleted mailbox"));
};

export const listDeletedMailboxes = async (
  context: MailRequestContext,
  params: { limit?: number; cursor?: string } = {},
): Promise<Result<DeletedMailboxPage>> => {
  const boundedLimit = Math.min(Math.max(Math.floor(params.limit ?? 100), 1), 200);
  const cursor = decodeDeletedMailboxCursor(params.cursor);
  if (!cursor.ok) return cursor;
  if (!(await isCurrentActorActive(context)) || capByCredentialScopes(context, "admin") !== "admin") {
    return ok({ items: [], nextCursor: null });
  }
  if (context.actor.kind === "service_account" && context.actor.serviceAccount.kind === "resource_bound") {
    const mailboxId = context.actor.serviceAccount.resourceId;
    if (!mailboxId || !isResourceBoundToMailbox(context, mailboxId) || cursor.data) return ok({ items: [], nextCursor: null });
    const mailbox = await getDeletedMailbox(context, mailboxId);
    return mailbox.ok ? ok({ items: [{ ...mailbox.data, permission: "admin" }], nextCursor: null }) : ok({ items: [], nextCursor: null });
  }

  if (await isCurrentPlatformAdmin(context)) {
    const rows = await sql<DbMailbox[]>`
      SELECT ${mailboxColumns}
      FROM mail.mailboxes m
      WHERE m.deleted_at IS NOT NULL
        AND (
          ${cursor.data?.id ?? null}::uuid IS NULL
          OR (
            (extract(epoch FROM m.deleted_at) * 1000000)::bigint,
            m.id
          ) < (${cursor.data?.deletedAtMicros ?? null}::bigint, ${cursor.data?.id ?? null}::uuid)
        )
      ORDER BY m.deleted_at DESC, m.id DESC
      LIMIT ${boundedLimit + 1}
    `;
    return ok(deletedMailboxPage(rows, boundedLimit));
  }

  const rows = await sql<DbMailbox[]>`
    SELECT DISTINCT ${mailboxColumns}
    FROM mail.mailboxes m
    JOIN mail.mailbox_access ma ON ma.mailbox_id = m.id
    JOIN auth.access a ON a.id = ma.access_id
    WHERE m.deleted_at IS NOT NULL
      AND a.permission = 'admin'
      AND (
        ${cursor.data?.id ?? null}::uuid IS NULL
        OR (
          (extract(epoch FROM m.deleted_at) * 1000000)::bigint,
          m.id
        ) < (${cursor.data?.deletedAtMicros ?? null}::bigint, ${cursor.data?.id ?? null}::uuid)
      )
      AND ${mailboxAccessPrincipalCondition(context.accessSubject)}
    ORDER BY m.deleted_at DESC, m.id DESC
    LIMIT ${boundedLimit + 1}
  `;
  return ok(deletedMailboxPage(rows, boundedLimit));
};

export const listMailboxes = async (
  context: MailRequestContext,
  limit = 100,
  exactName?: string,
  search?: string,
  minimumPermission: Exclude<PermissionLevel, "none"> = "read",
  page?: { afterId?: string },
): Promise<Result<MailboxListItem[]>> => {
  const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 200);
  if (page?.afterId && !z.uuid().safeParse(page.afterId).success) return fail(err.badInput("Invalid cursor"));
  const normalizedExactName = exactName?.trim() || null;
  const normalizedSearch = search?.trim() || null;
  if (context.actor.kind === "service_account" && context.actor.serviceAccount.kind === "resource_bound") {
    const mailboxId = context.actor.serviceAccount.resourceId;
    if (!mailboxId || !isResourceBoundToMailbox(context, mailboxId)) return ok([]);
    if (page?.afterId && mailboxId <= page.afterId) return ok([]);
    const mailbox = await getMailbox(context, mailboxId);
    if (!mailbox.ok) return mailbox.error.code === "FORBIDDEN" || mailbox.error.code === "NOT_FOUND" ? ok([]) : mailbox;
    const receivingAddress = await getMailboxReceivingAddress(mailboxId);
    if (normalizedExactName && mailbox.data.name !== normalizedExactName) return ok([]);
    if (
      normalizedSearch &&
      !`${mailbox.data.name} ${mailbox.data.description ?? ""} ${receivingAddress ?? ""}`
        .toLowerCase()
        .includes(normalizedSearch.toLowerCase())
    ) {
      return ok([]);
    }
    const permission = await getMailboxPermission(context, mailboxId);
    const permissionRank = { none: 0, read: 1, write: 2, admin: 3 } as const;
    return permissionRank[permission] < permissionRank[minimumPermission]
      ? ok([])
      : ok([{ ...mailbox.data, permission, receivingAddress }]);
  }

  const minimumPermissionRank = { read: 1, write: 2, admin: 3 }[minimumPermission];
  if (capByCredentialScopes(context, minimumPermission) !== minimumPermission) return ok([]);

  const rows = await sql<DbMailboxListItem[]>`
    WITH ranked AS (
      SELECT
        ma.mailbox_id,
        max(CASE a.permission WHEN 'admin' THEN 3 WHEN 'write' THEN 2 WHEN 'read' THEN 1 ELSE 0 END) AS permission_rank
      FROM mail.mailbox_access ma
      JOIN auth.access a ON a.id = ma.access_id
      WHERE ${mailboxAccessPrincipalCondition(context.accessSubject)}
      GROUP BY ma.mailbox_id
    )
    SELECT
      ${mailboxColumns},
      CASE ranked.permission_rank WHEN 3 THEN 'admin'::auth.permission_level WHEN 2 THEN 'write'::auth.permission_level ELSE 'read'::auth.permission_level END AS permission,
      pc.email AS receiving_address
    FROM mail.mailboxes m
    JOIN ranked ON ranked.mailbox_id = m.id AND ranked.permission_rank >= ${minimumPermissionRank}
    LEFT JOIN mail.provider_connections pc ON pc.owner_mailbox_id = m.id AND pc.status <> 'revoked'
    WHERE m.deleted_at IS NULL
      AND (${page?.afterId ?? null}::uuid IS NULL OR m.id > ${page?.afterId ?? null}::uuid)
      AND (${normalizedExactName}::text IS NULL OR m.name = ${normalizedExactName})
      AND (
        ${normalizedSearch}::text IS NULL
        OR strpos(lower(m.name), lower(${normalizedSearch})) > 0
        OR strpos(lower(coalesce(m.description, '')), lower(${normalizedSearch})) > 0
        OR strpos(lower(coalesce(pc.email, '')), lower(${normalizedSearch})) > 0
      )
    ORDER BY ${page ? sql`m.id ASC` : sql`m.updated_at DESC, m.id DESC`}
    LIMIT ${boundedLimit}
  `;

  return ok(
    rows
      .map((row) => ({
        ...mapMailbox(row),
        permission: capByCredentialScopes(context, row.permission),
        receivingAddress: row.receiving_address,
      }))
      .filter((row) => {
        const permissionRank = { none: 0, read: 1, write: 2, admin: 3 } as const;
        return permissionRank[row.permission] >= permissionRank[minimumPermission];
      }),
  );
};

export const updateMailbox = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  name?: string;
  description?: string | null;
  syncEnabled?: boolean;
  searchBackend?: Mailbox["searchBackend"];
  automaticReplyManagementPermission?: Mailbox["automaticReplyManagementPermission"];
  composeSafety?: Mailbox["composeSafety"];
}): Promise<Result<Mailbox>> => {
  const name = params.name?.trim();
  if (name !== undefined && (name.length < 1 || name.length > 160)) return fail(err.badInput("Mailbox name is invalid"));
  const description = params.description?.trim() || null;
  if (description && description.length > 2_000) return fail(err.badInput("Mailbox description is too long"));
  const composeSafety = params.composeSafety === undefined ? null : composeSafetyConfigSchema.safeParse(params.composeSafety);
  if (composeSafety && !composeSafety.success) {
    return fail(err.badInput(composeSafety.error.issues[0]?.message ?? "Composer safety settings are invalid"));
  }

  return tryCatch(
    () =>
      sql.begin(async (tx) => {
        const [locked] = await tx<{ id: string }[]>`
          SELECT id FROM mail.mailboxes WHERE id = ${params.mailboxId}::uuid AND deleted_at IS NULL FOR UPDATE
        `;
        if (!locked) unwrap(fail(err.notFound("Mailbox")));
        unwrap(await requireMailboxPermission(params.context, params.mailboxId, "admin", tx));
        if (composeSafety) {
          unwrap(
            await validateDestructiveIncomingAutomationsForMailbox({
              mailboxId: params.mailboxId,
              internalDomains: composeSafety.data.internalDomains,
              db: tx,
            }),
          );
        }
        const [row] = await tx<DbMailbox[]>`
          UPDATE mail.mailboxes
          SET
            name = COALESCE(${name ?? null}, name),
            description = CASE WHEN ${params.description !== undefined} THEN ${description} ELSE description END,
            sync_enabled = COALESCE(${params.syncEnabled ?? null}, sync_enabled),
            search_backend = COALESCE(${params.searchBackend ?? null}, search_backend),
            automatic_reply_management_permission = COALESCE(
              ${params.automaticReplyManagementPermission ?? null},
              automatic_reply_management_permission
            ),
            compose_safety = COALESCE(${composeSafety?.data ?? null}::jsonb, compose_safety),
            health = CASE
              WHEN ${params.syncEnabled === false} THEN 'paused'
              WHEN ${params.syncEnabled === true} AND health = 'paused' THEN 'bootstrapping'
              ELSE health
            END,
            health_reason = CASE
              WHEN ${params.syncEnabled === false} THEN 'Synchronization paused by a mailbox administrator'
              WHEN ${params.syncEnabled === true} AND health = 'paused' THEN 'Synchronization resumed; provider reconciliation pending'
              ELSE health_reason
            END
          WHERE id = ${params.mailboxId}::uuid
          RETURNING id, name, description, health, health_reason, sync_enabled, search_backend,
            automatic_reply_management_permission, compose_safety, deleted_at, created_at, updated_at
        `;
        if (!row) throw new Error("Mailbox update returned no row");
        await audit.record(
          {
            action: "mail.mailbox.update",
            outcome: "allowed",
            actor: auditActorFromRequest(params.context),
            target: { type: "mailbox", id: params.mailboxId, label: row.name },
            requestId: params.context.requestId,
            metadata: { changed: Object.keys(params).filter((key) => key !== "context" && key !== "mailboxId") },
          },
          tx,
        );
        return mapMailbox(row);
      }),
    () => err.internal("Failed to update mailbox"),
  );
};

export const deleteMailbox = async (context: MailRequestContext, mailboxId: string): Promise<Result<void>> => {
  const allowed = await requireMailboxLifecycleAdmin(context, mailboxId);
  if (!allowed.ok) return allowed;
  const resourceIds = await listMailboxRemoteResourceIds(mailboxId);

  let transitioned = false;
  let activityId: string | null = null;
  const result = await tryCatch(
    async () => {
      const barrier = await withMailboxProviderOperationBarrier(mailboxId, resourceIds, async (assertLeaseActive) => {
        await sql.begin(async (tx) => {
          const [row] = await tx<{ id: string; name: string; deleted_at: Date | string | null }[]>`
            SELECT id, name, deleted_at FROM mail.mailboxes WHERE id = ${mailboxId}::uuid FOR UPDATE
          `;
          if (!row) {
            const notFound = err.notFound("Mailbox");
            throw Object.assign(new Error(notFound.message), notFound);
          }
          unwrap(await requireMailboxLifecycleAdmin(context, mailboxId, tx));
          if (row.deleted_at) return;
          const currentResourceIds = await listMailboxRemoteResourceIds(mailboxId, tx);
          if (currentResourceIds.length !== resourceIds.length || currentResourceIds.some((id, index) => id !== resourceIds[index])) {
            const conflict = err.conflict("Mailbox provider bindings changed during deletion; retry the operation");
            throw Object.assign(new Error(conflict.message), conflict);
          }
          await tx`
            UPDATE mail.mailboxes
            SET
              deleted_at = now(),
              sync_enabled = false,
              health = 'paused',
              health_reason = 'Mailbox deleted; provider transport and execution are paused',
              updated_at = now()
            WHERE id = ${mailboxId}::uuid
          `;
          await tx`
            UPDATE mail.attachment_links
            SET revoked_at = COALESCE(revoked_at, now())
            WHERE mailbox_id = ${mailboxId}::uuid
          `;
          await tx`
            DELETE FROM mail.attachment_link_grants AS link_grant
            USING mail.attachment_links link
            WHERE link_grant.link_id = link.id
              AND link.mailbox_id = ${mailboxId}::uuid
          `;
          transitioned = true;
          const execution = await pauseDeletedMailboxExecution(mailboxId, tx);
          activityId = await recordMailboxLifecycleActivity({
            db: tx,
            context,
            mailboxId,
            action: "mailbox.deleted",
            metadata: { execution },
          });
          await audit.record(
            {
              action: "mail.mailbox.delete",
              outcome: "allowed",
              actor: auditActorFromRequest(context),
              target: { type: "mailbox", id: mailboxId, label: row.name },
              requestId: context.requestId,
              metadata: { execution },
            },
            tx,
          );
          await assertLeaseActive();
        });
      });
      if (!barrier.acquired) {
        const conflict = err.conflict("Mailbox provider work is still running; retry deletion shortly");
        throw Object.assign(new Error(conflict.message), conflict);
      }
    },
    () => err.internal("Failed to delete mailbox"),
  );
  if (result.ok && transitioned && activityId) {
    await publishMailMailboxEvent({
      mailboxId,
      conversationId: null,
      reason: "deleted",
      targetId: null,
      activityId,
    });
  }
  return result;
};

export const restoreMailbox = async (context: MailRequestContext, mailboxId: string): Promise<Result<Mailbox>> => {
  let transitioned = false;
  let activityId: string | null = null;
  const result = await tryCatch(
    () =>
      sql.begin(async (tx) => {
        const [current] = await tx<DbMailbox[]>`
          SELECT ${mailboxColumns}
          FROM mail.mailboxes m
          WHERE m.id = ${mailboxId}::uuid
          FOR UPDATE OF m
        `;
        if (!current) {
          const notFound = err.notFound("Mailbox");
          throw Object.assign(new Error(notFound.message), notFound);
        }
        unwrap(await requireMailboxLifecycleAdmin(context, mailboxId, tx));
        if (!current.deleted_at) return mapMailbox(current);

        await pauseMailboxTransport({
          mailboxId,
          code: "MAILBOX_RESTORED_PAUSED",
          message: "Mailbox was restored; provider diagnostics and explicit synchronization resume are required",
          db: tx,
        });
        const [restored] = await tx<DbMailbox[]>`
          UPDATE mail.mailboxes
          SET
            deleted_at = NULL,
            sync_enabled = false,
            health = 'paused',
            health_reason = 'Mailbox restored; provider diagnostics are required before synchronization can resume',
            updated_at = now()
          WHERE id = ${mailboxId}::uuid AND deleted_at IS NOT NULL
          RETURNING id, name, description, health, health_reason, sync_enabled, search_backend,
            automatic_reply_management_permission, deleted_at, created_at, updated_at
        `;
        if (!restored) throw new Error("Mailbox restore returned no row");
        transitioned = true;
        const deletedAt = toIso(current.deleted_at);
        activityId = await recordMailboxLifecycleActivity({
          db: tx,
          context,
          mailboxId,
          action: "mailbox.restored",
          metadata: { deletedAt, syncEnabled: false, providerDiagnosticsRequired: true },
        });
        await audit.record(
          {
            action: "mail.mailbox.restore",
            outcome: "allowed",
            actor: auditActorFromRequest(context),
            target: { type: "mailbox", id: mailboxId, label: restored.name },
            requestId: context.requestId,
            metadata: { deletedAt, syncEnabled: false, providerDiagnosticsRequired: true },
          },
          tx,
        );
        return mapMailbox(restored);
      }),
    () => err.internal("Failed to restore mailbox"),
  );
  if (result.ok && transitioned && activityId) {
    await publishMailMailboxEvent({
      mailboxId,
      conversationId: null,
      reason: "restored",
      targetId: null,
      activityId,
    });
  }
  return result;
};
