import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import { z } from "zod";
import { MAIL_RECIPIENT_NAME_MAX, type MailRecipientSuggestions, mailRecipientSuggestionSchema } from "../contracts";
import type { MailRequestContext } from "./auth";
import { requireMailboxCollaborationPermission } from "./collaboration";

/**
 * Suggestions aggregate the newest messages of the mailbox at query time, so the cost grows with this window and not
 * with the mailbox: the newest messages come from the `(mailbox_id, internal_date)` index. Measured with
 * `recipient-suggestions-performance.integration.test.ts` on the 20,000-message large-mailbox harness (19.10.2026, shared
 * machine at load average ~27 on 24 cores): the bare query took p95 23–74 ms at 1,000 messages, 39–57 ms at 2,000,
 * 88–120 ms at 5,000, 174–284 ms at 10,000 and 259–434 ms at 20,000; the full service call with its permission check
 * took p95 87–144 ms at 5,000. 5,000 is the largest window that stays inside the budget below, and it covers weeks to
 * months of mail; older correspondents come from the contact directory.
 */
export const MAIL_RECIPIENT_SUGGESTION_WINDOW = 5_000;
/** p95 for one suggestion lookup (permission check included), so the list follows the 180 ms typing pause promptly. */
export const MAIL_RECIPIENT_SUGGESTION_P95_BUDGET_MS = 150;

type SuggestionRow = { address: string; display_name: string | null; last_seen_at: Date; written_to: boolean };
type QueryParams = { mailboxId: string; query: string; limit: number; now: Date; window: number };

/** Shared with the performance harness so EXPLAIN measures the exact production query. */
export const recipientSuggestionsQuery = (params: QueryParams, db: typeof sql = sql) => {
  const q = params.query.toLowerCase().replace(/[\\%_]/g, "\\$&");
  // Each step reads only rows of the bounded window through an index (`= ANY(ids)`), never a whole table.
  return db<SuggestionRow[]>`
    WITH recent AS MATERIALIZED (
      SELECT id, internal_date FROM mail.message_contents
      WHERE mailbox_id = ${params.mailboxId}::uuid
      ORDER BY internal_date DESC, id DESC
      LIMIT ${params.window}
    ), recent_ids AS MATERIALIZED (
      SELECT ARRAY_AGG(id) AS ids FROM recent
    ), placements AS MATERIALIZED (
      SELECT placement.message_id, BOOL_OR(COALESCE(role_override.role, folder.role) = 'junk') AS junk
      FROM mail.message_placements placement
      JOIN mail.folders folder ON folder.id = placement.folder_id
      LEFT JOIN mail.folder_role_overrides role_override
        ON role_override.folder_id = folder.id AND role_override.mailbox_id = ${params.mailboxId}::uuid
      WHERE placement.message_id = ANY((SELECT ids FROM recent_ids)::uuid[]) AND placement.deleted_at IS NULL
      GROUP BY placement.message_id
    ), live AS MATERIALIZED (
      SELECT recent.id, recent.internal_date
      FROM recent JOIN placements ON placements.message_id = recent.id
      WHERE NOT placements.junk
    ), live_ids AS MATERIALIZED (
      SELECT ARRAY_AGG(id) AS ids FROM live
    ), own_addresses AS MATERIALIZED (
      SELECT LOWER(BTRIM(from_address)) AS address FROM mail.sender_identities WHERE mailbox_id = ${params.mailboxId}::uuid
      UNION
      SELECT LOWER(BTRIM(reply_to)) FROM mail.sender_identities WHERE mailbox_id = ${params.mailboxId}::uuid AND reply_to IS NOT NULL
    ), addresses AS MATERIALIZED (
      SELECT address.message_id, address.role, address.position, address.normalized_email,
        NULLIF(LEFT(BTRIM(address.display_name), ${MAIL_RECIPIENT_NAME_MAX}), '') AS display_name
      FROM mail.message_addresses address
      WHERE address.message_id = ANY((SELECT ids FROM live_ids)::uuid[])
    ), outgoing AS MATERIALIZED (
      SELECT DISTINCT address.message_id
      FROM addresses address JOIN own_addresses own ON own.address = address.normalized_email
      WHERE address.role = 'from'
    ), occurrences AS MATERIALIZED (
      SELECT address.normalized_email AS address, address.display_name, live.id AS message_id, live.internal_date,
        address.role, address.position,
        address.role IN ('to', 'cc', 'bcc') AND outgoing.message_id IS NOT NULL AS written_to
      FROM addresses address
      JOIN live ON live.id = address.message_id
      LEFT JOIN outgoing ON outgoing.message_id = address.message_id
      WHERE NOT EXISTS (SELECT 1 FROM own_addresses own WHERE own.address = address.normalized_email)
        -- Only addresses the composer accepts, so invalid imported ones never take a result slot.
        AND address.normalized_email ~ ${z.regexes.email.source}
    ), matching AS (
      SELECT address FROM occurrences
      GROUP BY address
      HAVING BOOL_OR(address LIKE ${`%${q}%`} ESCAPE '\\'
        OR LOWER(display_name) LIKE ${`${q}%`} ESCAPE '\\'
        OR LOWER(display_name) LIKE ${`% ${q}%`} ESCAPE '\\')
    ), per_message AS (
      SELECT occurrence.address, occurrence.message_id, occurrence.internal_date,
        BOOL_OR(occurrence.written_to) AS written_to,
        (ARRAY_AGG(occurrence.display_name ORDER BY occurrence.role, occurrence.position)
          FILTER (WHERE occurrence.display_name IS NOT NULL))[1] AS display_name
      FROM occurrences occurrence JOIN matching USING (address)
      GROUP BY occurrence.address, occurrence.message_id, occurrence.internal_date
    ), ranked AS (
      SELECT address, MAX(internal_date) AS last_seen_at, BOOL_OR(written_to) AS written_to,
        (ARRAY_AGG(display_name ORDER BY internal_date DESC, message_id DESC)
          FILTER (WHERE display_name IS NOT NULL))[1] AS display_name,
        SUM(1.0 / (1.0 + GREATEST(EXTRACT(EPOCH FROM (${params.now.toISOString()}::timestamptz - internal_date)) / 86400.0, 0) / 30.0)) AS score
      FROM per_message GROUP BY address
    )
    SELECT ranked.address, ranked.display_name, ranked.last_seen_at, ranked.written_to
    FROM ranked
    ORDER BY ranked.written_to DESC, ranked.score DESC, ranked.last_seen_at DESC, ranked.address ASC
    LIMIT ${params.limit}
  `;
};

