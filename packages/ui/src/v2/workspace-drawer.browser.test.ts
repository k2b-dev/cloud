import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Browser, Locator, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-drawer.fixture";
import { measureV2Layout } from "./testing";
import { textEdge } from "./tokens";

// The sidebar as a drawer (concept: "Schublade am Tablet"), on the page the server sent and after it came alive.
// The fixture is Mail's workspace in small: sidebar 248, list 320 to 432, a reader that keeps 400 and that the workspace
// declares. The sidebar stays a column while the workspace holds it at its default beside every column at its minimum,
// the declared reader counted also while it is closed: 248 + 1 + 320 + 1 + 400 = 970 px inside the workspace's edge.
// Mail's workspace at a window of 1024 px is 958 px wide, so there the sidebar is a drawer, with or without a message
// open: a click never moves the sidebar between column and drawer.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
// The workspace takes the window less the 66 px that Cloud's shell takes beside Mail (958 px at 1024).
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0 0 0 66px; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
let server: { html: string; script: string };
const temp = mkdtempSync(resolve(tmpdir(), "k2-v2-drawer-"));
beforeAll(async () => {
  const serverFile = resolve(temp, "server.js");
  await Bun.write(serverFile, await bundleV2Entry("v2-drawer.server.tsx", "ssr"));
  const { render }: { render: () => { html: string; script: string } } = await import(serverFile);
  server = render();
  [client, browser] = await Promise.all([bundleV2Entry("v2-drawer.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
  rmSync(temp, { recursive: true, force: true });
});

/**
 * The page as the server sent it; with `live` (the default) hydrated, which is stricter than an island of
 * `@k2b/ssr` (it renders again over the server's markup): a node the client would make differently fails here.
 */
const withPage = async (run: (page: Page) => Promise<void>, { width = 1024, live = true } = {}) => {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${server.script}<style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root">${server.html}</div></body></html>`,
    );
    if (live) {
      await page.addScriptTag({ content: client });
      await page.waitForFunction(() => window.__k2Hydrated === true);
    }
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

const box = async (locator: Locator) => {
  const found = await locator.boundingBox();
  if (!found) throw new Error("no box");
  return found;
};
const shown = (locator: Locator) => locator.evaluate((element) => element.getClientRects().length > 0);
const toggle = (page: Page) => page.getByRole("button", { name: "Seitenleiste zeigen" });
/** The button, also while it is hidden (a hidden button has no role a person can reach). */
const toggleElement = (page: Page) => page.locator(".k2-ws-toggle");
/** The places of the parts a person sees: the same on the server's page and on the live one. */
const places = (page: Page) =>
  page.evaluate(() =>
    [".k2-ws-side", ".k2-ws-toggle", ".k2-bar-start", 'section[aria-label="Liste"]', 'section[aria-label="Leser"]'].map((selector) => {
      const found = document.querySelector(selector)?.getBoundingClientRect();
      return found && found.width > 0 ? [Math.round(found.x), Math.round(found.width)] : null;
    }),
  );

for (const live of [false, true])
  test(`a window of 1024 px ${live ? "after the page came alive" : "as the server sent it"}: the sidebar is a drawer, the reader keeps 400 px`, async () => {
    await withPage(
      async (page) => {
        const workspace = await box(page.locator(".k2-ws"));
        expect(workspace.width).toBe(958);
        expect(await shown(page.locator(".k2-ws-side"))).toBe(false);
        // the button stands at the start of the head with its icon on the text edge; the head's content after it
        const button = await box(toggle(page));
        const icon = await box(toggle(page).locator(".k2-icon"));
        expect([button.width, button.height, icon.x - workspace.x]).toEqual([36, 36, 1 + textEdge.wide]);
        expect((await box(page.locator('[data-slot="head"] .k2-bar-start'))).x).toBe(button.x + button.width + 8);
        expect((await box(page.locator('section[aria-label="Leser"]'))).width).toBeGreaterThanOrEqual(400);
        expect((await box(page.locator('section[aria-label="Liste"]'))).width).toBeGreaterThanOrEqual(320);
        expect((await measureV2Layout(page, { root: ".k2-ws" })).problems).toEqual([]);
      },
      { live },
    );
  });

test("nothing moves when the page comes alive", async () => {
  let sent: Awaited<ReturnType<typeof places>> = [];
  await withPage(
    async (page) => {
      sent = await places(page);
    },
    { live: false },
  );
  await withPage(async (page) => {
    expect(await places(page)).toEqual(sent);
  });
});

test("the drawer: the sidebar from the start of the window; Escape closes it, focus returns, an entry closes it", async () => {
  await withPage(async (page) => {
    await toggle(page).click();
    const drawer = page.locator('[data-k2-part="Drawer"]');
    await drawer.waitFor();
    await settled(page);
    expect(await drawer.getAttribute("aria-label")).toBe("Seitenleiste");
    const found = await box(drawer);
    expect([found.x, found.y, found.width, found.height]).toEqual([0, 0, 248, 800]);
    expect(await drawer.locator('[data-k2-part="Nav"]').count()).toBe(1);
    expect(await page.evaluate(() => document.querySelector('[data-k2-part="Drawer"]')?.contains(document.activeElement))).toBe(true);
    expect(await shown(page.locator(".k2-backdrop"))).toBe(true);
    await page.keyboard.press("Escape");
    await drawer.waitFor({ state: "detached" });
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Seitenleiste zeigen");
    // an entry opens its page and closes the drawer
    await toggle(page).click();
    await drawer.waitFor();
    await drawer.getByRole("link", { name: "Gesendet" }).click();
    await drawer.waitFor({ state: "detached" });
    expect(await page.evaluate(() => location.hash)).toBe("#sent");
  });
});

test("a wide window: the sidebar is a column, no button; the drawer that is open closes when the window grows", async () => {
  await withPage(async (page) => {
    await toggle(page).click();
    await page.locator('[data-k2-part="Drawer"]').waitFor();
    // the focus is in the drawer when it closes: it goes to the column's current entry, not to the hidden button
    expect(await page.evaluate(() => document.querySelector('[data-k2-part="Drawer"]')?.contains(document.activeElement))).toBe(true);
    await page.setViewportSize({ width: 1440, height: 800 });
    await page.locator('[data-k2-part="Drawer"]').waitFor({ state: "detached" });
    await settled(page);
    await page.waitForFunction(() => document.activeElement?.closest(".k2-ws-side") !== null);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-current"))).toBe("page");
    expect((await box(page.locator(".k2-ws-side"))).width).toBe(248);
    expect(await shown(toggleElement(page))).toBe(false);
    const workspace = await box(page.locator(".k2-ws"));
    expect((await box(page.locator('[data-slot="head"] .k2-bar-start'))).x - workspace.x).toBe(248 + 1 + 1 + textEdge.wide);
    expect((await measureV2Layout(page, { root: ".k2-ws" })).problems).toEqual([]);
  });
});

// The declared detail keeps its place while it is closed: an empty state stands there, so opening or closing a message
// moves nothing, neither the sidebar nor the list, at a tablet's width and at a wide one.
for (const width of [1024, 1440])
  test(`at ${width} px opening and closing the reader moves nothing; while it is closed its place says so`, async () => {
    await withPage(
      async (page) => {
        const where = () =>
          page.evaluate(() =>
            [".k2-ws-side", ".k2-ws-toggle", 'section[aria-label="Liste"]', ".k2-split > .k2-seam .k2-grip"].map((selector) => {
              const found = document.querySelector(selector)?.getBoundingClientRect();
              return found && found.width > 0 ? [Math.round(found.x), Math.round(found.width)] : null;
            }),
          );
        const open = await where();
        await page.evaluate(() => window.__k2Reader?.(false));
        await settled(page);
        expect(await where()).toEqual(open);
        const empty = page.locator(".k2-split > [data-detail-empty]");
        expect(await empty.getAttribute("aria-label")).toBe("Keine Nachricht ausgewählt");
        expect(await empty.locator('[data-k2-part="Empty"]').textContent()).toContain("Keine Nachricht ausgewählt");
        expect((await box(empty)).width).toBeGreaterThanOrEqual(400);
        expect((await measureV2Layout(page, { root: ".k2-ws" })).problems).toEqual([]);
        await page.evaluate(() => window.__k2Reader?.(true));
        await settled(page);
        expect(await where()).toEqual(open);
        expect(await page.locator("[data-detail-empty]").count()).toBe(0);
      },
      { width },
    );
  });

// The sidebar stays a column while the workspace's content box holds 248 + 1 + 320 + 1 + 400 = 970 px: a window of
// 1038 px (the workspace 972 with its edge of 1 on both sides) keeps it, one of 1037 px makes it a drawer.
for (const [width, column] of [
  [1038, true],
  [1037, false],
] as const)
  test(`a window of ${width} px: the sidebar is ${column ? "a column" : "a drawer"}`, async () => {
    await withPage(
      async (page) => {
        expect(await shown(page.locator(".k2-ws-side"))).toBe(column);
        expect(await shown(toggleElement(page))).toBe(!column);
      },
      { width },
    );
  });

test("a button in the drawer that opens a dialog, a menu or a fold keeps the drawer open", async () => {
  await withPage(async (page) => {
    await toggle(page).click();
    const drawer = page.locator('[data-k2-part="Drawer"]');
    await drawer.waitFor();
    await drawer.locator('[data-k2-part="Nav"]').evaluate((nav) => {
      for (const [name, value] of [
        ["aria-haspopup", "dialog"],
        ["aria-expanded", "false"],
      ] as const) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = name;
        button.setAttribute(name, value);
        nav.append(button);
      }
    });
    for (const name of ["aria-haspopup", "aria-expanded"]) {
      await drawer.getByRole("button", { name }).click();
      await settled(page);
      expect(await drawer.count()).toBe(1);
    }
  });
});

test("a workspace without a detail keeps the sidebar as a column where it fits beside the list", async () => {
  await withPage(async (page) => {
    await page.evaluate(() => {
      window.__k2Reader?.(false);
      window.__k2Declare?.(false);
    });
    await settled(page);
    expect((await box(page.locator(".k2-ws-side"))).width).toBe(248);
    expect(await shown(toggleElement(page))).toBe(false);
  });
});

test("the phone keeps its pages: no sidebar, no drawer button, and no place of a closed reader", async () => {
  await withPage(
    async (page) => {
      expect(await shown(page.locator(".k2-ws-side"))).toBe(false);
      expect(await shown(toggleElement(page))).toBe(false);
      await page.evaluate(() => window.__k2Reader?.(false));
      await settled(page);
      // the list is the page: the place of the reader and the line before it are not shown
      expect(await shown(page.locator("[data-detail-empty]"))).toBe(false);
      expect(
        await page.locator(".k2-split > .k2-seam").evaluateAll((seams) => seams.filter((seam) => seam.getClientRects().length > 0).length),
      ).toBe(0);
    },
    { width: 390 },
  );
});
