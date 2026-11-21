import { describe, expect, test } from "bun:test";
import type { Message } from "@k2b/nessi";
import { reviewFixture } from "../_internal/capability-review.test-fixture";
import type { AppRegistryEntry } from "../contracts/registry";
import { visibleMessages } from "./client/projection";
import { type AiWireEvent, buildBlocksFromMessages } from "./protocol";
import { messagesNeedChoiceContext, projectPublicAiStoredMessages, publicAiWireEvent, withCurrentAppNames } from "./public-projection";
import type { AiStoredMessage } from "./types";

const stored = (id: string, role: Extract<Message["role"], "user" | "assistant">, loopId: string | null): AiStoredMessage => ({
  id,
  shortId: id,
  conversationId: "internal-conversation",
  seq: role === "user" ? 1 : 2,
  kind: "message",
  message:
    role === "user"
      ? { role, content: [{ type: "text", text: "go" }] }
      : { role, content: [{ type: "text", text: "working" }], stopReason: "tool_use" },
  loopId,
  modelId: null,
  providerModel: null,
  usage: null,
  stopReason: role === "assistant" ? "tool_use" : null,
  loopAggregate: null,
  loopDoneReason: null,
  compactedAt: null,
  meta: null,
  createdAt: new Date(0).toISOString(),
});

describe("public AI message projection", () => {
  test("live updates and retained events carry a thinking step, never its content", () => {
    const raw = "INTERNAL_INSTRUCTION code_Open42 22222222-2222-4222-8222-222222222222 code_run({code: 'return 42'})";
    const thought = { id: "thought", kind: "thinking" as const, text: raw };
    const message: AiStoredMessage = {
      ...stored("assistant-1", "assistant", "internal-turn"),
      message: { role: "assistant", content: [{ type: "thinking", thinking: raw, signature: "signed-thinking" }] },
    };
    const base = { v: 1 as const, conversationId: "chat", turnId: "turn", attempt: 1, seq: 1 };
    const events: AiWireEvent[] = [
      { ...base, type: "turn_started", modelId: "model", providerModel: "model", blocks: [thought] },
      { ...base, type: "block_set", block: thought },
      { ...base, type: "block_delta", blockId: "thought", blockKind: "thinking", delta: raw },
      { ...base, type: "message_saved", message },
      { ...base, type: "turn_finished", status: "completed", error: null, messages: [message] },
    ];
    for (const event of events) {
      const projected = publicAiWireEvent(event);
      expect(projected).toMatchObject({ type: event.type, seq: event.seq });
      for (const forbidden of [raw, "signed-thinking"]) expect(JSON.stringify(projected)).not.toContain(forbidden);
      expect(JSON.stringify(event)).toContain(raw);
    }
    expect(publicAiWireEvent(events[1]!)).toMatchObject({ block: { id: "thought", kind: "thinking", text: "" } });
    expect(publicAiWireEvent(events[2]!)).toMatchObject({ blockKind: "thinking", delta: "" });
    const prose: AiWireEvent = { ...base, type: "block_delta", blockId: "answer", blockKind: "text", delta: "Finished." };
    expect(publicAiWireEvent(prose)).toEqual(prose);
  });

  test("thinking stays a step without its text or provider metadata, while canonical history stays intact", () => {
    const reasoning =
      "Follow INTERNAL_INSTRUCTION. Read code_Open42, version 11111111-1111-4111-8111-111111111111 via code_run({code: 'return 42'}).";
    const original: AiStoredMessage = {
      ...stored("assistant-1", "assistant", "internal-turn"),
      message: {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: reasoning,
            signature: "signed-thinking",
            redacted: "opaque-thinking",
            details: [{ type: "reasoning.encrypted", data: "opaque-details", index: 0 }],
          },
          { type: "text", text: "Finished." },
        ],
      },
    };
    const [message] = projectPublicAiStoredMessages([original], "public-chat", new Map([["internal-turn", "public-turn"]]));
    expect(message?.message).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "" },
        { type: "text", text: "Finished." },
      ],
    });
    expect(original.message).toMatchObject({
      content: [
        {
          thinking: reasoning,
          signature: "signed-thinking",
          redacted: "opaque-thinking",
          details: [{ type: "reasoning.encrypted", data: "opaque-details", index: 0 }],
        },
        {},
      ],
    });
  });

  test("Code run input stays with execution, never with public history or agent reads", () => {
    const source = "export default async () => cloud.spaces.task.create({ title: 'Delivery' })";
    const raw: AiStoredMessage = {
      ...stored("code-call", "assistant", "internal-turn"),
      message: { role: "assistant", content: [{ type: "tool_call", id: "run", name: "code_run", args: { code: source, inputPaths: [] } }] },
    };
    const messages = projectPublicAiStoredMessages([raw], "chat", new Map([["internal-turn", "turn"]]));
    expect(JSON.stringify(messages)).not.toContain(source);
    expect(buildBlocksFromMessages(messages)[0]).toMatchObject({ name: "code_run", args: { inputPaths: [] } });
    expect(raw.message).toMatchObject({ content: [{ args: { code: source } }] });
  });

  test("uses the public Turn id for message loops and hides active assistant rounds", () => {
    const messages = projectPublicAiStoredMessages(
      [stored("user-1", "user", "internal-turn"), stored("assistant-1", "assistant", "internal-turn")],
      "public-conversation",
      new Map([["internal-turn", "public-turn"]]),
    );

    expect(messages.map((message) => message.loopId)).toEqual(["public-turn", "public-turn"]);
    expect(
      visibleMessages({
        conversation: null,
        messages,
        activeTurn: { turnId: "public-turn", attempt: 1, seq: 1, status: "running", blocks: [], modelId: null },
      }).map((message) => message.id),
    ).toEqual(["user-1"]);
  });

  test("never exposes an unresolved internal loop id", () => {
    const [message] = projectPublicAiStoredMessages(
      [stored("assistant-1", "assistant", "internal-turn")],
      "public-conversation",
      new Map(),
    );
    expect(message?.loopId).toBeNull();
  });
});

