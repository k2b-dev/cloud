import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { migrate as migrateAuth } from "../../../core/src/migrate/core/auth";
import { migrate as migrateEvents } from "../../../core/src/migrate/core/events";
import { mapFixture } from "./map.test-fixture";
import { aiMapToolResult } from "./map-contracts";
import { AiMapConflict, aiMaps } from "./map-store";
import { migrateCloudAi } from "./migrate";
import { createAiShortId } from "./short-id";
import { aiConversations } from "./store";

const suite = databaseSuite();
const fixture = async () => {
  const suffix = crypto.randomUUID();
  const [user] = await sql<
    { id: string }[]
  >`INSERT INTO auth.users(uid,provider,profile,display_name,mail,given_name,sn) VALUES(${`map-${suffix}`},'local','user','Map Test',${`map-${suffix}@example.test`},'Map','Test') RETURNING id`;
  const owner = user!.id;
  const conversation = await aiConversations.createConversation({ ownerUserId: owner });
  const map = { ...mapFixture(), id: crypto.randomUUID(), conversationId: conversation.shortId };
  await aiMaps.save(conversation.id, owner, { map });
  const [stored] = await sql`SELECT jsonb_typeof(snapshot) AS kind FROM ai.maps WHERE id=${map.id}::uuid`;
  expect(stored.kind).toBe("object");
  return {
    owner,
    conversation,
    map,
    cleanup: async () => {
      await sql`DELETE FROM ai.conversations WHERE created_by_user_id=${owner}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${owner}::uuid`;
    },
  };
};
suite("Assistant durable map isolation", () => {
  let fresh: Awaited<ReturnType<typeof useFreshDatabase>>;
  afterAll(async () => {
    await sql.close();
    await fresh?.drop();
  });
  beforeAll(async () => {
    fresh = await useFreshDatabase("ai_maps");
    await migrateAuth();
    await sql`CREATE SCHEMA settings`;
    await sql`CREATE TABLE settings.entries(key text PRIMARY KEY,value text)`;
    await migrateEvents();
    await migrateCloudAi();
  });
  test("same-map message projection survives follow-ups, leaves text, and forks independent snapshots", async () => {
    const f = await fixture();
    try {
      const insert = async (seq: number, message: unknown, role: string) =>
        sql`INSERT INTO ai.messages(short_id,conversation_id,seq,kind,role,message) VALUES(${createAiShortId()},${f.conversation.id}::uuid,${seq},'message',${role},${JSON.stringify(message)}::text::jsonb)`;
      await insert(1, { role: "user", content: [{ type: "text", text: "Keep this question" }] }, "user");
      await insert(2, { role: "tool_result", callId: "map-first", name: "map", result: aiMapToolResult(f.map, true) }, "tool_result");
      await insert(3, { role: "assistant", content: [{ type: "text", text: "Keep this answer" }] }, "assistant");
      const next = { ...f.map, revision: 2, title: "Updated map" };
      await aiMaps.save(f.conversation.id, f.owner, { map: next }, 1);
      const [persisted] = await sql<{ kind: string }[]>`SELECT jsonb_typeof(snapshot) AS kind FROM ai.maps WHERE id=${f.map.id}::uuid`;
      expect(persisted?.kind).toBe("object");
      const history = await aiConversations.listMessages({ conversationId: f.conversation.id });
      expect(JSON.stringify(history)).toContain("Keep this question");
      expect(JSON.stringify(history)).toContain("Keep this answer");
      expect(JSON.stringify(history)).toContain("Updated map");
      const fork = await aiConversations.forkConversation({ sourceConversationId: f.conversation.id, ownerUserId: f.owner, throughSeq: 3 });
      const forked = await aiConversations.listMessages({ conversationId: fork.id });
      const tool = forked.find((m) => m.message.role === "tool_result")!;
      if (tool.message.role !== "tool_result") throw new Error("missing map");
      const { AiMapToolResultSchema } = await import("./map-contracts");
      const result = AiMapToolResultSchema.parse(tool.message.result);
      expect(result.map.id).not.toBe(f.map.id);
      expect(result.map.conversationId).toBe(fork.shortId);
      const [forkStorage] = await sql<
        { kind: string }[]
      >`SELECT jsonb_typeof(snapshot) AS kind FROM ai.maps WHERE id=${result.map.id}::uuid`;
      expect(forkStorage?.kind).toBe("object");
      expect((await aiMaps.read(fork.id, result.map.id))?.map.title).toBe("Updated map");
      await aiMaps.save(f.conversation.id, f.owner, { map: { ...next, revision: 3, title: "Source changed" } }, 2);
      expect((await aiMaps.read(fork.id, result.map.id))?.map.title).toBe("Updated map");
    } finally {
      await f.cleanup();
    }
  });
  test("an interrupted prepared map is rediscovered from its original call and copied on fork", async () => {
    const f = await fixture();
    try {
      await aiMaps.save(
        f.conversation.id,
        f.owner,
        {
          map: { ...f.map, revision: 2, pending: true, originCallId: "map-aborted" },
          retry: { type: "places", search: { title: "Museen", categories: ["museum"], near: "Ulm" } },
        },
        1,
      );
      await sql`INSERT INTO ai.messages(short_id,conversation_id,seq,kind,role,message) VALUES(${createAiShortId()},${f.conversation.id}::uuid,1,'message','assistant',${JSON.stringify({ role: "assistant", content: [{ type: "tool_call", id: "map-aborted", name: "map", args: {} }] })}::text::jsonb)`;
      const [persisted] = await sql<{ kind: string }[]>`SELECT jsonb_typeof(snapshot) AS kind FROM ai.maps WHERE id=${f.map.id}::uuid`;
      expect(persisted?.kind).toBe("object");
      const history = await aiConversations.listMessages({ conversationId: f.conversation.id });
      expect(history[0]?.meta?.toolInterimResults?.["map-aborted"]).toHaveProperty("map.id", f.map.id);
      const fork = await aiConversations.forkConversation({ sourceConversationId: f.conversation.id, ownerUserId: f.owner, throughSeq: 1 });
      const copied = await aiConversations.listMessages({ conversationId: fork.id });
      const { AiMapToolResultSchema } = await import("./map-contracts");
      const result = AiMapToolResultSchema.parse(copied[0]?.meta?.toolInterimResults?.["map-aborted"]);
      expect(result.map.id).not.toBe(f.map.id);
      expect(result.map.conversationId).toBe(fork.shortId);
    } finally {
      await f.cleanup();
    }
  });
  test("owner and conversation boundaries, stale CAS and concurrent provider work", async () => {
    const a = await fixture(),
      b = await fixture();
    try {
      expect(await aiMaps.read(b.conversation.id, a.map.id)).toBeNull();
      await expect(aiMaps.save(a.conversation.id, b.owner, { map: { ...a.map, revision: 2 } }, 1)).rejects.toThrow("MAP_FORBIDDEN");
      let calls = 0;
      const held = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const first = aiMaps.mutate(a.conversation.id, a.owner, 1, a.map.id, async (before) => {
        calls++;
        entered.resolve();
        await held.promise;
        return { map: { ...before.map, revision: 2 } };
      });
      await entered.promise;
      try {
        await expect(
          aiMaps.mutate(a.conversation.id, a.owner, 1, a.map.id, async (before) => {
            calls++;
            return before;
          }),
        ).rejects.toBeInstanceOf(AiMapConflict);
      } finally {
        held.resolve();
      }
      await first;
      expect(calls).toBe(1);
      await expect(aiMaps.save(a.conversation.id, a.owner, { map: { ...a.map, revision: 2 } }, 1)).rejects.toBeInstanceOf(AiMapConflict);
      await sql`UPDATE ai.conversations SET created_by_user_id=${b.owner}::uuid WHERE id=${a.conversation.id}::uuid`;
      await expect(aiMaps.mutate(a.conversation.id, a.owner, 2, a.map.id, async (before) => before)).rejects.toThrow("MAP_FORBIDDEN");
      await sql`UPDATE ai.conversations SET created_by_user_id=${a.owner}::uuid WHERE id=${a.conversation.id}::uuid`;
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });
});
