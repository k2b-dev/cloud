import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { aiMemories, formatAiMemories, isAiMemoryBm25CapabilityError } from "./memories";
import { migrateCloudAi } from "./migrate";
import { AI_SHORT_ID_PATTERN, createAiShortId } from "./short-id";

const canUseAiDatabase = async () => {
  try {
    const [authRow] = await sql<{ users: string | null }[]>`SELECT to_regclass('auth.users')::text AS users`;
    if (!authRow?.users) return false;
    await migrateCloudAi();
    const [aiRow] = await sql<{ memories: string | null }[]>`SELECT to_regclass('ai.memories')::text AS memories`;
    return Boolean(aiRow?.memories);
  } catch {
    return false;
  }
};

const insertUser = async () => {
  const suffix = crypto.randomUUID();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
    VALUES (${`ai-memory-${suffix}`}, 'local', 'user', 'AI Memory Test', ${`ai-memory-${suffix}@example.test`}, 'AI', 'Memory')
    RETURNING id
  `;
  return row!.id;
};

const insertConversation = async (userId: string, title: string): Promise<string> => {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO ai.conversations (short_id, created_by_user_id, title)
    VALUES (${createAiShortId()}, ${userId}::uuid, ${title})
    RETURNING id
  `;
  return row!.id;
};

