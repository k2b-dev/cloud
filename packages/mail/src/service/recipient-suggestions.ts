import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import { z } from "zod";
import { MAIL_RECIPIENT_NAME_MAX, type MailRecipientSuggestions, mailRecipientSuggestionSchema } from "../contracts";
import type { MailRequestContext } from "./auth";
import { requireMailboxCollaborationPermission } from "./collaboration";

/**
 * Suggestions aggregate the newest messages of the mailbox at query time, so the cost grows with this window and not
 * with the mailbox: the newest messages come from the `(mailbox_id, internal_date)` index. Measured with
 * `recipient-suggestions-performance.integration.test.ts` on the 20,000-message large-mailbox harness (19.10.2026, three runs
 * on a shared machine at load average 22–38 on 24 cores), bare query p95: 31–111 ms at 1,000 messages, 59–112 ms at
 * 2,000, 121–350 ms at 5,000 and 194–396 ms at 10,000. Only 2,000 keeps the query inside the budget below with room for
 * load; it covers weeks to months of mail, and older correspondents come from the contact directory.
 */
export const MAIL_RECIPIENT_SUGGESTION_WINDOW = 2_000;
/**
 * p95 of the suggestion query at the window above, so the list follows the 180 ms typing pause promptly. On the loaded
 * harness machine the full service call measured p50 35–66 ms; its p95 (54–250 ms) followed the machine's load.
 */
export const MAIL_RECIPIENT_SUGGESTION_P95_BUDGET_MS = 150;

type SuggestionRow = { address: string; display_name: string | null; last_seen_at: Date; written_to: boolean };
type QueryParams = { mailboxId: string; query: string; limit: number; now: Date; window: number };

/** Shared with the performance harness so EXPLAIN measures the exact production query. */
export const recipientSuggestionsQuery = (params: QueryParams, db: typeof sql = sql) => {
  const q = params.query.toLowerCase().replace(/[\\%_]/g, "\\$&");
  // Every table read is an index lookup for one message of the bounded window (aggregate or window LATERALs, which the
  // planner cannot flatten into a whole-table join), and no step joins two CTEs, so the plan does not depend on
  // row estimates and the cost stays linear in the window.
  return db<SuggestionRow[]>`
    WITH own AS MATERIALIZED (
      SELECT COALESCE(ARRAY_AGG(DISTINCT address), ARRAY[]::text[]) AS addresses
      FROM (
        SELECT LOWER(BTRIM(from_address)) AS address FROM mail.sender_identities WHERE mailbox_id = ${params.mailboxId}::uuid
        UNION ALL
        SELECT LOWER(BTRIM(reply_to)) FROM mail.sender_identities WHERE mailbox_id = ${params.mailboxId}::uuid AND reply_to IS NOT NULL
      ) identity
    ), excluded AS MATERIALIZED (
      SELECT COALESCE(ARRAY_AGG(folder.id), ARRAY[]::uuid[]) AS folder_ids
      FROM mail.folders folder
      JOIN mail.remote_resources resource ON resource.id = folder.remote_resource_id
      LEFT JOIN mail.folder_role_overrides role_override
        ON role_override.folder_id = folder.id AND role_override.mailbox_id = ${params.mailboxId}::uuid
      WHERE resource.mailbox_id = ${params.mailboxId}::uuid
        AND (
          COALESCE(role_override.role, folder.role) = 'junk'
          OR role_override.role = 'drafts'
          OR (
            COALESCE(role_override.role, folder.role) = 'drafts'
            AND NOT EXISTS (
              SELECT 1 FROM mail.folder_role_overrides drafts_override
              WHERE drafts_override.mailbox_id = ${params.mailboxId}::uuid AND drafts_override.role = 'drafts'
            )
          )
        )
    ), live AS MATERIALIZED (
      SELECT recent.id, recent.internal_date
      FROM (
        SELECT id, internal_date FROM mail.message_contents
        WHERE mailbox_id = ${params.mailboxId}::uuid
        ORDER BY internal_date DESC, id DESC
        LIMIT ${params.window}
      ) recent
      CROSS JOIN LATERAL (
        SELECT COUNT(*) AS live, BOOL_OR(placement.folder_id = ANY((SELECT folder_ids FROM excluded)::uuid[])) AS excluded
        FROM mail.message_placements placement
        WHERE placement.message_id = recent.id AND placement.deleted_at IS NULL
      ) placement
      WHERE placement.live > 0 AND NOT placement.excluded
    ), occurrences AS MATERIALIZED (
      SELECT address.normalized_email AS address, address.display_name, live.id AS message_id, live.internal_date,
        address.role, address.position,
        address.role IN ('to', 'cc', 'bcc') AND address.outgoing AS written_to
      FROM live
      CROSS JOIN LATERAL (
        SELECT candidate.normalized_email, candidate.role, candidate.position,
          NULLIF(LEFT(BTRIM(candidate.display_name), ${MAIL_RECIPIENT_NAME_MAX}), '') AS display_name,
          BOOL_OR(candidate.role = 'from' AND candidate.normalized_email = ANY((SELECT addresses FROM own)::text[])) OVER () AS outgoing
        FROM mail.message_addresses candidate
        WHERE candidate.message_id = live.id
      ) address
      WHERE address.role IN ('from', 'reply_to', 'to', 'cc', 'bcc')
        AND NOT address.normalized_email = ANY((SELECT addresses FROM own)::text[])
    ), matching AS (
      SELECT * FROM (
        SELECT occurrence.*,
          BOOL_OR(occurrence.address LIKE ${`%${q}%`} ESCAPE '\\'
            OR LOWER(occurrence.display_name) LIKE ${`${q}%`} ESCAPE '\\'
            OR LOWER(occurrence.display_name) LIKE ${`% ${q}%`} ESCAPE '\\') OVER (PARTITION BY occurrence.address) AS matches
        FROM occurrences occurrence
      ) candidate
      -- Only addresses the composer accepts, so invalid imported ones never take a result slot.
      WHERE candidate.matches AND candidate.address ~ ${z.regexes.email.source}
    ), per_message AS (
      SELECT address, message_id, internal_date, BOOL_OR(written_to) AS written_to,
        (ARRAY_AGG(display_name ORDER BY role, position) FILTER (WHERE display_name IS NOT NULL))[1] AS display_name
      FROM matching
      GROUP BY address, message_id, internal_date
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
