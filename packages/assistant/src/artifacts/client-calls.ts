import { sql } from "bun";
import { aiConversations, CodeRuntimeInput, CODE_RUNTIME_TOOL_NAMES, parseCodeToolInput } from "@k2b/cloud/ai";
import { userFromActor } from "@k2b/cloud/server";
import { z } from "zod";
import { ArtifactError, type ArtifactIdentity } from "./service";

export const ClientCall = z.object({
  conversationId: z.string().min(1).max(80), turnId: z.string().min(1).max(80), callId: z.string().min(1).max(180),
  clientId: z.uuid(), input: CodeRuntimeInput,
}).strict();
const Output = z.json().refine((value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 256 * 1024, "Tool result exceeds 256 KiB");
export const ClientCallResult = ClientCall.extend({ result: Output });
const decoded = (value: unknown) => typeof value === "string" ? JSON.parse(value) : value;

async function authorize(call: z.infer<typeof ClientCall>, identity: ArtifactIdentity) {
  const user = userFromActor(identity.actor);
  if (!user || identity.accessSubject.type !== "user" || identity.accessSubject.userId !== user.id) throw new ArtifactError("ACCESS_DENIED");
  const conversation = z.uuid().safeParse(call.conversationId).success
    ? await aiConversations.getConversation({ conversationId: call.conversationId, ownerUserId: user.id })
    : await aiConversations.getConversationByShortId({ shortId: call.conversationId, ownerUserId: user.id });
  if (!conversation) throw new ArtifactError("NOT_FOUND");
  const active = await aiConversations.getActiveTurn({ conversationId: conversation.id });
  const block = active?.liveBlocks.find((block) => block.kind === "tool" && block.callId === call.callId);
  if (!active || (active.turn.id !== call.turnId && active.turn.shortId !== call.turnId) || active.turn.status !== "waiting_for_action" || !block || block.kind !== "tool" || !CODE_RUNTIME_TOOL_NAMES.some((name) => name === block.name) || block.status !== "awaiting_client")
    throw new ArtifactError("CONFLICT");
  // Schema parsing gives canonical property order and strips no unknown fields.
  if (JSON.stringify(CodeRuntimeInput.parse(parseCodeToolInput(block.name, block.args))) !== JSON.stringify(call.input)) throw new ArtifactError("INVALID_INPUT");
  return { user, turnId: active.turn.id };
}

export const clientCalls = {
  async claim(input: unknown, identity: ArtifactIdentity) {
    const call = ClientCall.parse(input), { user, turnId } = await authorize(call, identity);
    return sql.begin(async (db) => {
      // Closed turns cannot pass authorize again. Keep completed-call payloads short-lived.
      await db`DELETE FROM assistant.artifact_client_calls WHERE user_id=${user.id}::uuid AND created_at < now() - interval '1 day'`;
      const inserted = await db`INSERT INTO assistant.artifact_client_calls(user_id,turn_id,call_id,client_id,input)
        VALUES(${user.id}::uuid,${turnId}::uuid,${call.callId},${call.clientId}::uuid,${JSON.stringify(call.input)}::jsonb)
        ON CONFLICT DO NOTHING RETURNING call_id`;
      if (inserted.length) return { status: "execute" as const };
      // Only the original host can renew ownership. A waiting tab never extends it.
      await db`UPDATE assistant.artifact_client_calls SET heartbeat_at=now()
        WHERE user_id=${user.id}::uuid AND turn_id=${turnId}::uuid AND call_id=${call.callId}
        AND client_id=${call.clientId}::uuid AND result IS NULL
        AND heartbeat_at >= now() - interval '2 minutes'`;
      const [row] = await db<{ result: unknown; completed: boolean; expired: boolean }[]>`SELECT result, result IS NOT NULL AS completed, heartbeat_at < now() - interval '2 minutes' AS expired
        FROM assistant.artifact_client_calls WHERE user_id=${user.id}::uuid AND turn_id=${turnId}::uuid AND call_id=${call.callId}`;
      if (row?.completed) return { status: "done" as const, result: Output.parse(decoded(row.result)) };
      // Never replay an execution with an uncertain outcome, including after reload.
      return { status: row?.expired ? "interrupted" as const : "pending" as const };
    });
  },
  async complete(input: unknown, identity: ArtifactIdentity) {
    const call = ClientCallResult.parse(input), { user, turnId } = await authorize(call, identity);
    const rows = await sql`UPDATE assistant.artifact_client_calls SET result=${JSON.stringify(call.result)}::jsonb
      WHERE user_id=${user.id}::uuid AND turn_id=${turnId}::uuid AND call_id=${call.callId}
      AND client_id=${call.clientId}::uuid AND input=${JSON.stringify(call.input)}::jsonb AND result IS NULL
      AND heartbeat_at >= now() - interval '2 minutes' RETURNING call_id`;
    if (!rows.length) throw new ArtifactError("CONFLICT");
    return { saved: true };
  },
};
