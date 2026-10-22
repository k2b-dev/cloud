import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { InboundEvent, OutboundEvent, ProviderRequest, StoreEntry, Tool } from "@k2b/nessi";
import { defineTool as defineNessiTool, nessi } from "@k2b/nessi";
import type { Provider } from "@k2b/nessi/ai";
import { z } from "zod";
import type { CapabilityActionCallReview } from "../contracts/capabilities";
import type { RequestActor } from "../server";
import { coreSettings } from "../services";
import { approvalReviewDigest } from "../services/approvals";
import { aiToolAllowsAlways, aiToolApprovalScope, aiToolNeedsApproval } from "./approvals";
import { aiChatAccessSubject } from "./assistant-models";
import * as credentials from "./credentials";
import {
  CLOUD_AI_DEFERRED_BUILTIN_TOOL_NAMES,
  CloudAiCardInputSchema,
  CloudAiTextEditorInputSchema,
  CloudAiTextEditorOutputSchema,
  createCloudAiCardTool,
  createCloudAiCodeTools,
  createCloudAiLocalBashTool,
  createConfiguredDefaultCloudAiTools,
  createDefaultCloudAiTools,
} from "./default-tools";
import { aiModelAccess } from "./model-access";
import { AiTurnActionSchema } from "./runtime";
import * as settings from "./settings";
import { cloudToolReview } from "./tool-sentences";
import { type AiApprovalUse, aiApprovalAskedLater, aiToolPromptHints, defineAiTool, prepareAiTools } from "./tools";
import type { AiApprovalTarget, AiModelProfile, AiToolRuntime } from "./types";

afterEach(() => mock.restore());

const configureAudio = async () => {
  const audio: AiModelProfile = {
    id: "speech",
    label: "Speech",
    provider: "openai-compatible",
    model: "whisper",
    baseURL: "https://example.invalid/v1",
    enabled: true,
    capabilities: ["transcription"],
    dataBoundary: "private",
  };
  const chat: AiModelProfile = { ...audio, id: "chat", capabilities: ["streaming", "tools"] };
  const state = await settings.resolveAiSettingsStateFromRaw({
    enabled: true,
    defaultModelId: chat.id,
    profilesJson: JSON.stringify([chat, audio]),
  });
  spyOn(settings, "readAiSettingsState").mockResolvedValue(state);
  spyOn(coreSettings, "get").mockResolvedValue(audio.id);
  spyOn(credentials, "getAiCredential").mockResolvedValue(null);
  spyOn(aiModelAccess, "assertAllowed").mockResolvedValue();
};

const actor = {
  kind: "user",
  user: {
    id: "11111111-1111-4111-8111-111111111111",
    uid: "tester",
    roles: ["user"],
    provider: "local",
  },
} as RequestActor;

