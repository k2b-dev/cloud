import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { launchBrowser, pageErrors, settled } from "../../../../packages/ui/test/browser";
import { registerSsrTestPlugin } from "../../../../packages/ui/test/ssr-test-plugin";

// The UI topic pages in a browser, from the real server: every recipe and each of its states stands live on its own
// route, and the Example on topic 2 switches state, width and code without moving the page.
type Browser = Awaited<ReturnType<typeof launchBrowser>>;
type Page = Awaited<ReturnType<Browser["newPage"]>>;

registerSsrTestPlugin(await import("../../ssr"));
await (await import("../../build-assets")).buildAssets();
const { recipeNames, recipeStates } = await import("./recipes");
const { default: app } = await import("../../server");

let browser: Browser | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let origin: string;
beforeAll(async () => {
  browser = await launchBrowser();
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => app.fetch(request) });
  origin = `http://127.0.0.1:${server.port}`;
}, 120_000);
afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    server?.stop(true);
  }
});

const open = async (path: string, width = 1440) => {
  const page: Page = await browser!.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  const errors = pageErrors(page);
  await page.goto(`${origin}${path}`, { waitUntil: "networkidle" });
  return { page, errors };
};

describe("recipe route", () => {
  for (const name of recipeNames)
    for (const state of ["", ...Object.keys(recipeStates(name))])
      test(`${name}${state ? ` · ${state}` : ""} hydrates and stands ready`, async () => {
        const { page, errors } = await open(`/en/ui/v2/recipe/${name}${state ? `?state=${state}` : ""}`);
        try {
          await page.waitForSelector(".ui-v2-recipe[data-recipe='ready']", { timeout: 10_000 });
          expect(await page.locator("[data-k2-workspace]").count()).toBe(1);
          expect(errors).toEqual([]);
        } finally {
          await page.close();
        }
      }, 30_000);

  test("an unknown recipe or state is not found", async () => {
    expect((await fetch(`${origin}/en/ui/v2/recipe/nothing`)).status).toBe(404);
    expect((await fetch(`${origin}/en/ui/v2/recipe/table?state=nothing`)).status).toBe(404);
  });
});

describe("Example on Lists and tables", () => {
  test("switches state, width and code, and its frame never moves the page", async () => {
    const { page, errors } = await open("/en/ui/v2/lists-and-tables");
    try {
      const example = page.locator("figure.ui-example#table");
      await page.locator("figure.ui-example#table[data-measured]").waitFor();
      await settled(page);
      const stage = example.locator(".ui-example__stage");
      const before = await stage.boundingBox();
      const below = await page.locator("figure.ui-example#list-detail").boundingBox();

      // the state: the frame loads the recipe's state, and the stage keeps its size
      await example.getByRole("radio", { name: "Empty" }).click();
      const frame = example.locator("iframe");
      expect(await frame.getAttribute("src")).toBe("/en/ui/v2/recipe/table?state=empty");
      const inside = page.frameLocator("figure.ui-example#table iframe");
      await inside.locator(".ui-v2-recipe[data-recipe='ready']").waitFor();
      await settled(page);
      expect(await inside.locator("[data-k2-part='Empty']").count()).toBe(1);
      expect(await stage.boundingBox()).toEqual(before);
      expect(await page.locator("figure.ui-example#list-detail").boundingBox()).toEqual(below);

      // the width: 390 stands 1:1 as a phone
      await example.getByRole("radio", { name: "390" }).click();
      await page.locator("figure.ui-example#table[data-phone]").waitFor();
      await settled(page);
      const phone = await frame.boundingBox();
      expect(Math.round(phone?.width ?? 0)).toBe(390);

      // the code: the whole recipe with its states
      await example.getByRole("radio", { name: "Code" }).click();
      expect(await stage.isHidden()).toBe(true);
      expect(await example.locator(".ui-example__code").innerText()).toContain("export const states");

      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  test("a phone page shows the phone width from the start", async () => {
    const { page, errors } = await open("/en/ui/v2/lists-and-tables", 390);
    try {
      const example = page.locator("figure.ui-example#table");
      await page.locator("figure.ui-example#table[data-measured]").waitFor();
      await settled(page);
      expect(await example.getByRole("radio", { name: "390" }).getAttribute("aria-checked")).toBe("true");
      const frame = await example.locator("iframe").boundingBox();
      const figure = await example.boundingBox();
      expect((frame?.width ?? 0) <= (figure?.width ?? 0) + 1).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);
});

describe("navigation", () => {
  test("v1 is folded on a v2 page and open on a v1 page", async () => {
    const v2 = await (await fetch(`${origin}/en/ui/v2/lists-and-tables`)).text();
    const v1 = await (await fetch(`${origin}/en/ui/layout/workspace`)).text();
    const opened = (html: string) => /<details class="group" open>\s*<summary[^>]*>\s*v1 \(existing\)/.test(html);
    expect(opened(v2)).toBe(false);
    expect(v2).toContain("v1 (existing)");
    expect(opened(v1)).toBe(true);
    expect(v1).toContain("New screens use <code>@k2b/ui/v2</code>");
  });
});
