import { describe, expect, mock, test } from "bun:test";
import { createRoot, onCleanup, onMount } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import { FULL_WIDTH_PREFERENCE_EVENT } from "./detail/events";
import { readFullWidth, setFullWidth } from "./settings/NotebookSettingsStore";

const openView = (root: HTMLElement) => {
  // happy-dom has no native top layer. Model only its open state and toggle event.
  const menu = root.querySelector<HTMLElement>('[role="menu"]')!;
  let open = false;
  const matches = menu.matches.bind(menu);
  Object.defineProperty(menu, "matches", { value: (selector: string) => (selector === ":popover-open" ? open : matches(selector)) });
  const toggle = (next: boolean) => {
    open = next;
    const event = new Event("toggle");
    Object.defineProperty(event, "newState", { value: next ? "open" : "closed" });
    menu.dispatchEvent(event);
  };
  menu.showPopover = () => toggle(true);
  menu.hidePopover = () => toggle(false);
  delegateEvents(["click"], root.ownerDocument);
  root.querySelector<HTMLButtonElement>(".notebook-view-menu__trigger")!.click();
};

// happy-dom reflects inline dimensions in computed styles; deliver observed callbacks ourselves.
const hostLayout = (dom: ReturnType<typeof createDomTestHarness>, initial = 1192) => {
  dom.window.happyDOM.setWindowSize({ width: 1680, height: 900 });
  document.documentElement.style.fontSize = "16px";
  document.documentElement.style.padding = "0px";
  document.documentElement.style.boxSizing = "content-box";
  document.documentElement.style.width = `${window.innerWidth}px`;
  dom.root.style.containerName = "k2b-app-area";
  dom.root.style.padding = "0px";
  dom.root.style.border = "0px solid";
  dom.root.style.boxSizing = "border-box";
  dom.root.style.width = `${initial}px`;
  const original = globalThis.ResizeObserver;
  const observers = new Map<ResizeObserver, ResizeObserverCallback>();
  const disconnected = mock(() => {});
  globalThis.ResizeObserver = class extends original {
    constructor(private callback: ResizeObserverCallback) {
      super(callback);
    }
    override observe(_target: Element) {
      observers.set(this, this.callback);
    }
    override disconnect() {
      if (observers.delete(this)) disconnected();
    }
  };
  return {
    disconnected,
    resize(next: number) {
      dom.root.style.width = `${next}px`;
      for (const [observer, callback] of observers) callback([], observer);
    },
    cleanup() {
      globalThis.ResizeObserver = original;
    },
  };
};

