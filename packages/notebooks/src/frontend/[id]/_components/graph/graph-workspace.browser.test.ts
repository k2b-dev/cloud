import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../../../../../ui/test/browser";
import { HANDBOOK_IDS } from "./graph.fixtures";

const ui = `${resolve(import.meta.dir, "../../../../../../ui")}/`;
let server: ReturnType<typeof Bun.serve>;
let browser: Browser;
beforeAll(async () => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "graph-workspace.browser-harness.tsx")],
    target: "browser",
    conditions: ["browser"],
    format: "esm",
    plugins: [
      {
        name: "solid-graph-workspace-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the graph workspace harness.");
  const bundle = await build.outputs[0]!.text();
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", `${resolve(import.meta.dir, "../../../../../../cloud")}/`)))
    .default;
  const sheet = async (entry: string) => {
    const output = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
    if (!output.success) throw new AggregateError(output.logs, `Could not compile ${entry}.`);
    return output.outputs[0]!.text();
  };
  // the shipped page-head order and cascade: Cloud, the app, then v2
  const css = [
    "@layer properties, theme, base, components, utilities;",
    await sheet(resolve(import.meta.dir, "../../../../styles/app.css")),
    await sheet(resolve(import.meta.dir, "../../../../../../../styles.css")),
    await Bun.file(fileURLToPath(import.meta.resolve("@k2b/ui/v2.css"))).text(),
  ].join("\n");
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/harness.js")
        return new Response(bundle, { headers: { "content-type": "application/javascript; charset=utf-8" } });
      if (/^\/(fonts\/)?[a-zA-Z0-9._-]+\.(woff2|css)$/.test(url.pathname))
        return new Response(Bun.file(resolve(ui, "dist", url.pathname.slice(1))));
      if (url.pathname.startsWith("/api/")) return new Response("Unavailable", { status: 503 });
      // a note opens as a plain page, so opening and Back are real navigations
      if (/^\/app\/notebooks\/\w{6}\/notes\/\w{6}$/.test(url.pathname) && url.searchParams.get("mode") !== "graph")
        return new Response('<!doctype html><html><body><h1 id="note-page">Note</h1></body></html>', {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      return new Response(
        `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/plex.css"><link rel="stylesheet" href="/tabler.css"><style>${css}</style></head><body class="k2b-ui" style="margin:0;--app-accent:#eab308"><div id="root" class="k2-ui" style="position:fixed;inset:0;display:flex"></div><script type="module" src="/harness.js"></script></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

const errors: string[] = [];
afterEach(() => {
  expect(errors.splice(0)).toEqual([]);
});
const open = async (path: string, width = 1440) => {
  const page = await browser.newPage({
    viewport: { width, height: width < 600 ? 844 : 900 },
    isMobile: width < 600,
    hasTouch: width < 1024,
  });
  // an error in the page fails the test that opened it, with its message
  // (a view transition that a navigation away cuts short is the browser's, not the page's)
  page.on("pageerror", (error) => {
    if (!error.message.includes("ViewTransition")) errors.push(error.message);
  });
  await page.goto(new URL(path, server.url).href);
  await page.locator("[data-k2-workspace]").waitFor();
  await page.evaluate(() => document.fonts.ready);
  return page;
};
const param = (page: Page, name: string) => new URL(page.url()).searchParams.get(name);
const handbook = `/app/notebooks/hand01/notes/${HANDBOOK_IDS.wein}?mode=graph`;

for (const width of [1440, 390]) {
  test(`${width}: the graph is a clean v2 workspace with its views, filters and the display in a Canvas`, async () => {
    const page = await open(handbook, width);
    try {
      await page.locator('[data-k2-part="Canvas"] .notebook-graph').waitFor();
      const outline = await describeV2Page(page, "#root");
      expect(outline.includes("Problems (") ? outline : "").toBe("");
      // the pane; the sidebar keeps the v1 note tree (k2b-ui gap: Nav tree)
      expect((await measureV2Layout(page, { root: '[data-k2-part="Pane"]' })).problems).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      // the display fills the pane below its filters
      const canvas = await page.locator('[data-k2-part="Canvas"]').boundingBox();
      expect(canvas!.height).toBeGreaterThan(300);
    } finally {
      await page.close();
    }
  }, 60_000);
}

test("a display tab, the links filter and an area go into the address and survive a reload", async () => {
  const page = await open(handbook);
  try {
    const display = (name: string) => page.locator('[data-k2-part="Tabs"]').getByRole("button", { name });
    await display("Circle").click();
    expect(param(page, "display")).toBe("circle");
    await page.getByRole("button", { name: "Which notes" }).click();
    await page.getByRole("menuitemradio", { name: "Only linked" }).click();
    expect(param(page, "links")).toBe("linked");
    // the areas stand in the same menu, each one ticked while it shows
    await page.getByRole("button", { name: "Which notes" }).click();
    const area = page.getByRole("menuitemcheckbox").first();
    expect(await area.getAttribute("aria-checked")).toBe("true");
    await area.click();
    await page.waitForFunction(() => new URL(location.href).searchParams.get("hide") !== null);
    await page.reload();
    await page.locator("[data-k2-workspace]").waitFor();
    expect(await display("Circle").getAttribute("aria-current")).toBe("page");
    await page.getByRole("button", { name: "Which notes" }).click();
    expect(await page.getByRole("menuitemradio", { name: "Only linked" }).getAttribute("aria-checked")).toBe("true");
    expect(await page.getByRole("menuitemcheckbox").first().getAttribute("aria-checked")).toBe("false");
  } finally {
    await page.close();
  }
}, 60_000);

test("As list shows the notes as a table whose rows open the note, and Back returns to the list", async () => {
  const page = await open(handbook);
  try {
    await page.getByRole("button", { name: "As list" }).click();
    expect(param(page, "list")).toBe("1");
    const rows = page.locator('[data-k2-part="Table"] tbody tr');
    await rows.first().waitFor();
    expect(await rows.count()).toBe(49);
    await rows.first().locator("a").first().click();
    await page.locator("#note-page").waitFor();
    await page.goBack();
    await page.locator('[data-k2-part="Table"]').waitFor();
    expect(param(page, "list")).toBe("1");
  } finally {
    await page.close();
  }
}, 60_000);

test("the search counts its matches and Enter moves into the graph", async () => {
  const page = await open(handbook);
  try {
    await page.locator('[data-k2-part="Canvas"] .notebook-graph').waitFor();
    const search = page.getByRole("searchbox", { name: "Find a note in the graph" });
    await search.fill("Kühl");
    await page
      .getByText(/\d+ match/)
      .first()
      .waitFor();
    // Enter in the search moves the focus to the first match in the graph
    await search.press("Enter");
    await page.waitForFunction((id) => document.activeElement?.getAttribute("data-node") === id, HANDBOOK_IDS.kuehl!);
    // the search reaches the address once typing pauses
    await page.waitForFunction(() => new URL(location.href).searchParams.get("q") === "Kühl");
  } finally {
    await page.close();
  }
}, 60_000);

test("notes without links list themselves with the way back, and an empty notebook says so", async () => {
  const page = await open("/app/notebooks/free01?mode=graph");
  try {
    await page.getByText("6 notes, not linked yet").waitFor();
    // without links there is nothing to filter or zoom
    expect(await page.getByRole("button", { name: "Zoom in" }).count()).toBe(0);
    expect(await page.locator('[data-k2-part="Section"] [data-k2-part="Row"]').count()).toBeGreaterThan(0);
    // the way back is the head's ×
    await page.getByRole("link", { name: "Close graph" }).waitFor();
    await page.goto(new URL("/app/notebooks/none01?mode=graph", server.url).href);
    await page.getByText("This notebook has no notes yet.").waitFor();
  } finally {
    await page.close();
  }
}, 60_000);
