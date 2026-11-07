import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import {
  defineTool,
  type Message,
  memoryStore,
  nessi,
  type OutboundEvent,
  type Provider,
  type ProviderEvent,
  type ProviderRequest,
} from "@k2b/nessi";
import { z } from "zod";
import { __aiExecutorTest } from "./executor";
import {
  AI_NEXT_MESSAGE_DESCRIPTION,
  AI_NEXT_MESSAGE_NOTED,
  aiNextMessageEnabled,
  createAiNextMessageRuntime,
  validateAiNextMessage,
} from "./next-message";
import * as nextMessageStore from "./next-message-store";
import type { AiUserPrefs } from "./prefs";
import { userResourceContext } from "./projects.test-fixture";
import { buildBlocksFromMessages } from "./protocol";
import { prepareAiTools } from "./tools";
import type { AiChatTurnRunConfig } from "./types";

const config: AiChatTurnRunConfig = {
  input: "Was hat Jana gefragt?",
  signedInSession: true,
  actor: userResourceContext({ type: "user", userId: "person" }).actor,
  toolSource: { kind: "default" },
};
const prefs: AiUserPrefs = {
  userId: "person",
  memoryEnabled: false,
  memoryLearningEnabled: false,
  suggestNextMessage: true,
  selection: null,
  updatedAt: "2026-11-07T09:00:00Z",
};
const text = (value = "Soll ich Jana antworten?"): ProviderEvent => ({
  type: "block_end",
  blockId: "text",
  index: 0,
  block: { type: "text", text: value },
});
const call = (value: unknown = "Ja, antworte Jana", id = "suggestion"): ProviderEvent => ({
  type: "block_end",
  blockId: id,
  index: 1,
  block: { type: "tool_call", id, name: "suggest_next_message", args: { text: value } },
});
const usage: ProviderEvent = { type: "usage", usage: { input: 10, output: 10, total: 20 }, finishReason: "tool_use" };

afterEach(() => setSystemTime());
const run = async (
  rounds: ProviderEvent[][],
  options: { stop?: boolean; redirect?: boolean; readFails?: boolean; history?: Message[] } = {},
) => {
  setSystemTime(new Date("2026-11-07T09:00:00Z"));
  const requests: ProviderRequest[] = [];
  const controller = new AbortController();
  const provider: Provider = {
    name: "frozen-fake",
    family: "openai-compatible",
    model: "fixture",
    capabilities: { streaming: true, tools: true, images: false, thinking: false, usage: true },
    stream: async function* (request) {
      requests.push(request);
      for (const event of rounds[requests.length - 1] ?? [text("Fertig.")]) yield event;
      if (options.stop) controller.abort();
    },
  };
  const runtime = createAiNextMessageRuntime(config, prefs, "chat", "turn");
  const read = defineTool({ name: "read", description: "Read", inputSchema: z.object({}) }).server(async () => {
    if (options.readFails) throw new Error("Frozen read failure");
    return "read";
  });
  const store = memoryStore();
  for (const message of options.history ?? []) await store.append(message);
  const events: OutboundEvent[] = [];
  let redirected = false;
  const loop = nessi({
    loopId: "fixture-turn",
    systemPrompt: "Frozen fixture",
    provider: runtime.wrap(provider),
    input: config.input,
    store,
    tools: [...prepareAiTools({ tools: runtime.tools, actor: config.actor! }).tools, read],
    maxTurns: 4,
    signal: controller.signal,
    steering: options.redirect
      ? async () => {
          if (requests.length && !redirected) {
            redirected = true;
            runtime.redirect(() => {})();
            return "Stopp, stattdessen Kai.";
          }
          return undefined;
        }
      : undefined,
  });
  for await (const event of loop) events.push(event);
  return { requests, events, store, runtime, controller };
};

describe("next message validation", () => {
  test.each([
    null,
    undefined,
    4,
    "",
    "  ",
    "a\nb",
    "a\rb",
    "a\u2028b",
    "a\u0000b",
    "a\u200bb",
    "a".repeat(201),
    "https://example.test",
    "www.example.test",
    "example.test",
    "Öffne 192.0.2.1/report",
    "localhost:3000",
    "tel:+49305550182",
    "file:/tmp/example",
    "/en/docs/example",
    "mail: jana@example.test",
    "@Jana",
    "**Ja**",
    "_Ja_",
    "[Ja](x)",
    "`Ja`",
    "# Ja",
    "- Ja",
    "1. Ja",
    "<b>Ja</b>",
    "~~Ja~~",
  ])("rejects %j", (value) => {
    expect(validateAiNextMessage(value, "last")).toBeNull();
  });
  test("normalizes Unicode, case, punctuation and whitespace before comparison", () => {
    expect(validateAiNextMessage("  ＪＡ,   antworte Jana! ", "ja antworte jana")).toBeNull();
    expect(validateAiNextMessage("Ja, entwirf die Antwort an Jana", "Was hat Jana gefragt?")).toBe("Ja, entwirf die Antwort an Jana");
    expect(validateAiNextMessage("😀".repeat(200), "last")).toHaveLength(400);
  });
});

