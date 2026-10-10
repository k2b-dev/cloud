import { expect, mock, spyOn, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

// A tab opened before a release asks for a search dialog chunk that the release removed.
mock.module("./GlobalSearchDialog", () => {
  throw new TypeError("Failed to fetch dynamically imported module: /_ssr/1/chunk-old.js");
});

const OPEN_TOAST = "[data-k2b-toast]:not([data-closing])";

test.skipIf(isServer)("search whose code cannot load offers a reload instead of asking to try again", async () => {
  const dom = createDomTestHarness();
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const [{ toast }, { createGlobalSearchHost }] = await Promise.all([import("@k2b/ui"), import("./global-search-host")]);
  const host = createGlobalSearchHost(() => []);
  try {
    host.open({});
    for (let attempt = 0; attempt < 100 && !dom.document.querySelector(OPEN_TOAST); attempt += 1) await Bun.sleep(5);
    const notices = Array.from(dom.document.querySelectorAll(OPEN_TOAST), (notice) => notice.textContent ?? "");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("Part of this page could not load.");
    expect(notices[0]).toContain("Reload");
    expect(notices[0]).not.toContain("Search is currently unavailable");
  } finally {
    host.dispose();
    toast.dismissAll();
    warn.mockRestore();
    dom.cleanup();
  }
});
