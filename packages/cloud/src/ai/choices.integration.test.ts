import { beforeAll, expect, spyOn, test } from "bun:test";
import { z } from "zod";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { compileCapabilities } from "../_internal/capabilities";
import { migrateCloudCapabilities, recordCapabilityExecution } from "../capabilities/executions";
import { defineCapabilities } from "../contracts/capabilities";
import { sql } from "../runtime/clients";
import { accounts } from "../services/accounts";
import { buildAiCapabilityCatalog } from "./capabilities";
import { createAiChoiceRoutes } from "./choice-routes";
import { migrateCloudAi } from "./migrate";
import { personalAiModelPolicy } from "./personal-agent";
import { publicAiStoredMessages } from "./public-projection";
import { aiQuoteModelText } from "./quote-markers";
import { resolveAiQuotes } from "./quote-sources";
import { aiConversations } from "./store";

const suite = databaseSuite();
const catalog = buildAiCapabilityCatalog([
  {
    appId: "art",
    appName: "Art",
    appIcon: "ti ti-box",
    appDescription: "Art",
    endpoint: "http://art:3000",
    manifest: compileCapabilities(
      "art",
      defineCapabilities({
        protocolVersion: 2,
        queries: {
          inspect: {
            title: "Inspect",
            description: "Inspect one category",
            input: z.strictObject({ category: z.string().describe("Category") }),
            data: z.object({}),
            openWorld: false,
            run: async () => ({ ok: true, data: { data: {} } }),
          },
        },
      }),
    ).manifest,
  },
]);

