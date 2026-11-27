import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { sentVsLive } from "../../test/sent-vs-live";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-empty-head.client";
import type { EmptyHeadCase } from "../../test/v2-empty-head.fixture";
import { measureV2Layout } from "./testing/measure-v2-layout";

// Never an empty top left (Valentin on Mail's administration, v9: "ganz oben links darf es nicht weiß sein"): a
// workspace head with only actions at its end stands as no row of its own. Its actions join the first pane's first
// row: the end of the pane's tabs, or beside the hero of a pane without a head. And no last line: the last part of a
// pane draws no line under itself ("die unterste Linie kann auch IMMER weg"). The fixture is
// test/v2-empty-head.client.tsx.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss = "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; }";
const widths = [390, 1440, 1920] as const;

let browser: Browser;
let client: string;
let server: (which: EmptyHeadCase) => { html: string; script: string };
const temp = mkdtempSync(resolve(tmpdir(), "k2-v2-empty-head-"));
beforeAll(async () => {
  const serverFile = resolve(temp, "server.js");
  await Bun.write(serverFile, await bundleV2Entry("v2-empty-head.server.tsx", "ssr"));
  ({ render: server } = await import(serverFile));
  [client, browser] = await Promise.all([bundleV2Entry("v2-empty-head.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
  rmSync(temp, { recursive: true, force: true });
});

/** `hydrate`: the page starts from what the server sent and keeps a copy of it (`window.__k2Sent`). */
const withPage = async (which: EmptyHeadCase, width: number, run: (page: Page) => Promise<void>, hydrate = false) => {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  const sent = hydrate ? server(which) : { html: "", script: "" };
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8">${sent.script}<style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root">${sent.html}</div></body></html>`,
    );
    await page.addScriptTag({ content: `window.__k2Case = ${JSON.stringify(which)}; window.__k2Hydrate = ${hydrate};` });
    if (hydrate)
      await page.evaluate(() => {
        window.__k2Sent = document.getElementById("root")!.cloneNode(true);
      });
    await page.addScriptTag({ content: client });
    await page.waitForFunction(() => window.__k2Mounted === true);
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

/** Where the head's actions and the first row stand, rounded to whole px. */
const shape = (page: Page) =>
  page.evaluate(() => {
    const shown = (element: Element) => element.getClientRects().length > 0;
    const box = (element: Element | null) => {
      if (!element) return null;
      const r = element.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) };
    };
    const middle = (element: Element | null) => {
      const r = element?.getBoundingClientRect();
      return r ? Math.round(r.top + r.height / 2) : null;
    };
    const search = [...document.querySelectorAll(".k2-input[data-search]")].find(shown) ?? null;
    const pane = document.querySelector(".k2-ws-main .k2-pane");
    const lead = document.querySelector(".k2-band > .k2-t-lead");
    // the hero's first line (on the phone the lead may take two)
    const words = document.createRange();
    if (lead) words.selectNodeContents(lead);
    const first = lead ? words.getClientRects()[0] : undefined;
    const nav = document.querySelector('.k2-pane > [data-slot="head"] > .k2-tabs-nav');
    const actions = search?.closest(".k2-bar") ?? null;
    // the hero's words beside the actions: none of them runs under them
    const under = [...document.querySelectorAll(".k2-band .k2-text")].filter((text) => {
      const a = actions?.getBoundingClientRect();
      const r = text.getBoundingClientRect();
      return !!a && r.right > a.left + 0.5 && r.top < a.bottom - 0.5 && r.bottom > a.top + 0.5;
    }).length;
    return {
      // bars that stand in the workspace's own head
      headBars: [...document.querySelectorAll('.k2-ws-main > [data-slot="head"] > .k2-bar')].filter(shown).length,
      search: middle(search),
      lead: first ? Math.round(first.top + first.height / 2) : null,
      tabs: middle(nav),
      paneTop: box(pane)?.top ?? null,
      bandTop: box(document.querySelector(".k2-band"))?.top ?? null,
      actions: box(actions),
      nav: box(nav),
      list: box(pane),
      under,
      // tabs that went into "Mehr"
      hiddenTabs: document.querySelectorAll(".k2-tab[data-overflow]").length,
    };
  });

/** The parts of each pane that draw a line on the bottom edge of the pane's content. */
const lastLines = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".k2-pane > .k2-scroll")].flatMap((scroll) => {
      const children = [...scroll.children].filter((child) => child.getClientRects().length > 0);
      const bottom = Math.max(...children.map((child) => child.getBoundingClientRect().bottom));
      return [...scroll.querySelectorAll("*")]
        .filter((element) => {
          const style = getComputedStyle(element);
          const drawn = Number.parseFloat(style.borderBottomWidth) > 0 && style.borderBottomColor !== "rgba(0, 0, 0, 0)";
          return drawn && Math.abs(element.getBoundingClientRect().bottom - bottom) < 1;
        })
        .map((element) => `${element.tagName.toLowerCase()}.${[...element.classList].join(".")}`);
    }),
  );

for (const width of widths) {
  test(`${width} px, a pane without a head: the head's actions stand beside the hero, no row of their own above it`, async () => {
    await withPage("hero", width, async (page) => {
      const found = await shape(page);
      expect(found.headBars).toBe(0);
      // the hero is the first row of the page, and the search stands on its first line
      expect(found.bandTop).toBe(found.paneTop);
      expect(Math.abs(found.search! - found.lead!)).toBeLessThanOrEqual(1);
      expect(found.under).toBe(0);
      expect(found.actions!.right).toBeLessThanOrEqual(found.list!.right);
    });
  });

  test(`${width} px, a pane with tabs: the head's actions stand at the end of the tabs' row`, async () => {
    await withPage("tabs", width, async (page) => {
      const found = await shape(page);
      expect(found.headBars).toBe(0);
      expect(found.search).toBe(found.tabs);
      // one row with one line under it: the actions' bar ends where the tabs end, inside the list's column
      expect(found.actions!.bottom).toBe(found.nav!.bottom);
      expect(found.actions!.right).toBeLessThanOrEqual(found.list!.right);
      // beside a list of 640 px the actions give way first (the search narrows), so the three tabs keep their place
      if (width > 390) expect(found.hiddenTabs).toBe(0);
    });
  });

  test(`${width} px, the last part of a pane draws no line under itself`, async () => {
    for (const which of ["hero", "tabs"] as const)
      await withPage(which, width, async (page) => {
        expect(await lastLines(page)).toEqual([]);
      });
  });
}

for (const which of ["hero", "tabs", "none"] as const)
  test(`hydration (${which}): the server already sends the head's actions in the first row, and the live page is what it sent`, async () => {
    await withPage(
      which,
      1440,
      async (page) => {
        expect(await page.evaluate(sentVsLive)).toEqual([]);
      },
      true,
    );
  });

test("a head with only an end that no pane takes stays, and the layout measure names its empty start", async () => {
  await withPage("none", 1440, async (page) => {
    expect((await shape(page)).headBars).toBe(1);
    const layout = await measureV2Layout(page, { root: ".k2-ws-main" });
    expect(layout.problems.filter((problem) => problem.includes("empty start"))).toHaveLength(1);
  });
});

test("the layout measure finds no empty start where the head's actions joined the first row", async () => {
  for (const which of ["hero", "tabs"] as const)
    await withPage(which, 1440, async (page) => {
      const layout = await measureV2Layout(page, { root: ".k2-ws-main" });
      expect(layout.problems.filter((problem) => problem.includes("empty start"))).toEqual([]);
    });
});
