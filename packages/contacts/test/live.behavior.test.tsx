import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../ui/test/dom";
import { listenForContactsLiveInvalidation } from "../src/frontend/_components/contacts-live";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: { t: string; id?: string; channel?: string; scope?: unknown; after?: string }[] = [];
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

const settle = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

const AT = "2026-10-04T08:00:00.000Z";

describe("Contacts live updates in an open page", () => {
  if (isServer) {
    test.skip("runs with browser conditions", () => {});
    return;
  }

  const originalWebSocket = globalThis.WebSocket;
  let dom: DomTestHarness;
  let reload: ReturnType<typeof spyOn>;
  let visibility: DocumentVisibilityState;
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    dom = createDomTestHarness();
    dom.window.sessionStorage.clear();
    reload = spyOn(dom.window.location, "reload").mockImplementation(() => {});
    visibility = "visible";
    Object.defineProperty(dom.document, "visibilityState", { configurable: true, get: () => visibility });
    FakeWebSocket.instances = [];
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  });

  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    reload.mockRestore();
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = originalWebSocket;
    dom.cleanup();
  });

  const mount = async (scope: { kind: "all" } | { kind: "book"; bookId: string }, initialCursor: string | null) => {
    const { default: ContactsLiveEvents } = await import("../src/frontend/_components/ContactsLiveEvents.island");
    const host = dom.document.createElement("div");
    dom.root.append(host);
    cleanups.push(render(() => createComponent(ContactsLiveEvents, { scope, initialCursor }), host));
  };

  const socket = () => FakeWebSocket.instances.at(-1) as FakeWebSocket;

  const returnToTab = () => {
    visibility = "hidden";
    dom.document.dispatchEvent(new dom.window.Event("visibilitychange") as unknown as Event);
    expect(socket().readyState).toBe(FakeWebSocket.CLOSED);
    visibility = "visible";
    dom.document.dispatchEvent(new dom.window.Event("visibilitychange") as unknown as Event);
    socket().open();
  };

  test("a returning tab resumes from its cursor and loads nothing again", async () => {
    const refreshed: string[] = [];
    cleanups.push(listenForContactsLiveInvalidation("results", async (event) => void refreshed.push(event.type)));
    await mount({ kind: "book", bookId: "Book01" }, "s6t.contacts.4");
    socket().open();
    expect(socket().url).toBe("ws://localhost/api/contacts/live");
    expect(socket().sent).toEqual([{ t: "sub", id: "1", channel: "book", scope: { book: "Book01" }, after: "s6t.contacts.4" }]);
    socket().message({ t: "ready", id: "1", cursor: "s6t.contacts.4" });
    socket().message({
      t: "event",
      id: "1",
      cursor: "s6t.contacts.5",
      data: { type: "contact.created", bookId: "Book01", contactId: "Cont01", at: AT },
    });
    await settle();
    expect(refreshed).toEqual(["contact.created"]);

    returnToTab();
    expect(socket().sent).toEqual([{ t: "sub", id: "1", channel: "book", scope: { book: "Book01" }, after: "s6t.contacts.5" }]);
    socket().message({ t: "ready", id: "1", cursor: "s6t.contacts.5" });
    await settle();
    expect(refreshed).toEqual(["contact.created"]);
    expect(reload).not.toHaveBeenCalled();
  });

  test("a move reaches the overview as a removal and an addition", async () => {
    const refreshed: string[] = [];
    cleanups.push(listenForContactsLiveInvalidation("results", async (event) => void refreshed.push(`${event.type}:${event.bookId}`)));
    await mount({ kind: "all" }, "s6t.contacts.1");
    socket().open();
    expect(socket().sent[0]).toMatchObject({ channel: "all", scope: {} });
    socket().message({ t: "ready", id: "1", cursor: "s6t.contacts.1" });
    socket().message({
      t: "event",
      id: "1",
      cursor: "s6t.contacts.2",
      data: { type: "contact.deleted", bookId: "Book01", contactId: "Cont01", at: AT },
    });
    socket().message({
      t: "event",
      id: "1",
      cursor: "s6t.contacts.3",
      data: { type: "contact.created", bookId: "Book02", contactId: "Cont01", at: AT },
    });
    await settle();
    expect(refreshed).toEqual(["contact.deleted:Book01", "contact.created:Book02"]);
    expect(reload).not.toHaveBeenCalled();
  });

  test("a changed set of books reloads the page once no editor is open", async () => {
    const editor = dom.document.createElement("form");
    editor.setAttribute("data-contacts-editor", "true");
    dom.root.append(editor);
    await mount({ kind: "all" }, "s6t.contacts.1");
    socket().open();
    socket().message({ t: "ready", id: "1", cursor: "s6t.contacts.1" });
    socket().message({ t: "resync", id: "1", cursor: "s6t.contacts.7" });
    await settle();
    expect(reload).not.toHaveBeenCalled();

    editor.remove();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("a book that is no longer readable reloads the page, at most once", async () => {
    await mount({ kind: "book", bookId: "Book01" }, "s6t.contacts.1");
    socket().open();
    socket().message({ t: "revoked", id: "1", code: "access_denied" });
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);

    for (const cleanup of cleanups.splice(0)) cleanup();
    await mount({ kind: "book", bookId: "Book01" }, "s6t.contacts.1");
    socket().open();
    socket().message({ t: "revoked", id: "1", code: "access_denied" });
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