describe("next message tool scope", () => {
  test("requires the enabled preference and a person's interactive default chat", () => {
    expect(aiNextMessageEnabled(config, prefs)).toBe(true);
    expect(
      aiNextMessageEnabled(
        {
          ...config,
          project: {
            id: "fixture",
            name: "Fixture",
            revision: 1,
            instructions: "",
            context: "",
            references: [],
            defaultModel: null,
          },
        },
        prefs,
      ),
    ).toBe(true);
    const excluded: Partial<AiChatTurnRunConfig>[] = [
      { signedInSession: undefined },
      { actor: undefined },
      { toolSource: { kind: "none" } },
      { background: { taskId: "task", occurrenceId: "occurrence", context: [] } },
      { client: { kind: "cli", cwd: "/fixture", os: "linux", shell: "bash", localTools: "off" } },
    ];
    for (const patch of excluded) expect(aiNextMessageEnabled({ ...config, ...patch }, prefs)).toBe(false);
    expect(aiNextMessageEnabled(config, { ...prefs, suggestNextMessage: false })).toBe(false);
    expect(aiNextMessageEnabled(config, null)).toBe(false);
    expect(createAiNextMessageRuntime(config, prefs, "chat", "turn").tools[0]?.def.description).toBe(AI_NEXT_MESSAGE_DESCRIPTION);
  });
});