test("public message reads deliver the same bound blocks as live tool blocks while storage stays raw", () => {
  const call: AiStoredMessage = {
    ...stored("call", "assistant", "turn"),
    message: { role: "assistant", content: [{ type: "tool_call", id: "call-1", name: "demo__query__get", args: {} }] },
  };
  const raw = {
    data: { rows: [{ name: "Vase" }] },
    view: {
      version: 1,
      blocks: [{ kind: "Table", title: "Objects", rows: { from: ["rows"] }, columns: [{ path: ["name"], label: "Name" }] }],
    },
  };
  const result: AiStoredMessage = {
    ...stored("result", "assistant", "turn"),
    seq: 3,
    message: { role: "tool_result", callId: "call-1", name: "demo__query__get", result: raw },
  };
  const publicMessages = projectPublicAiStoredMessages([call, result], "chat", new Map([["turn", "public-turn"]]));
  const block = buildBlocksFromMessages(publicMessages)[0];
  expect(block).toMatchObject({ kind: "tool", view: { version: 1, blocks: [{ kind: "Table", rows: raw.data.rows }] } });
  expect(result.meta).toBeNull();
  expect(result.message.role === "tool_result" ? result.message.result : null).toEqual(raw);
});

describe("app names of stored steps", () => {
  type CatalogApp = Pick<AppRegistryEntry, "name" | "description" | "presentation">;
  const platform: CatalogApp = {
    name: "Cloud",
    description: "Platform",
    presentation: { baseLocale: "en", translations: { de: { name: "Cloud", description: "Plattform" } } },
  };
  const notes: CatalogApp = {
    name: "Notebooks",
    description: "Notes",
    presentation: { baseLocale: "en", translations: { de: { name: "Notizbücher" } } },
  };
  const step = (appId: string, appName: string) => ({
    kind: "capability" as const,
    appId,
    appName,
    appIcon: "ti ti-app",
    title: "Find",
    capabilityKind: "query" as const,
  });
  const turn: AiStoredMessage = {
    ...stored("assistant-1", "assistant", "internal-turn"),
    meta: { toolPresentations: { a: step("core", "Core"), b: step("notebooks", "Notizbücher"), c: step("gone", "Old app") } },
  };
  const catalog = new Map<string, CatalogApp>([
    ["core", platform],
    ["notebooks", notes],
  ]);
  const registry = async (appId: string) => catalog.get(appId) ?? null;

  test("a renamed app reads as the catalog names it now, in the reader's language; an unknown app keeps its stored name", async () => {
    const [named] = await withCurrentAppNames([turn], "de", registry);
    const names = Object.values(named!.meta!.toolPresentations!).map((presentation) => presentation.appName);
    expect(names).toEqual(["Cloud", "Notizbücher", "Old app"]);
    const [english] = await withCurrentAppNames([turn], "en", registry);
    expect(english!.meta!.toolPresentations!.b!.appName).toBe("Notebooks");
  });

  test("a registry that cannot answer leaves every stored name as it was", async () => {
    const [named] = await withCurrentAppNames([turn], "de", async () => {
      throw new Error("registry unavailable");
    });
    expect(named).toEqual(turn);
  });
});

