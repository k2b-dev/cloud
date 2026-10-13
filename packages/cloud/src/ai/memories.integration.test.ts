import { beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { aiMemories, formatAiMemories, isAiMemoryBm25CapabilityError } from "./memories";
import { migrateCloudAi } from "./migrate";
import { AI_SHORT_ID_PATTERN, createAiShortId } from "./short-id";

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

const insertRecentMemories = async (userId: string): Promise<void> => {
  for (let index = 0; index < 21; index += 1) {
    await aiMemories.create({ userId, kind: "fact", content: `Ordinary durable fact ${index}.` });
  }
};

databaseSuite()("aiMemories (integration)", () => {
  beforeAll(async () => {
    await migrateCloudAi();
  });
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
      const pinned = await aiMemories.create({
        userId,
        kind: "preference",
        content: "Always answer concisely.",
        priority: "pinned",
      });
      const relevant = await aiMemories.create({ userId, kind: "fact", content: "The preferred deployment color is cobalt." });
      await sql`UPDATE ai.memories SET updated_at = now() - interval '30 days' WHERE user_id = ${userId}::uuid`;
      await insertRecentMemories(userId);

      const hot = await aiMemories.selectHot(userId, "Which deployment color do I prefer?");
      expect(hot.memories[0]?.id).toBe(pinned.id);
      expect(hot.memories.some((memory) => memory.id === relevant.id)).toBe(true);
      expect(hot.memories.length).toBeLessThanOrEqual(20);
      expect(hot.truncated).toBe(true);
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("long messages select old matches without selecting stop-word overlap", async () => {
    const userId = await insertUser();
    try {
      const relevant = await aiMemories.create({ userId, kind: "fact", content: "The preferred deployment color is cobalt." });
      const stopWords = await aiMemories.create({ userId, kind: "fact", content: "It is what it is." });
      await sql`UPDATE ai.memories SET updated_at = now() - interval '30 days' WHERE user_id = ${userId}::uuid`;
      await insertRecentMemories(userId);

      const message = `I was thinking about cobalt while walking through the park this morning, but most of what
        I want to discuss today is about something else entirely. There were birds near the pond and people
        sitting under trees with their lunches. It is what it is, and I do not know whether the weather will
        stay warm for the rest of the week. We could take a train somewhere quieter on Saturday or simply
        walk along the river after breakfast. Please consider how we might arrange the afternoon so that
        everyone has enough time to relax before returning home. There is no need to make a detailed schedule
        yet because we have not decided who will join us or where we would like to go.`;
      const hot = await aiMemories.selectHot(userId, message);
      expect(hot.memories[0]?.id).toBe(relevant.id);
      expect(hot.memories.some((memory) => memory.id === stopWords.id)).toBe(false);
      expect(hot.memories).toHaveLength(20);
      expect(hot.truncated).toBe(true);
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("a keyword at the end of a long message still selects its memory", async () => {
    const userId = await insertUser();
    try {
      const relevant = await aiMemories.create({ userId, kind: "fact", content: "The preferred deployment color is cobalt." });
      for (let index = 0; index < 25; index += 1) {
        await aiMemories.create({ userId, kind: "fact", content: `The user mentioned the park and the river walk ${index}.` });
      }
      await sql`UPDATE ai.memories SET updated_at = now() - interval '30 days' WHERE user_id = ${userId}::uuid`;
      await insertRecentMemories(userId);

      const message = `Yesterday I visited the park beside the river for a pleasant walk with friends after breakfast.
        We watched birds gather near the pond while children played beneath tall trees and families shared lunches.
        Later we discussed possible weekend trips through quiet villages, nearby forests, coastal paths, mountain trails,
        historic gardens, busy markets, small museums, comfortable cafes, local libraries, and outdoor concerts.
        Everyone suggested different activities, including cycling, swimming, painting, photography, cooking, reading,
        gardening, climbing, dancing, sailing, hiking, fishing, knitting, drawing, and learning unfamiliar musical instruments.
        We agreed to leave plenty of room for rest before returning home. Which cobalt shade did I pick?`;
      const hot = await aiMemories.selectHot(userId, message);
      expect(hot.memories[0]?.id).toBe(relevant.id);
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("very long messages consider both ends and ignore the middle", async () => {
    const userId = await insertUser();
    try {
      const first = await aiMemories.create({ userId, kind: "fact", content: "Cobalt." });
      const middle = await aiMemories.create({ userId, kind: "fact", content: "Amber." });
      const last = await aiMemories.create({ userId, kind: "fact", content: "Saffron." });
      await sql`UPDATE ai.memories SET updated_at = now() - interval '30 days' WHERE user_id = ${userId}::uuid`;
      await insertRecentMemories(userId);

      const message = `cobalt ${" ".repeat(5_993)}amber${" ".repeat(6_000)} saffron`;
      const hot = await aiMemories.selectHot(userId, message);
      expect(hot.memories.slice(0, 2).map((memory) => memory.id)).toEqual(expect.arrayContaining([first.id, last.id]));
      expect(hot.memories.some((memory) => memory.id === middle.id)).toBe(false);
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("a repeated word does not outrank two distinct matching words", async () => {
    const userId = await insertUser();
    try {
      const repeated = await aiMemories.create({ userId, kind: "fact", content: "Cobalt cobalt cobalt." });
      const distinct = await aiMemories.create({ userId, kind: "fact", content: "Cobalt saffron." });
      await sql`UPDATE ai.memories SET updated_at = now() - interval '30 days' WHERE user_id = ${userId}::uuid`;
      await insertRecentMemories(userId);

      const hot = await aiMemories.selectHot(userId, "Compare cobalt and saffron");
      expect(hot.memories.slice(0, 2).map((memory) => memory.id)).toEqual([distinct.id, repeated.id]);
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  for (const { content, message } of [
    { content: "My manager is anna@example.com.", message: "Write to anna@example.com" },
    { content: "The NAS is at 10.0.0.5.", message: "ping 10.0.0.5" },
    { content: "Settings live in config.ts.", message: "open config.ts" },
    { content: "Production runs v2.3.", message: "upgrade to v2.3" },
    { content: "मुझे हिन्दी पसंद है", message: "पसंद" },
  ]) {
    test(`addresses, versions, and file names match as whole tokens: ${message}`, async () => {
      const userId = await insertUser();
      try {
        const relevant = await aiMemories.create({ userId, kind: "fact", content });
        const emailLookalike = message.includes("anna@example.com")
          ? await aiMemories.create({ userId, kind: "fact", content: "Anna likes example code." })
          : null;
        await sql`UPDATE ai.memories SET updated_at = now() - interval '30 days' WHERE user_id = ${userId}::uuid`;
        await insertRecentMemories(userId);

        const hot = await aiMemories.selectHot(userId, message);
        expect(hot.memories[0]?.id).toBe(relevant.id);
        if (emailLookalike) {
          expect(hot.memories.some((memory) => memory.id === emailLookalike.id)).toBe(false);
        }
      } finally {
        await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
      }
    });
  }

  test("more matching terms rank first after pinned memories", async () => {
    const userId = await insertUser();
    try {
      const pinned = await aiMemories.create({ userId, kind: "preference", content: "Keep answers concise.", priority: "pinned" });
      const oneTerm = await aiMemories.create({ userId, kind: "fact", content: "Cobalt." });
      const twoTerms = await aiMemories.create({ userId, kind: "fact", content: "Cobalt saffron." });
      await sql`UPDATE ai.memories SET updated_at = now() - interval '30 days' WHERE user_id = ${userId}::uuid`;
      await insertRecentMemories(userId);

      const hot = await aiMemories.selectHot(userId, "Could you compare cobalt and saffron for tomorrow's presentation?");
      expect(hot.memories.slice(0, 3).map((memory) => memory.id)).toEqual([pinned.id, twoTerms.id, oneTerm.id]);
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  for (const { language, content, message } of [
    { language: "English", content: "The preferred deployment color is cobalt.", message: "How should I arrange my deployments?" },
    {
      language: "German",
      content: "Die bevorzugte Farbe für Präsentationen ist Kobaltblau.",
      message: "Welche Farben nutze ich für meine Folien?",
    },
  ]) {
    test(`${language} word stems select old memories`, async () => {
      const userId = await insertUser();
      try {
        const relevant = await aiMemories.create({ userId, kind: "fact", content });
        await sql`UPDATE ai.memories SET updated_at = now() - interval '30 days' WHERE user_id = ${userId}::uuid`;
        await insertRecentMemories(userId);

        const hot = await aiMemories.selectHot(userId, message);
        expect(hot.memories[0]?.id).toBe(relevant.id);
      } finally {
        await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
      }
    });
  }

  test("query syntax and punctuation cannot interfere with relevance", async () => {
    const userId = await insertUser();
    try {
      const relevant = await aiMemories.create({ userId, kind: "fact", content: "The preferred deployment color is cobalt." });
      await sql`UPDATE ai.memories SET updated_at = now() - interval '30 days' WHERE user_id = ${userId}::uuid`;
      await insertRecentMemories(userId);

      const hot = await aiMemories.selectHot(userId, String.raw`' '' \ | & ! ( ) :* <-> -word "quoted" OR AND NOT 😀 ½ COBALT`);
      expect(hot.memories[0]?.id).toBe(relevant.id);
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  for (const { label, message } of [
    { label: "stop words", message: "the and it is what und die ist für" },
    { label: "punctuation", message: String.raw`' '' \ | & ! ( ) :* <-> 😀 ½` },
    { label: "an empty message", message: "" },
  ]) {
    test(`${label} fall back to pinned and recent memories`, async () => {
      const userId = await insertUser();
      try {
        const pinned = await aiMemories.create({ userId, kind: "preference", content: "Keep answers concise.", priority: "pinned" });
        const old = await aiMemories.create({ userId, kind: "fact", content: "It is what it is." });
        await sql`UPDATE ai.memories SET updated_at = now() - interval '30 days' WHERE user_id = ${userId}::uuid`;
        await insertRecentMemories(userId);
        const expected = await aiMemories.list({ userId, limit: 20 });

        const hot = await aiMemories.selectHot(userId, message);
        expect(hot.memories.map((memory) => memory.id)).toEqual(expected.map((memory) => memory.id));
        expect(hot.memories[0]?.id).toBe(pinned.id);
        expect(hot.memories.some((memory) => memory.id === old.id)).toBe(false);
        expect(hot.truncated).toBe(true);
      } finally {
        await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
      }
    });
  }

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

  test("background proposals do not write from an archived source chat", async () => {
    const userId = await insertUser();
    try {
      const conversationId = await insertConversation(userId, "Archived source");
      const memory = await aiMemories.create({
        userId,
        kind: "preference",
        content: "Prefers short answers.",
        source: "background",
        sourceConversationId: conversationId,
      });
      await sql`UPDATE ai.conversations SET archived_at = now() WHERE id = ${conversationId}::uuid`;

      expect(
        await aiMemories.applyBackgroundProposal({
          userId,
          sourceConversationId: conversationId,
          proposal: { action: "add", kind: "preference", content: "Prefers German answers.", memoryIds: [], resourceRef: null },
        }),
      ).toEqual([]);
      expect(
        await aiMemories.applyBackgroundProposal({
          userId,
          sourceConversationId: conversationId,
          proposal: { action: "retire", kind: "preference", content: "", memoryIds: [memory.shortId], resourceRef: null },
        }),
      ).toEqual([]);
      expect((await aiMemories.list({ userId })).map((item) => item.id)).toEqual([memory.id]);
    } finally {
      await sql`DELETE FROM ai.conversations WHERE created_by_user_id = ${userId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("only known BM25 capability failures may downgrade search", () => {
    expect(isAiMemoryBm25CapabilityError({ code: "42883" })).toBe(true);
    expect(isAiMemoryBm25CapabilityError({ code: "57014" })).toBe(false);
    expect(isAiMemoryBm25CapabilityError(new Error("connection failed"))).toBe(false);
  });
});
