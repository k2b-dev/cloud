import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createDialogCore, dialogCore } from "../src/feedback/dialog-core";
import { createDomTestHarness, type DomTestHarness } from "./dom";

let dom: DomTestHarness;
const popObservers = new Set<() => void>();
beforeEach(() => {
  dom = createDomTestHarness();
  popObservers.clear();
  // Observe before the core's capture listener: application listeners added afterwards must not see owned Back events.
  window.addEventListener(
    "popstate",
    () => {
      for (const resolve of popObservers) resolve();
      popObservers.clear();
    },
    { capture: true },
  );
});
afterEach(() => dom.cleanup());

const popped = () => new Promise<void>((resolve) => popObservers.add(resolve));
const settle = () => Bun.sleep(20);
const marker = () => (history.state as { k2bDialog?: number } | null)?.k2bDialog;
const view = (text: string) => () => {
  const element = document.createElement("p");
  element.textContent = text;
  return element;
};

describe("dialogCore popstate ownership", () => {
  for (const kind of ["dialog", "holder"] as const) {
    for (const synthetic of [false, true]) {
      test(`${synthetic ? "closing" : "Back closes"} a ${kind} without notifying application listeners`, async () => {
        const core = createDialogCore();
        const addresses: string[] = [];
        window.addEventListener("popstate", () => addresses.push(location.href));
        let backCalls = 0;
        const result = kind === "dialog" ? core.open(view("Sheet"), { history: true }) : undefined;
        const release = kind === "holder" ? core.holdHistory(() => backCalls++) : () => core.close();
        const back = popped();
        if (synthetic) release();
        else history.back();
        await back;
        await result;
        await core.historySettled();
        expect(core.isOpen()).toBe(false);
        expect(marker()).toBeUndefined();
        expect(backCalls).toBe(kind === "holder" && !synthetic ? 1 : 0);
        expect(addresses).toEqual([]);
      });
    }
  }

  test("registers capture handling when created, before any entry is pushed", () => {
    const listen = spyOn(window, "addEventListener");
    createDialogCore();
    expect(listen).toHaveBeenCalledWith("popstate", expect.any(Function), { capture: true });
    listen.mockRestore();
  });

  test("capture runs before an earlier non-capture listener for a real history traversal", async () => {
    const phases: string[] = [];
    window.addEventListener("popstate", () => phases.push("application"));
    window.addEventListener("popstate", () => phases.push("capture"), { capture: true });
    const core = createDialogCore();
    const result = core.open(view("Sheet"), { history: true });
    history.back();
    await result;
    // Happy DOM, like browsers, runs capture-at-target before non-capture listeners, regardless of registration order.
    expect(phases).toEqual(["capture"]);
  });

  test("Back to a different address propagates when no dialog has opened", async () => {
    createDialogCore();
    const addresses: string[] = [];
    window.addEventListener("popstate", () => addresses.push(location.href));
    history.pushState({ page: "next" }, "", "/next");
    const back = popped();
    history.back();
    await back;
    expect(addresses).toEqual(["http://localhost/"]);
  });

  test("Back past an open dialog to a different address propagates and closes it", async () => {
    const core = createDialogCore();
    const addresses: string[] = [];
    window.addEventListener("popstate", () => addresses.push(location.href));
    history.pushState({ page: "next" }, "", "/next");
    const result = core.open(view("Sheet"), { history: true });
    history.go(-2);
    await result;
    expect(core.isOpen()).toBe(false);
    expect(addresses).toEqual(["http://localhost/"]);
  });

  test("a replaced address propagates even when Back lands on an own marker", async () => {
    const core = createDialogCore();
    const addresses: string[] = [];
    window.addEventListener("popstate", () => addresses.push(location.href));
    const outer = core.open(view("Outer"), { history: true });
    history.replaceState(history.state, "", "/replaced");
    const inner = core.open(view("Inner"), { history: true });
    history.back();
    await inner;
    expect(core.isOpen()).toBe(true);
    expect(addresses).toEqual(["http://localhost/replaced"]);
    core.close();
    await outer;
  });

  for (const synthetic of [false, true]) {
    test(`clears the base after ${synthetic ? "closing" : "Back closes"} the last entry`, async () => {
      const core = createDialogCore();
      const addresses: string[] = [];
      window.addEventListener("popstate", () => addresses.push(location.href));
      const result = core.open(view("Sheet"), { history: true });
      if (synthetic) core.close();
      else history.back();
      await result;
      history.pushState({ page: "next" }, "", "/next");
      const back = popped();
      history.back();
      await back;
      expect(addresses).toEqual(["http://localhost/"]);

      history.replaceState({}, "", "/new-base");
      const next = core.open(view("Next sheet"), { history: true });
      core.close();
      await next;
      expect(location.href).toBe("http://localhost/new-base");
      expect(addresses).toEqual(["http://localhost/"]);
    });
  }
});

