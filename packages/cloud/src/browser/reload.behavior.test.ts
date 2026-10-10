import { expect, spyOn, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

const OPEN_TOAST = "[data-k2b-toast]:not([data-closing])";

const load = async () => {
  const dom = createDomTestHarness();
  try {
    return { ui: await import("@k2b/ui"), reload: await import("./reload") };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();

/** What a browser reports for a chunk that a release removed after the page loaded. */
const missingChunk = () => Promise.reject(new TypeError("Failed to fetch dynamically imported module: /_ssr/1/chunk-old.js"));

if (isServer) test.skip("requires browser conditions", () => {});
else {
  test("passes the loaded code through without a notice", async () => {
    const { ui, reload } = modules!;
    const dom = createDomTestHarness();
    try {
      const code = { openDialog: () => "opened" };
      expect(await reload.importOnDemand(async () => code)).toBe(code);
      expect(dom.document.querySelector(OPEN_TOAST)).toBeNull();
    } finally {
      ui.toast.dismissAll();
      dom.cleanup();
    }
  });

  test("code that cannot load ends the action and offers one reload in the page's language", async () => {
    const { ui, reload } = modules!;
    const dom = createDomTestHarness();
    dom.document.documentElement.lang = "de";
    let reloads = 0;
    Object.assign(dom.window.location, {
      reload: () => {
        reloads += 1;
      },
    });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await reload.importOnDemand(missingChunk)).toBeUndefined();
      expect(await reload.importOnDemand(missingChunk)).toBeUndefined();
      // Every failure has the same remedy, so a second one replaces the first notice.
      const notices = dom.document.querySelectorAll<HTMLElement>(OPEN_TOAST);
      expect(notices).toHaveLength(1);
      expect(notices[0]!.textContent).toContain("Ein Teil dieser Seite konnte nicht geladen werden.");
      const action = notices[0]!.querySelector<HTMLButtonElement>(".k2b-toast__action")!;
      expect(action.textContent).toBe("Neu laden");
      action.click();
      expect(reloads).toBe(1);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
      ui.toast.dismissAll();
      dom.cleanup();
    }
  });
}
