import { audit } from "@k2b/cloud/services";
import { err, fail, isServiceError, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import { z } from "zod";
import { type ConfigurableFolderRole, configurableFolderRoleSchema, type FolderRole } from "../contracts";
import { requireMailboxPermission } from "./access";
import { actorRefFromRequest, auditActorFromRequest, type MailRequestContext } from "./auth";
import { publishMailMailboxEvent } from "./events";
import { listFolders, type MailFolderView } from "./messages";

type SqlClient = typeof sql;

export type ResolvedRoleFolder = {
  id: string;
  role: ConfigurableFolderRole | "inbox";
  providerRole: FolderRole;
  configured: boolean;
};

export type MailAdminFolderView = MailFolderView & {
  subscribed: boolean | null;
  rightsSource: "acl" | "select" | "probe" | "unknown" | null;
  effectiveRights: string[];
  canCreateChildren: boolean;
  canRename: boolean;
  canDelete: boolean;
  canManageSubscription: boolean;
};

type DbFolderProviderState = {
  folder_id: string;
  delimiter: string | null;
  namespace_kind: "personal" | "other_users" | "shared" | null;
  subscribed: boolean;
  effective_rights: string[];
  rights_source: "acl" | "select" | "probe" | "unknown";
};

const allowsProviderFolderOperation = (provider: DbFolderProviderState, right: "create_children" | "delete_folder"): boolean => {
  if (provider.rights_source === "acl") return provider.effective_rights.includes(right);
  // Shared namespaces without ACL evidence are intentionally fail-closed in the UI.
  // The command runtime still rechecks authoritative provider state before every effect.
  return provider.namespace_kind === "personal";
};

export const listAdminFolders = async (context: MailRequestContext, mailboxId: string): Promise<Result<MailAdminFolderView[]>> => {
  const permission = await requireMailboxPermission(context, mailboxId, "admin");
  if (!permission.ok) return permission;
  const folderResult = await listFolders(context, mailboxId);
  if (!folderResult.ok) return folderResult;
  const providerRows = await sql<DbFolderProviderState[]>`
    SELECT
      ref.folder_id,
      ref.delimiter,
      ref.namespace_kind,
      ref.subscribed,
      ref.effective_rights,
      ref.rights_source
    FROM mail.binding_folder_refs ref
    JOIN mail.provider_bindings binding ON binding.id = ref.binding_id
    JOIN mail.remote_resources resource ON resource.id = binding.remote_resource_id
    WHERE resource.mailbox_id = ${mailboxId}::uuid
      AND binding.state <> 'revoked'
      AND ref.missing_since IS NULL
  `;
  const providerByFolder = new Map(providerRows.map((row) => [row.folder_id, row]));
  return ok(
    folderResult.data.map((folder) => {
      const provider = providerByFolder.get(folder.id) ?? null;
      const parentProvider = folder.parentId ? (providerByFolder.get(folder.parentId) ?? null) : null;
      const active = folder.discoveryState === "active" && provider !== null;
      const canDeleteAtProvider = Boolean(provider && allowsProviderFolderOperation(provider, "delete_folder"));
      const canCreateAtParent = folder.parentId
        ? Boolean(parentProvider && allowsProviderFolderOperation(parentProvider, "create_children"))
        : provider?.namespace_kind === "personal";
      const protectedFolder = ["inbox", "all"].includes(folder.providerRole);
      return {
        ...folder,
        subscribed: provider?.subscribed ?? null,
        rightsSource: provider?.rights_source ?? null,
        effectiveRights: provider?.effective_rights ?? [],
        canCreateChildren: Boolean(active && provider?.delimiter && allowsProviderFolderOperation(provider, "create_children")),
        canRename: active && !protectedFolder && canDeleteAtProvider && canCreateAtParent,
        canDelete: active && folder.selectable && !protectedFolder && canDeleteAtProvider,
        canManageSubscription: active,
      };
    }),
  );
};

export const setFolderSidebarVisibility = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  folderId: string;
  showInSidebar: boolean;
}): Promise<Result<{ folderId: string; showInSidebar: boolean }>> => {
  const actor = actorRefFromRequest(params.context);
  let activityId: string | null = null;
  try {
    const result = await sql.begin(async (tx) => {
      const permission = await requireMailboxPermission(params.context, params.mailboxId, "admin", tx);
      if (!permission.ok) return permission;
      const [folder] = await tx<{ id: string }[]>`
        UPDATE mail.folders folder
        SET
          show_in_sidebar = ${params.showInSidebar},
          updated_at = CASE
            WHEN folder.show_in_sidebar <> ${params.showInSidebar} THEN now()
            ELSE folder.updated_at
          END
        FROM mail.remote_resources resource
        WHERE folder.id = ${params.folderId}::uuid
          AND resource.id = folder.remote_resource_id
          AND resource.mailbox_id = ${params.mailboxId}::uuid
          AND folder.discovery_state = 'active'
        RETURNING folder.id
      `;
      if (!folder) return fail(err.notFound("Mail folder"));
      const [activity] = await tx<{ id: string }[]>`
        INSERT INTO mail.activity_events (
          mailbox_id, actor_kind, actor_id, action, outcome, target_type, target_id, metadata
        ) VALUES (
          ${params.mailboxId}::uuid,
          ${actor.kind},
          ${actor.kind === "user" ? actor.userId : actor.kind === "service_account" ? actor.serviceAccountId : null}::uuid,
          'folder.sidebar_visibility_changed',
          'confirmed',
          'folder',
          ${folder.id}::uuid,
          ${{ showInSidebar: params.showInSidebar }}::jsonb
        )
        RETURNING id
      `;
      if (!activity) throw new Error("Folder visibility activity insert returned no row");
      activityId = String(activity.id);
      await audit.record(
        {
          action: "mail.folder.sidebar_visibility.change",
          outcome: "allowed",
          actor: auditActorFromRequest(params.context),
          target: { type: "mailbox", id: params.mailboxId },
          requestId: params.context.requestId,
          metadata: { folderId: folder.id, showInSidebar: params.showInSidebar },
        },
        tx,
      );
      return ok({ folderId: folder.id, showInSidebar: params.showInSidebar });
    });
    if (result.ok && activityId) {
      await publishMailMailboxEvent({
        mailboxId: params.mailboxId,
        conversationId: null,
        reason: "folder",
        targetId: params.folderId,
        activityId,
      });
    }
    return result;
  } catch (error) {
    if (isServiceError(error)) return fail(error);
    return fail(err.internal("Failed to update folder visibility"));
  }
};