describe("dialogCore history option", () => {
  test("Back closes the dialog instead of leaving the page", async () => {
    const core = createDialogCore();
    const start = history.length;
    const result = core.open(view("Sheet"), { history: true });
    expect(history.length).toBe(start + 1);
    expect(marker()).toBeNumber();
    const back = popped();
    history.back();
    await back;
    expect(await result).toBeUndefined();
    expect(core.isOpen()).toBe(false);
    expect(marker()).toBeUndefined();
    expect(location.href).toBe("http://localhost/");
  });

  test("closing removes the entry again before the promise settles", async () => {
    const core = createDialogCore();
    const result = core.open<string>(
      (close) => {
        queueMicrotask(() => close("done"));
        return document.createElement("p");
      },
      { history: true },
    );
    expect(await result).toBe("done");
    expect(marker()).toBeUndefined();
  });

  test("Back closes only the newest of nested dialogs, and everything opened after it", async () => {
    const core = createDialogCore();
    const outer = core.open(view("Outer"), { history: true });
    const inner = core.open(view("Inner"), { history: true });
    const confirmation = core.open(view("Confirm"));
    let back = popped();
    history.back();
    await back;
    expect(await inner).toBeUndefined();
    expect(await confirmation).toBeUndefined();
    expect(core.isOpen()).toBe(true);
    expect(document.querySelector("dialog")?.textContent).toBe("Outer");
    back = popped();
    history.back();
    await back;
    expect(await outer).toBeUndefined();
    expect(core.isOpen()).toBe(false);
  });

  test("closing every dialog returns to the page in one step, and the next dialog waits for it", async () => {
    const core = createDialogCore();
    const start = history.length;
    const first = core.open(view("First"), { history: true });
    const second = core.open(view("Second"), { history: true });
    core.close();
    const next = core.open(view("Next"), { history: true });
    expect(core.isOpen()).toBe(false);
    await Promise.all([first, second]);
    await settle();
    // Both closed entries left in one step; only the next dialog's entry is above the page.
    expect(core.isOpen()).toBe(true);
    expect(document.querySelector("dialog")?.textContent).toBe("Next");
    expect(history.length).toBe(start + 1);
    expect(marker()).toBeNumber();
    const back = popped();
    history.back();
    await back;
    await next;
    expect(core.isOpen()).toBe(false);
    expect(marker()).toBeUndefined();
  });

  test("a reloaded page drops a stale dialog marker instead of reopening on Forward", async () => {
    history.replaceState({ k2bDialog: 41, page: "tasks" }, "");
    const core = createDialogCore();
    const result = core.open(view("Sheet"), { history: true });
    const back = popped();
    history.back();
    await back;
    await result;
    expect(history.state).toEqual({ page: "tasks" });
  });

  test("dialogs without the option leave the history alone", async () => {
    const core = createDialogCore();
    const start = history.length;
    const result = core.open(view("Plain"));
    expect(history.length).toBe(start);
    core.close();
    await result;
    expect(history.length).toBe(start);
  });

  test("prompts take the option, and Back dismisses them", async () => {
    const core = createDialogCore();
    const { prompts } = await import("../src/feedback/prompts");
    // The shared core was evaluated without window. Test prompt delegation through this browser-created core.
    const open = spyOn(dialogCore, "open").mockImplementation(core.open);
    try {
      const start = history.length;
      const answer = prompts.confirm("Sign out of the app?", { history: true });
      expect(history.length).toBe(start + 1);
      const back = popped();
      history.back();
      await back;
      expect(await answer).toBeUndefined();
      expect(marker()).toBeUndefined();
    } finally {
      open.mockRestore();
    }
  });
});

