import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("AI chat primitives", () => {
  test("leaves response and tool progress indicators to the shared Chat UI", () => {
    const primitiveSource = readFileSync(resolve(import.meta.dir, "primitives.tsx"), "utf8");
    const effectsSource = readFileSync(resolve(import.meta.dir, "../../styles/effects.css"), "utf8");
    const uiChatSource = readFileSync(resolve(import.meta.dir, "../../../../ui/src/chat/ChatPrimitives.tsx"), "utf8");
    const uiStyles = readFileSync(resolve(import.meta.dir, "../../../../ui/src/styles/index.css"), "utf8");

    expect(primitiveSource).not.toContain("PulseDots");
    expect(effectsSource).not.toContain("ai-pulse-dot");
    expect(uiChatSource).toContain("k2b-chat-progress-dots");
    expect(uiStyles).toContain("@keyframes k2b-chat-dot-pulse");
  });

  test("uses the shared Chat activity for generic tool presentation", () => {
    const primitiveSource = readFileSync(resolve(import.meta.dir, "primitives.tsx"), "utf8");
    const blocksSource = readFileSync(resolve(import.meta.dir, "blocks.tsx"), "utf8");
    const fileSource = readFileSync(resolve(import.meta.dir, "file-tools.tsx"), "utf8");
    const presentationSource = readFileSync(resolve(import.meta.dir, "presentation.tsx"), "utf8");
    const disclosureSource = readFileSync(resolve(import.meta.dir, "tool-disclosure.tsx"), "utf8");
    const webSource = readFileSync(resolve(import.meta.dir, "web-tools.tsx"), "utf8");

    expect([primitiveSource, blocksSource, fileSource, presentationSource, disclosureSource, webSource].join("\n")).not.toContain(
      "ChatUtility",
    );
    expect(disclosureSource).toContain("<Chat.Activity");
    expect(blocksSource).toContain("<AiToolActivity");
    expect(blocksSource).toContain("busy");
    expect(fileSource).toContain("<Chat.Activity");
    expect(presentationSource).toContain("<AiTurnBlockList");
    expect(blocksSource).toContain("bodyInset={false}");
    expect(webSource).toContain("<Chat.Activity");
    expect(webSource).toContain('leading={<Favicon url={url()} fallbackIcon="ti ti-world-download" />}');
  });

  test("keeps assistant markdown stable while the generic timeline owns message actions", () => {
    const primitiveSource = readFileSync(resolve(import.meta.dir, "primitives.tsx"), "utf8");
    const blocksSource = readFileSync(resolve(import.meta.dir, "blocks.tsx"), "utf8");
    const actionsSource = readFileSync(resolve(import.meta.dir, "message-actions.tsx"), "utf8");
    const presentationSource = readFileSync(resolve(import.meta.dir, "presentation.tsx"), "utf8");
    const effectsSource = readFileSync(resolve(import.meta.dir, "../../styles/effects.css"), "utf8");

    expect(primitiveSource).toContain("export function AssistantMarkdownBlock");
    expect(primitiveSource).toContain("assistant-markdown-block");
    expect(primitiveSource).not.toContain("AssistantMessageLane");
    expect(primitiveSource).not.toContain("group/assistant-message");
    expect(actionsSource).not.toContain("invisible flex h-7");
    expect(presentationSource).not.toContain("MarkdownView");
    expect(presentationSource).not.toContain("assistantDraftMessage");
    expect(blocksSource).toContain('props.compact ? "gap-1" : "gap-2"');
    expect(presentationSource).toContain("turnId={turnId()} disclosureState={props.disclosureState}");
    // The unified render stack renders persisted messages and the live turn through
    // one block list; no separate draft/detached-block merge remains.
    expect(presentationSource).not.toContain("buildAssistantRenderBlocks");
    expect(presentationSource).toContain("AiTurnBlockList");
    expect(effectsSource).toContain(".assistant-markdown-block :where(*)");
    expect(effectsSource).toContain("margin-block: 0");
  });
});