const fixture = async () => {
  const suffix = crypto.randomUUID();
  const [row] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name, given_name, sn)
    VALUES (${`choice-${suffix}`}, 'local', 'user', 'Choice Person', 'Choice', 'Person') RETURNING id`;
  const user = await accounts.users.get({ id: row!.id });
  if (!user) throw new Error("Missing fixture user");
  const conversation = await aiConversations.createConversation({ ownerUserId: user.id });
  const config = {
    kind: "chat" as const,
    input: "Hi",
    locale: "de",
    actor: { kind: "user" as const, user },
    toolSource: { kind: "default" as const, appTools: true },
  };
  const source = await aiConversations.submitChatTurn({
    conversationId: conversation.id,
    modelId: "mock",
    runConfig: config,
    userMessage: { role: "user", content: [{ type: "text", text: "Hi" }] },
  });
  const session = aiConversations.createSessionStore({
    conversationId: conversation.id,
    turnId: source.turn.id,
    toolPresentations: new Map([
      [
        "art__query__categories",
        { kind: "capability", appId: "art", appName: "Art", appIcon: "ti ti-box", title: "Categories", capabilityKind: "query" },
      ],
    ]),
  });
  await session.append({
    role: "assistant",
    content: [{ type: "tool_call", id: "source-call", name: "art__query__categories", args: {} }],
  });
  const result = {
    data: {
      options: [
        { id: "jug", title: "Jugendstil" },
        { id: "modern", title: "Moderne" },
      ],
    },
    view: {
      version: 1,
      blocks: [
        {
          kind: "Choice",
          id: "category",
          title: "Kategorie?",
          submit: "Wählen",
          mode: "one",
          options: { from: ["options"] },
          option: { id: ["id"], title: ["title"] },
          then: { query: "art.query.inspect", input: { category: "old" }, field: "category" },
        },
      ],
    },
  };
  await session.append({ role: "tool_result", callId: "source-call", name: "art__query__categories", result });
  await sql`UPDATE ai.turns SET status = 'completed', completed_at = '2026-11-08T12:00:00Z' WHERE id = ${source.turn.id}::uuid`;
  const submit = (ids = ["jug"]) =>
    aiConversations.submitChatTurn({
      conversationId: conversation.id,
      modelId: "mock",
      runConfig: config,
      userMessage: { role: "user", content: [{ type: "text", text: "untrusted placeholder" }] },
      choice: { turnId: source.turn.id, toolCallId: "source-call", blockId: "category", ids, catalog },
    });
  const cleanup = async () => {
    await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
    await sql`DELETE FROM auth.users WHERE id = ${user.id}::uuid`;
  };
  return { user, conversation, source, submit, cleanup, result };
};

suite("choice admission transaction", () => {
  beforeAll(async () => {
    await migrateCloudAi();
    await migrateCloudCapabilities();
  });
  test("archiving after loading a choice returns 409 without admitting another turn", async () => {
    const f = await fixture();
    try {
      const routes = createAiChoiceRoutes({
        resolveContext: async () => ({
          actor: { kind: "user", user: f.user },
          ownerUserId: f.user.id,
          modelPolicy: personalAiModelPolicy,
          toolApprovalContext: { actorUserId: f.user.id },
          toolApprovalChangeContext: { actorUserId: f.user.id, actor: { kind: "user", user: f.user }, requestId: null },
          signedInSession: true,
        }),
        submit: async () => {
          expect(await aiConversations.archiveConversation({ conversationId: f.conversation.id, ownerUserId: f.user.id })).not.toBe(false);
          await f.submit();
          return new Response(null, { status: 201 });
        },
      });
      const response = await routes.request(`/${f.conversation.shortId}/choices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turnId: f.source.turn.shortId, toolCallId: "source-call", blockId: "category", ids: ["jug"] }),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ code: "choice_closed", message: "choice_closed" });
      const turns = await sql<{ id: string }[]>`SELECT id FROM ai.turns WHERE conversation_id=${f.conversation.id}::uuid`;
      expect(turns.map((turn) => turn.id)).toEqual([f.source.turn.id]);
      expect((await aiConversations.listMessages({ conversationId: f.conversation.id })).filter((message) => message.meta?.choice)).toEqual(
        [],
      );
    } finally {
      await f.cleanup();
    }
  });
  test("busy, wrong ids, and mode-one multiselection return conflicts without writing a choice", async () => {
    const f = await fixture();
    try {
      for (const ids of [[], ["wrong"], ["jug", "modern"]]) await expect(f.submit(ids)).rejects.toThrow("choice_invalid");
      await sql`UPDATE ai.turns SET status = 'running' WHERE id = ${f.source.turn.id}::uuid`;
      await expect(f.submit()).rejects.toThrow("choice_busy");
      expect(
        (await aiConversations.listMessages({ conversationId: f.conversation.id })).filter((message) => message.meta?.choice),
      ).toHaveLength(0);
    } finally {
      await f.cleanup();
    }
  });
  test("one concurrent answer wins; provenance, turn, and first Query commit together and survive reload", async () => {
    const f = await fixture();
    try {
      const results = await Promise.allSettled([f.submit(), f.submit()]);
      const wins = results.filter((result) => result.status === "fulfilled");
      expect(wins).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      const won = wins[0];
      if (won?.status !== "fulfilled") throw new Error("No admitted choice");
      const run = await aiConversations.getTurnRunConfig({ conversationId: f.conversation.id, turnId: won.value.turn.id });
      if (!run || run.kind === "compact") throw new Error("Missing choice run");
      const messages = await aiConversations.listTurnMessages({ conversationId: f.conversation.id, loopId: won.value.turn.id });
      expect(messages).toHaveLength(2);
      expect(messages[0]?.message).toEqual({
        role: "user",
        content: [{ type: "text", text: "Gewählt in Art · Kategorie?: Jugendstil (jug)" }],
      });
      expect(messages[0]?.meta?.choice).toMatchObject({ appName: "Art", ids: ["jug"], labels: ["Jugendstil"] });
      expect(messages[1]?.message).toMatchObject({
        role: "assistant",
        content: [{ type: "tool_call", id: run.choiceCall?.callId, name: "art__query__inspect", args: { category: "jug" } }],
      });
      const projected = await publicAiStoredMessages(
        await aiConversations.listMessages({ conversationId: f.conversation.id }),
        f.conversation,
        undefined,
        { locale: "de" },
      );
      expect(projected.find((message) => message.message.role === "tool_result")?.meta?.resultChoice).toMatchObject({
        state: "answered",
        chosen: ["jug"],
      });
      expect(projected.find((message) => message.meta?.choice)?.meta?.choice?.turnId).toBe(f.source.turn.shortId);
      await sql`UPDATE ai.turns SET status = 'completed' WHERE id = ${won.value.turn.id}::uuid`;
      await expect(f.submit()).rejects.toThrow("choice_closed");
    } finally {
      await f.cleanup();
    }
  });
  test("writer projection keeps choice history lazy and uses public turn ids", async () => {
    const f = await fixture();
    const list = spyOn(aiConversations, "listChoiceMessages");
    const meter = await meterSql();
    try {
      const answer = await f.submit();
      await sql`UPDATE ai.turns SET status='completed' WHERE id=${answer.turn.id}::uuid`;
      const initial = (await aiConversations.listTurnMessages({ conversationId: f.conversation.id, loopId: f.source.turn.id }))[0]!;
      const quotes = await resolveAiQuotes(f.conversation.id, [{ messageId: initial.shortId, text: "Hi" }], aiConversations);
      const quoted = await aiConversations.submitChatTurn({
        conversationId: f.conversation.id,
        modelId: "mock",
        runConfig: {
          kind: "chat",
          input: "Quoted reply",
          toolSource: { kind: "none" },
          quotes,
          writerOrigin: { kind: "person", id: f.user.id },
        },
        userMessage: {
          role: "user",
          content: [
            { type: "text", text: "Quoted reply" },
            { type: "text", text: aiQuoteModelText(quotes[0]!) },
          ],
        },
      });
      const all = await aiConversations.listMessages({ conversationId: f.conversation.id });
      const plain = all.filter(
        (message) => message.message.role === "user" && !message.meta?.choice && message.loopId === f.source.turn.id,
      );
      const without = await meter.during(async () => {
        const projected = await publicAiStoredMessages(plain, f.conversation, undefined, { locale: "en" });
        expect(projected.every((message) => message.loopId === f.source.turn.shortId)).toBeTrue();
        expect(projected[0]?.meta?.origin).toMatchObject({ kind: "person", name: "Choice Person" });
      });
      expect(list).not.toHaveBeenCalled();
      let projected: Awaited<ReturnType<typeof publicAiStoredMessages>> = [];
      const withChoice = await meter.during(async () => {
        projected = await publicAiStoredMessages(all, f.conversation, undefined, { locale: "en" });
      });
      expect(list).toHaveBeenCalledTimes(1);
      // Choice history adds its single read; choice turn IDs ride the existing origin/turn lookup.
      expect(withChoice.length - without.length).toBe(1);
      expect(withChoice.filter((text) => text.includes("display_name AS name"))).toHaveLength(1);
      expect(projected.find((message) => message.meta?.choice)?.meta?.choice?.turnId).toBe(f.source.turn.shortId);
      expect(
        projected
          .filter((message) => message.loopId)
          .every((message) => [f.source.turn.shortId, answer.turn.shortId, quoted.turn.shortId].includes(message.loopId!)),
      ).toBeTrue();
      expect(projected.find((message) => message.message.role === "tool_result")?.meta?.resultChoice).toMatchObject({
        state: "answered",
        chosen: ["jug"],
      });
      expect(projected.find((message) => message.id === quoted.message.shortId)?.meta?.quotes).toEqual(quotes);
      expect(JSON.stringify(projected)).not.toContain('"writerOrigin"');
    } finally {
      list.mockRestore();
      await meter.close();
      await f.cleanup();
    }
  });
  test("newer open choices supersede older choices under the same lock", async () => {
    const f = await fixture();
    try {
      const later = await aiConversations.submitChatTurn({
        conversationId: f.conversation.id,
        modelId: "mock",
        runConfig: {
          kind: "chat",
          input: "Later",
          actor: { kind: "user", user: f.user },
        },
        userMessage: { role: "user", content: [{ type: "text", text: "Later" }] },
      });
      const session = aiConversations.createSessionStore({
        conversationId: f.conversation.id,
        turnId: later.turn.id,
        toolPresentations: new Map([
          [
            "art__query__categories",
            { kind: "capability", appId: "art", appName: "Art", appIcon: "ti ti-box", title: "Categories", capabilityKind: "query" },
          ],
        ]),
      });
      await session.append({ role: "assistant", content: [{ type: "tool_call", id: "later", name: "art__query__categories", args: {} }] });
      await session.append({ role: "tool_result", name: "art__query__categories", callId: "later", result: f.result });
      await sql`UPDATE ai.turns SET status = 'completed' WHERE id = ${later.turn.id}::uuid`;
      await expect(f.submit()).rejects.toThrow("choice_closed");
    } finally {
      await f.cleanup();
    }
  });
  test("the capability execution ledger accepts and retains the new choice origin", async () => {
    const requestId = `choice-${crypto.randomUUID()}`;
    try {
      expect(
        await recordCapabilityExecution({
          requestId,
          origin: "choice",
          appId: "art",
          capability: "art.inspect",
          kind: "query",
          destructive: false,
          status: "succeeded",
          startedAt: new Date("2026-11-08T12:00:00Z"),
          completedAt: new Date("2026-11-08T12:00:01Z"),
        }),
      ).toMatch(/^[0-9a-f-]{36}$/);
      const [row] = await sql<{ origin: string }[]>`SELECT origin FROM capabilities.executions WHERE request_id = ${requestId}`;
      expect(row?.origin).toBe("choice");
    } finally {
      await sql`DELETE FROM capabilities.executions WHERE request_id = ${requestId}`;
    }
  });
});
