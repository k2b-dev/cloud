import { sql } from "@k2b/cloud";
import { ok, type Result } from "@k2b/stdlib";
import type { ConversationListDrafts } from "../contracts";
import { draftVisibleTo, requireMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";

/** One page query with the same draft visibility as the conversation's draft list. */
export const listConversationDraftSummaries = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  conversationIds: readonly string[];
}): Promise<Result<Map<string, ConversationListDrafts>>> => {
  const allowed = await requireMailboxAccess(params.context, params.mailboxId, "read");
  if (!allowed.ok) return allowed;
  const conversationIds = [...new Set(params.conversationIds)];
  if (!conversationIds.length) return ok(new Map());
  const rows = await sql<
    {
      conversation_id: string;
      count: number;
      editors: ConversationListDrafts["editors"];
      suggested_by: string | null;
    }[]
  >`
    WITH visible_drafts AS MATERIALIZED (
      SELECT d.conversation_id, d.author_kind, d.author_id, d.created_at,
        d.last_editor_kind, d.last_editor_id, d.updated_at, d.adopted_at
      FROM mail.drafts d
      WHERE d.mailbox_id = ${params.mailboxId}::uuid AND d.origin = 'user' AND d.state = 'draft'
        AND d.conversation_id IN (SELECT value::uuid FROM jsonb_array_elements_text(${conversationIds}::jsonb))
        AND ${draftVisibleTo(allowed.data, sql`d`)}
    ), counts AS (
      SELECT conversation_id, count(*)::int AS count FROM visible_drafts GROUP BY conversation_id
    ), contributors AS (
      SELECT conversation_id, author_kind AS kind, author_id AS id, created_at AS touched_at FROM visible_drafts
      UNION ALL
      SELECT conversation_id, last_editor_kind, last_editor_id, updated_at FROM visible_drafts
    ), people AS (
      SELECT contributor.conversation_id, contributor.kind, contributor.id,
        COALESCE(NULLIF(person.display_name, ''), person.uid, account.name) AS display_name,
        max(contributor.touched_at) AS touched_at
      FROM contributors contributor
      LEFT JOIN auth.users person ON contributor.kind = 'user' AND person.id = contributor.id
      LEFT JOIN auth.service_accounts account ON contributor.kind = 'service_account' AND account.id = contributor.id
      WHERE contributor.kind IN ('user', 'service_account')
        AND COALESCE(NULLIF(person.display_name, ''), person.uid, account.name) IS NOT NULL
      GROUP BY contributor.conversation_id, contributor.kind, contributor.id, person.display_name, person.uid, account.name
    ), ranked AS (
      SELECT *, row_number() OVER (PARTITION BY conversation_id ORDER BY touched_at DESC, kind, id) AS position FROM people
    ), editors AS (
      SELECT conversation_id,
        jsonb_agg(jsonb_build_object('kind', kind, 'id', id, 'displayName', display_name) ORDER BY position) AS editors
      FROM ranked WHERE position <= 3 GROUP BY conversation_id
    ), suggestions AS (
      -- The account that created an untouched suggestion, never whoever edited it last.
      SELECT draft.conversation_id, min(COALESCE(NULLIF(account.name, ''), 'Former service account')) AS suggested_by
      FROM visible_drafts draft
      LEFT JOIN auth.service_accounts account ON account.id = draft.author_id
      WHERE draft.author_kind = 'service_account' AND draft.adopted_at IS NULL
      GROUP BY draft.conversation_id
    )
    SELECT counts.conversation_id, counts.count, COALESCE(editors.editors, '[]'::jsonb) AS editors,
      CASE WHEN counts.count = 1 THEN suggestions.suggested_by END AS suggested_by
    FROM counts LEFT JOIN editors USING (conversation_id) LEFT JOIN suggestions USING (conversation_id)
  `;
  return ok(
    new Map(
      rows.map(({ conversation_id, count, editors, suggested_by }) => [conversation_id, { count, editors, suggestedBy: suggested_by }]),
    ),
  );
};
