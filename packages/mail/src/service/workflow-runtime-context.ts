import type { RequestActor } from "@k2b/cloud/server";
import { accounts, serviceAccounts, toPgTextArray } from "@k2b/cloud/services";
import { sql } from "bun";
import type { ActorRef } from "../contracts";
import { requireMailboxPermission } from "./access";
import type { MailRequestContext } from "./auth";
import { actorRefFromRequest, durableCredentialSnapshot } from "./auth";

type SqlClient = typeof sql;

type MailWorkflowActorAuthorization = {
  version: 2;
  authority: "actor";
  actor:
    | { kind: "user"; userId: string }
    | {
        kind: "service_account";
        serviceAccountId: string;
        delegatedUserId: string | null;
        scopes: string[];
        credentialId: string | null;
        credentialExpiresAt: string | null;
      };
  accessSubject: { kind: "user"; id: string } | { kind: "service_account"; id: string };
  capturedAt: string;
};

export type MailWorkflowAuthorizationSnapshot =
  | MailWorkflowActorAuthorization
  | {
      version: 2;
      authority: "mailbox";
      mailboxId: string;
      activatedBy: ActorRef;
      capturedAt: string;
    };

export type MailWorkflowExecutionAuthority =
  | { kind: "actor"; context: MailRequestContext }
  | { kind: "mailbox"; mailboxId: string; workflowVersionId: string };

const userAccountActive = (user: { accountExpires: string | null }): boolean =>
  user.accountExpires === null || Date.parse(user.accountExpires) > Date.now();

export const snapshotMailWorkflowAuthorization = (context: MailRequestContext): MailWorkflowAuthorizationSnapshot | null => {
  const credential = durableCredentialSnapshot(context);
  if (!credential) return null;
  return {
    version: 2,
    authority: "actor",
    actor:
      context.actor.kind === "user"
        ? { kind: "user", userId: context.actor.user.id }
        : {
            kind: "service_account",
            serviceAccountId: context.actor.serviceAccount.id,
            delegatedUserId: context.actor.delegatedUser?.id ?? null,
            scopes: [...context.actor.scopes],
            credentialId: credential.credentialId,
            credentialExpiresAt: credential.credentialExpiresAt,
          },
    accessSubject:
      context.accessSubject.type === "user"
        ? { kind: "user", id: context.accessSubject.userId }
        : { kind: "service_account", id: context.accessSubject.serviceAccountId },
    capturedAt: new Date().toISOString(),
  };
};

export const snapshotMailboxWorkflowAuthorization = (
  context: MailRequestContext,
  mailboxId: string,
): MailWorkflowAuthorizationSnapshot => ({
  version: 2,
  authority: "mailbox",
  mailboxId,
  activatedBy: actorRefFromRequest(context),
  capturedAt: new Date().toISOString(),
});

