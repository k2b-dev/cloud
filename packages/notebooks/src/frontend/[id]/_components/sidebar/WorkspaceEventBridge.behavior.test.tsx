import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../../../../ui/test/dom";
import { notebooksWorkspace } from "../../../../lib/workspace-events";

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

  message(type: string, payload: unknown) {
    this.onmessage?.({ data: JSON.stringify({ type, payload }) });
  }

  close(code = 1000, reason = "") {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
}

const NOTEBOOK_ID = "Book01";
const WS = notebooksWorkspace.wsType;

describe("WorkspaceEventBridge", () => {
  if (isServer) {
    test.skip("runs with browser conditions", () => {});
    return;
  }

  const originalWebSocket = globalThis.WebSocket;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let dom: DomTestHarness;
  let timers: Array<{ run: () => void; delay: number } | null>;
  let reload: ReturnType<typeof spyOn>;
  let random: ReturnType<typeof spyOn>;
  let clock: ReturnType<typeof spyOn>;
  let now: number;
  const disposers: Array<() => void> = [];

  beforeEach(() => {
    dom = createDomTestHarness();
    dom.window.sessionStorage.clear();
    reload = spyOn(dom.window.location, "reload").mockImplementation(() => {});
    random = spyOn(Math, "random").mockReturnValue(0);
    now = 1_000_000;
    clock = spyOn(Date, "now").mockImplementation(() => now);
    FakeWebSocket.instances = [];
    timers = [];
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    globalThis.setTimeout = ((run: () => void, delay = 0) => {
      timers.push({ run, delay });
      return timers.length;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((id: number) => {
      if (id > 0) timers[id - 1] = null;
    }) as typeof clearTimeout;
  });

  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
    reload.mockRestore();
    random.mockRestore();
    clock.mockRestore();
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = originalWebSocket;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    dom.cleanup();
  });

  const mount = async () => {
    const { default: WorkspaceEventBridge } = await import("./WorkspaceEventBridge.island");
    const host = dom.document.createElement("div");
    dom.root.append(host);
    disposers.push(
      render(
        () => createComponent(WorkspaceEventBridge, { notebookId: NOTEBOOK_ID, appUrl: "http://localhost", initialCursor: null }),
        host,
      ),
    );
  };

  const latestSocket = () => {
    const socket = FakeWebSocket.instances.at(-1);
    if (!socket) throw new Error("No socket was opened");
    return socket;
  };

  const pendingReconnects = () => timers.filter((timer) => timer !== null && timer.delay >= 2_000);

  /** Runs the pending reconnect and returns the delay it waited for. */
  const runReconnect = () => {
    const pending = pendingReconnects();
    expect(pending).toHaveLength(1);
    const timer = pending[0]!;
    timers[timers.indexOf(timer)] = null;
    timer.run();
    return timer.delay;
  };

  const signInRequired = (socket: FakeWebSocket) => {
    socket.open();
    socket.message(WS.error, { notebookId: NOTEBOOK_ID, code: "LOGIN_REQUIRED", message: "Login required" });
  };

  test("a sign-in failure reloads once and then shows a sign-in notice instead of looping", async () => {
    await mount();
    signInRequired(latestSocket());

    expect(reload).toHaveBeenCalledTimes(1);
    expect(pendingReconnects()).toHaveLength(0);

    // The reloaded page still cannot authenticate its live socket.
    for (const dispose of disposers.splice(0)) dispose();
    await mount();
    signInRequired(latestSocket());

    expect(reload).toHaveBeenCalledTimes(1);
    expect(pendingReconnects()).toHaveLength(0);
    expect(FakeWebSocket.instances).toHaveLength(2);
    const signIn = dom.document.querySelector<HTMLAnchorElement>('a[href^="/auth/login?redirectTo="]');
    expect(signIn?.getAttribute("href")).toBe(`/auth/login?redirectTo=${encodeURIComponent("/")}`);
  });

  test("repeated connection failures wait longer each time", async () => {
    await mount();
    const delays: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      latestSocket().close(1006);
      delays.push(runReconnect());
    }

    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 30_000]);
    expect(reload).not.toHaveBeenCalled();
  });

  test("a stream that fails right after the server accepts it reconnects with backoff instead of reloading", async () => {
    await mount();
    const delays: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // The server confirms the subscription before it reads the event stream.
      latestSocket().open();
      latestSocket().message(WS.ready, { notebookId: NOTEBOOK_ID });
      latestSocket().message(WS.error, { notebookId: NOTEBOOK_ID, code: "INTERNAL_ERROR", message: "Stream failed" });
      delays.push(runReconnect());
    }

    expect(delays).toEqual([2_000, 4_000, 8_000]);
    expect(reload).not.toHaveBeenCalled();
  });

  test("a subscription that stayed up resets the backoff", async () => {
    await mount();
    latestSocket().close(1006);
    runReconnect();
    latestSocket().close(1006);
    expect(runReconnect()).toBe(4_000);

    latestSocket().open();
    latestSocket().message(WS.ready, { notebookId: NOTEBOOK_ID });
    now += 30_000;
    latestSocket().close(1006);

    expect(runReconnect()).toBe(2_000);
  });

  test("lost access reloads once, then offers a manual reload", async () => {
    await mount();
    latestSocket().close(1008, "ACCESS_REVOKED");
    expect(reload).toHaveBeenCalledTimes(1);

    for (const dispose of disposers.splice(0)) dispose();
    await mount();
    latestSocket().open();
    latestSocket().message(WS.revoked, { notebookId: NOTEBOOK_ID, code: "ACCESS_REVOKED", message: "Access revoked" });

    expect(reload).toHaveBeenCalledTimes(1);
    expect(pendingReconnects()).toHaveLength(0);
    const action = Array.from(dom.document.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Reload");
    expect(action).toBeDefined();
    action?.click();
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
