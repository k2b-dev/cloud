import { beforeAll, expect, test } from "bun:test";
import type { Message } from "@k2b/nessi";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { migrateCloudAi } from "./migrate";
import { aiConversations } from "./store";

const insertUser = async () => {
  const suffix = crypto.randomUUID();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
    VALUES (${`ai-enrich-${suffix}`}, 'local', 'user', 'AI Enrich Test', ${`ai-enrich-${suffix}@example.test`}, 'AI', 'Enrich')
    RETURNING id
  `;
  return row!.id;
};

const cleanupFixture = async (input: { userId: string; conversationIds: string[] }) => {
  for (const conversationId of input.conversationIds) {
    await sql`DELETE FROM ai.conversations WHERE id = ${conversationId}::uuid`;
  }
  await sql`DELETE FROM auth.users WHERE id = ${input.userId}::uuid`;
};

const userMessage = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });

const runConfig = { kind: "chat" as const, input: "hi", toolSource: { kind: "none" as const } };

/** Seed a user message via the real submit path, then clear the queued turn so the chat has no active turn. */
const seedUserMessage = async (conversationId: string, text: string) => {
  await aiConversations.submitChatTurn({
    conversationId,
    modelProfileId: "test-model",
    runConfig,
    userMessage: userMessage(text),
  });
  await sql`DELETE FROM ai.turns WHERE conversation_id = ${conversationId}::uuid`;
};

const candidateIds = async () => (await aiConversations.listEnrichmentCandidates({ limit: 100 })).map((candidate) => candidate.id);

databaseSuite()("enrichment store (integration)", () => {
  beforeAll(async () => {
    await migrateCloudAi();
  });
  test("applyEnrichment with exact dirtyAsOf makes an unchanged conversation exactly clean", async () => {
    const userId = await insertUser();
    const conversationIds: string[] = [];
    try {
      const conversation = await aiConversations.createConversation({ ownerUserId: userId });
      conversationIds.push(conversation.id);
      await seedUserMessage(conversation.id, "Hi");

      // Dirty: never enriched. The candidate carries the exact microsecond timestamp.
      const candidates = await aiConversations.listEnrichmentCandidates({ limit: 100 });
      const candidate = candidates.find((entry) => entry.id === conversation.id);
      expect(candidate).toBeDefined();

      // First-message snapshot titles must stay replaceable ('default').
      expect(candidate!.title).toBe("Hi");
      expect(candidate!.titleSource).toBe("default");

      await aiConversations.applyEnrichment({
        conversationId: conversation.id,
        searchSummary: "First indexed summary",
        description: "A greeting.",
        keywords: ["greeting"],
        title: "Greeting chat",
        dirtyAsOf: candidate!.dirtyAsOf,
      });

      // Exactly clean — the millisecond-truncated ISO value would leave it dirty forever.
      expect(await candidateIds()).not.toContain(conversation.id);

      const updated = await aiConversations.getConversation({ conversationId: conversation.id });
      expect(updated?.title).toBe("Greeting chat");
      expect(updated?.titleSource).toBe("auto");
      expect(updated?.description).toBe("A greeting.");
      expect(updated?.descriptionSource).toBe("auto");

      // New activity makes it dirty again.
      await seedUserMessage(conversation.id, "More content");
      expect(await candidateIds()).toContain(conversation.id);
    } finally {
      await cleanupFixture({ userId, conversationIds });
    }
  });

  test("markEnrichmentFailed backs the conversation off and applyEnrichment clears it", async () => {
    const userId = await insertUser();
    const conversationIds: string[] = [];
    try {
      const conversation = await aiConversations.createConversation({ ownerUserId: userId });
      conversationIds.push(conversation.id);
      await seedUserMessage(conversation.id, "Hi");

      expect(await candidateIds()).toContain(conversation.id);

      await aiConversations.markEnrichmentFailed({ conversationId: conversation.id });
      expect(await candidateIds()).not.toContain(conversation.id);

      // Backoff elapsed (fail_count 1 → 10 minutes): simulate by aging the failure marker.
      await sql`UPDATE ai.conversations SET enrich_failed_at = now() - interval '11 minutes' WHERE id = ${conversation.id}::uuid`;
      const candidates = await aiConversations.listEnrichmentCandidates({ limit: 100 });
      const candidate = candidates.find((entry) => entry.id === conversation.id);
      expect(candidate).toBeDefined();
      expect(candidate!.enrichFailCount).toBe(1);

      // A successful enrichment clears the backoff.
      await aiConversations.applyEnrichment({
        conversationId: conversation.id,
        searchSummary: "Recovered summary",
        description: "A greeting.",
        keywords: ["greeting"],
        dirtyAsOf: candidate!.dirtyAsOf,
      });
      const [row] = await sql<{ enrich_fail_count: number; enrich_failed_at: string | null }[]>`
        SELECT enrich_fail_count, enrich_failed_at FROM ai.conversations WHERE id = ${conversation.id}::uuid
      `;
      expect(row?.enrich_fail_count).toBe(0);
      expect(row?.enrich_failed_at).toBeNull();
    } finally {
      await cleanupFixture({ userId, conversationIds });
    }
  });
});
