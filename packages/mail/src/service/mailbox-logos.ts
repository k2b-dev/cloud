import { createHash } from "node:crypto";
import { sql } from "bun";
import type { MailboxComposeLogo } from "../contracts";
import type { OutboundDraftSnapshot } from "./outbound-mime";

type SqlClient = typeof sql;
export type DbMailboxLogo = {
  id: string;
  content: Buffer;
  content_type: "image/png" | "image/jpeg";
  pixel_width: number;
  pixel_height: number;
  display_width: number;
  alt_text: string;
  sha256: string;
  created_at: Date | string;
};

export const mailboxLogoSha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export const mailboxLogoContentId = (versionId: string, senderEmail: string): string => {
  const domain = senderEmail.split("@")[1]?.toLowerCase() ?? "";
  return `logo.${versionId}@${/^[a-z0-9.-]+$/.test(domain) ? domain : "mail.invalid"}`;
};
export const mailboxLogoDataUrl = (row: DbMailboxLogo): string =>
  `data:${row.content_type};base64,${Buffer.from(row.content).toString("base64")}`;
export const mapMailboxLogo = (row: DbMailboxLogo | null): MailboxComposeLogo => ({
  logo: row
    ? {
        contentType: row.content_type,
        pixelWidth: row.pixel_width,
        pixelHeight: row.pixel_height,
        displayWidth: row.display_width,
        altText: row.alt_text,
        byteLength: row.content.byteLength,
        sha256: row.sha256,
        dataUrl: mailboxLogoDataUrl(row),
        createdAt: new Date(row.created_at).toISOString(),
      }
    : null,
});

/** In a send transaction the version lock survives rendering, MIME measurement and outbox insertion. */
export const currentMailboxLogo = async (db: SqlClient, mailboxId: string, lock: boolean): Promise<DbMailboxLogo | null> => {
  const rows = await db<DbMailboxLogo[]>`
    SELECT version.* FROM mail.mailboxes mailbox
    JOIN mail.mailbox_logo_versions version ON version.id = mailbox.logo_version_id AND version.mailbox_id = mailbox.id
    WHERE mailbox.id = ${mailboxId}::uuid AND mailbox.deleted_at IS NULL
    ${lock ? db`FOR KEY SHARE OF version` : db``}
  `;
  return rows[0] ?? null;
};

/** Never substitute today's logo for a queued message's frozen bytes. */
export const loadInlineLogoContent = async (
  inlineLogo: OutboundDraftSnapshot["inlineLogo"],
  db: SqlClient = sql,
): Promise<Buffer | null> => {
  if (!inlineLogo) return null;
  const [row] = await db<{ content: Buffer; content_type: string }[]>`
    SELECT content, content_type FROM mail.mailbox_logo_versions WHERE id = ${inlineLogo.versionId}::uuid
  `;
  if (
    !row ||
    row.content_type !== inlineLogo.contentType ||
    row.content.byteLength !== inlineLogo.byteLength ||
    mailboxLogoSha256(row.content) !== inlineLogo.sha256
  ) {
    throw Object.assign(new Error("The frozen mailbox logo is unavailable or damaged"), { code: "INLINE_LOGO_UNAVAILABLE" });
  }
  return Buffer.from(row.content);
};

export const deleteUnusedMailboxLogoVersions = async (
  params: { mailboxId?: string; limit: number },
  db: SqlClient = sql,
): Promise<number> => {
  if (!Number.isSafeInteger(params.limit) || params.limit < 1) throw new Error("Logo cleanup limit must be a positive integer");
  // command-runtime's claimOutbox only rebuilds in scheduled/undo_window, unknown,
  // sent_sync_pending and needs_attention (Sent-copy retries), with sending/accepted
  // active during work. Operator retries cannot retry send commands. Keep uncertain
  // states; these final outcomes cannot build MIME again. A pending Sent copy
  // always retains its logo, even if an operator has reconciled its delivery.
  const rows = await db<{ id: string }[]>`
    DELETE FROM mail.mailbox_logo_versions WHERE id IN (
      SELECT version.id FROM mail.mailbox_logo_versions version
      WHERE (${params.mailboxId ?? null}::uuid IS NULL OR version.mailbox_id = ${params.mailboxId ?? null}::uuid)
        AND NOT EXISTS (SELECT 1 FROM mail.mailboxes mailbox WHERE mailbox.logo_version_id = version.id)
        AND NOT EXISTS (
          SELECT 1 FROM mail.outbox_submissions outbox WHERE outbox.inline_logo_version_id = version.id
            AND (outbox.state NOT IN ('sent', 'failed', 'cancelled', 'reconciled_accepted', 'reconciled_unsent') OR outbox.sent_copy_pending)
        )
      ORDER BY version.created_at, version.id
      LIMIT ${params.limit} FOR UPDATE OF version SKIP LOCKED
    ) RETURNING id
  `;
  return rows.length;
};
