import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../../ui/test/dom";

const MAILBOX_ID = "Mbox01";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  ready(cursor: string) {
    this.onmessage?.({ data: JSON.stringify({ type: "mail.live.ready", payload: { mailboxId: MAILBOX_ID, cursor } }) });
  }

  close(code = 1000, reason = "") {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  subscribedCursor() {
    return (JSON.parse(this.sent.at(-1) ?? "{}") as { payload?: { fromCursor?: string | null } }).payload?.fromCursor;
  }
}

/** Longer than the dialog's live refresh delay, so a scheduled refresh has run. */
const settle = () => Bun.sleep(300);

describe("Mail subscription dialog live updates when a tab returns", () => {
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

  const latestSocket = () => {
    const socket = FakeWebSocket.instances.at(-1);
    if (!socket) throw new Error("No socket was opened");
    return socket;
  };

  const returnToTab = () => {
    visibility = "hidden";
    dom.document.dispatchEvent(new dom.window.Event("visibilitychange") as unknown as Event);
    expect(latestSocket().readyState).toBe(FakeWebSocket.CLOSED);
    visibility = "visible";
    dom.document.dispatchEvent(new dom.window.Event("visibilitychange") as unknown as Event);
    latestSocket().open();
  };

  test("refreshes the list only when the ready cursor moved", async () => {
    const { openMailSubscriptionDialog } = await import("./MailSubscriptionDialog");
    void openMailSubscriptionDialog({ mailboxId: MAILBOX_ID, canWrite: false });
    await settle();
    expect(listRequests).toBe(1);

    // The first subscription has no cursor, so the head it receives may skip events.
    latestSocket().open();
    expect(latestSocket().subscribedCursor()).toBeNull();
    latestSocket().ready("s6t.mail.4");
    await settle();
    expect(listRequests).toBe(2);

    // A returning tab resumes from the applied cursor; the server confirms it and replays.
    returnToTab();
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(latestSocket().subscribedCursor()).toBe("s6t.mail.4");
    latestSocket().ready("s6t.mail.4");
    await settle();
    expect(listRequests).toBe(2);

    // Replay was too long, so the server follows with its head: events were skipped.
    latestSocket().ready("s6t.mail.9");
    await settle();
    expect(listRequests).toBe(3);
  });
});
