import { describe, expect, test } from "bun:test";
import type { Message } from "@k2b/nessi";
import { Hono } from "hono";
import { z } from "zod";
import { compileCapabilities } from "../_internal/capabilities";
import { defineCapabilities } from "../contracts/capabilities";
import type { AuthContext } from "../server";
import { buildAiCapabilityCatalog } from "./capabilities";
import { createAiChoiceRoutes } from "./choice-routes";
import { AiChoiceConflict, conversationChoices, projectAiChoices, reconcileProjectedAiChoices, resolveAiChoice } from "./choices";
import { emptyProjection, reduceWireEvent } from "./client/projection";
import {
  AiClientToolResultSchema,
  AiConversationDraftInputSchema,
  AiMessageForkInputSchema,
  AiMessageRetryInputSchema,
  AiSteerInputSchema,
  AiSubmitConversationDraftInputSchema,
  AiTurnInputSchema,
} from "./http";
import { buildBlocksFromMessages } from "./protocol";
import { projectPublicAiStoredMessages } from "./public-projection";
import { type AiChatRequestContext, resolveAiChatRequestContext } from "./request-context";
import { AiTurnActionSchema } from "./runtime";
import type { AiStoredMessage } from "./types";

const at = "2026-11-08T12:00:00.000Z";
const stored = (seq: number, message: Message, meta: AiStoredMessage["meta"] = null, loopId = "turn-1"): AiStoredMessage => ({
  id: `message-${seq}`,
  shortId: `Msg00${seq}`,
  conversationId: "conversation-1",
  seq,
  kind: "message",
  message,
  loopId,
  modelId: null,
  providerModel: null,
  usage: null,
  stopReason: null,
  loopAggregate: null,
  loopDoneReason: null,
  compactedAt: null,
  meta,
  createdAt: at,
});
const catalog = buildAiCapabilityCatalog([
  {
    appId: "art",
    appName: "Kunst-Inspektor",
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
            description: "Inspect chosen category",
            input: z.strictObject({ category: z.string().describe("Chosen category") }),
            data: z.object({}),
            openWorld: false,
            run: async () => ({ ok: true, data: { data: {} } }),
          },
        },
      }),
    ).manifest,
  },
]);
const history = (
  turn = "turn-1",
  callId = "call-1",
  seq = 1,
  mode: "one" | "many" = "one",
  then?: { query: string; input: Record<string, unknown>; field: string },
) => [
  stored(
    seq,
    { role: "assistant", content: [{ type: "tool_call", id: callId, name: "art__query__categories", args: {} }] },
    {
      toolPresentations: {
        [callId]: {
          kind: "capability",
          appId: "art",
          appName: "Kunst-Inspektor",
          title: "Kategorien",
          appIcon: "ti ti-box",
          capabilityKind: "query",
        },
      },
    },
    turn,
  ),
  stored(
    seq + 1,
    {
      role: "tool_result",
      callId,
      name: "art__query__categories",
      result: {
        data: {
          categories: [
            { id: "cat_jug", title: "Jugendstil-Vase" },
            { id: "cat_mod", title: "Moderne" },
          ],
        },
        view: {
          version: 1,
          blocks: [
            {
              kind: "Section",
              title: "Kategorien",
              children: [
                {
                  kind: "Choice",
                  id: "category",
                  title: "Welche Kategorie?",
                  mode,
                  submit: "Wählen",
                  options: { from: ["categories"] },
                  option: { id: ["id"], title: ["title"] },
                  ...(then ? { then } : {}),
                },
              ],
            },
          ],
        },
      },
    },
    null,
    turn,
  ),
];
const target = { turnId: "turn-1", toolCallId: "call-1", blockId: "category", ids: ["cat_jug"], catalog };

