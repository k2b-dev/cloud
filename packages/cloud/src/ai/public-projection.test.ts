import { describe, expect, test } from "bun:test";
import type { Message } from "@k2b/nessi";
import { reviewFixture } from "../_internal/capability-review.test-fixture";
import type { AppRegistryEntry } from "../contracts/registry";
import { visibleMessages } from "./client/projection";
import { buildBlocksFromMessages } from "./protocol";
import { projectPublicAiStoredMessages, withCurrentAppNames } from "./public-projection";
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
        meta: { toolInterimResults: { call: { files: { "code.ts": source } } } },
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