describe("personal full-width bridge", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  const mountReadingSurface = async (stored: boolean, width = 1192, namedHost = true) => {
    // Each harness owns a fresh document and cookie jar.
    const dom = createDomTestHarness();
    setFullWidth(stored);
    const { collectContextAwareCommands } = await import("@k2b/cloud/browser/testing");
    const { LocaleProvider, useLocale } = await import("@k2b/ui");
    const { notebookWorkspaceMessages } = await import("../messages");
    const { ViewMenu } = await import("./detail/ViewMenu");
    const { followFullWidth } = await import("./full-width");
    const layout = hostLayout(dom, width);
    if (!namedHost) dom.root.style.containerName = "none";
    const keepPosition = mock(() => null);
    function ReadingSurface() {
      const locale = useLocale();
      let port: HTMLDivElement | undefined;
      onMount(() => {
        if (!port) throw new Error("No reading surface.");
        followFullWidth(port, keepPosition, () => notebookWorkspaceMessages.resolve([locale()]).t);
      });
      return (
        <div class="k2b-app-workspace">
          <div class="notebook-document-surface">
            <div ref={port} />
          </div>
          <ViewMenu mode="edit" notebookId="book01" noteId="note01" canEdit isRich onToggleRich={() => {}} fullWidth={false} />
        </div>
      );
    }
    const dispose = render(
      () => (
        <LocaleProvider locale="de">
          <ReadingSurface />
        </LocaleProvider>
      ),
      dom.root,
    );
    openView(dom.root);
    const surface = dom.root.querySelector<HTMLDivElement>(".notebook-document-surface");
    if (!surface) throw new Error("Missing reading surface.");
    const command = () => collectContextAwareCommands().find((command) => command.id === "notebooks.view.fullWidth");
    return {
      host: dom.root,
      surface,
      get toggle() {
        return dom.root.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]')!;
      },
      resize: layout.resize,
      disconnected: layout.disconnected,
      command,
      keepPosition,
      dispose,
      cleanup: () => {
        dispose();
        layout.cleanup();
        dom.cleanup();
      },
    };
  };

  test.each(["border-box", "content-box"])("host measurement uses the %s content width and root rem units", async (boxSizing) => {
    const dom = createDomTestHarness();
    const inset = boxSizing === "border-box" ? 36 : 0;
    const layout = hostLayout(dom, 1280 + inset - 0.25);
    const { watchAppHostWidth } = await import("@k2b/ui");
    document.documentElement.style.fontSize = "20px";
    dom.root.style.fontSize = "8px";
    dom.root.style.paddingLeft = "16px";
    dom.root.style.paddingRight = "16px";
    dom.root.style.border = "2px solid";
    dom.root.style.boxSizing = boxSizing;
    const child = document.createElement("div");
    dom.root.append(child);
    const values: boolean[] = [];
    const dispose = createRoot((dispose) => {
      onCleanup(watchAppHostWidth(child, 64, (wide) => values.push(wide)));
      return dispose;
    });
    try {
      expect(values).toEqual([false]);
      layout.resize(1280 + inset);
      layout.resize(1280 + inset - 0.25);
      expect(values).toEqual([false, true, false]);
      dispose();
      expect(layout.disconnected).toHaveBeenCalledTimes(1);
      layout.resize(1400);
      expect(values).toEqual([false, true, false]);
    } finally {
      dispose();
      layout.cleanup();
      dom.cleanup();
    }
  });

  test("switches from the root to a host that gains its container name after mount", async () => {
    const view = await mountReadingSurface(false, 952, false);
    try {
      expect(view.command()).toBeDefined();
      expect(view.toggle).not.toBeNull();
      view.host.style.containerName = "k2b-app-area";
      view.resize(952);
      expect(view.command()).toBeUndefined();
      expect(view.toggle).toBeNull();
    } finally {
      view.cleanup();
    }
  });

  // Pins host width: a wide window cannot offer a command or option for a narrow app.
  test("nearest host crossing 64 rem toggles both offers in a wide window", async () => {
    const view = await mountReadingSurface(false, 952);
    try {
      expect(window.innerWidth).toBe(1680);
      expect(view.command()).toBeUndefined();
      expect(view.toggle).toBeNull();
      view.resize(1023.75);
      expect(view.command()).toBeUndefined();
      expect(view.toggle).toBeNull();
      view.resize(1024);
      expect(view.command()).toBeDefined();
      expect(view.toggle).not.toBeNull();
      view.resize(1023);
      expect(view.command()).toBeUndefined();
      expect(view.toggle).toBeNull();
      view.resize(1192);
      expect(view.command()).toBeDefined();
      expect(view.toggle).not.toBeNull();
      view.dispose();
      expect(view.disconnected).toHaveBeenCalled();
      view.resize(952);
      expect(view.command()).toBeUndefined();
    } finally {
      view.cleanup();
    }
  });

  test("remounts from the cookie and keeps the menu choice and command usable", async () => {
    const view = await mountReadingSurface(true);
    try {
      expect(view.surface.hasAttribute("data-full-width")).toBe(true);
      expect(view.toggle.getAttribute("aria-checked") === "true").toBe(true);
      expect(view.command()?.title).toBe("Volle Breite ausschalten");
      expect(view.keepPosition).toHaveBeenCalledTimes(1);

      for (const on of [false, true]) {
        const action = view.command()?.action;
        if (typeof action !== "function") throw new Error("Expected a local command.");
        await action();
        expect(view.surface.hasAttribute("data-full-width")).toBe(on);
        expect(view.toggle.getAttribute("aria-checked") === "true").toBe(on);
        expect(readFullWidth()).toBe(on);
        expect(view.command()?.title).toBe(on ? "Volle Breite ausschalten" : "Volle Breite einschalten");
      }
    } finally {
      view.cleanup();
    }
  });

  test("follows other tabs on focus and visible changes without notifying, until disposed", async () => {
    const view = await mountReadingSurface(false);
    const visibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    const notified = mock(() => undefined);
    window.addEventListener(FULL_WIDTH_PREFERENCE_EVENT, notified);
    const expectWidth = (on: boolean) => {
      expect(view.surface.hasAttribute("data-full-width")).toBe(on);
      expect(view.toggle.getAttribute("aria-checked") === "true").toBe(on);
      expect(view.command()?.title).toBe(on ? "Volle Breite ausschalten" : "Volle Breite einschalten");
    };
    try {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      expectWidth(false);
      setFullWidth(true);
      window.dispatchEvent(new Event("focus"));
      expectWidth(true);
      expect(view.keepPosition).toHaveBeenCalledTimes(1);

      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      setFullWidth(false);
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
      expectWidth(true);
      expect(view.keepPosition).toHaveBeenCalledTimes(1);

      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
      expectWidth(false);
      expect(view.keepPosition).toHaveBeenCalledTimes(2);

      // A surface may already match while the command still holds the old value.
      setFullWidth(true);
      view.surface.setAttribute("data-full-width", "");
      window.dispatchEvent(new Event("focus"));
      expectWidth(true);
      expect(view.keepPosition).toHaveBeenCalledTimes(2);
      expect(notified).not.toHaveBeenCalled();

      const lastToggle = view.toggle;
      view.dispose();
      setFullWidth(false);
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      expect(view.surface.hasAttribute("data-full-width")).toBe(true);
      expect(lastToggle.getAttribute("aria-checked") === "true").toBe(true);
      expect(view.command()).toBeUndefined();
      expect(view.keepPosition).toHaveBeenCalledTimes(2);
      expect(notified).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(FULL_WIDTH_PREFERENCE_EVENT, notified);
      if (visibility) Object.defineProperty(document, "visibilityState", visibility);
      else Reflect.deleteProperty(document, "visibilityState");
      view.cleanup();
    }
  });

  test("rewraps between capture and synchronous restore, follows commands and cleans up its listeners", async () => {
    const dom = createDomTestHarness();
    const { collectContextAwareCommands } = await import("@k2b/cloud/browser/testing");
    const { LocaleProvider, useLocale } = await import("@k2b/ui");
    const { notebookWorkspaceMessages } = await import("../messages");
    const { ViewMenu } = await import("./detail/ViewMenu");
    const { changeFullWidth, followFullWidth } = await import("./full-width");
    const layout = hostLayout(dom);
    const phases: boolean[] = [];
    let surface: HTMLDivElement | undefined;
    let port: HTMLDivElement | undefined;
    function ReadingSurface() {
      const locale = useLocale();
      const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
      onMount(() => {
        if (!port || !surface) throw new Error("No reading surface.");
        followFullWidth(
          port,
          () => {
            phases.push(surface!.hasAttribute("data-full-width"));
            return () => phases.push(surface!.hasAttribute("data-full-width"));
          },
          t,
        );
      });
      return (
        <>
          <div ref={surface} class="notebook-document-surface">
            <div ref={port} />
          </div>
          <ViewMenu mode="edit" notebookId="book01" noteId="note01" canEdit isRich onToggleRich={() => {}} fullWidth={false} />
        </>
      );
    }
    const dispose = render(
      () => (
        <LocaleProvider locale="de">
          <ReadingSurface />
        </LocaleProvider>
      ),
      dom.root,
    );
    let disposed = false;
    try {
      openView(dom.root);
      const toggle = dom.root.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]')!;
      const command = () => collectContextAwareCommands().find((command) => command.id === "notebooks.view.fullWidth");
      expect(command()?.title).toBe("Volle Breite einschalten");
      const action = command()?.action;
      if (typeof action !== "function") throw new Error("Expected a local command.");
      await action();
      expect(phases).toEqual([false, true]);
      expect(toggle.getAttribute("aria-checked") === "true").toBe(true);
      expect(readFullWidth()).toBe(true);
      expect(command()?.title).toBe("Volle Breite ausschalten");

      // A repeated notification must not capture or restore a position that already matches.
      window.dispatchEvent(new Event(FULL_WIDTH_PREFERENCE_EVENT));
      expect(phases).toEqual([false, true]);
      toggle.click();
      expect(dom.root.querySelector(".notebook-view-menu__trigger")?.getAttribute("aria-expanded")).toBe("true");
      expect(phases).toEqual([false, true, true, false]);
      expect(toggle.getAttribute("aria-checked") === "true").toBe(false);
      expect(command()?.title).toBe("Volle Breite einschalten");

      layout.resize(952);
      expect(command()).toBeUndefined();
      layout.resize(1192);
      expect(command()?.title).toBe("Volle Breite einschalten");

      const lastToggle = dom.root.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]')!;
      dispose();
      disposed = true;
      expect(command()).toBeUndefined();
      expect(layout.disconnected).toHaveBeenCalled();
      changeFullWidth(true);
      expect(phases).toEqual([false, true, true, false]);
      expect(lastToggle.getAttribute("aria-checked") === "true").toBe(false);
    } finally {
      if (!disposed) dispose();
      layout.cleanup();
      dom.cleanup();
    }
  });
});
