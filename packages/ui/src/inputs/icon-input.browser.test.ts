import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";

const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "icon-input.fixture.ts");
// A settings form column narrower than the picker needs, as in Notebooks.
const fixture = `
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { IconInput } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
render(() => createComponent(IconInput, { label: "Symbol", value: null, onValueChange: () => {} }), document.getElementById("field"));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the IconInput browser fixture.");
const script = await build.outputs[0]!.text();

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  browser = await launchBrowser();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const params = new URL(request.url).searchParams;
      // `place=end-low` puts the field at the right edge, low in the viewport.
      const field = params.get("place") === "end-low" ? "width:300px;margin:560px 0 0 auto" : "width:300px";
      return new Response(
        `<!doctype html><html lang="${params.get("lang") ?? "en"}"><head><title>Icon picker fixture</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="k2b-ui"><main style="padding:32px"><div id="field" style="${field}"></div></main></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    },
  });
}, 30_000);
afterAll(async () => {
  await browser?.close();
  await server?.stop(true);
});

const open = async (lang: "de" | "en", viewport: { width: number; height: number }, place = "start") => {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
  try {
    const page = await context.newPage();
    await page.goto(new URL(`/?lang=${lang}&place=${place}`, server.url).href);
    await page.addScriptTag({ content: script });
    await page.getByRole("combobox", { name: "Symbol" }).click();
    await page.locator(".k2b-choice-popover:popover-open").waitFor();
    await settled(page);
    return { page, close: () => context.close() };
  } catch (error) {
    await context.close();
    throw error;
  }
};

const geometry = (page: Page) =>
  page.evaluate(() => {
    const rect = (element: Element | null) => {
      const { left, right, top, bottom, width } = element!.getBoundingClientRect();
      return { left, right, top, bottom, width };
    };
    const popover = document.querySelector(".k2b-choice-popover:popover-open");
    return {
      viewport: document.documentElement.clientWidth,
      trigger: rect(document.querySelector(".k2b-choice-trigger")),
      popover: rect(popover),
      search: rect(popover!.querySelector(".k2b-choice-search")),
      groups: rect(popover!.querySelector(".k2b-choice-groups")),
      chips: Array.from(popover!.querySelectorAll(".k2b-choice-groups > button"), (chip) => ({ label: chip.textContent, ...rect(chip) })),
    };
  });
const labels = (page: Page) => page.locator("[role='option'] strong").allTextContents();

describe("IconInput picker", () => {
  test("opens wider than a narrow field, inside the viewport, with German labels", async () => {
    const { page, close } = await open("de", { width: 1280, height: 900 });
    try {
      const layout = await geometry(page);
      expect(layout.trigger.width).toBe(300);
      expect(layout.popover.width).toBeGreaterThanOrEqual(416);
      expect(layout.popover.left).toBeGreaterThanOrEqual(8);
      expect(layout.popover.right).toBeLessThanOrEqual(layout.viewport - 8);

      // The first chips sit fully inside the row; the rest scroll into it
      // without the popover cutting them off.
      expect(layout.chips.slice(0, 3).map((chip) => chip.label)).toEqual(["Alle", "Empfohlen", "Personen"]);
      for (const chip of layout.chips.slice(0, 3)) expect(chip.right).toBeLessThanOrEqual(layout.groups.right);
      expect(layout.groups.right).toBeLessThanOrEqual(layout.popover.right);
      await page.locator(".k2b-choice-groups > button").last().scrollIntoViewIfNeeded();
      const scrolled = await geometry(page);
      const last = scrolled.chips.at(-1)!;
      expect(last.label).toBe("Geräte");
      expect(last.right).toBeLessThanOrEqual(scrolled.groups.right + 0.5);
      expect(last.left).toBeGreaterThanOrEqual(scrolled.groups.left - 0.5);

      // The grid shows five columns of the recommended icons at a glance.
      const columns = await page.evaluate(
        () => getComputedStyle(document.querySelector(".k2b-choice-options")!).gridTemplateColumns.split(" ").length,
      );
      expect(columns).toBeGreaterThanOrEqual(5);
      expect(await labels(page)).toContain("Glocke");
      expect(await page.getByRole("searchbox").getAttribute("placeholder")).toBe("Suchen...");
    } finally {
      await close();
    }
  });

  test("searches every group without loose matches and without moving the picker", async () => {
    const { page, close } = await open("de", { width: 1280, height: 900 });
    try {
      const before = await geometry(page);
      await page.getByRole("searchbox").fill("gro");
      await settled(page);
      // "gro" is only the English keyword "group" of Freunde; the old fuzzy
      // match also found "warninG eRrOr" and "settinGs contROls".
      expect(await labels(page)).toEqual(["Freunde"]);
      expect(await page.getByRole("radio", { name: "Alle" }).getAttribute("aria-checked")).toBe("true");

      // German compounds and words outside "Empfohlen" are found.
      await page.getByRole("searchbox").fill("karte");
      await settled(page);
      expect(await labels(page)).toEqual(["Karte", "Kreditkarte"]);
      await page.getByRole("searchbox").fill("truck");
      expect(await labels(page)).toEqual(["Lastwagen"]);

      // A group chosen while searching narrows the results again.
      await page.getByRole("searchbox").fill("start");
      await page.getByRole("radio", { name: "Medien" }).click();
      await settled(page);
      expect(await labels(page)).toEqual(["Abspielen"]);
      await page.getByRole("radio", { name: "Alle" }).click();
      expect(await labels(page)).toEqual(["Abspielen", "Haus", "Rakete"]);
      await settled(page);

      const after = await geometry(page);
      expect(after.popover.left).toBe(before.popover.left);
      expect(after.popover.top).toBe(before.popover.top);
      expect(after.popover.width).toBe(before.popover.width);
      expect(after.search).toEqual(before.search);
      expect(after.groups).toEqual(before.groups);
    } finally {
      await close();
    }
  });

  test("shifts left at the right edge and keeps its place above a low field while filtering", async () => {
    const { page, close } = await open("de", { width: 1280, height: 800 }, "end-low");
    try {
      const before = await geometry(page);
      expect(before.trigger.right).toBeGreaterThan(1280 - 48);
      expect(before.popover.width).toBeGreaterThanOrEqual(416);
      expect(before.popover.right).toBeLessThanOrEqual(1280 - 8);
      expect(before.popover.left).toBeLessThan(before.trigger.left);
      expect(before.popover.bottom).toBeLessThanOrEqual(before.trigger.top);

      await page.getByRole("searchbox").fill("pizza");
      await settled(page);
      expect(await labels(page)).toEqual(["Pizza"]);
      const after = await geometry(page);
      expect(after.popover).toEqual(before.popover);
      expect(after.search).toEqual(before.search);
    } finally {
      await close();
    }
  });

  test("keeps the English catalogue under the English locale", async () => {
    const { page, close } = await open("en", { width: 1280, height: 900 });
    try {
      expect((await geometry(page)).chips.slice(0, 2).map((chip) => chip.label)).toEqual(["All", "Recommended"]);
      await page.getByRole("searchbox").fill("gro");
      expect(await labels(page)).toEqual(["Friends"]);
    } finally {
      await close();
    }
  });

  test("spans the phone width as a sheet under the field", async () => {
    const { page, close } = await open("de", { width: 390, height: 844 });
    try {
      const layout = await geometry(page);
      expect(layout.popover.left).toBe(8);
      expect(layout.popover.right).toBe(382);
      expect(layout.popover.top).toBeGreaterThan(layout.trigger.bottom);
    } finally {
      await close();
    }
  });
});