describe("closing suggestion in the real nessi loop", () => {
  test("an earlier run's suggestion and failure do not affect the current run", async () => {
    const { runtime, controller } = await run([[text(), call(), usage]], {
      history: [
        { role: "user", content: [{ type: "text", text: "Eine alte Frage" }] },
        {
          role: "assistant",
          content: [{ type: "tool_call", id: "old", name: "suggest_next_message", args: { text: "Alter Vorschlag" } }],
          stopReason: "tool_use",
        },
        { role: "tool_result", callId: "old", name: "suggest_next_message", result: "old failure", isError: true },
      ],
    });
    expect(runtime.result("completed", controller.signal)).toBe("Ja, antworte Jana");
  });
  test("a failed suggestion save is best effort after normal loop completion", async () => {
    const { runtime, controller, events } = await run([[text(), call(), usage]]);
    const save = spyOn(nextMessageStore, "saveAiNextMessage").mockRejectedValue(new Error("Frozen storage failure"));
    try {
      await expect(runtime.save("completed", controller.signal)).resolves.toBeUndefined();
      expect(save).toHaveBeenCalledTimes(1);
      expect(events.at(-1)).toMatchObject({ type: "loop_end", reason: "stop" });
    } finally {
      save.mockRestore();
    }
  });
  test("a failed tool suppresses the suggestion even when the model finishes normally", async () => {
    const { runtime, controller, events } = await run(
      [
        [{ type: "block_end", blockId: "read", index: 0, block: { type: "tool_call", id: "read", name: "read", args: {} } }, usage],
        [text(), call(), usage],
      ],
      { readFails: true },
    );
    expect(events.at(-1)).toMatchObject({ type: "loop_end", reason: "stop" });
    expect(runtime.result("completed", controller.signal)).toBeNull();
  });
  test.each([true, false])("hides the complete tool stream, including an initially unnamed call: %j", async (named) => {
    const { requests, events } = await run([
      [
        text(),
        {
          type: "block_start",
          blockId: "suggestion",
          index: 1,
          kind: "tool_call",
          callId: "suggestion",
          ...(named ? { name: "suggest_next_message" } : {}),
        },
        { type: "block_delta", blockId: "suggestion", delta: '{"text":"Ja, antworte Jana"}' },
        call(),
        usage,
      ],
    ]);
    expect(requests).toHaveLength(1);
    expect(events.some((event) => event.type === "block_start" && event.kind === "tool_call")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "loop_end", reason: "stop" });
  });
  test("restores an initially unnamed unrelated tool before its deltas and completion", async () => {
    const { requests, events } = await run([
      [
        text(),
        { type: "block_start", blockId: "other", index: 1, kind: "tool_call", callId: "other" },
        { type: "block_delta", blockId: "other", delta: "{}" },
        { type: "block_end", blockId: "other", index: 1, block: { type: "tool_call", id: "other", name: "read", args: {} } },
        usage,
      ],
      [text()],
    ]);
    expect(requests).toHaveLength(2);
    const toolEvents = events.filter((event) => "blockId" in event && event.blockId === "other");
    expect(toolEvents.map((event) => event.type)).toEqual(["block_start", "block_delta", "block_end"]);
    expect(toolEvents[0]).toMatchObject({ name: "read" });
  });
  test.each(["Ja, antworte Jana", null, "**invalid**"])("ends without a follow-up model request for %j", async (suggestion) => {
    const { requests, events, runtime, controller } = await run([[text(), call(suggestion), usage]]);
    expect(runtime.result("completed", controller.signal)).toBe(validateAiNextMessage(suggestion, "Was hat Jana gefragt?"));
    expect(requests).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "loop_end", reason: "stop", aggregate: { assistantMessageCount: 1, toolCallCount: 0 } });
    expect(events.some((event) => event.type === "tool_execution_start")).toBe(false);
  });
  test.each([true, false])("mixed calls get the note and redact named or initially unnamed arguments: %j", async (named) => {
    const other: ProviderEvent = {
      type: "block_end",
      blockId: "other",
      index: 2,
      block: { type: "tool_call", id: "other", name: "read", args: {} },
    };
    const { requests, events, runtime, controller } = await run([
      [
        text(),
        {
          type: "block_start",
          blockId: "suggestion",
          index: 1,
          kind: "tool_call",
          callId: "suggestion",
          ...(named ? { name: "suggest_next_message" } : {}),
        },
        { type: "block_delta", blockId: "suggestion", delta: '{"text":"Ja, antworte Jana"}' },
        call(),
        other,
        usage,
      ],
      [text("Jetzt fertig.")],
    ]);
    expect(runtime.result("completed", controller.signal)).toBeNull();
    expect(JSON.stringify(requests[1]?.messages)).not.toContain("Ja, antworte Jana");
    expect(events.filter((event) => event.type === "block_delta" && event.blockId === "suggestion")).toEqual([]);
    expect(requests[1]?.messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        content: expect.arrayContaining([
          expect.objectContaining({ type: "tool_call", name: "suggest_next_message", args: { text: null } }),
        ]),
      }),
    );
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages).toContainEqual(
      expect.objectContaining({ role: "tool_result", name: "suggest_next_message", result: AI_NEXT_MESSAGE_NOTED }),
    );
    const mapper = __aiExecutorTest.createEventMapper(1, []);
    expect(
      events
        .flatMap((event) => mapper.translate(event))
        .some((op) => op.type === "block_set" && op.block.kind === "tool" && op.block.name === "suggest_next_message"),
    ).toBe(false);
    const history = requests[1]!.messages.map((message, seq) => ({ seq, message }));
    expect(buildBlocksFromMessages(history).some((block) => block.kind === "tool" && block.name === "suggest_next_message")).toBe(false);
  });
  test.each([null, "**invalid**", "Ja, antworte Jana"])("ignores mixed calls and keeps the closing call: %j", async (first) => {
    const other: ProviderEvent = {
      type: "block_end",
      blockId: "other",
      index: 2,
      block: { type: "tool_call", id: "other", name: "read", args: {} },
    };
    const { runtime, controller, requests } = await run([
      [text(), call(first), other, usage],
      [text(), call("Ja, entwirf etwas anderes", "second"), usage],
    ]);
    expect(requests).toHaveLength(2);
    expect(runtime.result("completed", controller.signal)).toBe("Ja, entwirf etwas anderes");
  });
  test("a call without preceding answer text gets the note and another step", async () => {
    const { requests, runtime, controller } = await run([[call(), text(), usage], [text()]]);
    expect(runtime.result("completed", controller.signal)).toBeNull();
    expect(JSON.stringify(requests[1]?.messages)).not.toContain("Ja, antworte Jana");
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages).toContainEqual(expect.objectContaining({ result: AI_NEXT_MESSAGE_NOTED }));
  });
  test("a stop stays aborted and cannot save a suggestion", async () => {
    const { events, runtime, controller } = await run([[text(), call(), usage]], { stop: true });
    expect(events.at(-1)).toMatchObject({ type: "loop_end", reason: "aborted" });
    expect(runtime.result("completed", controller.signal)).toBeNull();
    await runtime.save("aborted", controller.signal);
  });
  test("steering is consumed before normal completion", async () => {
    const { events, requests, runtime, controller } = await run([[text(), call(), usage], [text("Kai statt Jana.")]], { redirect: true });
    expect(runtime.result("completed", controller.signal)).toBeNull();
    expect(requests).toHaveLength(2);
    expect(events.some((event) => event.type === "steer_applied")).toBe(true);
  });
  test("provider errors cannot save a suggestion", async () => {
    const { events, runtime, controller } = await run([
      [
        text(),
        call(),
        { type: "issue", issue: { kind: "provider_error", message: "Fixture error", retryable: false } },
        { ...usage, finishReason: "error" },
      ],
    ]);
    expect(events.at(-1)).toMatchObject({ type: "loop_end", reason: "error" });
    expect(runtime.result("completed", controller.signal)).toBeNull();
    await runtime.save("completed", controller.signal);
  });
});
