import { beforeAll, expect, test } from "bun:test";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { sql } from "../runtime/clients";
import { migrateCloudAi } from "./migrate";
import { aiConversations } from "./store";
import { aiToolAudit } from "./tool-audit";

databaseSuite()("place tool audit", () => {
  beforeAll(migrateCloudAi);
  test("rejections survive completion and keep the person's immutable place binding", async () => {
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,display_name)
      VALUES(${`place-audit-${crypto.randomUUID()}`},'local','user','Lea Fixture') RETURNING id`;
    const userId = user!.id;
    try {
      const chat = await aiConversations.createPlaceConversation({
        ownerUserId: userId,
        place: { ref: { type: "place-fixture.conversation", id: "marta" }, title: "Marta" },
        draft: [{ type: "text", text: "Write" }],
      });
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: chat.id,
        modelId: "mock",
        runConfig: { kind: "chat", input: "Write", toolSource: { kind: "none" } },
        userMessage: { role: "user", content: [{ type: "text", text: "Write" }] },
      });
      await aiToolAudit.noteToolCall({
        conversationId: chat.id,
        turnId: turn.id,
        callId: "revoked",
        toolName: "place-fixture.reply.set",
        location: "server",
      });
      await aiToolAudit.noteToolStarted({
        conversationId: chat.id,
        turnId: turn.id,
        callId: "revoked",
        toolName: "place-fixture.reply.set",
      });
      await aiToolAudit.noteToolCompleted({ turnId: turn.id, callId: "revoked", isError: true, rejected: true });
      await aiToolAudit.noteToolCompleted({ turnId: turn.id, callId: "revoked", isError: true });
      const [row] =
        await sql`SELECT call.status,call.rejected_at,conversation.created_by_user_id,conversation.place_type,conversation.place_id
        FROM ai.tool_calls call JOIN ai.conversations conversation ON conversation.id=call.conversation_id
        WHERE call.turn_id=${turn.id}::uuid AND call.call_id='revoked'`;
      expect(row).toMatchObject({
        status: "rejected",
        created_by_user_id: userId,
        place_type: "place-fixture.conversation",
        place_id: "marta",
      });
      expect(row!.rejected_at).not.toBeNull();
    } finally {
      await sql`DELETE FROM ai.conversations WHERE created_by_user_id=${userId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    }
  });
});
