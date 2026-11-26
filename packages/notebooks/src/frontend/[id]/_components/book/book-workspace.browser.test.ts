import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../../../../../ui/test/browser";

const ui = `${resolve(import.meta.dir, "../../../../../../ui")}/`;
const second = {
  href: "/app/notebooks/book01/notes/note02?mode=book",
  html: '<h1 id="wareneingang">Wareneingang</h1><p>Annahme an Rampe 2.</p>',
  title: "Wareneingang",
  notebookName: "Handbuch Lager",
  selectedNoteId: "note02",
  hasNotes: true,
  tags: [{ tag: "lager", count: 3 }],
  canWrite: true,
  locked: false,
  historyIncomplete: false,
  cursor: null,
  openComments: 2,
};
let server: ReturnType<typeof Bun.serve>;
let browser: Browser;
beforeAll(async () => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "book-workspace.browser-harness.tsx")],
    target: "browser",
    conditions: ["browser"],
    format: "esm",
    plugins: [
      {
        name: "solid-book-workspace-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the Book workspace harness.");
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
      // the next note arrives as a snapshot, without a new page
      if (url.pathname === "/api/notebooks/book01/book" && url.searchParams.get("href")?.includes("/notes/note02"))
        return Response.json(second);
      if (url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });
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
  server?.stop(true);
});

const errors: string[] = [];
afterEach(() => {
  expect(errors.splice(0)).toEqual([]);
});
const open = async (width: number) => {
  const page = await browser.newPage({
    viewport: { width, height: width < 600 ? 844 : 900 },
    isMobile: width < 600,
    hasTouch: width < 1024,
  });
  // an error in the page fails the test that opened it (a view transition a navigation cuts short is the browser's)
  page.on("pageerror", (error) => {
    if (!error.message.includes("ViewTransition")) errors.push(error.message);
  });
  await page.goto(new URL("/app/notebooks/book01/notes/note01?mode=book", server.url).href);
  await page.locator("#notebook-book-content h1").waitFor();
  await page.evaluate(() => document.fonts.ready);
  return page;
};
const tabs = (page: Page) => page.locator('[data-k2-part="Tabs"] a');

for (const width of [1440, 390]) {
  test(`${width}: Book is a clean v2 workspace, and the next note arrives in place with the head following it`, async () => {
    const page = await open(width);
    try {
      const outline = await describeV2Page(page, "#root");
      expect(outline.includes("Problems (") ? outline : "").toBe("");
      // the pane; the sidebar keeps the v1 reading order (k2b-ui gap: Nav tree)
      expect((await measureV2Layout(page, { root: '[data-k2-part="Pane"]' })).problems).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      expect(await tabs(page).evaluateAll((links) => links.map((link) => link.textContent?.trim()))).toEqual([
        "Bearbeiten",
        "Lesen",
        "Buch",
      ]);
      expect(await tabs(page).first().getAttribute("href")).toBe("/app/notebooks/book01/notes/note01?mode=write");
      // the reading surface scrolls inside the pane, below the head
      const surface = await page.locator(".notebook-book-main").boundingBox();
      expect(surface!.height).toBeGreaterThan(400);

      await page.getByRole("link", { name: "Weiter zum Wareneingang" }).click();
      await page.locator("#notebook-book-content h1", { hasText: "Wareneingang" }).waitFor();
      expect(new URL(page.url()).pathname).toBe("/app/notebooks/book01/notes/note02");
      expect(await page.evaluate(() => window.bookPageMarker)).toBe("first load");
      await page.waitForFunction(
        () => document.querySelector('[data-k2-part="Tabs"] a')?.getAttribute("href") === "/app/notebooks/book01/notes/note02?mode=write",
      );
      // the note's open comments: their sign and number, named in words, leading into Read at the first one
      // k2b-ui gap: a v2 Button with words takes `label` only as its title, not as its name, so the name is the number until
      // the Button names it in words as its contract says
      const open = page.locator('[data-k2-workspace] a[title="2 offene Kommentare"]');
      expect(await open.getAttribute("href")).toBe("/app/notebooks/book01/notes/note02?mode=readonly&annotation=first");
      expect(await open.textContent()).toContain("2");
      // with the comments in it, the head still fits
      expect((await measureV2Layout(page, { root: '[data-k2-workspace] [data-k2-part="Bar"]' })).problems).toEqual([]);
      await page.goBack();
      await page.locator("#notebook-book-content h1", { hasText: "Überblick" }).waitFor();
      expect(await page.evaluate(() => window.bookPageMarker)).toBe("first load");
    } finally {
      await page.close();
    }
  }, 60_000);
}

test("the reading order in the sidebar opens a note in place", async () => {
  const page = await open(1440);
  try {
    await page.locator('[role="tree"]').getByRole("link", { name: "Wareneingang" }).click();
    await page.locator("#notebook-book-content h1", { hasText: "Wareneingang" }).waitFor();
    expect(await page.evaluate(() => window.bookPageMarker)).toBe("first load");
    expect(await page.locator('[role="tree"] [aria-current="page"]').textContent()).toContain("Wareneingang");
  } finally {
    await page.close();
  }
}, 60_000);