describe("AI tools", () => {
  test("maps Cloud server tools to Nessi server tools with approval", () => {
    const tool = defineAiTool({
      name: "create_record",
      description: "Create a record",
      inputSchema: z.object({ title: z.string() }),
      outputSchema: z.object({ id: z.string() }),
      approval: "once",
    }).server(async ({ title }) => ({ id: title }));

    const prepared = prepareAiTools({ tools: [tool], actor });

    expect(prepared.tools[0]?.kind).toBe("server");
    expect(prepared.tools[0]?.def.needsApproval).toBe(true);
    expect(prepared.approvalPolicies.get("create_record")).toBe("once");
  });

  test("intermediate results use the declared schema and normal result budget", async () => {
    const reports: unknown[] = [];
    const tool = defineAiTool({
      name: "show_partial",
      description: "Show progress",
      inputSchema: z.object({ text: z.string() }),
      outputSchema: z.object({ text: z.string() }),
      approval: "never",
    }).server(async (input, ctx) => {
      await ctx.reportResult?.(input);
      return input;
    });
    const prepared = prepareAiTools({
      tools: [tool],
      actor,
      maxToolResultChars: 40,
      reportToolResult: async (_, value) => {
        reports.push(value);
      },
    });
    const runtime = prepared.tools[0]!;
    if (runtime.kind !== "server") throw new Error("Expected server tool");
    const context = {
      callId: "partial",
      signal: new AbortController().signal,
      requestApproval: async () => true,
      requestClientTool: async () => {
        throw new Error("unused");
      },
    };
    await runtime.execute({ text: "ready" }, context);
    expect(reports).toEqual([{ text: "ready" }]);
    await expect(runtime.execute({ text: "x".repeat(100) }, context)).rejects.toThrow("AI_TOOL_INTERIM_RESULT_TOO_LARGE");
    expect(reports).toHaveLength(1);
  });
  test("forwards optional historical result projectors to Nessi", async () => {
    const tool = defineAiTool({
      name: "read_report",
      description: "Read a report",
      inputSchema: z.object({ reportId: z.string() }),
      outputSchema: z.object({ rows: z.array(z.string()) }),
      approval: "never",
      toHistoricalResult: ({ input, output }) => ({ reportId: input.reportId, rowCount: output.rows.length }),
    }).server(async () => ({ rows: ["a", "b"] }));

    const prepared = prepareAiTools({ tools: [tool], actor });
    const historical = await prepared.tools[0]?.def.toHistoricalResult?.({
      input: { reportId: "r1" },
      output: { rows: ["a", "b"] },
      callId: "call-1",
    });

    expect(historical).toEqual({ reportId: "r1", rowCount: 2 });
  });

  test("persists full results for the origin loop and projects them in a later Cloud loop", async () => {
    const entries: StoreEntry[] = [];
    const requests: ProviderRequest[] = [];
    let providerCall = 0;
    const provider: Provider = {
      name: "historical-test",
      family: "openai-compatible",
      model: "historical-test",
      capabilities: { streaming: true, tools: true, images: false, thinking: false, usage: true },
      async *stream(request) {
        requests.push(request);
        if (providerCall++ === 0) {
          yield { type: "block_start", blockId: "tool-block", index: 0, kind: "tool_call", callId: "report-1", name: "read_report" };
          yield {
            type: "block_end",
            blockId: "tool-block",
            index: 0,
            block: { type: "tool_call", id: "report-1", name: "read_report", args: { reportId: "r1" } },
          };
          yield { type: "usage", usage: { input: 100, output: 20, total: 120 }, finishReason: "tool_use" };
          return;
        }
        yield { type: "block_start", blockId: `text-${providerCall}`, index: 0, kind: "text" };
        yield { type: "block_delta", blockId: `text-${providerCall}`, delta: "Done" };
        yield { type: "block_end", blockId: `text-${providerCall}`, index: 0, block: { type: "text", text: "Done" } };
        yield { type: "usage", usage: { input: 120, output: 5, total: 125 }, finishReason: "stop" };
      },
      async complete() {
        throw new Error("complete should not be used");
      },
    };
    const tool = defineAiTool({
      name: "read_report",
      description: "Read a report",
      inputSchema: z.object({ reportId: z.string() }),
      outputSchema: z.object({ rows: z.array(z.string()) }),
      approval: "never",
      toHistoricalResult: ({ input, output }) => ({ reportId: input.reportId, rowCount: output.rows.length }),
    }).server(async () => ({ rows: ["full", "report", "rows"] }));
    const prepared = prepareAiTools({ tools: [tool], actor });
    const store = {
      append: async (message: StoreEntry["message"]) => {
        entries.push({ seq: entries.length + 1, kind: "message" as const, message });
      },
      load: async () => entries,
    };

    for await (const _event of nessi({
      loopId: "origin-loop",
      provider,
      systemPrompt: "test",
      store,
      tools: prepared.tools,
      input: "Read the report",
    })) {
      // drain
    }
    for await (const _event of nessi({
      loopId: "later-loop",
      provider,
      systemPrompt: "test",
      store,
      tools: prepared.tools,
      input: "What did the report contain?",
    })) {
      // drain
    }

    const storedResult = entries.find((entry) => entry.message.role === "tool_result")?.message;
    expect(storedResult?.role === "tool_result" ? storedResult.result : undefined).toEqual({ rows: ["full", "report", "rows"] });
    expect(storedResult?.role === "tool_result" ? storedResult.historicalResult?.value : undefined).toEqual({
      reportId: "r1",
      rowCount: 3,
    });
    const originResult = requests[1]?.messages.find((message) => message.role === "tool_result");
    const laterResult = requests[2]?.messages.find((message) => message.role === "tool_result");
    expect(originResult?.role === "tool_result" ? originResult.result : undefined).toEqual({ rows: ["full", "report", "rows"] });
    expect(laterResult?.role === "tool_result" ? laterResult.result : undefined).toEqual({ reportId: "r1", rowCount: 3 });
  });

  test("a nested approval names its target under the call ID Nessi gives it", async () => {
    const described = new Map<string, unknown>();
    const target = { toolName: "website:read", approvalScope: "https://api.example.com", always: false };
    const tool = defineAiTool({
      name: "fetch_twice",
      description: "Asks twice",
      inputSchema: z.object({}),
      outputSchema: z.object({ approved: z.array(z.boolean()) }),
      approval: "never",
    }).server(async (_input, ctx) => ({
      approved: [await ctx.requestApproval("First"), await ctx.requestApprovalFor!("Second", target)],
    }));
    const prepared = prepareAiTools({
      tools: [tool],
      actor,
      describeApproval: (callId, value) => described.set(callId, value),
    });
    let calls = 0;
    const provider: Provider = {
      name: "approval-test",
      family: "openai-compatible",
      model: "approval-test",
      capabilities: { streaming: true, tools: true, images: false, thinking: false, usage: true },
      async *stream() {
        if (calls++ === 0) {
          yield { type: "block_start", blockId: "call", index: 0, kind: "tool_call", callId: "run", name: "fetch_twice" };
          yield { type: "block_end", blockId: "call", index: 0, block: { type: "tool_call", id: "run", name: "fetch_twice", args: {} } };
          yield { type: "usage", usage: { input: 1, output: 1, total: 2 }, finishReason: "tool_use" };
          return;
        }
        yield { type: "block_start", blockId: "text", index: 0, kind: "text" };
        yield { type: "block_end", blockId: "text", index: 0, block: { type: "text", text: "Done" } };
        yield { type: "usage", usage: { input: 1, output: 1, total: 2 }, finishReason: "stop" };
      },
      async complete() {
        throw new Error("complete should not be used");
      },
    };
    const entries: StoreEntry[] = [];
    const loop = nessi({
      loopId: "approval-loop",
      provider,
      systemPrompt: "test",
      tools: prepared.tools,
      input: "Run",
      store: {
        append: async (message) => {
          entries.push({ seq: entries.length + 1, kind: "message", message });
        },
        load: async () => entries,
      },
    });
    const requested: string[] = [];
    for await (const event of loop) {
      if (event.type !== "tool_action_request") continue;
      requested.push(event.callId);
      loop.push({ type: "approval_response", callId: event.callId, approved: true });
    }
    expect(requested).toEqual(["run-approval-0", "run-approval-1"]);
    expect([...described]).toEqual([["run-approval-1", target]]);
  });

  test("maps frontend interaction tools to Nessi client tools with mode metadata", () => {
    const tool = defineAiTool({
      name: "survey",
      description: "Ask the user a survey question",
      inputSchema: z.object({ question: z.string() }),
      outputSchema: z.object({ answer: z.string() }),
      approval: { kind: "user-configurable", default: "always", scope: "survey" },
    }).clientInteraction();

    const prepared = prepareAiTools({ tools: [tool], actor });

    expect(prepared.tools[0]?.kind).toBe("client");
    expect(prepared.tools[0]?.def.needsApproval).toBe(false);
    expect(prepared.frontendModes.get("survey")).toBe("client_interaction");
    expect(prepared.approvalPolicies.get("survey")).toEqual({ kind: "user-configurable", default: "always", scope: "survey" });
    // Output validation now lives in nessi: the schema travels with the tool definition.
    expect(prepared.tools[0]?.def.outputSchema).toBe(tool.def.outputSchema);
  });

  test("ships default interaction tools and the chart without offering Card to the Assistant", () => {
    const prepared = prepareAiTools({ tools: createDefaultCloudAiTools(), actor });

    expect(prepared.tools.map((tool) => tool.def.name)).toEqual(["todo_write", "survey", "text_editor", "chart"]);
    expect(prepared.tools.map((tool) => tool.kind)).toEqual(["server", "client", "client", "client"]);
    expect(prepared.frontendModes.get("survey")).toBe("client_interaction");
    expect(prepared.frontendModes.get("text_editor")).toBe("client_interaction");
    // Display only: the server answers the call itself, so a chart never waits for a browser.
    expect(prepared.frontendModes.get("chart")).toBe("client_view");
    expect(prepared.approvalPolicies.get("survey")).toBe("never");
    expect(prepared.approvalPolicies.get("text_editor")).toBe("never");
    expect(prepared.approvalPolicies.get("chart")).toBe("never");
    expect(CLOUD_AI_DEFERRED_BUILTIN_TOOL_NAMES.has("card")).toBe(false);
    expect(CLOUD_AI_DEFERRED_BUILTIN_TOOL_NAMES.has("chart")).toBe(true);
  });

  test("managed execution is deferred and only user-facing code tools need a browser", () => {
    const defaults = prepareAiTools({ tools: createDefaultCloudAiTools(), actor });
    const browser = prepareAiTools({ tools: createCloudAiCodeTools(), actor });
    for (const tool of browser.tools) {
      expect(defaults.tools.some((entry) => entry.def.name === tool.def.name)).toBe(false);
      expect(CLOUD_AI_DEFERRED_BUILTIN_TOOL_NAMES.has(tool.def.name)).toBe(true);
    }
    expect(browser.tools.map((tool) => tool.def.name)).toEqual([
      "code_secret",
      "code_action",
      "code_run",
      "code_inspect",
      "code_stop",
      "code_open",
      "code_check",
      "code_present",
      "code_export",
    ]);
    const check = browser.tools.find((tool) => tool.def.name === "code_check");
    expect(check?.kind).toBe("server");
    expect(browser.frontendModes.get("code_check")).toBeUndefined();
    expect(browser.approvalPolicies.get("code_check")).toBe("never");
    expect(check?.def.description).toContain("for EVERY path in review.paths");
    const presentation = browser.tools.find((tool) => tool.def.name === "code_present");
    expect(presentation?.kind).toBe("server");
    expect(browser.frontendModes.get("code_present")).toBeUndefined();
    expect(browser.approvalPolicies.get("code_present")).toBe("never");
    expect(browser.frontendModes.get("code_secret")).toBe("client");
    expect(browser.approvalPolicies.get("code_secret")).toBe("never");
    expect(browser.frontendModes.get("code_run")).toBeUndefined();
    expect(browser.tools.find((tool) => tool.def.name === "code_run")?.kind).toBe("server");
    expect(browser.tools.find((tool) => tool.def.name === "code_action")?.kind).toBe("server");
    expect(browser.frontendModes.get("code_open")).toBe("client");
    expect(browser.approvalPolicies.get("code_run")).toBe("never");
  });

  test("keeps local Bash outside the default toolset", () => {
    const defaults = prepareAiTools({ tools: createDefaultCloudAiTools(), actor });
    const localBash = prepareAiTools({ tools: [createCloudAiLocalBashTool()], actor });

    expect(defaults.tools.some((tool) => tool.def.name === "local_bash")).toBe(false);
    expect(localBash.tools[0]?.kind).toBe("client");
    expect(localBash.frontendModes.get("local_bash")).toBe("client");
    expect(localBash.approvalPolicies.get("local_bash")).toBe("never");
  });

  test("adds Firecrawl web tools only when configured", async () => {
    await configureAudio();
    const withoutWeb = await createConfiguredDefaultCloudAiTools({ firecrawlApiKey: "", accessSubject: aiChatAccessSubject(actor) });
    const withWeb = await createConfiguredDefaultCloudAiTools({ firecrawlApiKey: "fc-secret", accessSubject: aiChatAccessSubject(actor) });

    expect(withoutWeb.some((tool) => tool.def.name.startsWith("web_"))).toBe(false);
    expect(withWeb.filter((tool) => tool.def.name.startsWith("web_")).map((tool) => tool.def.name)).toEqual(["web_search", "web_extract"]);
    expect(withWeb.filter((tool) => !tool.def.name.startsWith("web_")).map((tool) => tool.def.name)).toEqual(
      withoutWeb.map((tool) => tool.def.name),
    );
    expect(aiToolPromptHints(withoutWeb).map((hint) => hint.name)).toEqual([
      "todo_write",
      "survey",
      "text_editor",
      "chart",
      "map",
      "code_create",
      "list_files",
      "read_file",
      "fetch_file",
      "write_file",
      "markdown_to_pdf",
      "html_to_pdf",
      "present",
      "calculate",
      "view_image",
      "transcribe_audio",
    ]);

    const prepared = prepareAiTools({ tools: withWeb, actor });
    expect(prepared.tools.find((tool) => tool.def.name === "web_search")?.kind).toBe("server");
    expect(prepared.tools.find((tool) => tool.def.name === "web_extract")?.kind).toBe("server");
    expect(prepared.tools.find((tool) => tool.def.name === "fetch_file")?.kind).toBe("server");
    expect(CLOUD_AI_DEFERRED_BUILTIN_TOOL_NAMES.has("fetch_file")).toBe(false);
    // Weaker models skip a load_tools detour and estimate sums mentally, so calculate is always callable.
    expect(CLOUD_AI_DEFERRED_BUILTIN_TOOL_NAMES.has("calculate")).toBe(false);
    expect(prepared.approvalPolicies.get("fetch_file")).toBe("never");
    expect(prepared.approvalPolicies.get("web_search")).toBe("never");
    expect(prepared.approvalPolicies.get("web_extract")).toBe("never");
  });

  test("accepts flat highlight-card trend fields from model tool calls", () => {
    const parsed = CloudAiCardInputSchema.parse({
      title: "Latency",
      value: "42 ms",
      trendLabel: "vs last week",
      trendValue: "-8%",
      trendDirection: "down",
    });

    expect(parsed).toEqual({
      title: "Latency",
      value: "42 ms",
      tone: "teal",
      trendLabel: "vs last week",
      trendValue: "-8%",
      trendDirection: "down",
    });
  });

  test("bounds and defaults the long-form text editor contract", () => {
    expect(CloudAiTextEditorInputSchema.parse({ title: "Review", content: "Hello" })).toEqual({
      title: "Review",
      content: "Hello",
      format: "plain",
      submitLabel: "Continue",
    });
    expect(CloudAiTextEditorOutputSchema.safeParse({ submitted: true, content: "# Hello", format: "markdown" }).success).toBe(true);
    expect(CloudAiTextEditorOutputSchema.safeParse({ submitted: false, feedback: "Make the opening more direct." }).success).toBe(true);
    expect(CloudAiTextEditorInputSchema.safeParse({ title: "Review", content: "x".repeat(20_001) }).success).toBe(false);
    expect(CloudAiTextEditorOutputSchema.safeParse({ submitted: false, feedback: " " }).success).toBe(false);
    expect(CloudAiTextEditorOutputSchema.safeParse({ submitted: false, content: "Hello", format: "plain" }).success).toBe(false);
  });

  test("rejects chart and table payloads for the KISS card tool", () => {
    expect(
      CloudAiCardInputSchema.safeParse({
        kind: "chart",
        title: "Latency",
        data: [{ label: "p95", value: 42 }],
      }).success,
    ).toBe(false);
    expect(
      CloudAiCardInputSchema.safeParse({
        kind: "table",
        title: "Projects",
        columns: ["Name", "Status"],
        rows: [["Website", "Done"]],
      }).success,
    ).toBe(false);
  });

  test("evaluates approval policies for per-user always-allow preferences", () => {
    expect(aiToolNeedsApproval("never")).toBe(false);
    expect(aiToolNeedsApproval("once")).toBe(true);
    expect(aiToolAllowsAlways("once")).toBe(false);
    expect(aiToolAllowsAlways("always")).toBe(true);
    expect(aiToolAllowsAlways({ kind: "user-configurable", default: "once" })).toBe(true);
    expect(aiToolApprovalScope("write_grid", { kind: "user-configurable", default: "once", scope: "grid-write" })).toBe("grid-write");
  });

  test("validates turn continuation actions", () => {
    expect(AiTurnActionSchema.safeParse({ type: "approval_response", approved: true, remember: "always" }).success).toBe(true);
    expect(AiTurnActionSchema.safeParse({ type: "approval_response", approved: true, remember: "chat" }).success).toBe(true);
    expect(AiTurnActionSchema.safeParse({ type: "approval_response", approved: true, remember: "forever" }).success).toBe(false);
    expect(AiTurnActionSchema.safeParse({ type: "tool_result", result: { answer: "yes" } }).success).toBe(true);
    expect(AiTurnActionSchema.safeParse({ type: "approval_response", result: "wrong" }).success).toBe(false);
  });

  test("explicit Card tool reaches Nessi client action requests", async () => {
    const entries: StoreEntry[] = [];
    const provider: Provider = {
      name: "fake",
      family: "openai-compatible",
      model: "fake/card",
      capabilities: { streaming: true, tools: true, images: false, thinking: false, usage: true },
      async *stream() {
        yield { type: "block_start", blockId: "block-0", index: 0, kind: "tool_call", callId: "call-card", name: "card" };
        yield { type: "block_delta", blockId: "block-0", delta: JSON.stringify({ title: "Status", value: "OK" }) };
        yield {
          type: "block_end",
          blockId: "block-0",
          index: 0,
          block: { type: "tool_call", id: "call-card", name: "card", args: { title: "Status", value: "OK" } },
        };
        yield { type: "usage", usage: { input: 1, output: 1, total: 2 }, finishReason: "tool_use" };
      },
      async complete() {
        throw new Error("complete should not be used");
      },
    };
    const prepared = prepareAiTools({ tools: [createCloudAiCardTool()], actor });
    const loop = nessi({
      agentId: "cloud",
      loopId: "loop-card",
      input: "show a card",
      provider,
      systemPrompt: "",
      tools: prepared.tools,
      maxTurns: 1,
      store: {
        append: async (message) => {
          entries.push({ seq: entries.length + 1, kind: "message", message });
        },
        load: async () => entries,
      },
    });

    let actionRequest: Extract<OutboundEvent, { type: "tool_action_request" }> | undefined;
    for await (const event of loop) {
      if (event.type === "tool_action_request") {
        actionRequest = event;
        break;
      }
    }

    expect(actionRequest).toMatchObject({
      type: "tool_action_request",
      kind: "client_tool",
      callId: "call-card",
      name: "card",
      args: { title: "Status", value: "OK", tone: "teal", trendDirection: "flat" },
    });
  });
});

