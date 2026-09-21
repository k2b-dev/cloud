import { expect, test } from "bun:test";
import { createMemo } from "solid-js";
import { createStore, reconcile, unwrap } from "solid-js/store";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import { emptyProjection, mergeActiveTurn, reduceProjection, visibleMessages } from "../client/projection";
import type { AiWireEvent } from "../protocol";

(isServer ? test.skip : test)("streamed text and tool updates render each block exactly once", async () => {
  const dom = createDomTestHarness();
  const { Chat } = await import("@k2b/ui");
  const { createAiChatTimeline, AiChatActionsProvider } = await import("./presentation");
  const [state, setState] = createStore(emptyProjection());
  const emit = (event: AiWireEvent) => setState(reconcile(reduceProjection(state, event), { key: "id", merge: true }));
  const dispose = render(
    () => (
      <AiChatActionsProvider actions={{}}>
        {(() => {
          const items = createAiChatTimeline({ messages: createMemo(() => visibleMessages(state)), activeTurn: () => state.activeTurn });
          return <Chat.Timeline items={items()} />;
        })()}
      </AiChatActionsProvider>
    ),
    dom.root,
  );
  const base = { v: 1 as const, conversationId: "chat", turnId: "turn", attempt: 1 };
  try {
    emit({ ...base, seq: 1, type: "turn_started", modelProfileId: "model", providerModel: "model", blocks: [] });
    for (let index = 0; index < 10; index++) {
      emit({
        ...base,
        seq: 2 + index * 3,
        type: "block_delta",
        blockId: `text-${index}`,
        blockKind: "text",
        delta: `Unique message ${index}.`,
      });
      emit({
        ...base,
        seq: 3 + index * 3,
        type: "block_set",
        block: { id: `tool-${index}`, kind: "tool", callId: `call-${index}`, name: "code_run", args: {}, status: "running" },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (let previous = 0; previous <= index; previous++)
        expect(dom.root.textContent?.split(`Unique message ${previous}.`).length).toBe(2);
      emit({
        ...base,
        seq: 4 + index * 3,
        type: "block_set",
        block: { id: `tool-${index}`, kind: "tool", callId: `call-${index}`, name: "code_run", args: {}, status: "completed", result: {} },
      });
    }
    const old = structuredClone(unwrap(state.activeTurn))!;
    const baseline = {
      ...old,
      seq: 100,
      blocks: old.blocks.map((block) => ({ ...block, id: block.kind === "text" ? `persisted-${block.id}` : block.id })),
    };
    setState("activeTurn", reconcile(mergeActiveTurn(state.activeTurn, baseline)));
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let index = 0; index < 10; index++) expect(dom.root.textContent?.split(`Unique message ${index}.`).length).toBe(2);
    setState("activeTurn", reconcile(mergeActiveTurn(state.activeTurn, old)));
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let index = 0; index < 10; index++) expect(dom.root.textContent?.split(`Unique message ${index}.`).length).toBe(2);
  } finally {
    dispose();
    dom.cleanup();
  }
});
