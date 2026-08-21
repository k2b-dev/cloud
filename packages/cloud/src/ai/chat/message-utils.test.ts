import { describe, expect, test } from "bun:test";
import type { LoopAggregate, Message, Usage } from "@k2b/nessi";
import type { AiStoredMessage } from "../types";
import {
  aiToolIcon,
  capabilityErrorDescription,
  displayToolName,
  fetchFileErrorPresentation,
  latestLoopUsage,
  latestUsage,
  latestUsageSnapshot,
  memoryToolPresentation,
} from "./message-utils";

const storedAssistant = (input: { usage: Usage; aggregate?: LoopAggregate }): AiStoredMessage => {
  const message: Message = {
    role: "assistant",
    content: [{ type: "text", text: "Done" }],
    usage: input.usage,
    stopReason: "stop",
  };
  return {
    id: "message-1",
    shortId: "mSg234",
    conversationId: "conversation-1",
    seq: 1,
    kind: "message",
    message,
    loopId: "loop-1",
    modelProfileId: "model-1",
    providerModel: "provider/model",
    usage: input.usage,
    stopReason: "stop",
    loopAggregate: input.aggregate ?? null,
    loopDoneReason: input.aggregate ? "stop" : null,
    compactedAt: null,
    meta: null,
    createdAt: new Date(0).toISOString(),
  };
};

const aggregate = (lastRequest: Usage, loopUsage: Usage): LoopAggregate => ({
  turns: [
    {
      message: { role: "assistant", content: [{ type: "text", text: "Working" }], stopReason: "tool_use" },
      usage: { input: 8_598, output: 118, total: 8_716 },
      stopReason: "tool_use",
      toolCalls: [],
    },
    {
      message: { role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop" },
      usage: lastRequest,
      stopReason: "stop",
      toolCalls: [],
    },
  ],
  usage: loopUsage,
  issueCount: 0,
  issues: [],
  toolCallCount: 0,
  toolErrorCount: 0,
  toolIssueCount: 0,
  toolMalformedCount: 0,
  toolCancelledCount: 0,
  toolIssues: [],
  assistantMessageCount: 2,
});

describe("AI usage selectors", () => {
  test("separates the final provider request from cumulative loop usage", () => {
    const finalRequest = { input: 15_876, output: 32, total: 15_908 };
    const loopUsage = { input: 69_944, output: 819, total: 70_763 };
    const messages = [storedAssistant({ usage: loopUsage, aggregate: aggregate(finalRequest, loopUsage) })];

    expect(latestUsage(messages)).toEqual(finalRequest);
    expect(latestLoopUsage(messages)).toEqual(loopUsage);
    expect(latestUsageSnapshot(messages)).toEqual({ request: finalRequest, loop: loopUsage, modelProfileId: "model-1" });
  });

  test("falls back to stored turn usage for legacy single-turn messages", () => {
    const requestUsage = { input: 400, output: 20, total: 420 };
    const messages = [storedAssistant({ usage: requestUsage })];

    expect(latestUsage(messages)).toEqual(requestUsage);
    expect(latestLoopUsage(messages)).toEqual(requestUsage);
  });
});

describe("AI tool icons", () => {
  test("humanizes technical fallback names without metadata", () => {
    expect(displayToolName("search_tools")).toBe("Search tools");
    expect(displayToolName("custom_tool")).toBe("Custom tool");
    expect(displayToolName("local_bash")).toBe("Local Bash");
  });

  test.each([
    ["search_project", "ti ti-folder-search"],
    ["read_project_knowledge", "ti ti-notebook"],
    ["list_files", "ti ti-file-spark"],
    ["read_file", "ti ti-file-spark"],
    ["write_file", "ti ti-file-spark"],
    ["fetch_file", "ti ti-world-download"],
    ["markdown_to_pdf", "ti ti-file-type-pdf"],
    ["present", "ti ti-file-spark"],
    ["view_image", "ti ti-photo-spark"],
    ["memory", "ti ti-brain"],
    ["calculate", "ti ti-calculator"],
    ["web_search", "ti ti-search"],
    ["web_extract", "ti ti-world-download"],
    ["search_help", "ti ti-help-hexagon"],
    ["read_help", "ti ti-help-hexagon"],
    ["search_tools", "ti ti-ai-gateway"],
    ["load_tools", "ti ti-ai-gateway"],
    ["load_skill", "ti ti-sparkles"],
    ["list_apps", "ti ti-apps"],
    ["read_cloud_resource", "ti ti-ai-gateway"],
    ["local_bash", "ti ti-terminal-2"],
    ["card", "ti ti-layout-cards"],
    ["survey", "ti ti-forms"],
    ["text_editor", "ti ti-edit"],
  ])("maps %s to its semantic family", (name, icon) => {
    expect(aiToolIcon(name)).toBe(icon);
  });

  test("keeps app identity and uses the AI gateway only as the capability fallback", () => {
    expect(aiToolIcon("contacts__query__list", "ti ti-address-book")).toBe("ti ti-address-book");
    expect(aiToolIcon("contacts__query__list")).toBe("ti ti-ai-gateway");
    expect(aiToolIcon("custom_tool")).toBe("ti ti-tool");
  });
});

describe("capability error presentation", () => {
  test("uses the canonical error without exposing raw structured details", () => {
    expect(capabilityErrorDescription({ code: "CONFLICT", message: "Reload the Skill before saving." })).toBe(
      "CONFLICT: Reload the Skill before saving.",
    );
  });

  test("bounds and flattens provider errors for a single chat row", () => {
    expect(capabilityErrorDescription(`Bad input\n${"x".repeat(600)}`)).toBe(`Bad input ${"x".repeat(487)}...`);
  });
});

describe("fetch_file error presentation", () => {
  test("separates a categorized title from its actionable explanation", () => {
    expect(fetchFileErrorPresentation("File not found — The linked file does not exist.")).toEqual({
      label: "File not found",
      description: "The linked file does not exist.",
    });
  });

  test("keeps unknown failures useful without inventing a category", () => {
    expect(fetchFileErrorPresentation({ error: "Connection reset" })).toEqual({
      label: "File download failed",
      description: "Connection reset",
    });
  });
});

describe("memory tool presentation", () => {
  test("shows an added memory once without technical result fields", () => {
    expect(
      memoryToolPresentation(
        { action: "add", content: "Valentin is in Reichardtsroth until Wednesday." },
        { ok: true, message: "Remembered: Valentin is in Reichardtsroth until Wednesday." },
      ),
    ).toEqual({ label: "Remembered", description: "Valentin is in Reichardtsroth until Wednesday.", failed: false });
  });

  test("uses the affected entry for deletion copy", () => {
    expect(memoryToolPresentation({ action: "delete", id: "memory-id" }, { ok: true, message: "Forgot memory: First visit." })).toEqual({
      label: "Forgot memory",
      description: "First visit.",
      failed: false,
    });
  });

  test("keeps failed updates visible", () => {
    expect(memoryToolPresentation({ action: "add", content: "A fact" }, { ok: false, message: "Memory is full." })).toEqual({
      label: "Memory not updated",
      description: "Memory is full.",
      failed: true,
    });
  });
});
