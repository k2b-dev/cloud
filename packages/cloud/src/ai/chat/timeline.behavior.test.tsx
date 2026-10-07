import { expect, test } from "bun:test";
import { createMemo, createSignal } from "solid-js";
import { createStore, reconcile, unwrap } from "solid-js/store";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import { emptyProjection, mergeActiveTurn, reduceProjection, visibleMessages } from "../client/projection";
import type { AiStreamEvent, AiTurnBlock, AiWireEvent } from "../protocol";
import type { AiStoredMessage } from "../types";

(isServer ? test.skip : test)("streamed text and tool updates render each block exactly once", async () => {
  const dom = createDomTestHarness();
  // The expanded work line shows every folded text; the newest stays below it.
  window.sessionStorage.setItem("cloud.ai.tool-disclosure:work:ai-turn:turn:0", "open");
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
    window.sessionStorage.clear();
    dom.cleanup();
  }
});

(isServer ? test.skip : test)("a finished turn keeps its elements and host views when it becomes history", async () => {
  const dom = createDomTestHarness();
  const { Chat } = await import("@k2b/ui");
  const { createAiChatTimeline, AiChatActionsProvider } = await import("./presentation");
  const [state, setState] = createStore(emptyProjection());
  const emit = (event: AiStreamEvent) => setState(reconcile(reduceProjection(unwrap(state), event), { key: "id", merge: true }));
  const presentations: (() => unknown)[] = [];
  const dispose = render(
    () => (
      <AiChatActionsProvider
        actions={{
          renderCodePresentation: (result) => {
            presentations.push(result);
            return (
              <section class="host-view">
                {String((result() as { presentationId?: string } | undefined)?.presentationId ?? "pending")}
              </section>
            );
          },
        }}
      >
        {(() => {
          const items = createAiChatTimeline({ messages: createMemo(() => visibleMessages(state)), activeTurn: () => state.activeTurn });
          return <Chat.Timeline items={items()} />;
        })()}
      </AiChatActionsProvider>
    ),
    dom.root,
  );
  const base = { v: 1 as const, conversationId: "chat", turnId: "turn", attempt: 1 };
  const stored = (seq: number, message: AiStoredMessage["message"], patch: Partial<AiStoredMessage> = {}): AiStoredMessage => ({
    id: `m${seq}`,
    shortId: `m${seq}`,
    conversationId: "chat",
    seq,
    kind: "message",
    message,
    loopId: "turn",
    modelProfileId: null,
    providerModel: null,
    usage: null,
    stopReason: null,
    loopAggregate: null,
    loopDoneReason: null,
    compactedAt: null,
    meta: null,
    createdAt: "2026-10-06T10:00:00.000Z",
    ...patch,
  });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  try {
    emit({ ...base, seq: 1, type: "turn_started", modelProfileId: "model", providerModel: "model", blocks: [] });
    emit({ ...base, seq: 2, type: "block_delta", blockId: "a1-t0-0", blockKind: "text", delta: "I build the dashboard." });
    const running = {
      id: "tool-view",
      kind: "tool" as const,
      callId: "view",
      name: "code_present",
      args: { runId: "r", title: "Dashboard" },
    };
    emit({ ...base, seq: 3, type: "block_set", block: { ...running, status: "running" } });
    await tick();
    const turn = dom.root.querySelector(".ai-turn");
    const host = dom.root.querySelector(".host-view");
    expect(host?.textContent).toBe("pending");
    const result = { presentationId: "00000000-0000-4000-8000-000000000001", title: "Dashboard" };
    emit({ ...base, seq: 4, type: "block_set", block: { ...running, status: "completed", result } });
    emit({ ...base, seq: 5, type: "block_delta", blockId: "a1-t1-0", blockKind: "text", delta: "Revenue grew by 8 %." });
    await tick();
    expect(dom.root.querySelector(".host-view")).toBe(host);
    emit({
      ...base,
      seq: 6,
      type: "turn_finished",
      status: "completed",
      error: null,
      messages: [
        stored(10, { role: "user", content: [{ type: "text", text: "Build it" }] }),
        stored(11, {
          role: "assistant",
          content: [
            { type: "text", text: "I build the dashboard." },
            { type: "tool_call", id: "view", name: "code_present", args: running.args },
          ],
        }),
        stored(12, { role: "tool_result", callId: "view", name: "code_present", result, isError: false }),
        stored(13, { role: "assistant", content: [{ type: "text", text: "Revenue grew by 8 %." }] }, { loopDoneReason: "stop" }),
      ],
    });
    await tick();
    expect(state.activeTurn).toBeNull();
    expect(dom.root.querySelector(".ai-turn")).toBe(turn);
    expect(dom.root.querySelector(".host-view")).toBe(host);
    expect(host?.textContent).toBe(result.presentationId);
    expect(presentations).toHaveLength(1);
    expect(dom.root.textContent?.split("Revenue grew by 8 %.").length).toBe(2);
    expect(dom.root.textContent).not.toContain("I build the dashboard.");
  } finally {
    dispose();
    dom.cleanup();
  }
});