export const listRecipientSuggestions = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  query: string;
  limit?: number;
  now?: Date;
  /** Performance tests may reduce the window; never exceeds the production maximum. */
  window?: number;
}): Promise<Result<MailRecipientSuggestions>> => {
  const access = await requireMailboxCollaborationPermission(params.context, params.mailboxId, "read");
  if (!access.ok) return access;
  const query = params.query.trim();
  if (query.length < 2 || query.length > 320) return fail(err.badInput("Query must have 2 to 320 characters"));
  const limit = Number.isFinite(params.limit) ? Math.max(1, Math.min(20, Math.trunc(params.limit ?? 8))) : 8;
  const window = Number.isFinite(params.window)
    ? Math.max(1, Math.min(MAIL_RECIPIENT_SUGGESTION_WINDOW, Math.trunc(params.window ?? MAIL_RECIPIENT_SUGGESTION_WINDOW)))
    : MAIL_RECIPIENT_SUGGESTION_WINDOW;
  const rows = await sql.begin(async (tx) => {
    await tx`SET LOCAL jit = off`;
    return recipientSuggestionsQuery({ mailboxId: params.mailboxId, query, limit, window, now: params.now ?? new Date() }, tx);
  });
  // Imported messages can contain addresses outside the contact email contract. Skip those rows.
  return ok({
    items: rows.flatMap((row) => {
      const parsed = mailRecipientSuggestionSchema.safeParse({
        address: row.address,
        displayName: row.display_name,
        lastSeenAt: row.last_seen_at.toISOString(),
        writtenTo: row.written_to,
      });
      return parsed.success ? [parsed.data] : [];
    }),
  });
};
