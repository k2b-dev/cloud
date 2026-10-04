import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../../ui/test/dom";

const MAILBOX_ID = "Mbox01";

type Frame = { t: string; id?: string; channel?: string; scope?: unknown; after?: string };

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: Frame[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  message(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  close(code = 1000, reason = "") {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
}

/** Long enough for a refresh through the mocked API to finish. */
const settle = () => Bun.sleep(60);

describe("Mail subscription dialog live updates", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  let dom: DomTestHarness;
  let visibility: DocumentVisibilityState;
  let listRequests: number;

  beforeEach(() => {
    dom = createDomTestHarness();
    visibility = "visible";
    Object.defineProperty(dom.document, "visibilityState", { configurable: true, get: () => visibility });
    FakeWebSocket.instances = [];
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    listRequests = 0;
    globalThis.fetch = Object.assign(
      async () => {
        listRequests += 1;
        return Response.json({ items: [], nextCursor: null });
      },
      { preconnect: originalFetch.preconnect },
    );
  });

  afterEach(async () => {
    const { dialogCore } = await import("@k2b/ui");
    dialogCore.close();
    await Bun.sleep(20);
    globalThis.fetch = originalFetch;
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = originalWebSocket;
    dom.cleanup();
  });

  const socket = () => {
    const latest = FakeWebSocket.instances.at(-1);
    if (!latest) throw new Error("No socket was opened");
    return latest;
  };

  const returnToTab = () => {
    visibility = "hidden";
    dom.document.dispatchEvent(new dom.window.Event("visibilitychange") as unknown as Event);
    expect(socket().readyState).toBe(FakeWebSocket.CLOSED);
    visibility = "visible";
    dom.document.dispatchEvent(new dom.window.Event("visibilitychange") as unknown as Event);
    socket().open();
  };

  test("refreshes the list on changes, and a returning tab resumes from its cursor without loading again", async () => {
    const { openMailSubscriptionDialog } = await import("./MailSubscriptionDialog");
    void openMailSubscriptionDialog({ mailboxId: MAILBOX_ID, canWrite: false, liveCursor: "s6t.mail.4" });
    await settle();
    expect(listRequests).toBe(1);

    // The page's cursor was read before the list loaded, so a change made while it loaded still arrives.
    socket().open();
    expect(socket().sent).toEqual([{ t: "sub", id: "1", channel: "mailbox", scope: { mailbox: MAILBOX_ID }, after: "s6t.mail.4" }]);
    socket().message({ t: "ready", id: "1", cursor: "s6t.mail.4" });
    await settle();
    expect(listRequests).toBe(1);

    socket().message({ t: "event", id: "1", cursor: "s6t.mail.5", data: { conversationId: "Conv01" } });
    await settle();
    expect(listRequests).toBe(2);

    returnToTab();
    expect(socket().sent).toEqual([{ t: "sub", id: "1", channel: "mailbox", scope: { mailbox: MAILBOX_ID }, after: "s6t.mail.5" }]);
    socket().message({ t: "ready", id: "1", cursor: "s6t.mail.5" });
    await settle();
    expect(listRequests).toBe(2);

    // A cursor the server can no longer replay from loads the list once.
    socket().message({ t: "resync", id: "1", cursor: "s6t.mail.90" });
    await settle();
    expect(listRequests).toBe(3);
  });
});