(isServer ? test.skip : test)("a provider retry shows one calm reconnecting row at the end of the live turn", async () => {
  const dom = createDomTestHarness();
  const { Chat, LocaleProvider } = await import("@k2b/ui");
  const { createAiChatTimeline, AiChatActionsProvider } = await import("./presentation");
  const [state, setState] = createStore(emptyProjection());
  const [locale, setLocale] = createSignal("en");
  const emit = (event: AiWireEvent) => setState(reconcile(reduceProjection(state, event), { key: "id", merge: true }));
  const dispose = render(
    () => (
      <LocaleProvider locale={locale()}>
        <AiChatActionsProvider actions={{}}>
          {(() => {
            const items = createAiChatTimeline({ messages: createMemo(() => visibleMessages(state)), activeTurn: () => state.activeTurn });
            return <Chat.Timeline items={items()} />;
          })()}
        </AiChatActionsProvider>
      </LocaleProvider>
    ),
    dom.root,
  );
  const base = { v: 1 as const, conversationId: "chat", turnId: "turn", attempt: 1 };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const rows = () => Array.from(dom.root.querySelectorAll(".k2b-chat-activity")).map((row) => row.textContent?.trim());
  try {
    emit({ ...base, seq: 1, type: "turn_started", modelProfileId: "model", providerModel: "model", blocks: [] });
    emit({ ...base, seq: 2, type: "provider_retry" });
    await settle();
    expect(rows()).toEqual(["Reconnecting"]);

    emit({ ...base, seq: 3, type: "block_delta", blockId: "text-1", blockKind: "text", delta: "Checking the files." });
    emit({
      ...base,
      seq: 4,
      type: "block_set",
      block: { id: "tool-1", kind: "tool", callId: "call-1", name: "code_run", args: {}, status: "completed", result: {} },
    });
    await settle();
    expect(rows().some((row) => row?.includes("Reconnecting"))).toBe(false);
    const before = Array.from(dom.root.querySelectorAll(".k2b-chat-activity, .k2b-chat-message"));

    emit({ ...base, seq: 5, type: "provider_retry" });
    await settle();
    // The wait appends one row and leaves every earlier node in place.
    const during = Array.from(dom.root.querySelectorAll(".k2b-chat-activity, .k2b-chat-message"));
    expect(during).toHaveLength(before.length + 1);
    before.forEach((node, index) => expect(during[index]).toBe(node));
    expect(rows().at(-1)).toBe("Reconnecting");

    setLocale("de");
    await settle();
    expect(rows().at(-1)).toBe("Verbindung wird wiederhergestellt");
    const retryRow = Array.from(dom.root.querySelectorAll(".k2b-chat-activity")).at(-1);
    expect(retryRow?.getAttribute("data-busy")).toBeNull();

    emit({ ...base, seq: 6, type: "block_delta", blockId: "text-2", blockKind: "text", delta: "Done." });
    await settle();
    expect(rows().some((row) => row?.includes("Verbindung"))).toBe(false);
    expect(dom.root.textContent).toContain("Done.");
  } finally {
    dispose();
    dom.cleanup();
  }
});

(isServer ? test.skip : test)("a provider retry stays visible after a steer that waits for the next model call", async () => {
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
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const rows = () => Array.from(dom.root.querySelectorAll(".k2b-chat-activity")).map((row) => row.textContent?.trim());
  const nodes = () => dom.root.querySelectorAll(".k2b-chat-activity, .k2b-chat-message");
  try {
    emit({ ...base, seq: 1, type: "turn_started", modelProfileId: "model", providerModel: "model", blocks: [] });
    emit({ ...base, seq: 2, type: "block_delta", blockId: "text-1", blockKind: "text", delta: "Reading the report." });
    // The controller appends the steer locally; the server applies it with the next model call.
    setState("activeTurn", "blocks", (blocks): AiTurnBlock[] => [
      ...blocks,
      { id: "steer-request-1", kind: "steer_message", steerId: "1", text: "Use the newer file", status: "pending" },
    ]);
    await settle();
    const before = nodes();
    expect(rows()).toEqual([]);

    emit({ ...base, seq: 3, type: "provider_retry" });
    await settle();
    expect(rows().at(-1)).toBe("Reconnecting");
    expect(nodes()).toHaveLength(before.length + 1);
    expect(dom.root.textContent?.indexOf("Use the newer file")).toBeLessThan(dom.root.textContent?.indexOf("Reconnecting") ?? -1);

    emit({ ...base, seq: 4, type: "block_delta", blockId: "text-2", blockKind: "text", delta: "Using the newer file." });
    await settle();
    expect(rows().some((row) => row?.includes("Reconnecting"))).toBe(false);
    expect(dom.root.textContent).toContain("Using the newer file.");
  } finally {
    dispose();
    dom.cleanup();
  }
});