describe("platform approval consumption in server tools", () => {
  const callProvider = (name: string): Provider => {
    let calls = 0;
    return {
      name: "approval-binding-test",
      family: "openai-compatible",
      model: "test",
      capabilities: { streaming: true, tools: true, images: false, thinking: false, usage: true },
      async complete() {
        throw new Error("Unexpected completion");
      },
      async *stream() {
        if (calls++ === 0) {
          yield { type: "block_start", blockId: "call", index: 0, kind: "tool_call", callId: "run", name };
          yield {
            type: "block_end",
            blockId: "call",
            index: 0,
            block: { type: "tool_call", id: "run", name, args: { value: "one" } },
          };
          yield { type: "usage", usage: { input: 1, output: 1, total: 2 }, finishReason: "tool_use" };
        } else {
          yield { type: "block_start", blockId: "done", index: 0, kind: "text" };
          yield { type: "block_end", blockId: "done", index: 0, block: { type: "text", text: "Done" } };
          yield { type: "usage", usage: { input: 1, output: 1, total: 2 }, finishReason: "stop" };
        }
      },
    };
  };
  const toolResult = (entries: StoreEntry[]) =>
    entries.flatMap((entry) => (entry.message.role === "tool_result" ? [entry.message.result] : []));
  const runTool = async (
    tool: AiToolRuntime | Tool,
    hooks: Pick<Parameters<typeof prepareAiTools>[0], "consumeApproval" | "linkApproval" | "describeApproval" | "describeReview">,
    approved = true,
  ) => {
    const entries: StoreEntry[] = [];
    const requested: string[] = [];
    const loop = nessi({
      loopId: "approval-binding",
      provider: callProvider(tool.def.name),
      systemPrompt: "",
      input: "Run",
      maxTurns: 3,
      tools: prepareAiTools({ tools: [tool], actor, ...hooks }).tools,
      store: {
        load: async () => entries,
        append: async (message) => {
          entries.push({ seq: entries.length + 1, kind: "message", message });
        },
      },
    });
    for await (const event of loop) {
      if (event.type !== "tool_action_request") continue;
      requested.push(event.callId);
      loop.push({ type: "approval_response", callId: event.callId, approved });
    }
    return { requested, entries };
  };
  const definition = (approval: "never" | "once" = "never") =>
    defineAiTool({
      name: "write",
      description: "Write",
      inputSchema: z.object({ value: z.string() }),
      outputSchema: z.boolean(),
      approval,
    });
  test("consumes a nested approval against its action ID and real tool input", async () => {
    const consume = mock(async (_callId: string, _input: unknown): Promise<AiApprovalUse> => "approved");
    const result = await runTool(
      definition().server(async (_input, ctx) => ctx.requestApproval("Write?")),
      { consumeApproval: consume },
    );
    expect(result.requested).toEqual(["run-approval-0"]);
    expect(consume).toHaveBeenCalledWith("run-approval-0", { value: "one" });
  });
  test("a failed consumption asks again under the next ID and describes the target again", async () => {
    const consume = mock(async (_callId: string, _input: unknown): Promise<AiApprovalUse> => "approved").mockResolvedValueOnce("changed");
    const describe = mock((_callId: string, _target: AiApprovalTarget) => {});
    const target = { toolName: "demo.write", approvalScope: "item:one", always: true };
    const result = await runTool(
      definition().server(async (_input, ctx) => ctx.requestApprovalFor!("Write?", target)),
      {
        consumeApproval: consume,
        describeApproval: describe,
      },
    );
    expect(result.requested).toEqual(["run-approval-0", "run-approval-1"]);
    expect(consume.mock.calls).toEqual([
      ["run-approval-0", { value: "one" }],
      ["run-approval-1", { value: "one" }],
    ]);
    expect(describe.mock.calls).toEqual([
      ["run-approval-0", target],
      ["run-approval-1", target],
    ]);
  });
  test("nested reviews register before every question and consume the same digest after replay", async () => {
    const base = cloudToolReview("web_extract", { url: "https://example.com/private?value=one" }, "de")!;
    const review: CapabilityActionCallReview = { ...base, ask: "sends" };
    const target = { toolName: "website:read", approvalScope: "https://example.com", always: false };
    const registered = new Map<string, CapabilityActionCallReview>();
    const consumed: string[] = [];
    let attempts = 0;
    const run = () =>
      runTool(
        definition().server(async (_input, ctx) => ctx.requestApprovalFor!("Read?", target, review)),
        {
          describeReview: async (callId, value) => {
            await Promise.resolve();
            registered.set(callId, value);
          },
          consumeApproval: async (callId) => {
            expect(registered.has(callId)).toBe(true);
            consumed.push(approvalReviewDigest(registered.get(callId)));
            return attempts++ === 0 ? "changed" : "approved";
          },
        },
      );
    expect((await run()).requested).toEqual(["run-approval-0", "run-approval-1"]);
    registered.clear();
    expect((await run()).requested).toEqual(["run-approval-0"]);
    expect(consumed).toEqual(Array(3).fill(approvalReviewDigest(review)));
  });
  test("a rejection does not consume", async () => {
    const consume = mock(async (_callId: string, _input: unknown): Promise<AiApprovalUse> => "approved");
    await runTool(
      definition().server(async (_input, ctx) => ctx.requestApproval("Write?")),
      { consumeApproval: consume },
      false,
    );
    expect(consume).not.toHaveBeenCalled();
  });
  test("relays link the record and describe the target without consuming it", async () => {
    const consume = mock(async (_callId: string, _input: unknown): Promise<AiApprovalUse> => "changed"),
      link = mock((_callId: string, _approvalId: string) => {}),
      describe = mock((_callId: string, _target: AiApprovalTarget) => {});
    const approvalId = crypto.randomUUID();
    const target = { toolName: "demo.write", approvalScope: "item:one", always: true };
    const result = await runTool(
      definition().server(async (_input, ctx) => ctx.requestRelayedApproval!("Write?", { approvalId, target })),
      {
        consumeApproval: consume,
        linkApproval: link,
        describeApproval: describe,
      },
    );
    expect(result.requested).toEqual(["run-approval-0"]);
    expect(link).toHaveBeenCalledWith("run-approval-0", approvalId);
    expect(describe).toHaveBeenCalledWith("run-approval-0", target);
    expect(consume).not.toHaveBeenCalled();
  });
  test("native Nessi server tools inherit the same protection", async () => {
    const consume = mock(async (_callId: string, _input: unknown): Promise<AiApprovalUse> => "changed"),
      execute = mock(async () => true);
    const tool = defineNessiTool({
      name: "write",
      description: "Write",
      inputSchema: z.object({ value: z.string() }),
      needsApproval: true,
    }).server(execute);
    await runTool(tool, { consumeApproval: consume });
    expect(consume).toHaveBeenCalledWith("run", { value: "one" });
    expect(execute).not.toHaveBeenCalled();
  });
  test("tool-level approvals refuse execution when consumption fails", async () => {
    for (const [use, error] of [
      ["changed", "This approval no longer matches the call. Ask again."],
      ["used", "This approval was already used, so Cloud does not run the call again."],
    ] as const) {
      const execute = mock(async () => true),
        consume = mock(async (_callId: string, _input: unknown): Promise<AiApprovalUse> => use);
      const result = await runTool(definition("once").server(execute), { consumeApproval: consume });
      expect(result.requested).toEqual(["run"]);
      expect(consume).toHaveBeenCalledWith("run", { value: "one" });
      expect(execute).not.toHaveBeenCalled();
      expect(JSON.stringify(toolResult(result.entries))).toContain(error);
    }
  });

  /** Uses each approval once, like the platform, and lets the call's own resume after a later question through. */
  const platform = () => {
    const asked: string[] = [],
      used = new Set<string>();
    const consume = mock(async (approvalCallId: string, _input: unknown): Promise<AiApprovalUse> => {
      if (!used.has(approvalCallId)) {
        used.add(approvalCallId);
        return "approved";
      }
      return aiApprovalAskedLater(approvalCallId, asked) ? "approved" : "used";
    });
    return { asked, consume };
  };
  /** Suspends at every question and resumes with all answers so far, as each new claim of a waiting turn does. */
  const resumeTool = async (tool: AiToolRuntime, fake: ReturnType<typeof platform>) => {
    const entries: StoreEntry[] = [],
      responses: InboundEvent[] = [],
      requested: { callId: string; message?: string }[] = [];
    const provider = callProvider(tool.def.name);
    const tools = prepareAiTools({ tools: [tool], actor, consumeApproval: fake.consume }).tools;
    for (let attempt = 0; attempt < 5; attempt++) {
      const loop = nessi({
        loopId: "approval-resume",
        provider,
        systemPrompt: "",
        tools,
        maxTurns: 3,
        ...(attempt === 0 ? { input: "Run" } : {}),
        store: {
          load: async () => entries,
          append: async (message) => {
            entries.push({ seq: entries.length + 1, kind: "message", message });
          },
        },
      });
      for (const response of responses) loop.push(response);
      let suspended = false;
      for await (const event of loop) {
        if (event.type !== "tool_action_request") continue;
        requested.push({ callId: event.callId, ...(event.message ? { message: event.message } : {}) });
        fake.asked.push(event.callId);
        responses.push({ type: "approval_response", callId: event.callId, approved: true });
        suspended = true;
        break;
      }
      if (!suspended) return { requested, entries };
    }
    throw new Error("The tool kept asking");
  };
  test("a tool-level approval stays valid when the call resumes after its own nested question", async () => {
    const fake = platform();
    const result = await resumeTool(
      definition("once").server(async (_input, ctx) => ctx.requestApproval("Also archive the attachments?")),
      fake,
    );
    expect(result.requested.map(({ callId }) => callId)).toEqual(["run", "run-approval-0"]);
    expect(fake.consume.mock.calls.map(([callId]) => callId)).toEqual(["run", "run", "run-approval-0"]);
    expect(toolResult(result.entries)).toEqual([true]);
  });
  test("two questions of one call keep their own approvals across resumes", async () => {
    const fake = platform();
    const result = await resumeTool(
      definition().server(async (_input, ctx) => (await ctx.requestApproval("First?")) && ctx.requestApproval("Second?")),
      fake,
    );
    expect(result.requested).toEqual([
      { callId: "run-approval-0", message: "First?" },
      { callId: "run-approval-1", message: "Second?" },
    ]);
    expect(toolResult(result.entries)).toEqual([true]);
  });
  test("an approval an earlier run already used ends the call instead of asking or running again", async () => {
    const execute = mock(async () => true);
    const result = await runTool(
      definition().server(async (_input, ctx) => (await ctx.requestApproval("Write?")) && execute()),
      { consumeApproval: mock(async (_callId: string, _input: unknown): Promise<AiApprovalUse> => "used") },
    );
    expect(result.requested).toEqual(["run-approval-0"]);
    expect(execute).not.toHaveBeenCalled();
    expect(JSON.stringify(toolResult(result.entries))).toContain("This approval was already used");
  });
  test("a relay without a record of its own uses the chat's approval when it hands the decision over", async () => {
    const consume = mock(async (_callId: string, _input: unknown): Promise<AiApprovalUse> => "approved");
    const relay = definition().server(async (_input, ctx) => ctx.requestRelayedApproval!("GET https://example.test/", {}));
    expect(toolResult((await runTool(relay, { consumeApproval: consume })).entries)).toEqual([true]);
    expect(consume).toHaveBeenCalledWith("run-approval-0", { value: "one" });
    // A decision the chat cannot use any more reaches the effect as a refusal.
    consume.mockResolvedValueOnce("used");
    expect(toolResult((await runTool(relay, { consumeApproval: consume })).entries)).toEqual([false]);
  });
  test("only a later question of the same call continues a used approval", () => {
    expect(aiApprovalAskedLater("run", ["run-approval-0"])).toBe(true);
    expect(aiApprovalAskedLater("run", ["run", "other-approval-0"])).toBe(false);
    expect(aiApprovalAskedLater("run-approval-1", ["run-approval-0", "run-approval-1"])).toBe(false);
    expect(aiApprovalAskedLater("run-approval-1", ["run-approval-10"])).toBe(true);
    expect(aiApprovalAskedLater("run-approval-1", ["xrun-approval-2"])).toBe(false);
  });
});