describe.skipIf(!(await canUseAiDatabase()))("aiMemories (integration)", () => {
  test("owns, searches, updates, pins, and soft-deletes atomic memories", async () => {
    const firstUser = await insertUser();
    const secondUser = await insertUser();
    try {
      const fact = await aiMemories.create({ userId: firstUser, kind: "fact", content: "Studies computer science at Uni Ulm." });
      const preference = await aiMemories.create({
        userId: firstUser,
        kind: "preference",
        content: "  Prefers   concise German answers. ",
      });
      await aiMemories.create({ userId: secondUser, kind: "fact", content: "Studies chemistry." });

      expect(fact.shortId).toMatch(AI_SHORT_ID_PATTERN);
      expect(preference.shortId).toMatch(AI_SHORT_ID_PATTERN);
      expect((await aiMemories.list({ userId: firstUser })).map((memory) => memory.id)).toEqual([preference.id, fact.id]);
      expect((await aiMemories.list({ userId: firstUser, query: "German" })).map((memory) => memory.id)).toEqual([preference.id]);
      expect(await aiMemories.get(secondUser, fact.id)).toBeNull();

      const updated = await aiMemories.update(firstUser, fact.id, { content: "Studies software engineering.", priority: "pinned" });
      expect(updated?.content).toBe("Studies software engineering.");
      expect(updated?.priority).toBe("pinned");

      expect(await aiMemories.delete(secondUser, fact.id)).toBe(false);
      expect(await aiMemories.delete(firstUser, fact.id)).toBe(true);
      expect(await aiMemories.get(firstUser, fact.id)).toBeNull();
      expect(await aiMemories.wasDeleted(firstUser, "Studies software engineering.")).toBe(true);
    } finally {
      await sql`DELETE FROM auth.users WHERE id IN (${firstUser}::uuid, ${secondUser}::uuid)`;
    }
  });

  test("hot selection keeps all small sets and obeys the prompt budget", async () => {
    const userId = await insertUser();
    try {
      for (let index = 0; index < 4; index += 1) {
        await aiMemories.create({ userId, kind: "fact", content: `Durable memory ${index}.` });
      }
      const hot = await aiMemories.selectHot(userId, "unrelated request");
      expect(hot.memories).toHaveLength(4);
      expect(hot.text).toContain("Durable memory 0.");
      expect(formatAiMemories(hot.memories, 40).included.length).toBeLessThan(4);
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("large sets keep pinned memories and select lexical matches", async () => {
    const userId = await insertUser();
    try {
      for (let index = 0; index < 21; index += 1) {
        await aiMemories.create({ userId, kind: "fact", content: `Ordinary durable fact ${index}.` });
      }
      const pinned = await aiMemories.create({
        userId,
        kind: "preference",
        content: "Always answer concisely.",
        priority: "pinned",
      });
      const relevant = await aiMemories.create({ userId, kind: "fact", content: "The preferred deployment color is cobalt." });

      const hot = await aiMemories.selectHot(userId, "Which deployment color do I prefer?");
      expect(hot.memories[0]?.id).toBe(pinned.id);
      expect(hot.memories.some((memory) => memory.id === relevant.id)).toBe(true);
      expect(hot.memories.length).toBeLessThanOrEqual(20);
      expect(hot.truncated).toBe(true);
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("supersedes duplicate corrections without crossing user ownership", async () => {
    const firstUser = await insertUser();
    const secondUser = await insertUser();
    try {
      const stale = await aiMemories.create({ userId: firstUser, kind: "preference", content: "Prefers long answers." });
      const current = await aiMemories.create({ userId: firstUser, kind: "preference", content: "Prefers concise answers." });

      expect(await aiMemories.supersede(secondUser, stale.id, current.id)).toBe(false);
      expect(await aiMemories.supersede(firstUser, stale.id, current.id)).toBe(true);
      expect(await aiMemories.get(firstUser, stale.id)).toBeNull();
      expect((await aiMemories.list({ userId: firstUser })).map((memory) => memory.id)).toEqual([current.id]);
    } finally {
      await sql`DELETE FROM auth.users WHERE id IN (${firstUser}::uuid, ${secondUser}::uuid)`;
    }
  });

  test("applies background merge, retire, and workflow changes without touching protected or cross-user data", async () => {
    const firstUser = await insertUser();
    const secondUser = await insertUser();
    const firstConversation = await insertConversation(firstUser, "First user source");
    const secondConversation = await insertConversation(secondUser, "Second user source");
    try {
      const first = await aiMemories.create({
        userId: firstUser,
        kind: "preference",
        content: "Prefers short answers.",
        source: "background",
        sourceConversationId: firstConversation,
      });
      const second = await aiMemories.create({
        userId: firstUser,
        kind: "preference",
        content: "Prefers answers without long introductions.",
        source: "background",
        sourceConversationId: firstConversation,
      });
      const pinned = await aiMemories.create({
        userId: firstUser,
        kind: "fact",
        content: "Name is Valentin.",
        priority: "pinned",
        source: "user",
      });

      expect(
        await aiMemories.applyBackgroundProposal({
          userId: firstUser,
          sourceConversationId: secondConversation,
          proposal: {
            action: "merge",
            kind: "preference",
            content: "Prefers short answers without long introductions.",
            memoryIds: [first.shortId, second.shortId],
            resourceRef: null,
          },
        }),
      ).toEqual([]);

      const merged = await aiMemories.applyBackgroundProposal({
        userId: firstUser,
        sourceConversationId: firstConversation,
        proposal: {
          action: "merge",
          kind: "preference",
          content: "Prefers short answers without long introductions.",
          memoryIds: [first.shortId, second.shortId],
          resourceRef: null,
        },
      });
      expect(merged).toMatchObject([{ action: "merged", kind: "preference" }]);

      expect(
        await aiMemories.applyBackgroundProposal({
          userId: firstUser,
          sourceConversationId: firstConversation,
          proposal: { action: "retire", kind: "fact", content: "", memoryIds: [pinned.shortId], resourceRef: null },
        }),
      ).toEqual([]);
      expect(await aiMemories.get(firstUser, pinned.id)).not.toBeNull();

      const workflow = await aiMemories.applyBackgroundProposal({
        userId: firstUser,
        sourceConversationId: firstConversation,
        proposal: {
          action: "add",
          kind: "workflow",
          content: "Uses Accounting for invoice-related mail.",
          memoryIds: [],
          resourceRef: { type: "mail.mailbox", id: "Box123" },
        },
      });
      expect(workflow).toMatchObject([{ action: "added", kind: "workflow" }]);
      const savedWorkflow = (await aiMemories.list({ userId: firstUser })).find((memory) => memory.kind === "workflow");
      expect(savedWorkflow?.resourceRef).toEqual({ type: "mail.mailbox", id: "Box123" });
      expect(formatAiMemories(savedWorkflow ? [savedWorkflow] : []).text).toContain("mail.mailbox:Box123");

      const activeMerged = (await aiMemories.list({ userId: firstUser })).find(
        (memory) => memory.content === "Prefers short answers without long introductions.",
      );
      expect(activeMerged).toBeDefined();
      const retired = await aiMemories.applyBackgroundProposal({
        userId: firstUser,
        sourceConversationId: firstConversation,
        proposal: {
          action: "retire",
          kind: "preference",
          content: "",
          memoryIds: [activeMerged!.shortId],
          resourceRef: null,
        },
      });
      expect(retired).toMatchObject([{ action: "retired", kind: "preference" }]);
      expect(await aiMemories.get(firstUser, activeMerged!.id)).toBeNull();
    } finally {
      await sql`DELETE FROM auth.users WHERE id IN (${firstUser}::uuid, ${secondUser}::uuid)`;
    }
  });

  test("only known BM25 capability failures may downgrade search", () => {
    expect(isAiMemoryBm25CapabilityError({ code: "42883" })).toBe(true);
    expect(isAiMemoryBm25CapabilityError({ code: "57014" })).toBe(false);
    expect(isAiMemoryBm25CapabilityError(new Error("connection failed"))).toBe(false);
  });
});
