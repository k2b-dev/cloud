import { describe, expect, spyOn, test } from "bun:test";
import { onMount } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import { FULL_WIDTH_PREFERENCE_EVENT } from "./detail/events";
import { readFullWidth } from "./settings/NotebookSettingsStore";

describe("personal full-width bridge", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  test("rewraps between capture and synchronous restore, follows commands and cleans up its listeners", async () => {
    const dom = createDomTestHarness();
    const { collectContextAwareCommands } = await import("@k2b/cloud/browser/testing");
    const { LocaleProvider, useLocale } = await import("@k2b/ui");
    const { notebookWorkspaceMessages } = await import("../messages");
    const { FullWidthSection } = await import("./detail/FullWidthSection");
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
          <FullWidthSection initial={false} />
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
      const toggle = dom.root.querySelector<HTMLInputElement>('input[role="switch"]')!;
      const command = () => collectContextAwareCommands().find((command) => command.id === "notebooks.view.fullWidth");
      expect(matchMedia).toHaveBeenCalledWith("(min-width: 64rem)");
      expect(command()?.title).toBe("Volle Breite einschalten");
      const action = command()?.action;
      if (typeof action !== "function") throw new Error("Expected a local command.");
      await action();
      expect(phases).toEqual([false, true]);
      expect(toggle.checked).toBe(true);
      expect(readFullWidth()).toBe(true);
      expect(command()?.title).toBe("Volle Breite ausschalten");

      // A repeated notification must not capture or restore a position that already matches.
      window.dispatchEvent(new Event(FULL_WIDTH_PREFERENCE_EVENT));
      expect(phases).toEqual([false, true]);
      changeFullWidth(false);
      expect(phases).toEqual([false, true, true, false]);
      expect(toggle.checked).toBe(false);
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
      expect(toggle.checked).toBe(false);
    } finally {
      if (!disposed) dispose();
      removeMedia.mockRestore();
      matchMedia.mockRestore();
      dom.cleanup();
    }
  });
});
