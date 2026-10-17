import { describe, expect, mock, spyOn, test } from "bun:test";
import { onMount } from "solid-js";
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

describe("personal full-width bridge", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  const mountReadingSurface = async (stored: boolean) => {
    // Each harness owns a fresh document and cookie jar.
    const dom = createDomTestHarness();
    setFullWidth(stored);
    const { collectContextAwareCommands } = await import("@k2b/cloud/browser/testing");
    const { LocaleProvider, useLocale } = await import("@k2b/ui");
    const { notebookWorkspaceMessages } = await import("../messages");
    const { ViewMenu } = await import("./detail/ViewMenu");
    const { followFullWidth } = await import("./full-width");
    const media = window.matchMedia("(min-width: 64rem)");
    Object.defineProperty(media, "matches", { configurable: true, value: true });
    const matchMedia = spyOn(window, "matchMedia").mockReturnValue(media);
    const keepPosition = mock(() => null);
    function ReadingSurface() {
      const locale = useLocale();
      let port: HTMLDivElement | undefined;
      onMount(() => {
        if (!port) throw new Error("No reading surface.");
        followFullWidth(port, keepPosition, () => notebookWorkspaceMessages.resolve([locale()]).t);
      });
      return (
        <>
          <div class="notebook-document-surface">
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
    openView(dom.root);
    const surface = dom.root.querySelector<HTMLDivElement>(".notebook-document-surface");
    const toggle = dom.root.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]');
    if (!surface || !toggle) throw new Error("Missing full-width controls.");
    const command = () => collectContextAwareCommands().find((command) => command.id === "notebooks.view.fullWidth");
    return {
      surface,
      toggle,
      command,
      keepPosition,
      dispose,
      cleanup: () => {
        dispose();
        matchMedia.mockRestore();
        dom.cleanup();
      },
    };
  };

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

      view.dispose();
      setFullWidth(false);
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      expect(view.surface.hasAttribute("data-full-width")).toBe(true);
      expect(view.toggle.getAttribute("aria-checked") === "true").toBe(true);
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
    const media = window.matchMedia("(min-width: 64rem)");
    let wide = true;
    Object.defineProperty(media, "matches", { configurable: true, get: () => wide });
    const matchMedia = spyOn(window, "matchMedia").mockReturnValue(media);
    const removeMedia = spyOn(media, "removeEventListener");
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
      expect(matchMedia).toHaveBeenCalledWith("(min-width: 64rem)");
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

      wide = false;
      media.dispatchEvent(new Event("change"));
      expect(command()).toBeUndefined();
      wide = true;
      media.dispatchEvent(new Event("change"));
      expect(command()?.title).toBe("Volle Breite einschalten");

      dispose();
      disposed = true;
      expect(command()).toBeUndefined();
      expect(removeMedia).toHaveBeenCalledWith("change", expect.any(Function));
      changeFullWidth(true);
      expect(phases).toEqual([false, true, true, false]);
      expect(toggle.getAttribute("aria-checked") === "true").toBe(false);
    } finally {
      if (!disposed) dispose();
      removeMedia.mockRestore();
      matchMedia.mockRestore();
      dom.cleanup();
    }
  });
});
