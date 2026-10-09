import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import type { MailExecutionOperation, SenderAuthenticationPolicy } from "../contracts";
import { type MailboxAccess, requireMailboxAccess, requireMailboxPermission } from "./access";
import type { MailRequestContext } from "./auth";

type SqlClient = typeof sql;

export type BindingCandidate = {
  bindingId: string;
  connectionId: string;
  secretRevision: number;
  folders: Record<string, { path: string; rights: string[] }>;
  identityVerified: boolean;
  savesSentAutomatically: boolean | null;
  lastErrorCode: string | null;
  lastUsedAt: string | null;
};

export type BindingSelectionInput = {
  operation: MailExecutionOperation;
  senderPolicy: SenderAuthenticationPolicy | null;
  senderSentFolderId: string | null;
  folderRequirements: Array<{ folderId: string; rights: string[] }>;
  candidates: BindingCandidate[];
};

export const selectBindingCandidate = (input: BindingSelectionInput): BindingCandidate | null => {
  // Multiple current candidates violate the mailbox-owned connection invariant.
  // Fail closed instead of silently introducing provider failover semantics.
  if (input.candidates.length !== 1) return null;
  const candidates = input.candidates
    .filter(() => input.operation !== "automation" || input.senderPolicy === null || input.senderPolicy.automation === "mailbox")
    .filter(() => input.operation !== "actorSend" || input.senderPolicy !== null)
    .filter((candidate) =>
      input.folderRequirements.every((requirement) => {
        const folder = candidate.folders[requirement.folderId];
        return Boolean(folder && requirement.rights.every((right) => folder.rights.includes(right)));
      }),
    )
    .filter((candidate) => (input.operation === "actorSend" || input.senderPolicy ? candidate.identityVerified : true))
    .filter((candidate) => {
      if (input.operation !== "actorSend") return true;
      if (candidate.savesSentAutomatically === true) return true;
      if (!input.senderSentFolderId) return false;
      return candidate.folders[input.senderSentFolderId]?.rights.includes("insert") ?? false;
    });
  return candidates[0] ?? null;
};

type DbMailboxExecution = {
  health: string;
  health_reason: string | null;
  sync_enabled: boolean;
  remote_resource_id: string | null;
  remote_resource_status: string | null;
  scope_fingerprint: string | null;
};

type DbCandidate = {
  binding_id: string;
  connection_id: string;
  secret_revision: number;
  folder_id: string | null;
  folder_path: string | null;
  effective_rights: string[] | null;
  identity_verified: boolean;
  saves_sent_automatically: boolean | null;
  last_error_code: string | null;
  last_used_at: Date | string | null;
};

export type ResolvedMailExecution = {
  mailboxId: string;
  remoteResourceId: string | null;
  bindingId: string | null;
  connectionId: string | null;
  secretRevision: number | null;
  folders: Record<string, { path: string; rights: string[] }>;
  localOnly: boolean;
  sentDelivery: null | {
    savesSentAutomatically: boolean;
    folderId: string | null;
    path: string | null;
  };
  rightsSnapshot: {
    folders: Record<string, string[]>;
    resolvedAt: string;
  };
  /**
   * What the actor may see, for an actor operation that asked for `conversationScoped`; mailbox-wide
   * otherwise. Every caller that passes `conversationScoped` restricts its rows with it.
   */
  access: MailboxAccess | null;
};

const requiredPermission = (operation: MailExecutionOperation): "read" | "write" | null => {
  if (operation === "actorRead") return "read";
  if (operation === "actorMutation" || operation === "actorSend") return "write";
  return null;
};

const authorizeExecution = async (params: {
  mailboxId: string;
  operation: MailExecutionOperation;
  context?: MailRequestContext | null;
  conversationScoped?: boolean;
  db: SqlClient;
}): Promise<Result<MailboxAccess | null>> => {
  const permission = requiredPermission(params.operation);
  if (!permission) return ok(null);
  if (!params.context) return fail(err.unauthenticated());
  if (params.conversationScoped) {
    return requireMailboxAccess(params.context, params.mailboxId, permission, params.db);
  }
  const allowed = await requireMailboxPermission(params.context, params.mailboxId, permission, params.db);
  return allowed.ok ? ok({ scope: "mailbox", permission: allowed.data as MailboxAccess["permission"] }) : allowed;
};

const localExecution = (mailboxId: string, remoteResourceId: string | null, access: MailboxAccess | null): ResolvedMailExecution => ({
  mailboxId,
  remoteResourceId,
  bindingId: null,
  connectionId: null,
  secretRevision: null,
  folders: {},
  localOnly: true,
  sentDelivery: null,
  rightsSnapshot: { folders: {}, resolvedAt: new Date().toISOString() },
  access,
});

type SenderSelection = {
  policy: SenderAuthenticationPolicy | null;
  sentFolderId: string | null;
};

const usableRemoteResourceStatuses = new Set(["active", "degraded"]);
const blockedMailboxHealthStates = new Set(["auth_required", "connection_required", "paused"]);

