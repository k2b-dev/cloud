import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { demoBundle, serverMarkup } from "../../test/v2-behavior/harness";
import type {} from "../../test/v2-head-search.demo";

// The search of a v2 head with `send` (test/v2-head-search.demo.tsx): without JavaScript the server's markup alone is a
// GET form, and Enter loads the list's page with `q` and the rest of the address; where JavaScript runs, `onSearch`
// searches in place and nothing loads. The field is the form itself, so the head's rules (its place at the end, the
// phone's fold) hold as for a plain search.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";
const origin = "http://search.test";

let browser: Browser;
let bundle: string;
let markup: string;
beforeAll(async () => {
  [bundle, markup, browser] = await Promise.all([demoBundle("../v2-head-search"), serverMarkup("../v2-head-search"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const page = (root: string) =>
  `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root">${root}</div></body></html>`;

/** Opens the list at `search`, with JavaScript (the island mounts) or without (the server's markup only). */
const withPage = async (
  search: string,
  run: (page: Page, loaded: string[]) => Promise<void>,
  { script = true, width = 1440 }: { script?: boolean; width?: number } = {},
) => {
  const context = await browser.newContext({ javaScriptEnabled: script, viewport: { width, height: 800 }, hasTouch: width < 768 });
  const tab = await context.newPage();
  tab.setDefaultTimeout(3000);
  const errors = pageErrors(tab);
  // every address the page loads, so a test sees whether Enter loaded one
  const loaded: string[] = [];
  await tab.route(`${origin}/**`, (route) => {
    const url = new URL(route.request().url());
    loaded.push(`${url.pathname}${url.search}`);
    return route.fulfill({ contentType: "text/html", body: page(script ? "" : markup) });
  });
  try {
    await tab.goto(`${origin}/gruppen${search}`);
    // without JavaScript nothing runs in the page, so there is nothing to wait for
    if (script) {
      await tab.addScriptTag({ content: bundle });
      await tab.waitForFunction(() => window.__mounted === true);
      await settled(tab);
    }
    await run(tab, loaded);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
};

const field = (tab: Page) => tab.getByRole("searchbox", { name: "Gruppen durchsuchen" });

test("the server's markup is a GET search form with the field's classes, the rest of the address hidden in it", () => {
  const form = markup.match(/<form[^>]*role="search"[^>]*>/)?.[0] ?? "";
  expect(form).toContain('method="get"');
  expect(form).toContain('action="/gruppen"');
  expect(form).toMatch(/class="k2-input\s*"/);
  expect(form).toContain("data-search");
  const kept = markup.match(/<input[^>]*type="hidden"[^>]*>/g) ?? [];
  expect(kept).toHaveLength(1);
  expect(kept[0]).toContain('name="level"');
  expect(kept[0]).toContain('value="error"');
  // the field's own name is not kept twice
  expect(markup.match(/name="q"/g)).toHaveLength(1);
});

test("without JavaScript, Enter loads the list's page with the text and the rest of the address", async () => {
  await withPage(
    "?level=error&q=Lager",
    async (tab, loaded) => {
      expect(await field(tab).inputValue()).toBe("Lager");
      await field(tab).fill("Vase");
      await field(tab).press("Enter");
      await tab.waitForURL(`${origin}/gruppen?level=error&q=Vase`);
      expect(loaded).toEqual(["/gruppen?level=error&q=Lager", "/gruppen?level=error&q=Vase"]);
    },
    { script: false },
  );
});

test("where JavaScript runs, onSearch takes Enter and the page searches in place; nothing loads", async () => {
  await withPage("?level=error&q=Lager", async (tab, loaded) => {
    await field(tab).fill("Vase");
    await field(tab).press("Enter");
    await tab.waitForFunction(() => window.__searched?.length === 1);
    expect(await tab.evaluate(() => window.__searched)).toEqual(["Vase"]);
    expect(await tab.getByText("Suche: Vase").count()).toBe(1);
    expect(loaded).toEqual(["/gruppen?level=error&q=Lager"]);
  });
});

test("without onSearch the form loads the page also where JavaScript runs", async () => {
  await withPage("?_load&level=error", async (tab) => {
    await field(tab).fill("Vase");
    await field(tab).press("Enter");
    await tab.waitForURL(`${origin}/gruppen?level=error&q=Vase`);
  });
});

test("the form stands where a plain search stands: at the end of the head, 36 px high; on the phone it folds to its symbol", async () => {
  await withPage("?level=error", async (tab) => {
    const place = await field(tab).evaluate((input) => {
      const form = input.parentElement!;
      return {
        tag: form.tagName,
        inEnd: form.parentElement?.matches('[data-slot="head"] > .k2-bar > .k2-bar-end') ?? false,
        height: form.getBoundingClientRect().height,
      };
    });
    expect(place).toEqual({ tag: "FORM", inEnd: true, height: 36 });
  });
  await withPage(
    "?level=error",
    async (tab) => {
      // folded: the symbol of 36 px; a tap opens it over the head, Escape folds it back and keeps the words
      const width = () => field(tab).evaluate((input) => input.parentElement!.getBoundingClientRect().width);
      expect(await width()).toBe(36);
      await field(tab).tap();
      await tab.waitForFunction(() => (document.activeElement?.parentElement?.getBoundingClientRect().width ?? 0) > 36);
      await field(tab).fill("Vase");
      await tab.keyboard.press("Escape");
      await tab.waitForFunction(() => document.activeElement?.tagName !== "INPUT");
      await settled(tab);
      expect(await width()).toBe(36);
      expect(await field(tab).inputValue()).toBe("Vase");
    },
    { width: 390 },
  );
});
