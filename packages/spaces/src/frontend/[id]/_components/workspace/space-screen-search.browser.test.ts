import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Page } from "playwright";
import { launchHookMs, settled } from "../../../../../../ui/test/browser";
import { createScreenBrowser, wide } from "../../../../../test/v2-screen-browser";
import { spaceOpener } from "./space-screen.browser-open";
import { spaceScreenProps } from "./space-screen.fixture";

// The search in a Space's head on v2, as main's list search (v1's list-search behaviour test): while a search loads,
// the box keeps the focus and the list its last rows; an older answer never replaces a newer search; Back and forward
// bring back the words and the rows of their entry. The test's server searches the titles of the usual Space.
const screen = createScreenBrowser(resolve(import.meta.dir, "space-screen.browser-harness.tsx"));
beforeAll(screen.start, launchHookMs);
afterAll(screen.stop);
const open = spaceOpener(screen);

const items = spaceScreenProps("/app/spaces/Space1").state.itemsResult.items;
const found = (words: string) => items.filter((item) => item.title.toLowerCase().includes(words)).map((item) => item.id);
/** Answers a list load that searches with the matching items; `hold` keeps the answer for one search back. */
const searching = (hold?: string) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const loads: string[] = [];
  return {
    release,
    loads,
    api: async (url: URL) => {
      if (url.pathname !== "/api/spaces/workspace/view") return undefined;
      loads.push(url.searchParams.get("href") ?? "");
      const href = new URL(url.searchParams.get("href") ?? "/", "http://spaces.local");
      const words = href.searchParams.get("q");
      if (!words) return undefined;
      if (words === hold) await held;
      const shown = items.filter((item) => found(words).includes(item.id));
      return { kind: "list", currentView: "list", itemsResult: { items: shown, page: 1, pageSize: 50, total: shown.length, totalPages: 1 } };
    },
  };
};
const rows = (tab: Page) =>
  tab
    .locator('[data-k2-workspace] [data-k2-part="Pane"]:not([data-detail]) a[href*="item="]')
    .evaluateAll((links) => [...new Set(links.map((link) => new URL((link as HTMLAnchorElement).href).searchParams.get("item")))]);
const box = (tab: Page) => tab.getByRole("searchbox", { name: "Search items" });
const search = async (tab: Page, words: string) => {
  await box(tab).fill(words);
  await box(tab).press("Enter");
};
const all = items.map((item) => item.id);

describe("the search of a Space on v2", () => {
  test("while a search loads, the box keeps the focus and the list its last rows, without a loading state", async () => {
    const server = searching("shelf");
    const { context, tab, errors } = await open(wide, "/app/spaces/Space1?view=list&groupBy=none", "usual", { api: server.api });
    try {
      expect(await rows(tab)).toEqual(all);
      await search(tab, "shelf");
      await settled(tab);
      expect(await box(tab).evaluate((input) => input === document.activeElement)).toBe(true);
      expect(await rows(tab)).toEqual(all);
      expect(await tab.locator('[data-k2-part="Loading"]').count()).toBe(0);
      server.release();
      await tab.waitForURL(/q=shelf/);
      await settled(tab);
      expect(await rows(tab)).toEqual(found("shelf"));
      expect(await box(tab).evaluate((input) => input === document.activeElement)).toBe(true);
      expect(await box(tab).inputValue()).toBe("shelf");
      expect(errors).toEqual([]);
    } finally {
      server.release();
      await context.close();
    }
  }, 60_000);

  test("an older search that answers late never replaces the newer one", async () => {
    const server = searching("shelf");
    const { context, tab, errors } = await open(wide, "/app/spaces/Space1?view=list&groupBy=none", "usual", { api: server.api });
    try {
      await search(tab, "shelf");
      await search(tab, "film");
      await tab.waitForURL(/q=film/);
      await settled(tab);
      expect(await rows(tab)).toEqual(found("film"));
      server.release();
      await settled(tab);
      await tab.waitForTimeout(200);
      expect(await rows(tab)).toEqual(found("film"));
      expect(new URL(tab.url()).searchParams.get("q")).toBe("film");
      expect(await box(tab).inputValue()).toBe("film");
      expect(errors).toEqual([]);
    } finally {
      server.release();
      await context.close();
    }
  }, 60_000);

  test("Back and forward bring back the words in the box and the rows of their entry", async () => {
    const server = searching();
    const { context, tab, errors } = await open(wide, "/app/spaces/Space1?view=list&groupBy=none", "usual", { api: server.api });
    try {
      // An open item is an entry of its own; the search then changes that entry.
      await tab.locator('a[href*="item=Item06"]').first().click();
      await tab.waitForURL(/item=Item06/);
      await search(tab, "shelf");
      await tab.waitForURL(/q=shelf/);
      await settled(tab);
      expect(await rows(tab)).toEqual(found("shelf"));
      await tab.goBack();
      await tab.waitForFunction(() => !new URL(location.href).searchParams.has("q"));
      await settled(tab);
      expect(await rows(tab)).toEqual(all);
      expect(await box(tab).inputValue()).toBe("");
      await tab.goForward();
      await tab.waitForURL(/q=shelf/);
      await settled(tab);
      expect(await rows(tab)).toEqual(found("shelf"));
      expect(await box(tab).inputValue()).toBe("shelf");
      // Words typed and not searched yet give way to the entry's, and nothing searches for them.
      const loads = server.loads.length;
      await box(tab).fill("unsent");
      await tab.goBack();
      await tab.waitForFunction(() => !new URL(location.href).searchParams.has("q"));
      await settled(tab);
      expect(await box(tab).inputValue()).toBe("");
      expect(server.loads.slice(loads).filter((href) => href.includes("unsent"))).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);
});
