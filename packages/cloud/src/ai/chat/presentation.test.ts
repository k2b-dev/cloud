import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type AiTurnBlock, splitActiveTurnBlocks } from "../protocol";

test("uses the shared message streaming state before the first model block", () => {
  const presentationSource = readFileSync(resolve(import.meta.dir, "presentation.tsx"), "utf8");
  const blocksSource = readFileSync(resolve(import.meta.dir, "blocks.tsx"), "utf8");

  expect(presentationSource).toContain("id: `${turn.turnId}-pending`");
  expect(presentationSource).toContain('kind: "message"');
  expect(presentationSource).toContain('status: "streaming"');
  expect(presentationSource).not.toContain("Generating response");
  expect(blocksSource).toContain('label="Thinking"');
  expect(blocksSource).toContain('label="Show reasoning"');
});

test("uses the full message width for every tool, including persisted messages", () => {
  const presentationSource = readFileSync(resolve(import.meta.dir, "presentation.tsx"), "utf8");
  const cloudStyles = readFileSync(resolve(import.meta.dir, "../../styles/effects.css"), "utf8");

  expect(presentationSource).toContain('const isWideBlock = (block: AiAssistantTimelineItem["blocks"][number]) => block.kind === "tool";');
  expect(presentationSource).toContain('class: item.blocks.some(isWideBlock) ? "ai-chat-message-wide" : undefined');
  expect(presentationSource).toContain('class: blocks.some(isWideBlock) ? "ai-chat-message-wide" : undefined');
  expect(cloudStyles).toMatch(/\.k2b-chat-message\.ai-chat-message-wide\s*\{\s*width:\s*100%;/);
  expect(cloudStyles).toMatch(/\.k2b-chat-message\.ai-chat-message-wide\s*\{[^}]*max-width:\s*none;/);
  expect(cloudStyles).toMatch(/\.k2b-chat-message\.ai-chat-message-wide\s+:where\([^}]+min-width:\s*0;/);
  expect(cloudStyles).toMatch(/\.k2b-button\.ai-chat-result-link\[data-size="xs"\]\s*\{[^}]*min-height:\s*1\.25rem;/);
  expect(cloudStyles).toMatch(/\.k2b-button\.ai-chat-result-link\[data-size="xs"\]\s*\{[^}]*padding-block:\s*0;/);
});

test("keeps persisted assistant blocks in their original order without a Worked wrapper", () => {
  const presentationSource = readFileSync(resolve(import.meta.dir, "presentation.tsx"), "utf8");

  expect(presentationSource).toContain(
    "<AiTurnBlockList blocks={renderable()} turnId={turnId()} disclosureState={props.disclosureState} />",
  );
  expect(presentationSource).not.toContain("const worked =");
  expect(presentationSource).not.toContain("const visible =");
  expect(presentationSource).not.toContain("Worked for ${");
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