export const dismissUnavailableFolder = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  folderId: string;
}): Promise<Result<{ folderId: string; dismissedFolderCount: number }>> => {
  const actor = actorRefFromRequest(params.context);
  let activityId: string | null = null;
  try {
    const result = await sql.begin(async (tx) => {
      const permission = await requireMailboxPermission(params.context, params.mailboxId, "admin", tx);
      if (!permission.ok) return permission;

      const subtree = await tx<
        {
          id: string;
          discovery_state: "active" | "ambiguous" | "missing";
          has_active_provider_ref: boolean;
        }[]
      >`
        WITH RECURSIVE folder_subtree AS (
          SELECT folder.id
          FROM mail.folders folder
          JOIN mail.remote_resources resource ON resource.id = folder.remote_resource_id
          WHERE folder.id = ${params.folderId}::uuid
            AND resource.mailbox_id = ${params.mailboxId}::uuid

          UNION ALL

          SELECT child.id
          FROM mail.folders child
          JOIN folder_subtree parent ON child.parent_id = parent.id
          JOIN mail.remote_resources child_resource ON child_resource.id = child.remote_resource_id
          WHERE child_resource.mailbox_id = ${params.mailboxId}::uuid
        )
        SELECT
          folder.id,
          folder.discovery_state,
          EXISTS (
            SELECT 1
            FROM mail.binding_folder_refs ref
            JOIN mail.provider_bindings binding ON binding.id = ref.binding_id
            WHERE ref.folder_id = folder.id
              AND ref.missing_since IS NULL
              AND binding.state <> 'revoked'
          ) AS has_active_provider_ref
        FROM mail.folders folder
        JOIN folder_subtree subtree ON subtree.id = folder.id
        ORDER BY folder.id
        FOR UPDATE OF folder
      `;
      if (subtree.length === 0) return fail(err.notFound("Mail folder"));
      if (subtree.some((folder) => folder.discovery_state !== "missing" || folder.has_active_provider_ref)) {
        return fail(err.conflict("Only unavailable folders can be removed from Mail"));
      }

      const folderIds = subtree.map((folder) => folder.id);
      await tx`
        UPDATE mail.folders
        SET dismissed_at = now(), updated_at = now()
        WHERE id IN (
          SELECT value::uuid
          FROM jsonb_array_elements_text(${folderIds}::jsonb)
        )
      `;
      const [activity] = await tx<{ id: string }[]>`
        INSERT INTO mail.activity_events (
          mailbox_id, actor_kind, actor_id, action, outcome, target_type, target_id, metadata
        ) VALUES (
          ${params.mailboxId}::uuid,
          ${actor.kind},
          ${actor.kind === "user" ? actor.userId : actor.kind === "service_account" ? actor.serviceAccountId : null}::uuid,
          'folder.unavailable_projection_dismissed',
          'confirmed',
          'folder',
          ${params.folderId}::uuid,
          ${{ dismissedFolderCount: folderIds.length }}::jsonb
        )
        RETURNING id
      `;
      if (!activity) throw new Error("Folder dismissal activity insert returned no row");
      activityId = String(activity.id);
      await audit.record(
        {
          action: "mail.folder.unavailable_projection.dismiss",
          outcome: "allowed",
          actor: auditActorFromRequest(params.context),
          target: { type: "mailbox", id: params.mailboxId },
          requestId: params.context.requestId,
          metadata: { folderId: params.folderId, dismissedFolderCount: folderIds.length },
        },
        tx,
      );
      return ok({ folderId: params.folderId, dismissedFolderCount: folderIds.length });
    });
    if (result.ok && activityId) {
      await publishMailMailboxEvent({
        mailboxId: params.mailboxId,
        conversationId: null,
        reason: "folder",
        targetId: params.folderId,
        activityId,
      });
    }
    return result;
  } catch (error) {
    if (isServiceError(error)) return fail(error);
    return fail(err.internal("Failed to remove unavailable folder from Mail"));
  }
};

