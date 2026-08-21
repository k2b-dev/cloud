import { describe, expect, test } from "bun:test";
import type { OutboundEvent, ProviderRequest, StoreEntry } from "@k2b/nessi";
import { nessi } from "@k2b/nessi";
import type { Provider } from "@k2b/nessi/ai";
import { z } from "zod";
import type { RequestActor } from "../server";
import { aiToolAllowsAlways, aiToolApprovalScope, aiToolNeedsApproval } from "./approvals";
import {
  CloudAiCardInputSchema,
  CloudAiTextEditorInputSchema,
  CloudAiTextEditorOutputSchema,
  CLOUD_AI_DEFERRED_BUILTIN_TOOL_NAMES,
  createCloudAiCardTool,
  createCloudAiLocalBashTool,
  createConfiguredDefaultCloudAiTools,
  createDefaultCloudAiTools,
} from "./default-tools";
import { AiTurnActionSchema } from "./runtime";
import { aiToolPromptHints, defineAiTool, prepareAiTools } from "./tools";

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
    expect(prepared.frontendModes.get("survey")).toBe("client_interaction");
    expect(prepared.approvalPolicies.get("survey")).toEqual({ kind: "user-configurable", default: "always", scope: "survey" });
    // Output validation now lives in nessi: the schema travels with the tool definition.
    expect(prepared.tools[0]?.def.outputSchema).toBe(tool.def.outputSchema);
  });

  test("ships default interaction tools without offering Card to the Assistant", () => {
    const prepared = prepareAiTools({ tools: createDefaultCloudAiTools(), actor });

    expect(prepared.tools.map((tool) => tool.def.name)).toEqual(["survey", "text_editor"]);
    expect(prepared.tools.every((tool) => tool.kind === "client")).toBe(true);
    expect(prepared.frontendModes.get("survey")).toBe("client_interaction");
    expect(prepared.frontendModes.get("text_editor")).toBe("client_interaction");
    expect(prepared.approvalPolicies.get("survey")).toBe("never");
    expect(prepared.approvalPolicies.get("text_editor")).toBe("never");
    expect(CLOUD_AI_DEFERRED_BUILTIN_TOOL_NAMES.has("card")).toBe(false);
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
    const withoutWeb = await createConfiguredDefaultCloudAiTools({ firecrawlApiKey: "" });
    const withWeb = await createConfiguredDefaultCloudAiTools({ firecrawlApiKey: "fc-secret" });

    expect(withoutWeb.map((tool) => tool.def.name)).toEqual([
      "survey",
      "text_editor",
      "list_files",
      "read_file",
      "fetch_file",
      "write_file",
      "markdown_to_pdf",
      "present",
      "calculate",
      "view_image",
    ]);
    expect(withWeb.map((tool) => tool.def.name)).toEqual([
      "survey",
      "text_editor",
      "list_files",
      "read_file",
      "fetch_file",
      "write_file",
      "markdown_to_pdf",
      "present",
      "calculate",
      "view_image",
      "web_search",
      "web_extract",
    ]);
    expect(aiToolPromptHints(withoutWeb).map((hint) => hint.name)).toEqual([
      "survey",
      "text_editor",
      "list_files",
      "read_file",
      "fetch_file",
      "write_file",
      "markdown_to_pdf",
      "present",
      "calculate",
      "view_image",
    ]);

    const prepared = prepareAiTools({ tools: withWeb, actor });
    expect(prepared.tools.find((tool) => tool.def.name === "web_search")?.kind).toBe("server");
    expect(prepared.tools.find((tool) => tool.def.name === "web_extract")?.kind).toBe("server");
    expect(prepared.tools.find((tool) => tool.def.name === "fetch_file")?.kind).toBe("server");
    expect(CLOUD_AI_DEFERRED_BUILTIN_TOOL_NAMES.has("fetch_file")).toBe(false);
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
