import { expect, jest, test } from "bun:test";
import { createMemo, createSignal } from "solid-js";
import { createStore, reconcile, unwrap } from "solid-js/store";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import { emptyProjection, mergeActiveTurn, reduceProjection, visibleMessages } from "../client/projection";
import { type AiStreamEvent, type AiTurnBlock, type AiWireEvent, steerAppliedBlockId, steerMessageBlockId } from "../protocol";
import type { AiStoredMessage } from "../types";

(isServer ? test.skip : test)("streamed text and tool updates render each block exactly once", async () => {
  const dom = createDomTestHarness();
  // The expanded work line shows every folded text; the newest stays below it.
  window.sessionStorage.setItem("cloud.ai.tool-disclosure:work:ai-turn:turn:start", "open");
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

(isServer ? test.skip : test)("a provider retry shows calmly in the work line, or in a row before it has one", async () => {
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
    const workLine = () => dom.root.querySelector(".ai-turn-work");
    const label = () => workLine()?.querySelector(".k2b-chat-activity__copy strong")?.textContent?.trim();

    emit({ ...base, seq: 5, type: "provider_retry" });
    await settle();
    // Once the turn has a work line, the wait changes its label in place: no row comes or goes.
    const during = Array.from(dom.root.querySelectorAll(".k2b-chat-activity, .k2b-chat-message"));
    expect(during).toEqual(before);
    expect(label()).toBe("Reconnecting");
    expect(workLine()?.getAttribute("data-busy")).toBeNull();

    setLocale("de");
    await settle();
    expect(label()).toBe("Verbindung wird wiederhergestellt");

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

(isServer ? test.skip : test)("the segment above a waiting steer keeps working while the progress indicator moves below it", async () => {
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
  const work = () => dom.root.querySelector(".ai-turn-work");
  const messages = () => Array.from(dom.root.querySelectorAll(".k2b-chat-message"));
  const tool = {
    id: "tool-1",
    kind: "tool" as const,
    callId: "call-1",
    name: "code_run",
    args: { title: "report" },
    status: "running" as const,
  };
  try {
    emit({ ...base, seq: 1, type: "turn_started", modelProfileId: "model", providerModel: "model", blocks: [] });
    emit({ ...base, seq: 2, type: "block_set", block: tool });
    await settle();
    const working = work();
    expect(working?.getAttribute("data-busy")).toBe("true");

    setState("activeTurn", "blocks", (blocks): AiTurnBlock[] => [
      ...blocks,
      { id: "steer-request-1", kind: "steer_message", steerId: "1", text: "Use the newer file", status: "pending" },
    ]);
    await settle();
    // The running call still belongs to the segment above the steer; only the progress indicator ends the turn.
    expect(work()).toBe(working);
    expect(work()?.getAttribute("data-busy")).toBe("true");
    expect(messages().map((message) => [message.getAttribute("data-role"), message.getAttribute("data-status")])).toEqual([
      ["assistant", "complete"],
      ["user", "pending"],
      ["assistant", "streaming"],
    ]);

    emit({ ...base, seq: 3, type: "block_set", block: { ...tool, status: "completed", result: {} } });
    await settle();
    expect(work()).toBe(working);
    expect(work()?.textContent).toContain("Thinking");
  } finally {
    dispose();
    dom.cleanup();
  }
});

const storedMessage = (seq: number, message: AiStoredMessage["message"], patch: Partial<AiStoredMessage> = {}): AiStoredMessage => ({
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
const presentationResult = { presentationId: "00000000-0000-4000-8000-000000000002", title: "Inventory" };
const viewArgs = { runId: "r", title: "Inventory" };
/** A turn steered twice at one boundary, with a Studio view after the steering, as the server stores it. */
const steeredHistory = [
  storedMessage(10, { role: "user", content: [{ type: "text", text: "Build it" }] }),
  storedMessage(11, {
    role: "assistant",
    content: [
      { type: "text", text: "I read the data first." },
      { type: "tool_call", id: "read", name: "read_file", args: { path: "/a.csv" } },
    ],
  }),
  storedMessage(12, { role: "tool_result", callId: "read", name: "read_file", result: "a", isError: false }),
  storedMessage(13, { role: "user", content: [{ type: "text", text: "Use Q3." }] }, { meta: { steerId: "s1" } }),
  storedMessage(14, { role: "user", content: [{ type: "text", text: "And Q4." }] }, { meta: { steerId: "s2" } }),
  storedMessage(15, { role: "assistant", content: [{ type: "tool_call", id: "view", name: "code_present", args: viewArgs }] }),
  storedMessage(16, { role: "tool_result", callId: "view", name: "code_present", result: presentationResult, isError: false }),
  storedMessage(17, { role: "assistant", content: [{ type: "text", text: "Inventory is ready." }] }, { loopDoneReason: "stop" }),
];

const renderTimeline = async (
  dom: ReturnType<typeof createDomTestHarness>,
  source: { messages: () => readonly AiStoredMessage[]; activeTurn: () => ReturnType<typeof emptyProjection>["activeTurn"] },
) => {
  const { Chat } = await import("@k2b/ui");
  const { createAiChatTimeline, AiChatActionsProvider } = await import("./presentation");
  return render(
    () => (
      <AiChatActionsProvider
        actions={{
          renderCodePresentation: (result) => (
            <section class="host-view">
              {String((result() as { presentationId?: string } | undefined)?.presentationId ?? "pending")}
            </section>
          ),
        }}
      >
        {(() => {
          const items = createAiChatTimeline({ messages: createMemo(source.messages), activeTurn: source.activeTurn });
          return <Chat.Timeline items={items()} />;
        })()}
      </AiChatActionsProvider>
    ),
    dom.root,
  );
};

(isServer ? test.skip : test)("two steering messages at one boundary keep the steered segment when the turn ends", async () => {
  const dom = createDomTestHarness();
  const [state, setState] = createStore(emptyProjection());
  const emit = (event: AiStreamEvent) => setState(reconcile(reduceProjection(unwrap(state), event), { key: "id", merge: true }));
  const dispose = await renderTimeline(dom, { messages: () => visibleMessages(state), activeTurn: () => state.activeTurn });
  const base = { v: 1 as const, conversationId: "chat", turnId: "turn", attempt: 1 };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  let seq = 0;
  const set = (block: AiTurnBlock) => emit({ ...base, seq: ++seq, type: "block_set", block });
  try {
    emit({ ...base, seq: ++seq, type: "turn_started", modelProfileId: "model", providerModel: "model", blocks: [] });
    emit({ ...base, seq: ++seq, type: "block_delta", blockId: "a1-t0-0", blockKind: "text", delta: "I read the data first." });
    set({ id: "tool-read", kind: "tool", callId: "read", name: "read_file", args: { path: "/a.csv" }, status: "completed", result: "a" });
    for (const [steerId, text] of [
      ["s1", "Use Q3."],
      ["s2", "And Q4."],
    ] as const) {
      set({ id: steerMessageBlockId(steerId), kind: "steer_message", steerId, text, status: "consumed" });
      set({ id: steerAppliedBlockId(steerId), kind: "steer_applied", steerId });
    }
    set({
      id: "tool-view",
      kind: "tool",
      callId: "view",
      name: "code_present",
      args: viewArgs,
      status: "completed",
      result: presentationResult,
    });
    emit({ ...base, seq: ++seq, type: "block_delta", blockId: "a1-t2-0", blockKind: "text", delta: "Inventory is ready." });
    await tick();
    // The steering messages follow each other without an empty response between them.
    const articles = () => [...dom.root.querySelectorAll("article")].map((article) => article.textContent ?? "");
    expect(articles().filter((text) => text.trim() === "")).toEqual([]);
    const host = dom.root.querySelector(".host-view");
    expect(host?.textContent).toBe(presentationResult.presentationId);

    emit({ ...base, seq: ++seq, type: "turn_finished", status: "completed", error: null, messages: steeredHistory });
    await tick();
    expect(state.activeTurn).toBeNull();
    expect(dom.root.querySelector(".host-view")).toBe(host);
    expect(articles().filter((text) => text.trim() === "")).toEqual([]);
  } finally {
    dispose();
    dom.cleanup();
  }
});

(isServer ? test.skip : test)("loading older history keeps the segments of a turn that started before the window", async () => {
  const dom = createDomTestHarness();
  // The first window starts at the steering messages, in the middle of the turn.
  const [messages, setMessages] = createSignal<readonly AiStoredMessage[]>(steeredHistory.slice(3));
  const dispose = await renderTimeline(dom, { messages, activeTurn: () => null });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  try {
    await tick();
    const host = dom.root.querySelector(".host-view");
    expect(host?.textContent).toBe(presentationResult.presentationId);
    setMessages(steeredHistory);
    await tick();
    expect(dom.root.textContent).toContain("Build it");
    expect(dom.root.querySelector(".host-view")).toBe(host);
  } finally {
    dispose();
    dom.cleanup();
  }
});

(isServer ? test.skip : test)("the work line says that the stream reconnects and how long a long step runs", async () => {
  jest.useFakeTimers();
  const dom = createDomTestHarness();
  const { Chat } = await import("@k2b/ui");
  const { createAiChatTimeline, AiChatActionsProvider } = await import("./presentation");
  const [state, setState] = createStore(emptyProjection());
  const [reconnecting, setReconnecting] = createSignal(false);
  const emit = (event: AiWireEvent) => setState(reconcile(reduceProjection(state, event), { key: "id", merge: true }));
  const dispose = render(
    () => (
      <AiChatActionsProvider actions={{}}>
        {(() => {
          const items = createAiChatTimeline({
            messages: createMemo(() => visibleMessages(state)),
            activeTurn: () => state.activeTurn,
            reconnecting,
          });
          return <Chat.Timeline items={items()} />;
        })()}
      </AiChatActionsProvider>
    ),
    dom.root,
  );
  const base = { v: 1 as const, conversationId: "chat", turnId: "turn", attempt: 1 };
  const workLine = () => dom.root.querySelector(".ai-turn-work");
  const label = () => workLine()?.querySelector(".k2b-chat-activity__copy strong")?.textContent?.trim();
  const clock = () => workLine()?.querySelector(".ai-turn-work__meta")?.firstChild?.textContent?.trim();
  const run = { id: "tool-run", kind: "tool" as const, callId: "run", name: "code_run", args: { title: "Report" } };
  try {
    emit({ ...base, seq: 1, type: "turn_started", modelProfileId: "model", providerModel: "model", blocks: [] });
    emit({ ...base, seq: 2, type: "block_set", block: { ...run, status: "running" } });
    jest.advanceTimersByTime(10_000);
    expect(label()).toBe("Running code · Report");
    expect(clock()).toBe("0:10");
    const nodes = Array.from(dom.root.querySelectorAll(".k2b-chat-activity, .k2b-chat-message"));

    // The connection drops: the line says so in place, calmly, and its clock stands.
    setReconnecting(true);
    expect(label()).toBe("Reconnecting");
    expect(workLine()?.getAttribute("data-busy")).toBeNull();
    jest.advanceTimersByTime(20_000);
    expect(clock()).toBe("0:10");
    expect(Array.from(dom.root.querySelectorAll(".k2b-chat-activity, .k2b-chat-message"))).toEqual(nodes);

    // Back online, the clock shows the true work time, and the step that ran all along shows how long.
    setReconnecting(false);
    jest.advanceTimersByTime(1_000);
    expect(clock()).toBe("0:31");
    expect(label()).toBe("Running code · Report");
    jest.advanceTimersByTime(15_000);
    expect(label()).toBe("Running code · 46 s");
    jest.advanceTimersByTime(120_000);
    expect(label()).toBe("Running code · 2 min");

    // The next step starts its own time.
    emit({ ...base, seq: 3, type: "block_set", block: { ...run, status: "completed", result: {} } });
    expect(label()).toBe("Thinking");
    expect(Array.from(dom.root.querySelectorAll(".k2b-chat-activity, .k2b-chat-message"))).toEqual(nodes);
  } finally {
    dispose();
    dom.cleanup();
    jest.useRealTimers();
  }
});

(isServer ? test.skip : test)("a step that starts right after a model retry times only itself", async () => {
  jest.useFakeTimers();
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
  const workLine = () => dom.root.querySelector(".ai-turn-work");
  const label = () => workLine()?.querySelector(".k2b-chat-activity__copy strong")?.textContent?.trim();
  const clock = () => workLine()?.querySelector(".ai-turn-work__meta")?.firstChild?.textContent?.trim();
  const read = { id: "tool-read", kind: "tool" as const, callId: "read", name: "read_file", args: { path: "/a.csv" } };
  const run = { id: "tool-run", kind: "tool" as const, callId: "run", name: "code_run", args: { title: "Report" } };
  try {
    emit({ ...base, seq: 1, type: "turn_started", modelProfileId: "model", providerModel: "model", blocks: [] });
    emit({ ...base, seq: 2, type: "block_set", block: { ...read, status: "completed", result: {} } });
    jest.advanceTimersByTime(5_000);

    // The model call waits 30 seconds for its retry; the shown time stands.
    emit({ ...base, seq: 3, type: "provider_retry" });
    expect(label()).toBe("Reconnecting");
    jest.advanceTimersByTime(30_000);
    expect(clock()).toBe("0:05");

    // The next step starts with the true work time and is timed from there.
    emit({ ...base, seq: 4, type: "block_set", block: { ...run, status: "running" } });
    expect(clock()).toBe("0:35");
    jest.advanceTimersByTime(16_000);
    expect(label()).toBe("Running code · Report");
    jest.advanceTimersByTime(30_000);
    expect(label()).toBe("Running code · 46 s");
  } finally {
    dispose();
    dom.cleanup();
    jest.useRealTimers();
  }
});

const renderFailedTurnTimeline = async (
  dom: ReturnType<typeof createDomTestHarness>,
  source: { messages: () => readonly AiStoredMessage[]; activeTurn: () => ReturnType<typeof emptyProjection>["activeTurn"] },
  locale: string,
  onContinueTurn?: (message: string) => void,
) => {
  const { Chat, LocaleProvider } = await import("@k2b/ui");
  const { createAiChatTimeline, AiChatActionsProvider } = await import("./presentation");
  return render(
    () => (
      <LocaleProvider locale={locale}>
        <AiChatActionsProvider actions={{ onContinueTurn }}>
          {(() => {
            const items = createAiChatTimeline(source);
            return <Chat.Timeline items={items()} />;
          })()}
        </AiChatActionsProvider>
      </LocaleProvider>
    ),
    dom.root,
  );
};

(isServer ? test.skip : test)("a failed turn keeps its elements and names its reason and next step in the reader's language", async () => {
  const dom = createDomTestHarness();
  const [state, setState] = createStore(emptyProjection());
  const emit = (event: AiStreamEvent) => setState(reconcile(reduceProjection(unwrap(state), event), { key: "id", merge: true }));
  const continued: string[] = [];
  const dispose = await renderFailedTurnTimeline(
    dom,
    { messages: () => visibleMessages(state), activeTurn: () => state.activeTurn },
    "de",
    (message) => {
      continued.push(message);
    },
  );
  const base = { v: 1 as const, conversationId: "chat", turnId: "turn", attempt: 1 };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const read = { id: "tool-read", kind: "tool" as const, callId: "read", name: "read_file", args: { path: "/q1.csv" } };
  try {
    emit({ ...base, seq: 1, type: "turn_started", modelProfileId: "model", providerModel: "model", blocks: [] });
    emit({ ...base, seq: 2, type: "block_delta", blockId: "a1-t0-0", blockKind: "text", delta: "Jetzt lese ich die Daten." });
    emit({ ...base, seq: 3, type: "block_set", block: { ...read, status: "completed", result: "a" } });
    await tick();
    const turn = dom.root.querySelector(".ai-turn");
    expect(dom.root.querySelector(".ai-turn__notice")).toBeNull();

    emit({
      ...base,
      seq: 4,
      type: "turn_finished",
      status: "failed",
      error: "Der KI-Dienst hat nicht geantwortet.",
      messages: [
        storedMessage(10, { role: "user", content: [{ type: "text", text: "Lies die Daten" }] }),
        storedMessage(
          11,
          {
            role: "assistant",
            content: [
              { type: "text", text: "Jetzt lese ich die Daten." },
              { type: "tool_call", id: "read", name: "read_file", args: read.args },
            ],
          },
          { loopDoneReason: "error" },
        ),
        storedMessage(
          12,
          { role: "tool_result", callId: "read", name: "read_file", result: "a", isError: false },
          { meta: { turnError: { code: "model_unavailable" } } },
        ),
      ],
    });
    await tick();
    expect(state.activeTurn).toBeNull();
    // The live turn becomes history in place; its status text folds into the work line, the notice ends the turn.
    expect(dom.root.querySelector(".ai-turn")).toBe(turn);
    expect(dom.root.textContent).not.toContain("Jetzt lese ich die Daten.");
    const notice = dom.root.querySelector(".ai-turn__notice");
    expect(notice?.textContent).toContain("Die Antwort wurde abgebrochen.");
    expect(notice?.textContent).toContain("Der KI-Dienst hat nicht geantwortet. Die bisherigen Ergebnisse bleiben erhalten.");
    expect(dom.root.querySelector(".ai-turn > :last-child")).toBe(notice);
    // The notice says why; the work line reads like any finished turn.
    expect(dom.root.querySelector(".ai-turn-work")?.textContent).not.toContain("abgebrochen");

    const live = dom.root.querySelector(".ai-turn")?.parentElement?.innerHTML;
    const history = structuredClone(unwrap(state.messages));

    const button = [...(notice?.querySelectorAll("button") ?? [])].find((element) => element.textContent?.includes("Weiterarbeiten"));
    expect(button).toBeDefined();
    button!.click();
    await tick();
    expect(continued).toEqual(["Mach an der Stelle weiter, an der du aufgehört hast."]);

    // Once the chat moved on, the turn keeps its reason but no longer offers to continue.
    setState("messages", (messages) => [
      ...messages,
      storedMessage(13, { role: "user", content: [{ type: "text", text: "Neue Frage" }] }, { loopId: "next" }),
    ]);
    await tick();
    expect(dom.root.querySelector(".ai-turn__notice")).toBe(notice);
    expect(notice?.textContent).not.toContain("Weiterarbeiten");

    // A reload renders the same turn from history alone.
    dispose();
    const reloaded = await renderFailedTurnTimeline(dom, { messages: () => history, activeTurn: () => null }, "de", () => {});
    try {
      await tick();
      expect(dom.root.querySelector(".ai-turn")?.parentElement?.innerHTML).toBe(live);
    } finally {
      reloaded();
    }
  } finally {
    dispose();
    dom.cleanup();
  }
});

(isServer ? test.skip : test)("a turn that failed before the model answered shows its reason where its progress stood", async () => {
  const dom = createDomTestHarness();
  const [state, setState] = createStore(emptyProjection());
  const emit = (event: AiStreamEvent) => setState(reconcile(reduceProjection(unwrap(state), event), { key: "id", merge: true }));
  const continued: string[] = [];
  const dispose = await renderFailedTurnTimeline(
    dom,
    { messages: () => visibleMessages(state), activeTurn: () => state.activeTurn },
    "en",
    (message) => {
      continued.push(message);
    },
  );
  const base = { v: 1 as const, conversationId: "chat", turnId: "turn", attempt: 1 };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  try {
    emit({ ...base, seq: 1, type: "turn_started", modelProfileId: "model", providerModel: "model", blocks: [] });
    await tick();
    const progress = dom.root.querySelector(".ai-turn");
    expect(progress).not.toBeNull();
    emit({
      ...base,
      seq: 2,
      type: "turn_finished",
      status: "failed",
      error: "Your AI usage limit for this period is reached.",
      messages: [
        storedMessage(
          10,
          { role: "user", content: [{ type: "text", text: "Summarize" }] },
          { meta: { turnError: { code: "quota_exhausted" } } },
        ),
      ],
    });
    await tick();
    expect(dom.root.querySelector(".ai-turn")).toBe(progress);
    expect(dom.root.querySelector(".ai-turn-work")).toBeNull();
    const notice = dom.root.querySelector(".ai-turn__notice");
    expect(notice?.textContent).toContain("The answer was interrupted.");
    expect(notice?.textContent).toContain("You can continue once it resets.");
    // Another turn would meet the same limit, so the notice offers no Continue.
    expect(notice?.querySelector("button")).toBeNull();
  } finally {
    dispose();
    dom.cleanup();
  }
});

(isServer ? test.skip : test)("a turn that failed after an accepted answer ends with its notice below the answer, in place", async () => {
  const dom = createDomTestHarness();
  const [state, setState] = createStore(emptyProjection());
  const emit = (event: AiStreamEvent) => setState(reconcile(reduceProjection(unwrap(state), event), { key: "id", merge: true }));
  const dispose = await renderFailedTurnTimeline(
    dom,
    { messages: () => visibleMessages(state), activeTurn: () => state.activeTurn },
    "en",
    () => {},
  );
  const base = { v: 1 as const, conversationId: "chat", turnId: "turn", attempt: 1 };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const args = { title: "Invoice details", questions: [{ id: "amount", type: "text", label: "Amount" }] };
  const answer = { submitted: true, answers: { amount: "150 EUR" } };
  try {
    emit({ ...base, seq: 1, type: "turn_started", modelProfileId: "model", providerModel: "model", blocks: [] });
    emit({
      ...base,
      seq: 2,
      type: "block_set",
      block: { id: "tool:survey-1", kind: "tool", callId: "survey-1", name: "survey", args, status: "completed", result: answer },
    });
    await tick();
    // After the answer, the live turn shows its progress below it.
    const progress = dom.root.querySelector(".ai-turn");
    expect(dom.root.textContent).toContain("150 EUR");
    expect(progress).not.toBeNull();

    emit({
      ...base,
      seq: 3,
      type: "turn_finished",
      status: "failed",
      error: "The model service did not answer.",
      messages: [
        storedMessage(10, { role: "user", content: [{ type: "text", text: "Book the invoice" }] }),
        storedMessage(
          11,
          { role: "assistant", content: [{ type: "tool_call", id: "survey-1", name: "survey", args }] },
          { loopDoneReason: "error" },
        ),
        storedMessage(
          12,
          { role: "tool_result", callId: "survey-1", name: "survey", result: answer, isError: false },
          { meta: { turnError: { code: "model_unavailable" } } },
        ),
      ],
    });
    await tick();
    expect(state.activeTurn).toBeNull();
    // The notice takes the progress's place, so nothing above it moves.
    expect(dom.root.querySelector(".ai-turn")).toBe(progress);
    const notice = dom.root.querySelector(".ai-turn__notice");
    expect(notice?.textContent).toContain("The model service did not answer.");
    expect(dom.root.textContent?.indexOf("150 EUR")).toBeLessThan(dom.root.textContent?.indexOf("The answer was interrupted.") ?? -1);
  } finally {
    dispose();
    dom.cleanup();
  }
});

(isServer ? test.skip : test)("a forwarded request whose turn failed before the model answered shows the notice below it", async () => {
  const dom = createDomTestHarness();
  const [state, setState] = createStore(emptyProjection());
  const emit = (event: AiStreamEvent) => setState(reconcile(reduceProjection(unwrap(state), event), { key: "id", merge: true }));
  const dispose = await renderFailedTurnTimeline(
    dom,
    { messages: () => visibleMessages(state), activeTurn: () => state.activeTurn },
    "en",
    () => {},
  );
  const base = { v: 1 as const, conversationId: "chat", turnId: "turn", attempt: 1 };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const agentMessage = { id: "forward-1", sourceChatId: "cSrc12", sourceTurnId: "tSrc12", sourceTitle: "Planning" };
  try {
    emit({ ...base, seq: 1, type: "turn_started", modelProfileId: "model", providerModel: "model", blocks: [] });
    await tick();
    const progress = dom.root.querySelector(".ai-turn");
    expect(progress).not.toBeNull();
    emit({
      ...base,
      seq: 2,
      type: "turn_finished",
      status: "failed",
      error: "The model service did not answer.",
      messages: [
        storedMessage(
          10,
          { role: "user", content: [{ type: "text", text: "Message from Planning\n\nPlease check the budget." }] },
          { meta: { agentMessage, turnError: { code: "model_unavailable" } } },
        ),
      ],
    });
    await tick();
    expect(dom.root.textContent).toContain("Please check the budget.");
    expect(dom.root.querySelector(".ai-turn")).toBe(progress);
    expect(dom.root.querySelector(".ai-turn__notice")?.textContent).toContain("The model service did not answer.");
  } finally {
    dispose();
    dom.cleanup();
  }
});