export const resolveRoleFolder = async (
  mailboxId: string,
  role: ConfigurableFolderRole | "inbox",
  db: SqlClient = sql,
): Promise<Result<ResolvedRoleFolder>> => {
  const parsedRole = z.union([configurableFolderRoleSchema, z.literal("inbox")]).safeParse(role);
  if (!parsedRole.success) return fail(err.badInput("Unsupported configurable folder role"));
  const rows = await db<{ id: string; provider_role: FolderRole; configured: boolean }[]>`
    WITH configured AS (
      SELECT override.folder_id
      FROM mail.folder_role_overrides override
      WHERE override.mailbox_id = ${mailboxId}::uuid AND override.role = ${parsedRole.data}
    )
    SELECT
      folder.id,
      folder.role AS provider_role,
      configured.folder_id IS NOT NULL AS configured
    FROM mail.folders folder
    JOIN mail.remote_resources resource ON resource.id = folder.remote_resource_id
    LEFT JOIN configured ON configured.folder_id = folder.id
    WHERE resource.mailbox_id = ${mailboxId}::uuid
      AND folder.discovery_state = 'active'
      AND folder.selectable
      AND (configured.folder_id IS NOT NULL OR folder.role = ${parsedRole.data})
    ORDER BY configured DESC, folder.id
  `;
  const configured = rows.find((row) => row.configured);
  if (configured) return ok({ id: configured.id, role: parsedRole.data, providerRole: configured.provider_role, configured: true });
  if (rows.length === 1) {
    const folder = rows[0]!;
    return ok({ id: folder.id, role: parsedRole.data, providerRole: folder.provider_role, configured: false });
  }
  return rows.length === 0
    ? fail(err.badInput(`No ${parsedRole.data} folder is configured`))
    : fail(err.conflict(`Several provider folders claim the ${parsedRole.data} role; configure one explicitly`));
};

