import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type AiTurnBlock, splitActiveTurnBlocks } from "../protocol";

test("uses the shared message streaming state before the first model block", () => {
  const presentationSource = readFileSync(resolve(import.meta.dir, "presentation.tsx"), "utf8");
  const viewSource = readFileSync(resolve(import.meta.dir, "turn-view.tsx"), "utf8");

  expect(presentationSource).toContain("if (segments.length === 0 ||");
  expect(presentationSource).toContain('status: turn.status === "running" && last ? "streaming" : "complete"');
  expect(presentationSource).not.toContain("Generating response");
  expect(viewSource).toContain("t.stepThinking");
});

test("spans the message width for turns with work, live and in history", () => {
  const presentationSource = readFileSync(resolve(import.meta.dir, "presentation.tsx"), "utf8");
  const cloudStyles = readFileSync(resolve(import.meta.dir, "../../styles/effects.css"), "utf8");

  expect(presentationSource.match(/class: isWideLayout\(layout(, error)?\) \? "ai-chat-message-wide" : undefined/g)).toHaveLength(2);
  expect(cloudStyles).toMatch(/\.k2b-chat-message\.ai-chat-message-wide\s*\{\s*width:\s*100%;/);
  expect(cloudStyles).toMatch(/\.k2b-chat-message\.ai-chat-message-wide\s*\{[^}]*max-width:\s*none;/);
  expect(cloudStyles).toMatch(/\.k2b-chat-message\.ai-chat-message-wide\s+:where\([^}]+min-width:\s*0;/);
  expect(cloudStyles).toMatch(/\.k2b-button\.ai-chat-result-link\[data-size="xs"\]\s*\{[^}]*min-height:\s*1\.25rem;/);
  expect(cloudStyles).toMatch(/\.k2b-button\.ai-chat-result-link\[data-size="xs"\]\s*\{[^}]*padding-block:\s*0;/);
});

test("renders attributable inter-chat input as a system message", () => {
  const presentationSource = readFileSync(resolve(import.meta.dir, "presentation.tsx"), "utf8");

  expect(presentationSource).toContain("item.entry.meta?.agentMessage");
  expect(presentationSource).toContain('role: "system"');
  expect(presentationSource).toContain("agentMessage.sourceHref");
  expect(presentationSource).toContain("turn {agentMessage.sourceTurnId}");
});

describe("active turn message segmentation", () => {
  test("keeps the optimistic steer bubble between pre-steer work and the applied marker", () => {
    const blocks: AiTurnBlock[] = [
      { id: "text-1", kind: "text", text: "Working" },
      { id: "steer-message-1", kind: "steer_message", steerId: "1", text: "Change course", status: "pending" },
      { id: "tool-1", kind: "tool", callId: "call-1", name: "read_file", status: "completed", result: "ok" },
      { id: "steer-applied-1", kind: "steer_applied", steerId: "1" },
      { id: "text-2", kind: "text", text: "Revised" },
    ];

    const segments = splitActiveTurnBlocks(blocks);
    expect(segments.map((segment) => segment.type)).toEqual(["assistant", "steer", "assistant"]);
    expect(segments[0]).toMatchObject({ type: "assistant", blocks: [{ id: "text-1" }] });
    expect(segments[1]).toMatchObject({ type: "steer", block: { text: "Change course", status: "pending" } });
    expect(segments[2]).toMatchObject({
      type: "assistant",
      blocks: [{ id: "tool-1" }, { id: "steer-applied-1" }, { id: "text-2" }],
    });
  });
});

test("a long step shows its duration in place of its target, in the reader's language", async () => {
  const { liveStepLabel } = await import("./turn-view");
  const { aiChatMessages } = await import("./messages");
  const run: AiTurnBlock = {
    id: "tool-run",
    kind: "tool",
    callId: "run",
    name: "code_run",
    args: { title: "dashboard.tsx" },
    status: "running",
  };
  const read: AiTurnBlock = {
    id: "tool-read",
    kind: "tool",
    callId: "read",
    name: "read_file",
    args: { path: "/q1.csv" },
    status: "running",
  };
  expect(liveStepLabel(run, aiChatMessages("de"), 44_000)).toBe("Führt Code aus · dashboard.tsx");
  expect(liveStepLabel(run, aiChatMessages("de"), 3 * 60_000)).toBe("Führt Code aus · 3 Min.");
  expect(liveStepLabel(read, aiChatMessages("en"))).toBe("Reading q1.csv");
  expect(liveStepLabel(read, aiChatMessages("en"), 60_000)).toBe("Reading a file · 1 min");
});

test("an app check has its own calm live label in the reader's language", async () => {
  const { liveStepLabel } = await import("./turn-view");
  const { aiChatMessages } = await import("./messages");
  const check: AiTurnBlock = {
    id: "tool-check",
    kind: "tool",
    callId: "check",
    name: "code_check",
    args: { id: "app-1" },
    status: "running",
  };
  const inspect: AiTurnBlock = { ...check, id: "tool-inspect", callId: "inspect", name: "code_inspect", args: { runId: "run-1" } };
  expect(liveStepLabel(check, aiChatMessages("en"))).toBe("Checking the app");
  expect(liveStepLabel(check, aiChatMessages("de"))).toBe("Prüft die App");
  expect(liveStepLabel(inspect, aiChatMessages("en"))).toBe("Checking the run");
  expect(liveStepLabel(inspect, aiChatMessages("de"))).toBe("Prüft den Lauf");
});