test("public history keeps the Code approval's app name in the original review locale", async () => {
  const raw: AiStoredMessage = {
    ...stored("code-call", "assistant", "internal-turn"),
    message: { role: "assistant", content: [{ type: "tool_call", id: "run", name: "code_run", args: { code: "export default () => 1" } }] },
    meta: {
      toolPresentations: {
        run: {
          kind: "capability",
          appId: "notebooks",
          appName: "Notizbücher",
          appIcon: "ti ti-app",
          title: "Notiz erstellen",
          capabilityKind: "action",
        },
      },
      toolReviews: { run: { ...reviewFixture(), locale: "de" } },
    },
  };
  const registry = async () => ({
    name: "Notebooks",
    description: "Notes",
    presentation: { baseLocale: "en", translations: { de: { name: "Notizbücher" } } },
  });
  const messages = projectPublicAiStoredMessages(await withCurrentAppNames([raw], "en", registry), "chat", new Map());
  expect(messages[0]!.meta!.toolPresentations!.run).toMatchObject({ appName: "Notizbücher", title: "Notiz erstellen" });
  expect(messages[0]!.meta!.toolReviews!.run).toEqual(raw.meta!.toolReviews!.run);
});

test("public history omits lasting Code inputs, projects and source results without changing canonical messages", () => {
  const source = "export default () => 'source-must-stay-internal'";
  for (const name of [
    "code_write",
    "code_read",
    "code_pull",
    "code_init",
    "code_sdk",
    "code_diff",
    "code_check",
    "code_test",
    "code_simulate",
    "code_submit",
  ]) {
    const raw: AiStoredMessage[] = [
      {
        ...stored("call", "assistant", "turn"),
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_call",
              id: "call",
              name,
              args: { codeId: "ABCDEF", content: source, files: { "code.ts": source }, project: { files: { "code.ts": source } } },
            },
          ],
        },
        meta: { toolInterimResults: { call: { files: { "code.ts": source }, diagnostics: [{ code: "TS2322", message: source }] } } },
      },
      {
        ...stored("result", "assistant", "turn"),
        message: {
          role: "tool_result",
          callId: "call",
          name,
          result: {
            version: 1,
            files: { "code.ts": source },
            declarations: source,
            diagnostics: [{ code: "TS2322", message: source }],
            warnings: [{ code: "code_warning", message: source }],
            diff: { files: [{ path: "code.ts", lines: [{ kind: "add", text: source }] }] },
          },
        },
      },
    ];
    const canonical = structuredClone(raw);
    const projected = projectPublicAiStoredMessages(raw, "chat", new Map());
    expect(JSON.stringify(projected)).not.toContain(source);
    expect(JSON.stringify(buildBlocksFromMessages(projected))).not.toContain(source);
    expect(raw).toEqual(canonical);
  }
});

