import { sql } from "@k2b/cloud";
import type { SQL } from "bun";
import { type CodeContext, CodeDataError } from "./access";

/** Tool entry rejects stopped work; submission repeats this check under the owning Code lock. */
export async function assertCodeReviewTurn(codeId: string, context: CodeContext, db: SQL = sql) {
  if (!context.reviewTurn) return;
  const [work] = await db<{ state: string; turn_id: string | null }[]>`SELECT state,turn_id FROM code.review_chat_work
    WHERE version_id=${context.reviewTurn.versionId}::uuid AND code_id=${codeId}`;
  if (work?.state !== "running" || work.turn_id !== context.reviewTurn.turnId)
    throw new CodeDataError("CONFLICT", "The automatic revision has stopped or already submitted. Ask the person before continuing.");
}

/** Both Composer cancellation and card cancellation enter here, before the runtime abort signal. */
export async function stopCodeReviewTurn(input: { conversationId: string; turnId: string }) {
  await sql.begin(async (tx) => {
    const [candidate] = await tx<{ code_id: string }[]>`SELECT code_id FROM code.review_chat_work
      WHERE conversation_id=${input.conversationId}::uuid AND turn_id=${input.turnId}::uuid`;
    if (!candidate) return;
    await tx`SELECT id FROM code.codes WHERE id=${candidate.code_id} FOR UPDATE`;
    await tx`UPDATE code.review_chat_work SET state='stopped',reason='stopped',updated_at=now()
      WHERE conversation_id=${input.conversationId}::uuid AND turn_id=${input.turnId}::uuid AND state IN ('queued','running')`;
  });
}

/** Same transaction as the immutable decision or successful activation. CLI never creates chat work. */
export async function enqueueCodeReviewChat(versionId: string, kind: "decision" | "activation", db: SQL) {
  await db`INSERT INTO code.review_chat_work(version_id,code_id,conversation_id,user_id,state,reason)
    SELECT s.version_id,s.code_id,(s.origin->>'conversationId')::uuid,v.created_by,
      CASE WHEN ${kind}='decision' AND d.outcome='changes_requested' AND NOT (s.origin->>'automaticAfterReview')::boolean THEN 'queued' ELSE 'none' END,
      CASE WHEN d.outcome='changes_requested' AND (s.origin->>'automaticAfterReview')::boolean THEN 'already_automatic' END
    FROM code.version_submissions s JOIN code.versions v ON v.id=s.version_id
      LEFT JOIN code.version_decisions d ON d.version_id=v.id
    WHERE s.version_id=${versionId}::uuid AND s.origin->>'kind'='ai_chat'
    ON CONFLICT DO NOTHING`;
  await db`INSERT INTO code.review_chat_outbox(version_id,kind)
    SELECT version_id,${kind} FROM code.review_chat_work WHERE version_id=${versionId}::uuid ON CONFLICT DO NOTHING`;
  if (kind === "decision")
    await db`INSERT INTO code.review_chat_outbox(version_id,kind)
      SELECT version_id,'revision' FROM code.review_chat_work WHERE version_id=${versionId}::uuid AND state='queued' ON CONFLICT DO NOTHING`;
}
