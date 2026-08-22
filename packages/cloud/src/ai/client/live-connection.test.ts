import { afterEach, describe, expect, test } from "bun:test";
import type { AiStreamEvent } from "../protocol";
import type { AiConversation } from "../types";
import { createAiLiveConnection } from "./live-connection";

class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: unknown[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  message(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }

  close(code = 1000, reason = "") {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason } as CloseEvent);
  }
}

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalWebSocket = globalThis.WebSocket;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
let timers: Array<(() => void) | null> = [];

const installBrowser = () => {
  FakeWebSocket.instances = [];
  timers = [];
  (globalThis as unknown as { window: unknown }).window = { location: { origin: "http://localhost:3000" } };
  (globalThis as unknown as { document: unknown }).document = new FakeDocument();
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  globalThis.setTimeout = ((callback: () => void) => {
    timers.push(callback);
    return timers.length;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => {
    timers[id - 1] = null;
  }) as typeof clearTimeout;
};

const runNextTimer = () => {
  const index = timers.findIndex(Boolean);
  const timer = timers[index];
  if (!timer) throw new Error("No pending reconnect timer");
  timers[index] = null;
  timer();
};

const conversation = (id: string): AiConversation => ({
  id,
  shortId: id,
  title: "New chat",
  titleSource: "default",
  description: "",
  descriptionSource: "default",
  keywords: [],
  pinnedAt: null,
  archivedAt: null,
  runStatus: "idle",
  runError: null,
  unreadCompletion: false,
  projectId: null,
  draft: { content: [], revision: 0, updatedAt: null },
  createdByUserId: null,
  createdAt: "2026-08-22T00:00:00.000Z",
  updatedAt: "2026-08-22T00:00:00.000Z",
});

const stateEvent = (conversationId: string): AiStreamEvent => ({
  type: "state",
  conversation: conversation(conversationId),
  messages: [],
  activeTurn: null,
});

afterEach(() => {
  FakeWebSocket.instances = [];
  (globalThis as unknown as { window: unknown }).window = originalWindow;
  (globalThis as unknown as { document: unknown }).document = originalDocument;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = originalWebSocket;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
});

describe("AI live connection multiplexing", () => {
  test("keeps one socket across rapid conversation switches and resubscribes only the current turn", () => {
    installBrowser();
    const received: string[] = [];
    const connection = createAiLiveConnection({ initialCursor: "4-1", onLiveMessage: () => undefined });
    const first = connection.streamTransport.subscribe({
      conversationId: "Chat01",
      url: "/unused",
      onEvent: () => received.push("Chat01"),
    });

    connection.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    expect(socket.sent).toEqual([
      { type: "ai.live.subscribe", payload: { fromCursor: "4-1", recover: false } },
      { type: "ai.turn.subscribe", payload: { conversationId: "Chat01" } },
    ]);

    first.close();
    const second = connection.streamTransport.subscribe({
      conversationId: "Chat02",
      url: "/unused",
      onEvent: () => received.push("Chat02"),
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(socket.sent.slice(-2)).toEqual([
      { type: "ai.turn.unsubscribe", payload: { conversationId: "Chat01" } },
      { type: "ai.turn.subscribe", payload: { conversationId: "Chat02" } },
    ]);

    second.close();
    connection.streamTransport.subscribe({
      conversationId: "Chat03",
      url: "/unused",
      onEvent: () => received.push("Chat03"),
    });
    expect(FakeWebSocket.instances).toHaveLength(1);

    socket.message({ type: "ai.turn.event", payload: { conversationId: "Chat01", event: stateEvent("Chat01") } });
    socket.message({ type: "ai.turn.event", payload: { conversationId: "Chat02", event: stateEvent("Chat02") } });
    socket.message({ type: "ai.turn.event", payload: { conversationId: "Chat03", event: stateEvent("Chat03") } });
    expect(received).toEqual(["Chat03"]);

    connection.markApplied("4-2");
    socket.close(1013, "backpressure");
    runNextTimer();
    expect(FakeWebSocket.instances).toHaveLength(2);
    const reconnected = FakeWebSocket.instances[1]!;
    reconnected.open();
    expect(reconnected.sent).toEqual([
      { type: "ai.live.subscribe", payload: { fromCursor: "4-2", recover: true } },
      { type: "ai.turn.subscribe", payload: { conversationId: "Chat03" } },
    ]);
    connection.dispose();
  });

  test("isolates a conversation error without terminating live invalidations", () => {
    installBrowser();
    const errors: string[] = [];
    const live: string[] = [];
    const connection = createAiLiveConnection({
      initialCursor: "0-0",
      onLiveMessage: (message) => live.push(message.type),
    });
    connection.streamTransport.subscribe({
      conversationId: "Chat01",
      url: "/unused",
      onEvent: () => undefined,
      onError: (error) => errors.push(error.message),
    });
    connection.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.message({
      type: "ai.turn.error",
      payload: { conversationId: "Chat01", code: "not_found", message: "Conversation not found" },
    });
    socket.message({ type: "ai.live.ready", payload: { cursor: "1-0", recovered: false } });

    expect(errors).toEqual(["Conversation not found"]);
    expect(live).toEqual(["ai.live.ready"]);
    expect(FakeWebSocket.instances).toHaveLength(1);
    connection.dispose();
  });

  test("keeps tabs independent and rejects cross-conversation events", () => {
    installBrowser();
    const receivedA: string[] = [];
    const receivedB: string[] = [];
    const tabA = createAiLiveConnection({ initialCursor: "0-0", onLiveMessage: () => undefined });
    const tabB = createAiLiveConnection({ initialCursor: "0-0", onLiveMessage: () => undefined });
    tabA.streamTransport.subscribe({
      conversationId: "Chat01",
      url: "/unused",
      onEvent: () => receivedA.push("Chat01"),
    });
    tabB.streamTransport.subscribe({
      conversationId: "Chat02",
      url: "/unused",
      onEvent: () => receivedB.push("Chat02"),
    });
    tabA.connect();
    tabB.connect();
    expect(FakeWebSocket.instances).toHaveLength(2);
    const [socketA, socketB] = FakeWebSocket.instances;
    socketA!.open();
    socketB!.open();

    socketA!.message({ type: "ai.turn.event", payload: { conversationId: "Chat02", event: stateEvent("Chat02") } });
    socketA!.message({ type: "ai.turn.event", payload: { conversationId: "Chat01", event: stateEvent("Chat01") } });
    socketB!.message({ type: "ai.turn.event", payload: { conversationId: "Chat01", event: stateEvent("Chat01") } });
    socketB!.message({ type: "ai.turn.event", payload: { conversationId: "Chat02", event: stateEvent("Chat02") } });

    expect(receivedA).toEqual(["Chat01"]);
    expect(receivedB).toEqual(["Chat02"]);
    tabA.dispose();
    tabB.dispose();
  });

  test("treats authorization revocation as terminal for both channels", () => {
    installBrowser();
    const errors: string[] = [];
    const fatal: string[] = [];
    const connection = createAiLiveConnection({
      initialCursor: "0-0",
      onLiveMessage: () => undefined,
      onFatal: (error) => fatal.push(error.code),
    });
    connection.streamTransport.subscribe({
      conversationId: "Chat01",
      url: "/unused",
      onEvent: () => undefined,
      onError: (error) => errors.push(error.message),
    });
    connection.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.close(1008, "login_required");

    expect(fatal).toEqual(["login_required"]);
    expect(errors).toEqual(["Live access changed or expired."]);
    expect(timers.filter(Boolean)).toHaveLength(0);
    connection.dispose();
  });
});