const loadSenderSelection = async (params: {
  mailboxId: string;
  operation: MailExecutionOperation;
  senderIdentityId?: string | null;
  db: SqlClient;
}): Promise<Result<SenderSelection>> => {
  if (!params.senderIdentityId) {
    return params.operation === "actorSend"
      ? fail(err.badInput("A verified sender identity is required"))
      : ok({ policy: null, sentFolderId: null });
  }
  const [identity] = await params.db<
    {
      automation_policy: "disabled" | "mailbox";
      sent_folder_id: string | null;
    }[]
  >`
    SELECT automation_policy, sent_folder_id
    FROM mail.sender_identities
    WHERE id = ${params.senderIdentityId}::uuid
      AND mailbox_id = ${params.mailboxId}::uuid
      AND status = 'verified'
  `;
  if (!identity) return fail(err.badInput("Sender identity is not verified"));
  return ok({
    policy: { automation: identity.automation_policy },
    sentFolderId: identity.sent_folder_id,
  });
};

const normalizeFolderRequirements = (params: {
  operation: MailExecutionOperation;
  folderId?: string | null;
  requiredRights?: string[];
  folderRequirements?: Array<{ folderId: string; rights: string[] }>;
  senderSentFolderId: string | null;
}): Result<{ requirements: Array<{ folderId: string; rights: string[] }>; folderIds: string[] }> => {
  const requirements = [
    ...(params.folderRequirements ?? []),
    ...(params.folderId ? [{ folderId: params.folderId, rights: params.requiredRights ?? [] }] : []),
  ].map((requirement) => ({ folderId: requirement.folderId, rights: [...new Set(requirement.rights)] }));
  if (new Set(requirements.map((requirement) => requirement.folderId)).size !== requirements.length) {
    return fail(err.badInput("Each folder may appear only once in an execution request"));
  }
  return ok({
    requirements,
    folderIds: [
      ...requirements.map((requirement) => requirement.folderId),
      ...(params.operation === "actorSend" && params.senderSentFolderId ? [params.senderSentFolderId] : []),
    ],
  });
};

const groupBindingCandidates = (rows: DbCandidate[]): BindingCandidate[] => {
  const groupedCandidates = new Map<string, BindingCandidate>();
  for (const candidate of rows) {
    let grouped = groupedCandidates.get(candidate.binding_id);
    if (!grouped) {
      grouped = {
        bindingId: candidate.binding_id,
        connectionId: candidate.connection_id,
        secretRevision: candidate.secret_revision,
        folders: {},
        identityVerified: candidate.identity_verified,
        savesSentAutomatically: candidate.saves_sent_automatically,
        lastErrorCode: candidate.last_error_code,
        lastUsedAt: candidate.last_used_at
          ? (candidate.last_used_at instanceof Date ? candidate.last_used_at : new Date(candidate.last_used_at)).toISOString()
          : null,
      };
      groupedCandidates.set(candidate.binding_id, grouped);
    }
    if (candidate.folder_id && candidate.folder_path) {
      grouped.folders[candidate.folder_id] = {
        path: candidate.folder_path,
        rights: candidate.effective_rights ?? [],
      };
    }
  }
  return [...groupedCandidates.values()];
};

const resolvedExecution = (params: {
  mailboxId: string;
  remoteResourceId: string;
  operation: MailExecutionOperation;
  senderSentFolderId: string | null;
  selected: BindingCandidate;
  access: MailboxAccess | null;
}): ResolvedMailExecution => ({
  mailboxId: params.mailboxId,
  remoteResourceId: params.remoteResourceId,
  bindingId: params.selected.bindingId,
  connectionId: params.selected.connectionId,
  secretRevision: params.selected.secretRevision,
  folders: params.selected.folders,
  localOnly: false,
  sentDelivery:
    params.operation === "actorSend"
      ? {
          savesSentAutomatically: params.selected.savesSentAutomatically === true,
          folderId: params.selected.savesSentAutomatically === true ? null : params.senderSentFolderId,
          path:
            params.selected.savesSentAutomatically === true || !params.senderSentFolderId
              ? null
              : (params.selected.folders[params.senderSentFolderId]?.path ?? null),
        }
      : null,
  rightsSnapshot: {
    folders: Object.fromEntries(Object.entries(params.selected.folders).map(([folderId, folder]) => [folderId, [...folder.rights]])),
    resolvedAt: new Date().toISOString(),
  },
  access: params.access,
});

