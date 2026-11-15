import { sql } from "@k2b/cloud";
import { z } from "zod";
import { type CodeContext, codePermission, codePerson } from "./access";
import { CodeIdSchema } from "./contracts";
import { type CodeRow, mapCode } from "./store";

/** A chat lists at most this many Code; the box shows three of them. */
export const CODE_CHAT_LIST_LIMIT = 20;

/**
 * Where a version from the chat stands, as one stable code (concept gustav-ui-neu 3d). Apps word it themselves:
 * `on` runs, `paused` was switched on and is paused, `ready` may be switched on, `waiting` waits for an admin,
 * `expired` waited too long and may be asked for again, `changes` has requested changes, `revising` is being revised by the chat's assistant, `rejected` was declined.
 */
export const CodeChatStateSchema = z.enum(["on", "paused", "ready", "waiting", "expired", "changes", "revising", "rejected"]);
export type CodeChatState = z.infer<typeof CodeChatStateSchema>;

export const codeChatListContract = {
  input: z.object({ conversationId: z.uuid().describe("UUID of your own AI conversation.") }).strict(),
  data: z
    .object({
      items: z
        .array(
          z
            .object({
              codeId: CodeIdSchema,
              title: z.string(),
              versionId: z.uuid(),
              number: z.number().int().positive(),
              state: CodeChatStateSchema,
              /** The person can act next: switch it on, read the requested changes, or ask again. */
              attention: z.boolean(),
              /** The `data-chat-anchor` of the version's card in the chat; a version asked for again keeps its card. */
              anchor: z.string().max(200),
              submittedAt: z.iso.datetime(),
            })
            .strict(),
        )
        .max(CODE_CHAT_LIST_LIMIT),
      /** Readable Code among the chat's newest submissions that were read; may exceed the items shown. */
      count: z.number().int().nonnegative(),
    })
    .strict(),
};
export type CodeChatList = z.infer<typeof codeChatListContract.data>;

type Row = CodeRow & {
  version_id: string;
  number: number;
  submitted_at: Date;
  outcome: "approved" | "changes_requested" | "rejected" | null;
  approval_id: string | null;
  expired: boolean | null;
  closed: boolean | null;
  card_version_id: string | null;
  work_state: string | null;
  active_number: number | null;
};

const stateOf = (row: Row): CodeChatState => {
  // The Code runs this version, or a newer one made elsewhere: the chat's automation is on.
  if (row.version_id === row.active_version_id || (row.active_number ?? 0) > row.number) return row.state === "paused" ? "paused" : "on";
  if (row.outcome === "rejected") return "rejected";
  if (row.outcome === "changes_requested") return row.work_state === "queued" || row.work_state === "running" ? "revising" : "changes";
  if (row.outcome === "approved" || row.approval_id === null) return "ready";
  return row.expired ? "expired" : "waiting";
};

/**
 * The Code this person's chat submitted, each with its newest version from that chat, newest first. Only the chat's
 * owner gets an answer, and only Code they may read; one read for all, bounded.
 */
export async function listChatCode(input: z.infer<typeof codeChatListContract.input>, context: CodeContext): Promise<CodeChatList> {
  const user = codePerson(context);
  const rows = await sql<Row[]>`SELECT * FROM (SELECT DISTINCT ON (c.id) c.*, NULL AS service_account_handle, NULL AS activated_by_name,
      v.id AS version_id, v.number, s.created_at AS submitted_at, s.approval_id, d.outcome, w.state AS work_state,
      -- The same predicate as asking again (versions.ts expiredSubmission), which needs the request.
      (r.status='expired' OR (r.status='pending' AND r.expires_at<=now())) AS expired,
      -- A request closed without a decision: a newer version replaced it, nothing waits here any more.
      (s.approval_id IS NOT NULL AND d.outcome IS NULL AND r.status IS NOT NULL AND r.status NOT IN ('pending','expired')) AS closed,
      -- Asking again makes a new version under the same card: the card is the chat's first version with that anchor.
      (SELECT first.version_id FROM code.version_submissions first JOIN code.versions fv ON fv.id=first.version_id
        WHERE first.code_id=c.id AND first.origin->>'kind'='ai_chat' AND first.origin->>'conversationId'=${input.conversationId}
          AND first.origin->>'cardAnchor'=s.origin->>'cardAnchor'
        ORDER BY fv.number LIMIT 1) AS card_version_id,
      (SELECT active.number FROM code.versions active WHERE active.id=c.active_version_id) AS active_number
    FROM code.version_submissions s
      JOIN ai.conversations chat ON chat.id=${input.conversationId}::uuid AND chat.created_by_user_id=${user.id}::uuid
      JOIN code.versions v ON v.id=s.version_id JOIN code.codes c ON c.id=s.code_id
      LEFT JOIN code.version_decisions d ON d.version_id=v.id LEFT JOIN approvals.requests r ON r.id=s.approval_id
      LEFT JOIN code.review_chat_work w ON w.version_id=v.id
    WHERE s.origin->>'kind'='ai_chat' AND s.origin->>'conversationId'=${input.conversationId} AND c.state<>'deleting'
      AND NOT EXISTS(SELECT 1 FROM code.version_withdrawals withdrawn WHERE withdrawn.version_id=v.id)
    ORDER BY c.id, v.number DESC) newest
    -- Replaced by a newer version from elsewhere: the Code is no longer this chat's to show in an older state.
    WHERE NOT closed
    ORDER BY submitted_at DESC, id LIMIT ${CODE_CHAT_LIST_LIMIT * 2}`;
  const readable: Row[] = [];
  for (const row of rows) if (await codePermission(mapCode(row, user), context, sql, "read")) readable.push(row);
  readable.sort((a, b) => b.submitted_at.getTime() - a.submitted_at.getTime() || a.id.localeCompare(b.id));
  return {
    count: readable.length,
    items: readable.slice(0, CODE_CHAT_LIST_LIMIT).map((row) => {
      const state = stateOf(row);
      return {
        codeId: row.id,
        title: row.title,
        versionId: row.version_id,
        number: row.number,
        state,
        attention: state === "ready" || state === "changes" || state === "expired",
        // The version card in the chat carries this anchor (Assistant's codeVersionCardAnchor); `origin.cardAnchor` names
        // the submitting tool call, which renders no element of its own once the card replaced it.
        anchor: `code-version-${row.card_version_id ?? row.version_id}`,
        submittedAt: row.submitted_at.toISOString(),
      };
    }),
  };
}
