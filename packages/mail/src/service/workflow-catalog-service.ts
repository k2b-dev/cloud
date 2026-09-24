import { sql } from "bun";
import { buildMailWorkflowCatalog, type MailWorkflowCatalog } from "../workflows/catalog";
import type { MailRequestContext } from "./auth";
import { listCurrentMailboxUsers } from "./collaborators";
import type { SqlClient } from "./workflow-data";

export const loadMailWorkflowCatalog = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  db?: SqlClient;
}): Promise<MailWorkflowCatalog> => {
  const db = params.db ?? sql;
  const folders = await db<{ id: string; name: string; path: string; role: string }[]>`
      WITH RECURSIVE folder_paths AS (
        SELECT folder.id, folder.name::text AS path
        FROM mail.folders folder
        JOIN mail.remote_resources resource ON resource.id = folder.remote_resource_id
        WHERE resource.mailbox_id = ${params.mailboxId}::uuid AND folder.parent_id IS NULL

        UNION ALL

        SELECT child.id, parent.path || ' / ' || child.name
        FROM mail.folders child
        JOIN folder_paths parent ON child.parent_id = parent.id
      )
      SELECT DISTINCT
        folder.short_id AS id,
        folder.name,
        COALESCE(folder_path.path, folder.name) AS path,
        COALESCE(role_override.role, folder.role) AS role
      FROM mail.folders folder
      JOIN mail.remote_resources resource ON resource.id = folder.remote_resource_id
      JOIN mail.mailboxes mailbox ON mailbox.id = resource.mailbox_id
      LEFT JOIN folder_paths folder_path ON folder_path.id = folder.id
      LEFT JOIN mail.folder_role_overrides role_override
        ON role_override.mailbox_id = mailbox.id AND role_override.folder_id = folder.id
      WHERE mailbox.id = ${params.mailboxId}::uuid
        AND mailbox.deleted_at IS NULL
        AND folder.discovery_state = 'active'
        AND folder.selectable
        AND EXISTS (
          SELECT 1
          FROM mail.binding_folder_refs folder_ref
          JOIN mail.provider_bindings binding ON binding.id = folder_ref.binding_id
          JOIN mail.provider_connections connection ON connection.id = binding.connection_id
          WHERE folder_ref.folder_id = folder.id
            AND 'insert' = ANY(folder_ref.effective_rights)
            AND binding.state = 'active'
            AND binding.verified_scope_fingerprint = resource.scope_fingerprint
            AND binding.verified_secret_revision = connection.secret_revision
            AND connection.status = 'active'
            AND connection.encrypted_secret IS NOT NULL
            AND connection.owner_mailbox_id = mailbox.id
        )
      ORDER BY folder.short_id
    `;
  const senderIdentities = await db<{ id: string; name: string }[]>`
      SELECT short_id AS id, display_name || ' <' || from_address || '>' AS name
      FROM mail.sender_identities
      WHERE mailbox_id = ${params.mailboxId}::uuid
        AND status = 'verified'
        AND automation_policy = 'mailbox'
      ORDER BY short_id
    `;
  const localTags = await db<{ id: string; name: string; color: string }[]>`
      SELECT short_id AS id, name, color
      FROM mail.local_tags
      WHERE mailbox_id = ${params.mailboxId}::uuid
      ORDER BY short_id
    `;
  const assignableUsers = await listCurrentMailboxUsers({
    mailboxId: params.mailboxId,
    minimumPermission: "write",
    limit: 500,
    db,
  });
  const notificationUsers = await listCurrentMailboxUsers({
    mailboxId: params.mailboxId,
    minimumPermission: "read",
    limit: 500,
    db,
  });
  return buildMailWorkflowCatalog({
    folders,
    assignableUsers: assignableUsers.map((user) => ({ id: user.id, name: user.displayName || user.uid })),
    senderIdentities,
    localTags,
    notificationUsers: notificationUsers.map((user) => ({ id: user.id, name: user.displayName || user.uid })),
  });
};