describe("choice event contract", () => {
  test("binds stored options and creates plain locale text with separate Cloud provenance", () => {
    const result = resolveAiChoice(history(), target, "de", at);
    expect(result.text).toBe("Gewählt in Kunst-Inspektor · Welche Kategorie?: Jugendstil-Vase (cat_jug)");
    expect(result.provenance).toMatchObject({ ids: ["cat_jug"], labels: ["Jugendstil-Vase"], appName: "Kunst-Inspektor", at });
    expect(result.then).toBeUndefined();
  });
  test("admission always rebinds the stored raw result instead of trusting projected metadata", () => {
    const messages = history();
    const result = messages[1]!;
    result.meta = {
      resultView: {
        version: 1,
        blocks: [
          {
            kind: "Choice",
            id: "category",
            title: "Forged",
            submit: "Choose",
            mode: "one",
            options: [{ id: "forged", title: "Forged" }],
            option: { id: ["id"], title: ["title"] },
          },
        ],
      },
    };
    expect(resolveAiChoice(messages, target, "en", at).provenance.labels).toEqual(["Jugendstil-Vase"]);
    expect(() => resolveAiChoice(messages, { ...target, ids: ["forged"] }, "en", at)).toThrow("choice_invalid");
  });
  test.each([{ ids: [] }, { ids: ["missing"] }, { ids: ["cat_jug", "cat_mod"] }, { ids: ["cat_jug", "cat_jug"] }])(
    "rejects invalid selection %j",
    ({ ids }) => {
      expect(() => resolveAiChoice(history(), { ...target, ids: [...ids] }, "en", at)).toThrow("choice_invalid");
    },
  );
  test("answers survive reload, compaction, and a history page excluding the answer", () => {
    const messages = history();
    const answer = resolveAiChoice(messages, target, "en", at);
    messages.push(stored(3, { role: "user", content: [{ type: "text", text: answer.text }] }, { choice: answer.provenance }, "turn-2"));
    messages[0]!.compactedAt = at;
    expect(() => resolveAiChoice(messages, target, "en", at)).toThrow("choice_closed");
    const publicMessages = projectPublicAiStoredMessages(messages.slice(0, 2), "Chat01", new Map([["turn-1", "Trn234"]]), messages);
    expect(publicMessages[1]?.meta?.resultChoice).toEqual({ state: "answered", chosen: ["cat_jug"], answeredAt: at });
    expect(buildBlocksFromMessages(publicMessages)[0]).toMatchObject({ choice: { state: "answered", chosen: ["cat_jug"] } });
    const publicAnswer = projectPublicAiStoredMessages(
      messages.slice(2),
      "Chat01",
      new Map([
        ["turn-1", "Trn234"],
        ["turn-2", "Turn02"],
      ]),
      messages,
    )[0];
    expect(publicAnswer?.meta?.choice).toMatchObject({ turnId: "Trn234", labels: ["Jugendstil-Vase"], appName: "Kunst-Inspektor" });
  });
  test("a live choice message closes the same source block as the reload projection", () => {
    const source = history();
    const answer = resolveAiChoice(source, target, "en", at);
    const storedAnswer = stored(
      3,
      { role: "user", content: [{ type: "text", text: answer.text }] },
      { choice: answer.provenance },
      "turn-2",
    );
    const ids = new Map([
      ["turn-1", "Trn234"],
      ["turn-2", "Trn235"],
    ]);
    const historyPage = projectPublicAiStoredMessages(source, "Chat23", ids);
    const [message] = projectPublicAiStoredMessages([storedAnswer], "Chat23", ids, [...source, storedAnswer]);
    if (!message) throw new Error("Missing projected choice message");
    const running = reduceWireEvent(
      { ...emptyProjection(), messages: historyPage },
      {
        v: 1,
        conversationId: "Chat23",
        turnId: "Trn235",
        attempt: 1,
        seq: 1,
        type: "turn_started",
        modelId: "fixture",
        providerModel: "fixture",
      },
    );
    const live = reduceWireEvent(running, {
      v: 1,
      conversationId: "Chat23",
      turnId: "Trn235",
      attempt: 1,
      seq: 2,
      type: "message_saved",
      message,
    });
    const reload = projectPublicAiStoredMessages([...source, storedAnswer], "Chat23", ids);
    expect(live.messages[1]?.meta?.resultChoice).toEqual(reload[1]?.meta?.resultChoice);
    expect(live.messages[1]?.meta?.resultChoice).toMatchObject({ state: "answered", chosen: ["cat_jug"] });
    expect(live.messages[2]?.meta?.choice).toEqual(reload[2]?.meta?.choice);
  });
  test("a later open choice of the same app supersedes an unanswered choice", () => {
    const messages = [...history(), ...history("turn-2", "call-2", 3)];
    expect(conversationChoices(messages).map((entry) => entry.state.state)).toEqual(["superseded", "open"]);
    expect(() => resolveAiChoice(messages, target, "en", at)).toThrow("choice_closed");
    expect(projectAiChoices(messages)[1]?.meta?.resultChoice?.state).toBe("superseded");
  });
  test("answering the replacement never reopens an older choice, including previously loaded history", () => {
    const first = history();
    const second = history("turn-2", "call-2", 3);
    const answer = resolveAiChoice([...first, ...second], { ...target, turnId: "turn-2", toolCallId: "call-2" }, "en", at);
    const all = [
      ...first,
      ...second,
      stored(5, { role: "user", content: [{ type: "text", text: answer.text }] }, { choice: answer.provenance }, "turn-3"),
    ];
    expect(conversationChoices(all).map((entry) => entry.state.state)).toEqual(["superseded", "answered"]);
    const turnIds = new Map([
      ["turn-1", "Trn234"],
      ["turn-2", "Trn235"],
      ["turn-3", "Trn236"],
    ]);
    const olderPage = projectPublicAiStoredMessages(first, "Chat23", turnIds);
    const newerPage = projectPublicAiStoredMessages(all.slice(2), "Chat23", turnIds, all);
    const reconciled = reconcileProjectedAiChoices([...olderPage, ...newerPage]);
    expect(reconciled[1]?.meta?.resultChoice?.state).toBe("superseded");
    expect(reconciled[3]?.meta?.resultChoice).toMatchObject({ state: "answered", chosen: ["cat_jug"] });
  });
  test("then resolves only the same app's Query and maps one or many ids over the declared input", () => {
    const then = { query: "art.query.inspect", input: { category: "old" }, field: "category" };
    expect(resolveAiChoice(history("turn-1", "call-1", 1, "one", then), target, "en", at).then).toMatchObject({
      entry: { appId: "art", kind: "query" },
      input: { category: "cat_jug" },
    });
    expect(
      resolveAiChoice(history("turn-1", "call-1", 1, "many", then), { ...target, ids: ["cat_jug", "cat_mod"] }, "en", at).then?.input,
    ).toEqual({ category: ["cat_jug", "cat_mod"] });
    for (const query of ["other.query.inspect", "art.action.inspect", "art.query.missing"]) {
      expect(() => resolveAiChoice(history("turn-1", "call-1", 1, "one", { ...then, query }), target, "en", at)).toThrow("choice_invalid");
    }
  });
  test("model/client content can describe a choice but cannot author provenance", () => {
    const provenance = { blockId: "category", ids: ["cat_jug"] };
    const cases = [
      { schema: AiTurnInputSchema, input: { message: "hello" } },
      { schema: AiSubmitConversationDraftInputSchema, input: { draftRevision: 1, queueId: "11111111-1111-4111-8111-111111111111" } },
      { schema: AiMessageRetryInputSchema, input: {} },
      { schema: AiMessageForkInputSchema, input: {} },
      { schema: AiSteerInputSchema, input: { message: "hello", clientRequestId: "one" } },
      { schema: AiConversationDraftInputSchema, input: { content: [{ type: "text", text: "hello" }] } },
    ];
    for (const { schema, input } of cases) {
      expect(schema.safeParse({ ...input, meta: { choice: provenance } }).success).toBe(false);
      expect(schema.safeParse({ ...input, choice: provenance }).success).toBe(false);
    }
    for (const schema of [AiTurnInputSchema, AiMessageRetryInputSchema]) {
      expect(schema.safeParse({ content: [{ type: "choice", ...provenance }] }).success).toBe(false);
      expect(schema.safeParse({ content: [{ type: "text", text: "hello", meta: { choice: provenance } }] }).success).toBe(false);
    }
    for (const forged of [
      { type: "choice", ...provenance },
      { nested: { meta: { choice: provenance } } },
      { choice: { appId: "art", ...provenance } },
    ]) {
      expect(AiClientToolResultSchema.safeParse(forged).success).toBe(false);
      expect(AiTurnActionSchema.safeParse({ type: "tool_result", result: forged }).success).toBe(false);
    }
    expect(AiTurnActionSchema.safeParse({ type: "tool_result", result: {}, meta: { choice: provenance } }).success).toBe(false);
    expect(AiClientToolResultSchema.safeParse({ data: { choice: "a domain value" } }).success).toBe(true);
  });
});