describe("dialogCore internal history holders", () => {
  test("holders close once on Back and stay gone on Forward", async () => {
    history.replaceState({ sentinel: 1 }, "");
    const core = createDialogCore();
    const addresses: string[] = [];
    window.addEventListener("popstate", () => addresses.push(location.href));
    let calls = 0;
    const release = core.holdHistory(() => calls++);
    expect(marker()).toBeNumber();
    expect(core.isOpen()).toBe(false);
    let back = popped();
    history.back();
    await back;
    expect(calls).toBe(1);
    expect(history.state).toEqual({ sentinel: 1 });
    expect(addresses).toEqual([]);
    release();
    release();
    back = popped();
    history.forward();
    await back;
    expect(calls).toBe(1);
    expect(addresses).toEqual(["http://localhost/"]);
    back = popped();
    history.back();
    await back;
    expect(calls).toBe(1);
    expect(addresses).toEqual(["http://localhost/", "http://localhost/"]);
  });

  test("releasing holders is idempotent and restores page state in one traversal", async () => {
    history.replaceState({ sentinel: 1 }, "");
    const core = createDialogCore();
    let calls = 0;
    const first = core.holdHistory(() => calls++);
    const second = core.holdHistory(() => calls++);
    const go = spyOn(history, "go");
    const back = popped();
    first();
    first();
    second();
    await back;
    expect(go.mock.calls).toEqual([[-2]]);
    expect(history.state).toEqual({ sentinel: 1 });
    expect(calls).toBe(0);
    go.mockRestore();
  });

  test("Back past the newest holder also removes an older released entry", async () => {
    history.replaceState({ sentinel: 1 }, "");
    const core = createDialogCore();
    const release = core.holdHistory(() => {
      throw new Error("Already released");
    });
    let calls = 0;
    core.holdHistory(() => calls++);
    release();
    await Promise.resolve();
    const back = popped();
    history.back();
    await back;
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(history.state).toEqual({ sentinel: 1 });
  });

  test("releasing a holder leaves foreign history alone", async () => {
    const core = createDialogCore();
    const addresses: string[] = [];
    window.addEventListener("popstate", () => addresses.push(location.href));
    const release = core.holdHistory(() => {});
    history.pushState({ foreign: true }, "");
    const go = spyOn(history, "go");
    release();
    await Promise.resolve();
    expect(go).not.toHaveBeenCalled();
    expect(history.state).toEqual({ foreign: true });
    go.mockRestore();
    const back = popped();
    history.back();
    await back;
    expect(addresses).toEqual(["http://localhost/"]);
  });

  for (const inFlight of [false, true]) {
    test(`a new holder waits for ${inFlight ? "returning" : "a pending release"}`, async () => {
      history.replaceState({ sentinel: 1 }, "");
      const core = createDialogCore();
      let calls = 0;
      const first = core.holdHistory(() => calls++);
      const firstMarker = marker();
      const push = spyOn(history, "pushState");
      const back = popped();
      first();
      if (inFlight) await Promise.resolve();
      const release = core.holdHistory(() => calls++);
      expect(push).not.toHaveBeenCalled();
      await back;
      // The deferred push is a reaction to returning, after this popstate.
      await Promise.resolve();
      expect(marker()).toBeNumber();
      expect(marker()).not.toBe(firstMarker);
      expect(history.length).toBe(2);
      expect(push).toHaveBeenCalledTimes(1);
      push.mockRestore();
      expect(calls).toBe(0);
      const done = popped();
      release();
      await done;
      expect(history.state).toEqual({ sentinel: 1 });
    });
  }

  test("releasing a deferred holder prevents its entry being pushed", async () => {
    history.replaceState({ sentinel: 1 }, "");
    const core = createDialogCore();
    const first = core.holdHistory(() => {});
    const back = popped();
    first();
    const cancel = core.holdHistory(() => {
      throw new Error("Already released");
    });
    cancel();
    await back;
    await Promise.resolve();
    expect(history.state).toEqual({ sentinel: 1 });
  });

  test("a dialog replaces a released holder without leaving an extra entry", async () => {
    history.replaceState({ sentinel: 1 }, "");
    const core = createDialogCore();
    const release = core.holdHistory(() => {});
    const back = popped();
    release();
    const result = core.open(view("Command dialog"), { history: true });
    expect(core.isOpen()).toBe(false);
    await back;
    await Promise.resolve();
    expect(core.isOpen()).toBe(true);
    expect(history.length).toBe(2);
    core.close();
    await result;
    expect(history.state).toEqual({ sentinel: 1 });
  });

  test("a holder waits for a closing dialog and interleaves with dialogs", async () => {
    history.replaceState({ sentinel: 1 }, "");
    const core = createDialogCore();
    const outer = core.open(view("Outer"), { history: true });
    const closing = core.open(view("Closing"), { history: true });
    const top = core.open(view("Top"));
    // Closing the stack leaves a synthetic Back in flight before the holder.
    core.close();
    let calls = 0;
    core.holdHistory(() => calls++);
    await Promise.all([outer, closing, top]);
    await Promise.resolve();
    expect(marker()).toBeNumber();
    expect(history.length).toBe(2);
    const dialog = core.open(view("Above holder"), { history: true });
    let back = popped();
    history.back();
    await back;
    await dialog;
    expect(calls).toBe(0);
    expect(marker()).toBeNumber();
    back = popped();
    history.back();
    await back;
    expect(calls).toBe(1);
    expect(history.state).toEqual({ sentinel: 1 });
  });
});