test("choice history stays lazy for text and thinking; stored and live choices share the same gate", () => {
  const message = stored("ordinary", "assistant", "turn");
  expect(messagesNeedChoiceContext([message], [{ id: "thought", kind: "thinking", text: "Private" }])).toBeFalse();
  const choice = {
    version: 1 as const,
    blocks: [
      {
        kind: "Choice" as const,
        id: "choice",
        title: "Pick",
        submit: "Choose",
        mode: "one" as const,
        options: { from: ["options"] },
        option: { id: ["id"], title: ["title"] },
        then: { query: "art.query.inspect", input: {}, field: "category" },
      },
    ],
  };
  expect(
    messagesNeedChoiceContext(
      [message],
      [{ id: "tool", kind: "tool", callId: "call", name: "art__query__categories", status: "completed", result: { view: choice } }],
    ),
  ).toBeTrue();
  expect(
    messagesNeedChoiceContext([
      { ...message, message: { role: "tool_result", callId: "call", name: "art__query__categories", result: { view: choice } } },
    ]),
  ).toBeTrue();
});

test("a message an automation sent shows its instruction and its data apart; the person's own text and storage stay whole", () => {
  const text = 'Bestätige den Kontostand in einem Satz.\n\nSource context (untrusted data):\n"Geschäftskonto 4.210,18 €"';
  const automation: AiStoredMessage = {
    ...stored("m1", "user", "turn-1"),
    message: { role: "user", content: [{ type: "text", text }] },
    meta: { writerOrigin: { kind: "automation", id: "c_brief" } },
  };
  const person: AiStoredMessage = {
    ...stored("m2", "user", "turn-2"),
    message: { role: "user", content: [{ type: "text", text }] },
    meta: { writerOrigin: { kind: "person", id: "u1" } },
  };
  const [sent, typed] = projectPublicAiStoredMessages([automation, person], "chat", new Map());
  expect(sent?.message).toEqual({ role: "user", content: [{ type: "text", text: "Bestätige den Kontostand in einem Satz." }] });
  expect(sent?.meta?.sourceContext).toBe("Geschäftskonto 4.210,18 €");
  expect(typed?.message).toEqual(person.message);
  expect(typed?.meta?.sourceContext).toBeUndefined();
  expect(automation.message).toEqual({ role: "user", content: [{ type: "text", text }] });
});

test.each([
  ["a text part", (text: string) => ({ type: "text" as const, text })],
  ["a plain string part", (text: string) => text],
])("an automation's message as %s shows its instruction; empty data adds no data line", (_name, part) => {
  const build = (context: string) =>
    ({
      ...stored("m3", "user", "turn-3"),
      message: { role: "user", content: [part(`Bestätige kurz.\n\nSource context (untrusted data):\n${JSON.stringify(context)}`)] },
      meta: { writerOrigin: { kind: "automation", id: "c_brief" } },
    }) as AiStoredMessage;
  const [withData, empty] = projectPublicAiStoredMessages([build("4.210,18 €"), build("")], "chat", new Map());
  expect(withData?.message).toEqual({ role: "user", content: [{ type: "text", text: "Bestätige kurz." }] });
  expect(withData?.meta?.sourceContext).toBe("4.210,18 €");
  expect(empty?.message).toEqual({ role: "user", content: [{ type: "text", text: "Bestätige kurz." }] });
  expect(empty?.meta?.sourceContext).toBeUndefined();
});
