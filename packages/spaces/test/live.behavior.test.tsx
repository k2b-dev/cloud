import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { dates } from "@k2b/stdlib";
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

const SPACE_ID = "Space1";

const settle = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

describe("Spaces live updates in an open page", () => {
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
    setSystemTime();
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    reload.mockRestore();
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = originalWebSocket;
    dom.cleanup();
  });

  const setVisibility = (next: DocumentVisibilityState) => {
    visibility = next;
    dom.document.dispatchEvent(new dom.window.Event("visibilitychange") as unknown as Event);
  };

  const dateConfig = { timeZone: "Europe/Berlin" };

  /** Mounts the island as SSR renders it; the snapshot day defaults to the current day. */
  const mount = async (initialCursor: string | null, snapshotDay = dates.formatDateKey(new Date(), dateConfig)) => {
    const { default: SpaceLiveEvents } = await import("../src/frontend/[id]/_components/workspace/SpaceLiveEvents.island");
    const host = dom.document.createElement("div");
    dom.root.append(host);
    const dispose = render(() => createComponent(SpaceLiveEvents, { spaceId: SPACE_ID, initialCursor, snapshotDay, dateConfig }), host);
    cleanups.push(dispose);
    return { host, dispose };
  };

  const socket = () => {
    const latest = FakeWebSocket.instances.at(-1);
    if (!latest) throw new Error("No socket was opened");
    return latest;
  };

  /** Hides the tab, which closes the socket, and shows it again, which opens a new one. */
  const returnToTab = () => {
    setVisibility("hidden");
    expect(socket().readyState).toBe(FakeWebSocket.CLOSED);
    setVisibility("visible");
    socket().open();
  };

  /** Records which data each refresh covered, and the item it named. */
  const recordRefreshes = () => {
    const refreshed: string[] = [];
    for (const domain of ["view", "detail", "wormholes"] as const) {
      cleanups.push(
        subscribeToSpacesDataInvalidation([domain], async ({ itemId }) => void refreshed.push(itemId ? `${domain}:${itemId}` : domain)),
      );
    }
    return refreshed;
  };

  test("changes refresh the data they touch, and a returning tab resumes from its cursor without loading again", async () => {
    const refreshed = recordRefreshes();
    await mount("s6t.spaces.4");
    socket().open();
    expect(socket().url).toBe("ws://localhost/api/spaces/live");
    expect(socket().sent).toEqual([{ t: "sub", id: "1", channel: "space", scope: { space: SPACE_ID }, after: "s6t.spaces.4" }]);
    socket().message({ t: "ready", id: "1", cursor: "s6t.spaces.4" });
    socket().message({ t: "event", id: "1", cursor: "s6t.spaces.5", data: { type: "item.updated", itemId: "Item01" } });
    await settle();
    expect(refreshed.sort()).toEqual(["detail:Item01", "view:Item01"]);

    refreshed.length = 0;
    socket().message({ t: "event", id: "1", cursor: "s6t.spaces.6", data: { type: "wormhole.created" } });
    await settle();
    expect(refreshed.sort()).toEqual(["view", "wormholes"]);

    // Hidden, the tab misses one change; it arrives as a replay after the applied cursor.
    refreshed.length = 0;
    returnToTab();
    expect(socket().sent).toEqual([{ t: "sub", id: "1", channel: "space", scope: { space: SPACE_ID }, after: "s6t.spaces.6" }]);
    socket().message({ t: "event", id: "1", cursor: "s6t.spaces.7", data: { type: "item.moved", itemId: "Item02" } });
    socket().message({ t: "ready", id: "1", cursor: "s6t.spaces.7" });
    await settle();
    expect(refreshed.sort()).toEqual(["detail:Item02", "view:Item02"]);

    // A quiet return loads nothing again.
    refreshed.length = 0;
    returnToTab();
    expect(socket().sent[0]?.after).toBe("s6t.spaces.7");
    socket().message({ t: "ready", id: "1", cursor: "s6t.spaces.7" });
    await settle();
    expect(refreshed).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
  });

  test("changes of several items refresh every open detail; a resync reloads all data", async () => {
    // The first refresh is slow, so the next two changes wait and arrive together.
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    cleanups.push(
      subscribeToSpacesDataInvalidation(["view"], async () => {
        if (!first) return;
        first = false;
        await slow;
      }),
    );
    const refreshed = recordRefreshes();
    await mount("s6t.spaces.1");
    socket().open();
    socket().message({ t: "event", id: "1", cursor: "s6t.spaces.2", data: { type: "item.created", itemId: "Item01" } });
    socket().message({ t: "event", id: "1", cursor: "s6t.spaces.3", data: { type: "item.transferred", itemId: "Item02" } });
    socket().message({ t: "event", id: "1", cursor: "s6t.spaces.4", data: { type: "item.deleted", itemId: "Item03" } });
    release();
    await settle();
    expect(refreshed.sort()).toEqual(["detail", "detail:Item01", "view", "view:Item01"]);

    refreshed.length = 0;
    socket().message({ t: "resync", id: "1", cursor: "s6t.spaces.9" });
    await settle();
    expect(refreshed.sort()).toEqual(["detail", "view", "wormholes"]);
    expect(reload).not.toHaveBeenCalled();
  });

  test("a changed Space or access reloads the page, at most once", async () => {
    await mount("s6t.spaces.1");
    socket().open();
    socket().message({ t: "event", id: "1", cursor: "s6t.spaces.2", data: { type: "access.changed" } });
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);

    // The reloaded page loses access; it does not reload again but offers a manual reload.
    for (const cleanup of cleanups.splice(0)) cleanup();
    const { host } = await mount("s6t.spaces.2");
    socket().open();
    socket().message({ t: "revoked", id: "1", code: "access_denied" });
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(host.textContent).toBe("");
    expect(dom.document.body.textContent).toContain("Live updates are unavailable right now");
  });

  test("a tab that returns on a later day refreshes its deadline views even without a change", async () => {
    const refreshed = recordRefreshes();
    setSystemTime(new Date("2026-10-03T21:30:00Z"));
    await mount("s6t.spaces.4");
    socket().open();
    socket().message({ t: "ready", id: "1", cursor: "s6t.spaces.4" });
    await settle();
    expect(refreshed).toEqual([]);

    // 00:30 in Berlin: yesterday's "today" deadlines are overdue now.
    setSystemTime(new Date("2026-10-03T22:30:00Z"));
    returnToTab();
    await settle();
    expect(refreshed.sort()).toEqual(["detail", "view", "wormholes"]);

    refreshed.length = 0;
    returnToTab();
    await settle();
    expect(refreshed).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
  });

  test("a page rendered before midnight or without a cursor refreshes when it starts", async () => {
    const refreshed = recordRefreshes();
    setSystemTime(new Date("2026-10-03T22:00:05Z"));
    await mount("s6t.spaces.4", "2026-10-03");
    await settle();
    expect(refreshed.sort()).toEqual(["detail", "view", "wormholes"]);

    refreshed.length = 0;
    await mount(null);
    await settle();
    expect(refreshed.sort()).toEqual(["detail", "view", "wormholes"]);
  });

  test("a board rebuilt by a refresh does not turn its disposed column queries into a reload", async () => {
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
    await mount("s6t.spaces.1");
    socket().open();
    socket().message({ t: "event", id: "1", cursor: "s6t.spaces.2", data: { type: "item.created", itemId: "Item01" } });
    await settle();

    // Covered on the first attempt: the disposed column is not a failure that needs a retry.
    expect(snapshots).toBe(1);
    expect(reload).not.toHaveBeenCalled();
    returnToTab();
    expect(socket().sent[0]?.after).toBe("s6t.spaces.2");
  });

  test("a refresh that fails briefly is retried instead of reloading the page", async () => {
    let attempts = 0;
    cleanups.push(
      subscribeToSpacesDataInvalidation(["view"], async () => {
        attempts += 1;
        if (attempts < 2) throw new Error("Bad gateway");
      }),
    );
    await mount("s6t.spaces.1");
    socket().open();
    socket().message({ t: "event", id: "1", cursor: "s6t.spaces.2", data: { type: "item.updated", itemId: "Item01" } });
    for (let wait = 0; wait < 100 && attempts < 2; wait += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    await settle();

    expect(attempts).toBe(2);
    expect(reload).not.toHaveBeenCalled();
    returnToTab();
    expect(socket().sent[0]?.after).toBe("s6t.spaces.2");
  });

  test("transient closes reconnect quietly", async () => {
    const { host } = await mount("s6t.spaces.4");
    for (const code of [1011, 1012, 1013]) {
      socket().open();
      socket().close(code, "temporarily_unavailable");
      // Focus skips the pending backoff; a terminated connection would ignore it.
      dom.window.dispatchEvent(new dom.window.Event("focus") as unknown as Event);
    }
    expect(FakeWebSocket.instances).toHaveLength(4);
    expect(reload).not.toHaveBeenCalled();
    expect(host.textContent).toBe("");
    expect(dom.document.body.textContent).not.toContain("Live updates are unavailable");
  });

  test("a refresh that settles after the page left neither reloads nor reopens the socket", async () => {
    let fail!: (error: Error) => void;
    cleanups.push(subscribeToSpacesDataInvalidation(["detail"], () => new Promise<void>((_, reject) => (fail = reject))));
    const { dispose } = await mount("s6t.spaces.1");
    socket().open();
    socket().message({ t: "event", id: "1", cursor: "s6t.spaces.2", data: { type: "item.updated", itemId: "Item01" } });
    await settle();
    dispose();
    expect(socket().readyState).toBe(FakeWebSocket.CLOSED);

    fail(new Error("Query owner disposed"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reload).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