const serviceCredentialActive = async (
  actor: Extract<MailWorkflowActorAuthorization["actor"], { kind: "service_account" }>,
  db: SqlClient = sql,
): Promise<boolean> => {
  if (!actor.credentialId) {
    const expiresAt = actor.credentialExpiresAt ? Date.parse(actor.credentialExpiresAt) : Number.NaN;
    return Number.isFinite(expiresAt) && expiresAt > Date.now();
  }
  const [row] = await db<{ active: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM auth.service_account_credentials credential
      WHERE credential.id = ${actor.credentialId}::uuid
        AND credential.service_account_id = ${actor.serviceAccountId}::uuid
        AND credential.status = 'active'
        AND credential.revoked_at IS NULL
        AND (credential.expires_at IS NULL OR credential.expires_at > now())
        AND credential.scopes @> ${toPgTextArray(actor.scopes)}::text[]
        AND credential.scopes <@ ${toPgTextArray(actor.scopes)}::text[]
    ) AS active
  `;
  return row?.active === true;
};

export const restoreMailWorkflowContext = async (
  snapshot: MailWorkflowAuthorizationSnapshot,
  runId: string,
): Promise<MailRequestContext | null> => {
  if (snapshot.authority !== "actor") return null;
  let actor: RequestActor;
  if (snapshot.actor.kind === "user") {
    const user = await accounts.users.get({ id: snapshot.actor.userId });
    if (!user || !userAccountActive(user)) return null;
    actor = { kind: "user", user };
  } else {
    if (!(await serviceCredentialActive(snapshot.actor))) return null;
    const serviceAccount = await serviceAccounts.get({ id: snapshot.actor.serviceAccountId });
    if (!serviceAccount || serviceAccount.status !== "active" || serviceAccount.delegatedUserId !== snapshot.actor.delegatedUserId) {
      return null;
    }
    const delegatedUser = serviceAccount.delegatedUserId ? await accounts.users.get({ id: serviceAccount.delegatedUserId }) : null;
    if (serviceAccount.kind === "user_delegated" && (!delegatedUser || !userAccountActive(delegatedUser))) return null;
    actor = {
      kind: "service_account",
      serviceAccount,
      delegatedUser,
      scopes: snapshot.actor.scopes,
      credentialId: snapshot.actor.credentialId,
      credentialExpiresAt: snapshot.actor.credentialExpiresAt,
    };
  }

  return {
    actor,
    accessSubject:
      snapshot.accessSubject.kind === "user"
        ? { type: "user", userId: snapshot.accessSubject.id }
        : { type: "service_account", serviceAccountId: snapshot.accessSubject.id },
    requestId: `mail-workflow:${runId}`,
  };
};

export const resolveMailWorkflowExecutionAuthority = async (params: {
  snapshot: MailWorkflowAuthorizationSnapshot;
  mailboxId: string;
  workflowVersionId: string;
  runId: string;
}): Promise<MailWorkflowExecutionAuthority | null> => {
  if (params.snapshot.authority === "actor") {
    const context = await restoreMailWorkflowContext(params.snapshot, params.runId);
    return context ? { kind: "actor", context } : null;
  }
  if (params.snapshot.mailboxId !== params.mailboxId) return null;
  const [workflow] = await sql<{ authorized: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM workflows.version version
      JOIN workflows.workflow workflow
        ON workflow.id = version.workflow_id
       AND workflow.active_version_id = version.id
      JOIN mail.workflow_profile profile
        ON profile.id = workflow.id
       AND profile.enabled
      WHERE profile.mailbox_id = ${params.mailboxId}::uuid
        AND version.id = ${params.workflowVersionId}::uuid
    ) AS authorized
  `;
  return workflow?.authorized === true
    ? { kind: "mailbox", mailboxId: params.mailboxId, workflowVersionId: params.workflowVersionId }
    : null;
};

export const mailWorkflowExecutionAuthorityActive = async (
  authority: MailWorkflowExecutionAuthority,
  mailboxId: string,
  workflowVersionId: string,
  db: SqlClient = sql,
): Promise<boolean> => {
  if (authority.kind === "mailbox") {
    if (authority.mailboxId !== mailboxId || authority.workflowVersionId !== workflowVersionId) return false;
    const [version] = await db<{ authorized: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM workflows.version version
        JOIN workflows.workflow workflow
          ON workflow.id = version.workflow_id
         AND workflow.active_version_id = version.id
        JOIN mail.workflow_profile profile
          ON profile.id = workflow.id
         AND profile.enabled
        WHERE profile.mailbox_id = ${mailboxId}::uuid
          AND version.id = ${workflowVersionId}::uuid
      ) AS authorized
    `;
    return version?.authorized === true;
  }
  const permission = await requireMailboxPermission(authority.context, mailboxId, "write", db);
  if (!permission.ok) return false;
  if (authority.context.actor.kind === "user") return true;
  const credential = durableCredentialSnapshot(authority.context);
  if (!credential) return false;
  return serviceCredentialActive(
    {
      kind: "service_account",
      serviceAccountId: authority.context.actor.serviceAccount.id,
      delegatedUserId: authority.context.actor.delegatedUser?.id ?? null,
      scopes: credential.scopes,
      credentialId: credential.credentialId,
      credentialExpiresAt: credential.credentialExpiresAt,
    },
    db,
  );
};
