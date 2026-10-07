import type { AccessEntry } from "@k2b/cloud/contracts";
import { getEffectiveGroupIds } from "@k2b/cloud/server";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import { loadMailboxAccessEntries, requireMailboxPermission } from "./access";
import { type MailRequestContext, userBackedActor } from "./auth";

/** The connected provider account as every reader may see it: no login name, credentials, or provider errors. */
export type MailboxDetailsAccount = { email: string; server: string };

/**
 * What the mailbox details dialog adds to the mailbox page: the viewer's current access, who has access, the connected
 * account, and when Mail last synchronized. Everyone who can read the mailbox gets it.
 */
export type MailboxDetails = {
  /** Resolved for this request, so it never lags behind a change made while the page stayed open. */
  permission: "read" | "write" | "admin";
  /** The grants the viewer may see in the directory. */
  access: AccessEntry[];
  /** Grants left out because the directory does not show them to the viewer. */
  hiddenAccessCount: number;
  /** A mailbox has at most one connection that is not revoked. */
  account: MailboxDetailsAccount | null;
  lastSyncAt: string | null;
};

const toIso = (value: Date | string | null): string | null =>
  value ? (value instanceof Date ? value : new Date(value)).toISOString() : null;

/**
 * Guest accounts see only themselves and their effective groups in the directory, so the grant list keeps that rule.
 * Grants to every signed-in or public identity name no one and stay visible.
 */
const visibleAccess = async (context: MailRequestContext, access: AccessEntry[]): Promise<AccessEntry[]> => {
  const viewer = userBackedActor(context);
  if (!viewer || viewer.roles.includes("user")) return access;
  const groupIds = new Set(await getEffectiveGroupIds({ userId: viewer.id }));
  return access.filter(({ principal }) => {
    if (principal.type === "user") return principal.userId === viewer.id;
    if (principal.type === "group") return groupIds.has(principal.groupId);
    return principal.type !== "service_account";
  });
};

export const getMailboxDetails = async (context: MailRequestContext, mailboxId: string): Promise<Result<MailboxDetails>> => {
  const allowed = await requireMailboxPermission(context, mailboxId, "read");
  if (!allowed.ok) return allowed;
  const permission = allowed.data;
  if (permission === "none") return fail(err.forbidden("Access denied"));
  const [access, [account], [sync]] = await Promise.all([
    loadMailboxAccessEntries(mailboxId),
    sql<{ email: string; imap_host: string }[]>`
      SELECT pc.email, pc.imap_host
      FROM mail.provider_connections pc
      WHERE pc.owner_mailbox_id = ${mailboxId}::uuid AND pc.status <> 'revoked'
    `,
    sql<{ last_sync_at: Date | string | null }[]>`
      SELECT last_sync_at
      FROM mail.remote_resources
      WHERE mailbox_id = ${mailboxId}::uuid
    `,
  ]);
  const visible = await visibleAccess(context, access);
  return ok({
    permission,
    access: visible,
    hiddenAccessCount: access.length - visible.length,
    account: account ? { email: account.email, server: account.imap_host } : null,
    lastSyncAt: toIso(sync?.last_sync_at ?? null),
  });
};
