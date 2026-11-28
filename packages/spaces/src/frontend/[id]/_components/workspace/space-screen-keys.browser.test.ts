import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Page } from "playwright";
import { launchHookMs, settled } from "../../../../../../ui/test/browser";
import { createScreenBrowser, phone, wide } from "../../../../../test/v2-screen-browser";
import { spaceOpener } from "./space-screen.browser-open";
import { spaceScreenProps } from "./space-screen.fixture";

// J and K step through the rows of a Space's list, table and board while an item is open, as on main (v1's
// workspace-step suite): the address names the item and the step replaces it, the focus follows the step, a field
// keeps its letters, and the calendar leaves the keys to itself. The harness runs the page's commands by their keys,
// as the Cloud shell does.
const screen = createScreenBrowser(resolve(import.meta.dir, "space-screen.browser-harness.tsx"));
beforeAll(screen.start, launchHookMs);
afterAll(screen.stop);
const open = spaceOpener(screen);

const list = "/app/spaces/Space1?view=list&groupBy=none";
const table = "/app/spaces/Space1?view=table";
const detail = (tab: Page) => tab.locator('[data-k2-part="Pane"][data-detail]');
/** The rows' links in the order the view shows them. */
const rowIds = (tab: Page) =>
  tab
    .locator('[data-k2-workspace] [data-k2-part="Pane"]:not([data-detail]) a[href*="item="]')
    .evaluateAll((links) => [...new Set(links.map((link) => new URL((link as HTMLAnchorElement).href).searchParams.get("item")!))]);
const row = (tab: Page, id: string) =>
  tab.locator(`[data-k2-workspace] [data-k2-part="Pane"]:not([data-detail]) a[href*="item=${id}"]`).first();
/** The item the address names once its detail shows its title. */
const selected = async (tab: Page, id: string, title: string) => {
  await tab.waitForFunction((item) => new URL(location.href).searchParams.get("item") === item, id);
  await detail(tab).locator('[data-slot="head"]').getByText(title, { exact: true }).waitFor();
};
/** The title of an item of the usual Space, as its detail names it. */
const titleOf = (id: string) => spaceScreenProps("/app/spaces/Space1").state.itemsResult.items.find((item) => item.id === id)?.title ?? "";
/** Presses a key and says whether a step asked to open another item. */
const stepped = async (tab: Page, key: "j" | "k") => {
  await tab.evaluate(() => {
    document.documentElement.removeAttribute("data-test-step");
    window.addEventListener("spaces-detail-navigation", () => document.documentElement.setAttribute("data-test-step", ""), {
      once: true,
    });
  });
  await tab.keyboard.press(key);
  await settled(tab);
  return tab.evaluate(() => document.documentElement.hasAttribute("data-test-step"));
};
/** What has the focus: the link of a row, the detail's title, or something else. */
const focused = (tab: Page) =>
  tab.evaluate(() => {
    const active = document.activeElement;
    if (!active || active === document.body) return "nothing";
    if (active.matches('[data-k2-part="Pane"][data-detail] > [data-slot="head"] [data-k2-part="Text"]'))
      return `title: ${active.textContent}`;
    const link = active.closest("a");
    return link ? `row: ${new URL(link.href).searchParams.get("item")}` : `${active.tagName}`;
  });
/** Answers `/detail` of one item only once `release` is called. */
const holdDetail = (id: string) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release,
    api: async (url: URL) => {
      if (url.pathname.endsWith(`/items/${id}/detail`)) await held;
      return undefined;
    },
  };
};