const person = {
  id: "person",
  uid: "choice-person",
  provider: "local" as const,
  profile: "user" as const,
  displayName: "Person",
  mail: null,
  givenname: "Person",
  sn: "Choice",
  roles: ["user" as const],
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
};
const context = (session: boolean): AiChatRequestContext => ({
  actor: { kind: "user", user: person },
  ownerUserId: "person",
  signedInSession: session,
  modelPolicy: { kind: "platform-default" },
  toolApprovalContext: { actorUserId: "person" },
  toolApprovalChangeContext: { actorUserId: "person", actor: { kind: "user", user: person }, requestId: null },
});

describe("choice HTTP boundary", () => {
  test("rejects an API-key caller before admission; admits the signed-in owner path", async () => {
    for (const credentialKind of ["api_key", "oauth", "invocation", "session"] as const) {
      let admitted = false;
      const routes = new Hono<AuthContext>()
        .use("*", async (c, next) => {
          c.set("actor", { kind: "user", user: person });
          c.set("credentialKind", credentialKind);
          await next();
        })
        .route(
          "/",
          createAiChoiceRoutes({
            resolveContext: resolveAiChatRequestContext,
            submit: async (_c, ctx) => {
              expect(ctx.ownerUserId).toBe("person");
              admitted = true;
              return new Response(null, { status: 201 });
            },
          }),
        );
      const response = await routes.request("/Chat23/choices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turnId: "Trn234", toolCallId: "call-1", blockId: "category", ids: ["cat_jug"] }),
      });
      expect(response.status).toBe(credentialKind === "session" ? 201 : 403);
      expect(admitted).toBe(credentialKind === "session");
    }
  });
  test.each(["choice_busy", "choice_closed", "choice_invalid"] as const)("returns 409 with %s", async (code) => {
    const routes = createAiChoiceRoutes({
      resolveContext: async () => context(true),
      submit: async () => {
        throw new AiChoiceConflict(code);
      },
    });
    const response = await routes.request("/Chat23/choices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ turnId: "Trn234", toolCallId: "call-1", blockId: "category", ids: [] }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code });
  });
});
