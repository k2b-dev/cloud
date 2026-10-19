import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createDialogCore, dialogCore, holdDialogHistory } from "../src/feedback/dialog-core";
import { createDomTestHarness, type DomTestHarness } from "./dom";

let dom: DomTestHarness;
beforeEach(() => {
  dom = createDomTestHarness();
});
afterEach(() => {
  mock.restore();
  dom.cleanup();
});
const view = (label: string) => () => {
  const button = document.createElement("button");
  button.textContent = label;
  return button;
};
const trigger = (id?: string, tag = "solid-island") => {
  const parent = document.createElement(id ? tag : "div");
  if (id) parent.dataset.id = id;
  const button = document.createElement("button");
  parent.append(button);
  document.body.append(parent);
  return { parent, button };
};
const dispose = (island: Element) =>
  island.dispatchEvent(
    new CustomEvent("ssr:island-dispose", {
      bubbles: true,
      detail: { id: island.getAttribute("data-id") },
    }),
  );
const settle = () => Bun.sleep(20);

for (const navigationApi of [true, false]) {
  describe(navigationApi ? "with the Navigation API" : "without it", () => {
    let restoreNavigation: () => void;
    beforeEach(() => {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigation");
      const target = new dom.window.EventTarget();
      Object.defineProperty(globalThis, "navigation", { configurable: true, value: navigationApi ? target : undefined });
      const traverse = () => target.dispatchEvent(Object.assign(new dom.window.Event("navigate"), { navigationType: "traverse" }));
      const back = history.back.bind(history);
      const forward = history.forward.bind(history);
      const go = history.go.bind(history);
      const wrappers = navigationApi
        ? [
            spyOn(history, "back").mockImplementation(() => {
              traverse();
              back();
            }),
            spyOn(history, "forward").mockImplementation(() => {
              traverse();
              forward();
            }),
            spyOn(history, "go").mockImplementation((delta) => {
              traverse();
              go(delta);
            }),
          ]
        : [];
      restoreNavigation = () => {
        for (const wrapper of wrappers) wrapper.mockRestore();
        if (descriptor) Object.defineProperty(globalThis, "navigation", descriptor);
        else Reflect.deleteProperty(globalThis, "navigation");
      };
    });
    afterEach(() => restoreNavigation());
    /** A real browser traverses after the current task; Happy DOM would traverse inside go(). */
    const deferTraversals = () => {
      const go = Object.getPrototypeOf(history).go.bind(history);
      return spyOn(history, "go").mockImplementation((delta) => {
        setTimeout(() => {
          if (navigationApi) navigation.dispatchEvent(Object.assign(new Event("navigate"), { navigationType: "traverse" }));
          go(delta);
        }, 10);
      });
    };

    test("disposal closes the focused island's dialog, portal, focus trap and scroll lock", async () => {
      const core = createDialogCore();
      const { parent, button } = trigger("a");
      document.body.style.overflow = "auto";
      document.documentElement.style.overflow = "scroll";
      button.focus();
      const result = core.open(view("Owned content"));
      expect(document.querySelector("dialog")).not.toBeNull();
      expect(document.body.style.overflow).toBe("hidden");
      dispose(parent);
      expect(core.isOpen()).toBe(false);
      expect(document.querySelector("dialog")).toBeNull();
      expect(document.body.textContent).not.toContain("Owned content");
      expect(document.body.style.overflow).toBe("auto");
      expect(document.documentElement.style.overflow).toBe("scroll");
      expect(document.activeElement?.closest("dialog")).toBeNull();
      expect(await result).toBeUndefined();
    });

    test("disposal listening moves with the window, without the old press, even for a dialog without history", async () => {
      const core = createDialogCore();
      const remove = spyOn(window, "removeEventListener");
      // A press in the old window must not claim dialogs opened in the new one.
      trigger().button.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      dom.cleanup();
      dom = createDomTestHarness();
      const { parent, button } = trigger("a");
      button.focus();
      const result = core.open(view("Moved"));
      expect(remove).toHaveBeenCalledWith("ssr:island-dispose", expect.any(Function), { capture: true });
      dispose(parent);
      expect(core.isOpen()).toBe(false);
      expect(await result).toBeUndefined();
    });

    test("nested dialogs close top first while other-island and unowned levels below stay", async () => {
      const core = createDialogCore();
      const outside = trigger();
      const a = trigger("a");
      const b = trigger("b", "solid-client");
      outside.button.focus();
      const unowned = core.open(view("Outside"));
      b.button.focus();
      const other = core.open(view("Other island"));
      a.button.focus();
      const owned = core.open(view("Owned"));
      document.querySelector<HTMLButtonElement>("dialog > div:last-child button")!.focus();
      const nested = core.open(view("Nested"));
      const order: string[] = [];
      void owned.then(() => order.push("owned"));
      void nested.then(() => order.push("nested"));
      dispose(a.parent);
      expect(await nested).toBeUndefined();
      expect(await owned).toBeUndefined();
      expect(order).toEqual(["nested", "owned"]);
      expect(core.isOpen()).toBe(true);
      expect(document.body.textContent).toContain("Other island");
      expect(document.body.textContent).toContain("Outside");
      expect(document.body.textContent).not.toContain("Owned");
      dispose(b.parent);
      expect(await other).toBeUndefined();
      expect(core.isOpen()).toBe(true);
      core.close();
      await unowned;
    });

    test("the dispatch target owns a dialog even when WebKit leaves focus elsewhere", async () => {
      const core = createDialogCore();
      const { parent, button } = trigger("a");
      const outside = trigger();
      outside.button.focus();
      let result: Promise<unknown> | undefined;
      const descriptor = Object.getOwnPropertyDescriptor(window, "event");
      button.addEventListener("click", (event) => {
        // Happy DOM does not expose the browser's legacy window.event during dispatch.
        Object.defineProperty(window, "event", { configurable: true, value: event });
        result = core.open(view("Clicked"));
      });
      try {
        button.click();
      } finally {
        if (descriptor) Object.defineProperty(window, "event", descriptor);
        else Reflect.deleteProperty(window, "event");
      }
      dispose(parent);
      expect(core.isOpen()).toBe(false);
      expect(await result).toBeUndefined();
    });

    test("disposed history markers become ordinary traversals and later dialogs still own theirs", async () => {
      const core = createDialogCore();
      const application = mock(() => {});
      window.addEventListener("popstate", application);
      const a = trigger("a");
      const outside = trigger();
      outside.button.focus();
      const remaining = core.open(view("Keep open"));
      a.button.focus();
      const result = core.open(view("Owned"), { history: true });
      const length = history.length;
      const back = spyOn(history, "back");
      const go = spyOn(history, "go");
      const forward = spyOn(history, "forward");
      dispose(a.parent);
      expect(document.body.textContent).not.toContain("Owned");
      expect(await result).toBeUndefined();
      await settle();
      expect(back).not.toHaveBeenCalled();
      expect(go).not.toHaveBeenCalled();
      expect(forward).not.toHaveBeenCalled();
      expect(history.length).toBe(length);
      history.back();
      await settle();
      expect(application).toHaveBeenCalledTimes(1);
      expect(core.isOpen()).toBe(true);
      history.forward();
      await settle();
      expect(application).toHaveBeenCalledTimes(2);
      expect(core.isOpen()).toBe(true);
      outside.button.focus();
      const next = core.open(view("Next"), { history: true });
      expect(history.length).toBe(length + 1);
      document.querySelector<HTMLButtonElement>("dialog > div:last-child button")!.focus();
      // Back removes only the new level and its marker.
      history.back();
      expect(await next).toBeUndefined();
      expect(core.isOpen()).toBe(true);
      expect(application).toHaveBeenCalledTimes(navigationApi ? 2 : 3);
      core.close();
      await remaining;
    });

    test("a dead entry beside a live history dialog counts as a page entry above it", async () => {
      const core = createDialogCore();
      const application = mock(() => {});
      window.addEventListener("popstate", application);
      const a = trigger("a");
      const b = trigger("b");
      b.button.focus();
      const lower = core.open(view("Live history"), { history: true });
      a.button.focus();
      const upper = core.open(view("Disposed history"), { history: true });
      dispose(a.parent);
      expect(core.isOpen()).toBe(true);
      expect(document.body.textContent).not.toContain("Disposed history");
      expect(await upper).toBeUndefined();
      // A dialog opened on the dead entry is removed by one Back onto it; the live dialog below stays.
      b.button.focus();
      const next = core.open(view("Next"), { history: true });
      history.back();
      expect(await next).toBeUndefined();
      expect(document.body.textContent).toContain("Live history");
      expect(document.body.textContent).not.toContain("Next");
      // Back off the dead entry reaches the live dialog's entry: the dialog stays open.
      history.back();
      await settle();
      expect(core.isOpen()).toBe(true);
      // Forward onto the dead entry closes nothing either.
      history.forward();
      await settle();
      expect(core.isOpen()).toBe(true);
      expect(application).toHaveBeenCalledTimes(navigationApi ? 0 : 3);
      core.close();
      await lower;
    });

    test("closing dialogs never goes Back across a forgotten entry", async () => {
      const core = createDialogCore();
      const a = trigger("a");
      const b = trigger("b");
      b.button.focus();
      const lower = core.open(view("Live history"), { history: true });
      a.button.focus();
      const upper = core.open(view("Disposed history"), { history: true });
      const forgottenEntry = history.state;
      dispose(a.parent);
      expect(await upper).toBeUndefined();
      // The router may replace the forgotten entry with another page; a synthetic Back must never cross it.
      history.replaceState(forgottenEntry, "", "/elsewhere");
      b.button.focus();
      const next = core.open(view("Next"), { history: true });
      const go = spyOn(history, "go");
      core.close();
      expect(await next).toBeUndefined();
      expect(await lower).toBeUndefined();
      await settle();
      expect(go.mock.calls).toEqual([[-1]]);
      expect(location.pathname).toBe("/elsewhere");
      expect(history.state).toEqual(forgottenEntry);
    });

    test("a dialog opened after an await belongs to the island of the latest press", async () => {
      const core = createDialogCore();
      const { parent, button } = trigger("a");
      const outside = trigger();
      outside.button.focus();
      button.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true }));
      await Promise.resolve();
      const result = core.open(view("Loaded on demand"));
      dispose(parent);
      expect(core.isOpen()).toBe(false);
      expect(await result).toBeUndefined();
      // Disposal forgets the press, so a later dialog without a trigger belongs to no island.
      const unowned = core.open(view("Unowned"));
      dispose(parent);
      expect(core.isOpen()).toBe(true);
      core.close();
      await unowned;
    });

    test.each(["wrapper", "window"])("holder release on %s during disposal never schedules Back", async (target) => {
      const { parent, button } = trigger("a");
      button.focus();
      const dialog = dialogCore.open(view("Owned"));
      const release = holdDialogHistory(() => {
        throw new Error("must not close via Back");
      });
      const go = spyOn(history, "go");
      const length = history.length;
      // Target listeners run before bubble listeners; both releases belong to the disposal window.
      (target === "wrapper" ? parent : window).addEventListener("ssr:island-dispose", release, { once: true });
      dispose(parent);
      expect(dialogCore.isOpen()).toBe(false);
      expect(await dialog).toBeUndefined();
      await settle();
      expect(go).not.toHaveBeenCalled();
      expect(history.length).toBe(length);
    });

    test("a dialog disposed while an earlier Back is on its way settles only after that Back lands", async () => {
      // Registered before the core, so it sees the traversal even when the core stops its propagation.
      let landed = false;
      const onLanded = () => {
        landed = true;
      };
      window.addEventListener("popstate", onLanded, { capture: true });
      const core = createDialogCore();
      const a = trigger("a");
      a.button.focus();
      const first = core.open(view("First"), { history: true });
      document.querySelector<HTMLButtonElement>("dialog > div:last-child button")!.focus();
      let closeSecond = () => {};
      const second = core.open(
        (close) => {
          closeSecond = close;
          return view("Second")();
        },
        { history: true },
      );
      const deferred = deferTraversals();
      closeSecond();
      expect(core.isOpen()).toBe(true);
      // The synthetic Back that removes the second entry starts at the next microtask.
      await Promise.resolve();
      expect(deferred).toHaveBeenCalledWith(-1);
      expect(landed).toBe(false);
      dispose(a.parent);
      expect(core.isOpen()).toBe(false);
      let landedAtSettle: boolean | undefined;
      void first.then(() => {
        landedAtSettle = landed;
      });
      expect(await second).toBeUndefined();
      expect(await first).toBeUndefined();
      expect(landedAtSettle).toBe(true);
      window.removeEventListener("popstate", onLanded, { capture: true });
    });

    test("a history dialog waiting for an earlier Back never opens once its island is disposed", async () => {
      const core = createDialogCore();
      const outside = trigger();
      const b = trigger("b");
      document.body.style.overflow = "auto";
      outside.button.focus();
      let closeFirst = () => {};
      const first = core.open(
        (close) => {
          closeFirst = close;
          return view("First")();
        },
        { history: true },
      );
      const deferred = deferTraversals();
      closeFirst();
      await Promise.resolve();
      expect(deferred).toHaveBeenCalledWith(-1);
      b.button.focus();
      const waiting = core.open(view("Waiting"), { history: true });
      dispose(b.parent);
      expect(await first).toBeUndefined();
      expect(await waiting).toBeUndefined();
      expect(core.isOpen()).toBe(false);
      expect(document.querySelector("dialog")).toBeNull();
      expect(document.body.textContent).not.toContain("Waiting");
      expect(document.body.style.overflow).toBe("auto");
    });

    test("a nested history dialog waiting for an earlier Back never opens once its parent's island is disposed", async () => {
      const core = createDialogCore();
      const a = trigger("a");
      document.body.style.overflow = "auto";
      a.button.focus();
      const parent = core.open(view("Parent"), { history: true });
      const parentButton = document.querySelector<HTMLButtonElement>("dialog > div:last-child button")!;
      parentButton.focus();
      let closeChild = () => {};
      const child = core.open(
        (close) => {
          closeChild = close;
          return view("Child")();
        },
        { history: true },
      );
      const deferred = deferTraversals();
      closeChild();
      await Promise.resolve();
      expect(deferred).toHaveBeenCalledWith(-1);
      parentButton.focus();
      const waiting = core.open(view("Waiting child"), { history: true });
      dispose(a.parent);
      expect(await child).toBeUndefined();
      expect(await parent).toBeUndefined();
      expect(await waiting).toBeUndefined();
      expect(core.isOpen()).toBe(false);
      expect(document.querySelector("dialog")).toBeNull();
      expect(document.body.style.overflow).toBe("auto");
    });

    test("a dialog opened from a portalled menu item belongs to the island of the press that opened the menu", async () => {
      const core = createDialogCore();
      const { parent, button } = trigger("a");
      button.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      // The context menu renders in a portal outside the island and closes before it runs the chosen action.
      const menu = trigger();
      menu.button.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      menu.parent.remove();
      const descriptor = Object.getOwnPropertyDescriptor(window, "event");
      Object.defineProperty(window, "event", { configurable: true, value: { target: menu.button } });
      let result: Promise<unknown>;
      try {
        result = core.open(view("From menu"));
      } finally {
        if (descriptor) Object.defineProperty(window, "event", descriptor);
        else Reflect.deleteProperty(window, "event");
      }
      dispose(parent);
      expect(core.isOpen()).toBe(false);
      expect(await result).toBeUndefined();
    });

    test("the disposal window resets at the next microtask and normal close still goes Back", async () => {
      const core = createDialogCore();
      const { parent, button } = trigger("a");
      button.focus();
      const disposed = core.open(view("Disposed first"), { history: true });
      dispose(parent);
      expect(core.isOpen()).toBe(false);
      expect(await disposed).toBeUndefined();
      await Promise.resolve();
      button.focus();
      let close = () => {};
      const result = core.open(
        (done) => {
          close = done;
          return view("Normal")();
        },
        { history: true },
      );
      const go = spyOn(history, "go");
      close();
      expect(await result).toBeUndefined();
      expect(go).toHaveBeenCalledWith(-1);
    });
  });
}