export const setFolderRole = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  folderId: string;
  role: ConfigurableFolderRole;
}): Promise<Result<ResolvedRoleFolder>> => {
  const parsedRole = configurableFolderRoleSchema.safeParse(params.role);
  if (!parsedRole.success) return fail(err.badInput("Unsupported configurable folder role"));
  const actor = actorRefFromRequest(params.context);
  try {
    return await sql.begin(async (tx) => {
      const permission = await requireMailboxPermission(params.context, params.mailboxId, "admin", tx);
      if (!permission.ok) return permission;
      const [folder] = await tx<{ id: string; provider_role: FolderRole }[]>`
        SELECT folder.id, folder.role AS provider_role
        FROM mail.folders folder
        JOIN mail.remote_resources resource ON resource.id = folder.remote_resource_id
        WHERE folder.id = ${params.folderId}::uuid
          AND resource.mailbox_id = ${params.mailboxId}::uuid
          AND folder.discovery_state = 'active'
          AND folder.selectable
        FOR UPDATE OF folder
      `;
      if (!folder) return fail(err.notFound("Mail folder"));
      await tx`DELETE FROM mail.folder_role_overrides WHERE mailbox_id = ${params.mailboxId}::uuid AND folder_id = ${params.folderId}::uuid`;
      await tx`
        INSERT INTO mail.folder_role_overrides (mailbox_id, role, folder_id)
        VALUES (${params.mailboxId}::uuid, ${parsedRole.data}, ${params.folderId}::uuid)
        ON CONFLICT (mailbox_id, role) DO UPDATE SET folder_id = EXCLUDED.folder_id, updated_at = now()
      `;
      await tx`
        INSERT INTO mail.activity_events (
          mailbox_id, actor_kind, actor_id, action, outcome, target_type, target_id, metadata
        ) VALUES (
          ${params.mailboxId}::uuid,
          ${actor.kind},
          ${actor.kind === "user" ? actor.userId : actor.kind === "service_account" ? actor.serviceAccountId : null}::uuid,
          'folder.role_configured',
          'confirmed',
          'folder',
          ${params.folderId}::uuid,
          ${{ role: parsedRole.data }}::jsonb
        )
      `;
      await audit.record(
        {
          action: "mail.folder.role.configure",
          outcome: "allowed",
          actor: auditActorFromRequest(params.context),
          target: { type: "mailbox", id: params.mailboxId },
          requestId: params.context.requestId,
          metadata: { folderId: params.folderId, role: parsedRole.data },
        },
        tx,
      );
      return ok({ id: folder.id, role: parsedRole.data, providerRole: folder.provider_role, configured: true });
    });
  } catch (error) {
    if (isServiceError(error)) return fail(error);
    return fail(err.internal("Failed to configure folder role"));
  }
};

export const clearFolderRole = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  role: ConfigurableFolderRole;
}): Promise<Result<void>> => {
  const parsedRole = configurableFolderRoleSchema.safeParse(params.role);
  if (!parsedRole.success) return fail(err.badInput("Unsupported configurable folder role"));
  const actor = actorRefFromRequest(params.context);
  try {
    return await sql.begin(async (tx) => {
      const permission = await requireMailboxPermission(params.context, params.mailboxId, "admin", tx);
      if (!permission.ok) return permission;
      const [removed] = await tx<{ folder_id: string }[]>`
        DELETE FROM mail.folder_role_overrides
        WHERE mailbox_id = ${params.mailboxId}::uuid AND role = ${parsedRole.data}
        RETURNING folder_id
      `;
      if (removed) {
        await tx`
          INSERT INTO mail.activity_events (
            mailbox_id, actor_kind, actor_id, action, outcome, target_type, target_id, metadata
          ) VALUES (
            ${params.mailboxId}::uuid,
            ${actor.kind},
            ${actor.kind === "user" ? actor.userId : actor.kind === "service_account" ? actor.serviceAccountId : null}::uuid,
            'folder.role_cleared',
            'confirmed',
            'folder',
            ${removed.folder_id}::uuid,
            ${{ role: parsedRole.data }}::jsonb
          )
        `;
      }
      await audit.record(
        {
          action: "mail.folder.role.clear",
          outcome: "allowed",
          actor: auditActorFromRequest(params.context),
          target: { type: "mailbox", id: params.mailboxId },
          requestId: params.context.requestId,
          metadata: { role: parsedRole.data, folderId: removed?.folder_id ?? null, changed: Boolean(removed) },
        },
        tx,
      );
      return ok();
    });
  } catch (error) {
    if (isServiceError(error)) return fail(error);
    return fail(err.internal("Failed to clear folder role"));
  }
};
