import type { AccessEntry } from "@k2b/cloud/contracts";
import { ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import type { ProviderConnection } from "../contracts";
import { loadMailboxAccessEntries, requireMailboxPermission } from "./access";
import type { MailRequestContext } from "./auth";

/** The connected provider account as every reader may see it: no login name, credentials, or provider errors. */
export type MailboxDetailsAccount = {
  email: string;
  server: string;
  status: Exclude<ProviderConnection["status"], "revoked">;
  lastVerifiedAt: string | null;
};

/**
 * What the mailbox details dialog adds to the mailbox page: who has access, the connected
 * account, and when Mail last synchronized. Everyone who can read the mailbox gets it.
 */
export type MailboxDetails = {
  access: AccessEntry[];
  /** A mailbox has at most one connection that is not revoked. */
  account: MailboxDetailsAccount | null;
  lastSyncAt: string | null;
};

const toIso = (value: Date | string | null): string | null =>
  value ? (value instanceof Date ? value : new Date(value)).toISOString() : null;

export const getMailboxDetails = async (context: MailRequestContext, mailboxId: string): Promise<Result<MailboxDetails>> => {
  const allowed = await requireMailboxPermission(context, mailboxId, "read");
  if (!allowed.ok) return allowed;
  const [access, [account], [sync]] = await Promise.all([
    loadMailboxAccessEntries(mailboxId),
    sql<{ email: string; imap_host: string; status: MailboxDetailsAccount["status"]; last_verified_at: Date | string | null }[]>`
      SELECT pc.email, pc.imap_host, pc.status, pc.last_verified_at
      FROM mail.provider_connections pc
      WHERE pc.owner_mailbox_id = ${mailboxId}::uuid AND pc.status <> 'revoked'
    `,
    sql<{ last_sync_at: Date | string | null }[]>`
      SELECT last_sync_at
      FROM mail.remote_resources
      WHERE mailbox_id = ${mailboxId}::uuid
    `,
  ]);
  return ok({
    access,
    account: account
      ? { email: account.email, server: account.imap_host, status: account.status, lastVerifiedAt: toIso(account.last_verified_at) }
      : null,
    lastSyncAt: toIso(sync?.last_sync_at ?? null),
  });
};