export const resolveMailExecution = async (params: {
  mailboxId: string;
  operation: MailExecutionOperation;
  context?: MailRequestContext | null;
  folderId?: string | null;
  requiredRights?: string[];
  folderRequirements?: Array<{ folderId: string; rights: string[] }>;
  senderIdentityId?: string | null;
  /**
   * Accept access to assigned conversations only, besides mailbox-wide access. The caller then
   * restricts every row it reads or changes to `access` of the result.
   */
  conversationScoped?: boolean;
  db?: SqlClient;
}): Promise<Result<ResolvedMailExecution>> => {
  const db = params.db ?? sql;
  const authorized = await authorizeExecution({ ...params, db });
  if (!authorized.ok) return authorized;
  const access = authorized.data;

  const [mailbox] = await db<DbMailboxExecution[]>`
    SELECT
      m.health,
      m.health_reason,
      m.sync_enabled,
      rr.id AS remote_resource_id,
      rr.status AS remote_resource_status,
      rr.scope_fingerprint
    FROM mail.mailboxes m
    LEFT JOIN mail.remote_resources rr ON rr.mailbox_id = m.id
    WHERE m.id = ${params.mailboxId}::uuid AND m.deleted_at IS NULL
  `;
  if (!mailbox) return fail(err.notFound("Mailbox"));

  const localReadAllowed = params.operation === "actorRead";
  if (
    mailbox.remote_resource_id &&
    (!mailbox.remote_resource_status ||
      !usableRemoteResourceStatuses.has(mailbox.remote_resource_status) ||
      blockedMailboxHealthStates.has(mailbox.health))
  ) {
    const message =
      !mailbox.sync_enabled || mailbox.remote_resource_status === "paused"
        ? "Mailbox transport is paused"
        : `Mailbox transport is unavailable${mailbox.health_reason ? `: ${mailbox.health_reason}` : ""}`;
    return localReadAllowed ? ok(localExecution(params.mailboxId, mailbox.remote_resource_id, access)) : fail(err.forbidden(message));
  }
  if (!mailbox.remote_resource_id || !mailbox.scope_fingerprint) {
    return localReadAllowed
      ? ok(localExecution(params.mailboxId, null, access))
      : fail(err.forbidden("An active provider binding is required"));
  }

  const sender = await loadSenderSelection({ ...params, db });
  if (!sender.ok) return sender;

  const folders = normalizeFolderRequirements({ ...params, senderSentFolderId: sender.data.sentFolderId });
  if (!folders.ok) return folders;
  const candidateRows = await db<DbCandidate[]>`
    SELECT
      pb.id AS binding_id,
      pb.connection_id,
      pc.secret_revision,
      bfr.folder_id,
      bfr.remote_path AS folder_path,
      COALESCE(bfr.effective_rights, ARRAY[]::text[]) AS effective_rights,
      CASE
        WHEN ${params.senderIdentityId ?? null}::uuid IS NULL THEN false
        ELSE EXISTS (
          SELECT 1
          FROM mail.sender_identity_bindings sib
          WHERE sib.sender_identity_id = ${params.senderIdentityId ?? null}::uuid
            AND sib.binding_id = pb.id
            AND sib.verified_secret_revision = pc.secret_revision
            AND sib.revoked_at IS NULL
        )
      END AS identity_verified,
      CASE
        WHEN ${params.senderIdentityId ?? null}::uuid IS NULL THEN NULL
        ELSE (
          SELECT sib.saves_sent_automatically
          FROM mail.sender_identity_bindings sib
          WHERE sib.sender_identity_id = ${params.senderIdentityId ?? null}::uuid
            AND sib.binding_id = pb.id
            AND sib.verified_secret_revision = pc.secret_revision
            AND sib.revoked_at IS NULL
        )
      END AS saves_sent_automatically,
      pb.last_error_code,
      pb.last_used_at
    FROM mail.provider_bindings pb
    JOIN mail.provider_connections pc ON pc.id = pb.connection_id
    LEFT JOIN mail.binding_folder_refs bfr
     ON bfr.binding_id = pb.id
     AND bfr.folder_id IN (
       SELECT value::uuid FROM jsonb_array_elements_text(${folders.data.folderIds}::jsonb)
     )
    WHERE pb.remote_resource_id = ${mailbox.remote_resource_id}::uuid
      AND pb.state IN ('active', 'degraded')
      AND pb.verified_scope_fingerprint = ${mailbox.scope_fingerprint}
      AND pb.verified_secret_revision = pc.secret_revision
      AND pc.status IN ('active', 'degraded')
      AND pc.encrypted_secret IS NOT NULL
      AND pc.owner_mailbox_id = ${params.mailboxId}::uuid
  `;
  const selected = selectBindingCandidate({
    operation: params.operation,
    senderPolicy: sender.data.policy,
    senderSentFolderId: sender.data.sentFolderId,
    folderRequirements: folders.data.requirements,
    candidates: groupBindingCandidates(candidateRows),
  });

  if (!selected) {
    return localReadAllowed
      ? ok(localExecution(params.mailboxId, mailbox.remote_resource_id, access))
      : fail(err.forbidden("No eligible provider binding has the required current rights"));
  }

  return ok(
    resolvedExecution({
      mailboxId: params.mailboxId,
      remoteResourceId: mailbox.remote_resource_id,
      operation: params.operation,
      senderSentFolderId: sender.data.sentFolderId,
      selected,
      access,
    }),
  );
};
