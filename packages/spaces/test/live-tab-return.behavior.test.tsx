import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { query } from "@k2b/stdlib/solid";
import { createComponent, createRoot } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../ui/test/dom";
import { subscribeToSpacesDataInvalidation } from "../src/frontend/[id]/_components/workspace/workspace-events";

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
    this.onmessage?.({ data: JSON.stringify({ type: "spaces.live.ready", payload: { spaceId: SPACE_ID, cursor } }) });
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

const SPACE_ID = "Space1";

const settle = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

describe("Spaces live updates when a tab returns", () => {
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

  const setVisibility = (next: DocumentVisibilityState) => {
    visibility = next;
    dom.document.dispatchEvent(new dom.window.Event("visibilitychange") as unknown as Event);
  };

  const mount = async (initialCursor: string | null) => {
    const { default: SpaceLiveEvents } = await import("../src/frontend/[id]/_components/workspace/SpaceLiveEvents.island");
    const host = dom.document.createElement("div");
    dom.root.append(host);
    cleanups.push(render(() => createComponent(SpaceLiveEvents, { spaceId: SPACE_ID, initialCursor }), host));
    return host;
  };

  const latestSocket = () => {
    const socket = FakeWebSocket.instances.at(-1);
    if (!socket) throw new Error("No socket was opened");
    return socket;
  };

  /** Hides the tab, which closes the socket, and shows it again, which opens a new one. */
  const returnToTab = () => {
    setVisibility("hidden");
    expect(latestSocket().readyState).toBe(FakeWebSocket.CLOSED);
    setVisibility("visible");
    latestSocket().open();
  };

  test("a returning tab whose cursor did not move refetches nothing", async () => {
    const refetched: string[] = [];
    for (const domain of ["view", "detail", "wormholes"] as const) {
      cleanups.push(subscribeToSpacesDataInvalidation([domain], async () => void refetched.push(domain)));
    }
    await mount("s6t.spaces.4");
    latestSocket().open();
    expect(latestSocket().subscribedCursor()).toBe("s6t.spaces.4");
    latestSocket().ready("s6t.spaces.4");
    await settle();

    returnToTab();
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(latestSocket().subscribedCursor()).toBe("s6t.spaces.4");
    latestSocket().ready("s6t.spaces.4");
    await settle();

    expect(refetched).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
  });

  test("a board rebuilt by the refresh does not turn its disposed column queries into a reload", async () => {
    // A column of the board: its own query, covering the same `view` domain as the snapshot.
    const board = createRoot((dispose) => {
      query.create<string, number, { cursor: string | null }>({
        source: () => "column",
        initial: { source: "column", data: 1 },
        load: () => new Promise<number>(() => {}),
        subscribe: ({ invalidate }) => subscribeToSpacesDataInvalidation(["view"], invalidate),
      });
      return dispose;
    });
    // The snapshot query answers first and mounts a new board, which disposes the old columns.
    let snapshots = 0;
    cleanups.push(
      subscribeToSpacesDataInvalidation(["view"], async () => {
        snapshots += 1;
        await Promise.resolve();
        board();
      }),
    );
    // Without an SSR cursor, the first ready may skip events and therefore refreshes.
    await mount(null);
    latestSocket().open();
    latestSocket().ready("s6t.spaces.9");
    await settle();

    // Covered on the first attempt: the disposed column is not a failure that needs a retry.
    expect(snapshots).toBe(1);
    expect(reload).not.toHaveBeenCalled();
    returnToTab();
    expect(latestSocket().subscribedCursor()).toBe("s6t.spaces.9");
  });

  test("a refresh that fails briefly is retried instead of reloading the page", async () => {
    let attempts = 0;
    cleanups.push(
      subscribeToSpacesDataInvalidation(["view"], async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("Bad gateway");
      }),
    );
    await mount(null);
    latestSocket().open();
    latestSocket().ready("s6t.spaces.9");
    for (let wait = 0; wait < 50 && attempts < 3; wait += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    await settle();

    expect(attempts).toBe(3);
    expect(reload).not.toHaveBeenCalled();
    returnToTab();
    expect(latestSocket().subscribedCursor()).toBe("s6t.spaces.9");
  });

  test("transient closes reconnect quietly", async () => {
    const host = await mount("s6t.spaces.4");
    for (const code of [1011, 1012, 1013]) {
      latestSocket().open();
      latestSocket().close(code, "temporarily_unavailable");
      // Focus skips the pending backoff; a terminated connection would ignore it.
      dom.window.dispatchEvent(new dom.window.Event("focus") as unknown as Event);
    }
    expect(FakeWebSocket.instances).toHaveLength(4);
    expect(reload).not.toHaveBeenCalled();
    expect(host.textContent).toBe("");
  });
});
