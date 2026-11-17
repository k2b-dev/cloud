import { describe, expect, test } from "bun:test";
import type { Message } from "@k2b/nessi";
import type { AppRegistryEntry } from "../contracts/registry";
import { visibleMessages } from "./client/projection";
import type { AiWireEvent } from "./protocol";
import { projectPublicAiStoredMessages, publicAiWireEvent, withCurrentAppNames } from "./public-projection";
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
