import { beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { aiConversations, migrateCloudAi } from "@k2b/cloud/ai";
import { type CapabilityExecutionContext, capabilityResultSchema } from "@k2b/cloud/contracts";
import { accounts } from "@k2b/cloud/services";
import { databaseSuite } from "../../../scripts/fixtures/test-infra";
import "../../../scripts/fixtures/authorization-preload";
import { aiCapabilities } from "./capabilities";

databaseSuite()("Core reads newly created place chats", () => {
  beforeAll(migrateCloudAi);

  test("a maximum-length place title preserves its snapshot and fits both chat query contracts", async () => {
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name)
      VALUES (${`place-title-${crypto.randomUUID()}`}, 'local', 'user', 'Place title fixture') RETURNING id`;
    const ownerUserId = user!.id;
    const title = "T".repeat(200);
    try {
      const chat = await aiConversations.createPlaceConversation({
        ownerUserId,
        place: { ref: { type: "place-fixture.conversation", id: "marta" }, title },
        draft: [{ type: "text", text: "Summarize this conversation." }],
      });
      expect(chat.place?.title).toBe(title);
      const person = await accounts.users.get({ id: ownerUserId });
      if (!person) throw new Error("Missing place title fixture owner");
      const context: CapabilityExecutionContext = {
        actor: { kind: "user", user: person },
        user: person,
        accessSubject: { type: "user", userId: ownerUserId },
        locale: "en",
        requestId: "place-title-contract",
        origin: "assistant",
        signal: new AbortController().signal,
      };
      for (const [query, input] of [
        [aiCapabilities.queries["ai.chat.read"], { id: chat.shortId, limit: 20 }],
        [aiCapabilities.queries["ai.chat.search"], { chatId: chat.shortId, query: "summary", limit: 20 }],
      ] as const) {
        const result = await query.run(query.input.parse(input), context);
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.error.message);
        const parsed = capabilityResultSchema(query.data).parse(result.data);
        expect(parsed.data.chat.title).toBe("T".repeat(120));
      }
    } finally {
      await sql`DELETE FROM ai.conversations WHERE created_by_user_id = ${ownerUserId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${ownerUserId}::uuid`;
    }
  });
});