describe("J and K in a Space on v2", () => {
  for (const address of [list, table])
    test(`${address.split("?")[1]}: J and K follow the rows, replace the address, keep the focus on the row, and stop at the ends`, async () => {
      const { context, tab, errors } = await open(wide, address);
      try {
        const ids = await rowIds(tab);
        const [first, second] = [ids[0]!, ids[1]!];
        const last = ids.at(-1)!;
        await row(tab, first).click();
        await selected(tab, first, titleOf(first));
        const entries = await tab.evaluate(() => history.length);
        expect(await stepped(tab, "j")).toBe(true);
        await selected(tab, second, titleOf(second));
        expect(await tab.evaluate(() => history.length)).toBe(entries);
        expect(await focused(tab)).toBe(`row: ${second}`);
        expect(await stepped(tab, "k")).toBe(true);
        await selected(tab, first, titleOf(first));
        // The first row has nothing before it, and the last nothing after it: no wrap.
        expect(await stepped(tab, "k")).toBe(false);
        expect(new URL(tab.url()).searchParams.get("item")).toBe(first);
        await row(tab, last).click();
        await selected(tab, last, titleOf(last));
        expect(await stepped(tab, "j")).toBe(false);
        expect(new URL(tab.url()).searchParams.get("item")).toBe(last);
        // Back leaves the detail instead of replaying every step.
        await tab.goBack();
        await selected(tab, first, titleOf(first));
        await tab.goBack();
        await tab.waitForFunction(() => !new URL(location.href).searchParams.has("item"));
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }, 60_000);

  test("a rapid J J before the next item has loaded lands on the third row", async () => {
    const hold = holdDetail("Item02");
    const { context, tab, errors } = await open(wide, list, "usual", { api: hold.api });
    try {
      await row(tab, "Item01").click();
      await selected(tab, "Item01", "Clear out shelf B");
      // The second step starts from the item the first asked for, not from the one still shown.
      await tab.keyboard.press("j");
      await tab.keyboard.press("j");
      hold.release();
      await selected(tab, "Item03", "Agree on the route plan for week 43");
      expect(await focused(tab)).toBe("row: Item03");
      expect(errors).toEqual([]);
    } finally {
      hold.release();
      await context.close();
    }
  }, 60_000);

  test("a rapid J J from the detail's title keeps the focus on the title of the item it lands on", async () => {
    const hold = holdDetail("Item02");
    const { context, tab, errors } = await open(wide, list, "usual", { api: hold.api });
    try {
      await row(tab, "Item01").click();
      await selected(tab, "Item01", "Clear out shelf B");
      await detail(tab)
        .locator('[data-slot="head"] [data-k2-part="Text"]')
        .evaluate((title: HTMLElement) => {
          title.tabIndex = -1;
          title.focus();
        });
      // The first step swaps the detail to its loading state, which takes the focused title away.
      await tab.keyboard.press("j");
      await tab.keyboard.press("j");
      hold.release();
      await selected(tab, "Item03", "Agree on the route plan for week 43");
      await settled(tab);
      expect(await focused(tab)).toBe("title: Agree on the route plan for week 43");
      expect(errors).toEqual([]);
    } finally {
      hold.release();
      await context.close();
    }
  }, 60_000);

  test("j typed in the detail's comment field stays text", async () => {
    const { context, tab, errors } = await open(wide, list);
    try {
      await row(tab, "Item01").click();
      await selected(tab, "Item01", "Clear out shelf B");
      expect(await stepped(tab, "j")).toBe(true);
      await selected(tab, "Item02", "Ask the film supplier for a quote");
      const field = detail(tab).getByRole("textbox", { name: "Add comment" });
      await field.click();
      expect(await stepped(tab, "j")).toBe(false);
      expect(await field.inputValue()).toBe("j");
      expect(new URL(tab.url()).searchParams.get("item")).toBe("Item02");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("the calendar leaves J and K to itself while an item is open", async () => {
    const { context, tab, errors } = await open(wide, "/app/spaces/Space1?view=calendar&cv=week&cd=2026-10-15&item=Item06");
    try {
      await detail(tab).locator('[data-slot="head"]').getByText("Team meeting", { exact: true }).waitFor();
      const commands = await tab.evaluate(() => {
        const found = { commands: [] as { id: string; shortcut?: string }[] };
        window.dispatchEvent(new CustomEvent("cloud.command.collect", { detail: found }));
        return found.commands.filter((command) => command.shortcut === "j" || command.shortcut === "k").map((command) => command.id);
      });
      expect(commands.sort()).toEqual(["calendar.next", "calendar.previous"]);
      expect(await stepped(tab, "j")).toBe(false);
      expect(new URL(tab.url()).searchParams.get("item")).toBe("Item06");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("J from a row at the bottom of the list scrolls the next row into view and gives it the focus", async () => {
    const { context, tab, errors } = await open({ ...wide, height: 600 }, list, "huge");
    try {
      const ids = await rowIds(tab);
      const opening = ids[12]!;
      const next = ids[13]!;
      // The opening row ends the list's scrollport, so the next one is out of view before the step.
      await row(tab, opening).evaluate((link) => link.scrollIntoView({ block: "end" }));
      await row(tab, opening).click();
      await tab.waitForURL(new RegExp(`item=${opening}`));
      await settled(tab);
      expect(await inView(tab, next)).toBe(false);
      expect(await stepped(tab, "j")).toBe(true);
      await tab.waitForURL(new RegExp(`item=${next}`));
      expect(await inView(tab, next)).toBe(true);
      expect(await focused(tab)).toBe(`row: ${next}`);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("on the phone the open item takes the focus on its title, J goes on, and Back shows and focuses the row it went to", async () => {
    const { context, tab, errors } = await open(phone, list, "huge");
    try {
      const ids = await rowIds(tab);
      await row(tab, ids[2]!).focus();
      await tab.keyboard.press("Enter");
      await tab.waitForURL(new RegExp(`item=${ids[2]}`));
      await settled(tab);
      // The row gives way to the open item, so the focus does not stay with it.
      expect(await focused(tab)).toBe(`title: ${await detail(tab).locator('[data-slot="head"] [data-k2-part="Text"]').textContent()}`);
      for (let step = 0; step < 20; step++) {
        await tab.keyboard.press("j");
        await tab.waitForURL(new RegExp(`item=${ids[3 + step]}`));
      }
      await settled(tab);
      const shown = ids[22]!;
      expect(await focused(tab)).toBe(`title: ${await detail(tab).locator('[data-slot="head"] [data-k2-part="Text"]').textContent()}`);
      await tab.locator('[data-k2-part="Back"] a').click();
      await tab.waitForFunction(() => !location.search.includes("item="));
      await settled(tab);
      expect(await focused(tab)).toBe(`row: ${shown}`);
      expect(await inView(tab, shown)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);
});

/** Whether the row's link lies inside the list's scrolling pane. */
const inView = (tab: Page, id: string) =>
  row(tab, id).evaluate((link) => {
    const pane = link.closest('[data-k2-part="Pane"]')!;
    const scroller = [pane, ...pane.querySelectorAll("*")].find(
      (element) => element.scrollHeight > element.clientHeight + 1 && getComputedStyle(element).overflowY !== "visible",
    );
    const box = link.getBoundingClientRect();
    const bounds = (scroller ?? pane).getBoundingClientRect();
    return box.top >= bounds.top - 1 && box.bottom <= Math.min(bounds.bottom, innerHeight) + 1;
  });
