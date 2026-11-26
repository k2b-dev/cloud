import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../../../ui/test/browser";

// Notebooks for a person without a notebook, on v2: the test answers the notebooks API itself (a new notebook, a
// notebook from a template) and records what the page asked.
const ui = `${resolve(import.meta.dir, "../../../../../ui")}/`;
const created: { path: string; body: unknown }[] = [];
// the next creation answers 201 with a body that is no JSON, as a proxy page or a cut connection would
const server = { garbled: false };
let httpServer: ReturnType<typeof Bun.serve>;
let browser: Browser;

beforeAll(async () => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "notebooks-start.browser-harness.tsx")],
    target: "browser",
    conditions: ["browser"],
    format: "esm",
    plugins: [
      {
        name: "solid-notebooks-start-test",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the start harness.");
  const bundle = await build.outputs[0]!.text();
  const sheet = async (entry: string) => {
    const output = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
    if (!output.success) throw new AggregateError(output.logs, `Could not compile ${entry}.`);
    return output.outputs[0]!.text();
  };
  // the shipped page-head order and cascade: Cloud, the app, then v2
  const css = [
    "@layer properties, theme, base, components, utilities;",
    await sheet(resolve(import.meta.dir, "../../../styles/app.css")),
    await sheet(resolve(import.meta.dir, "../../../../../../styles.css")),
    await Bun.file(fileURLToPath(import.meta.resolve("@k2b/ui/v2.css"))).text(),
  ].join("\n");
  httpServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/harness.js")
        return new Response(bundle, { headers: { "content-type": "application/javascript; charset=utf-8" } });
      if (/^\/(fonts\/)?[a-zA-Z0-9._-]+\.(woff2|css)$/.test(url.pathname))
        return new Response(Bun.file(resolve(ui, "dist", url.pathname.slice(1))));
      if (request.method === "POST" && (url.pathname === "/api/notebooks" || url.pathname.startsWith("/api/notebooks/templates/"))) {
        created.push({ path: url.pathname, body: await request.json() });
        if (server.garbled) return new Response("<html>gateway</html>", { status: 201, headers: { "content-type": "text/html" } });
        return Response.json({ id: url.pathname === "/api/notebooks" ? "newbook" : "fromtemplate" });
      }
      if (url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });
      if (url.pathname !== "/app/notebooks")
        return new Response("<!doctype html><title>opened</title>", { headers: { "content-type": "text/html" } });
      return new Response(
        `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/plex.css"><link rel="stylesheet" href="/tabler.css"><style>${css}</style></head><body class="k2b-ui" style="margin:0"><div id="root" class="k2-ui" style="position:fixed;inset:0;display:flex"></div><script type="module" src="/harness.js"></script></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  httpServer?.stop(true);
});

// every page's errors; opening the new notebook may cut the page's view transition short, which is no error of it
const errors: string[][] = [];
afterEach(() => {
  expect(
    errors
      .splice(0)
      .flat()
      .filter((message) => !message.includes("ViewTransition")),
  ).toEqual([]);
  created.length = 0;
  server.garbled = false;
});
const open = async (width = 1440): Promise<Page> => {
  const page = await browser.newPage({
    viewport: { width, height: width < 600 ? 844 : width < 1200 ? 768 : 900 },
    isMobile: width < 600,
    hasTouch: width < 1024,
  });
  errors.push(pageErrors(page));
  await page.goto(new URL("/app/notebooks", httpServer.url).href);
  await page.locator("[data-k2-workspace]").waitFor();
  await page.evaluate(() => document.fonts.ready);
  await settled(page);
  return page;
};
const plus = (page: Page) => page.getByRole("button", { name: "Neues Notizbuch" }).first();

for (const width of [1440, 1024, 390]) {
  test(`${width}: without a notebook the page is one sentence and the one +, a clean v2 workspace`, async () => {
    const page = await open(width);
    try {
      const outline = await describeV2Page(page, "#root");
      expect(outline.includes("Problems (") ? outline : "").toBe("");
      expect((await measureV2Layout(page, { root: "[data-k2-workspace]" })).problems).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      // the one way to the first notebook is the head's "+", which the phone keeps too
      expect(await plus(page).isVisible()).toBe(true);
      expect((await page.locator('[data-k2-part="Empty"]').textContent())?.trim()).toBe("Noch keine Notizbücher.");
      expect(await page.locator('[data-k2-part="Empty"] button').count()).toBe(0);
    } finally {
      await page.close();
    }
  }, 60_000);
}

test("the one + makes a blank notebook after asking its name, and opens it", async () => {
  const page = await open();
  try {
    await plus(page).click();
    await page.getByRole("menuitem", { name: /Leeres Notizbuch/ }).click();
    const dialog = page.getByRole("dialog", { name: "Neues Notizbuch" });
    await dialog.waitFor();
    // without a name nothing is made
    await dialog.getByRole("button", { name: "Erstellen" }).click();
    await dialog.getByText("Gib dem Notizbuch einen Namen.").waitFor();
    expect(created).toEqual([]);
    await dialog.getByRole("textbox", { name: "Name" }).fill("Inventur 2027");
    await dialog.getByRole("button", { name: "Erstellen" }).click();
    await page.waitForURL((url) => url.pathname === "/app/notebooks/newbook");
    expect(created).toEqual([{ path: "/api/notebooks", body: { name: "Inventur 2027" } }]);
  } finally {
    await page.close();
  }
}, 60_000);

test("the one + makes a notebook from a template, under the template's name when none is given", async () => {
  const page = await open();
  try {
    await plus(page).click();
    await page.getByRole("menuitem", { name: /Besprechungen/ }).click();
    const dialog = page.getByRole("dialog", { name: "Besprechungen" });
    await dialog.getByRole("button", { name: "Erstellen" }).click();
    await page.waitForURL((url) => url.pathname === "/app/notebooks/fromtemplate");
    expect(created).toEqual([{ path: "/api/notebooks/templates/meeting", body: {} }]);
  } finally {
    await page.close();
  }
}, 60_000);

test("an answer that is no notebook says so in the dialog, which stays usable and closes", async () => {
  const page = await open();
  try {
    server.garbled = true;
    await plus(page).click();
    await page.getByRole("menuitem", { name: /Besprechungen/ }).click();
    const dialog = page.getByRole("dialog", { name: "Besprechungen" });
    await dialog.getByRole("button", { name: "Erstellen" }).click();
    await dialog.getByText("Das Notizbuch konnte nicht aus der Vorlage erstellt werden").waitFor();
    expect(new URL(page.url()).pathname).toBe("/app/notebooks");
    await dialog.getByRole("button", { name: "Abbrechen" }).click();
    await dialog.waitFor({ state: "hidden" });
  } finally {
    await page.close();
  }
}, 60_000);
