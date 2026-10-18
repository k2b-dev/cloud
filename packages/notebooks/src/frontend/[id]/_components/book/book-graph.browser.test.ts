import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { browserName, launchBrowser } from "../../../../../../ui/test/browser";
import { parseGraphViewState } from "../graph/view-state";
import { BookGraphFixture, type BookGraphFixtureProps } from "./book-graph.browser-harness";

const noteHref = "/app/notebooks/book01/notes/note03?mode=book";
const graphHref = `/app/notebooks/book01?mode=graph&note=note03&from=book&back=${encodeURIComponent(noteHref)}`;
const tree = [
  { id: "note01", title: "Guide", children: [] },
  { id: "note03", title: "Glossary", children: [] },
];
const graph = {
  nodes: tree.map((node, position) => ({
    id: node.id,
    title: node.title,
    inDegree: position,
    parentId: null,
    position,
    updatedAt: "2026-10-01T08:00:00.000Z",
  })),
  edges: [{ source: "note01", target: "note03" }],
};
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  const ui = `${resolve(import.meta.dir, "../../../../../../ui")}/`;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "book-graph.browser-harness.tsx")],
    target: "browser",
    conditions: ["browser"],
    format: "iife",
    plugins: [
      {
        name: "solid-book-graph-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the Book graph harness.");
  const bundle = await build.outputs[0]!.text();
  // Match the shipped page-head order, including the app's Book styles and Cloud's responsive sidebar rules.
  const stylesheets = [resolve(import.meta.dir, "../../../../styles/app.css"), resolve(import.meta.dir, "../../../../../../../styles.css")];
  const outputs = await Promise.all(
    stylesheets.map(async (entry) => {
      const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
      if (!build.success) throw new AggregateError(build.logs, `Could not compile ${entry}.`);
      return build.outputs[0]!.text();
    }),
  );
  const css = ["@layer properties, theme, base, components, utilities;", ...outputs].join("\n");
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/harness.js")
        return new Response(bundle, { headers: { "content-type": "application/javascript; charset=utf-8" } });
      const isGraph = url.pathname === "/app/notebooks/book01" && url.searchParams.get("mode") === "graph";
      const noteId = isGraph ? url.searchParams.get("note") : /^\/app\/notebooks\/book01\/notes\/(note01|note03)$/.exec(url.pathname)?.[1];
      if (!noteId || (!isGraph && url.searchParams.get("mode") !== "book")) return new Response("Not found", { status: 404 });
      const props: BookGraphFixtureProps = {
        navigator: {
          notebookId: "book01",
          notebookName: "Handbook",
          notebookIcon: null,
          selectedNoteId: noteId,
          currentHref: `/app/notebooks/book01/notes/${noteId}?mode=book`,
          canWrite: false,
          locked: false,
          navigationHidden: false,
          tree,
          tags: [],
          current: isGraph ? "graph" : undefined,
          graphBack: isGraph ? (url.searchParams.get("back") ?? undefined) : undefined,
        },
        graph: isGraph ? graph : null,
        view: parseGraphViewState(url.searchParams),
        now: "2026-10-16T17:30:00.000Z",
      };
      const html = renderToString(() => createComponent(BookGraphFixture, props));
      return new Response(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="k2b-ui" style="margin:0"><div id="root" style="height:100dvh;display:flex;flex-direction:column">${html}</div><script id="book-props" type="application/json">${JSON.stringify(props).replace(/</g, "\\u003c")}</script><script src="/harness.js"></script></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  await server?.stop(true);
});

const linksItem = (page: Page) => page.locator(".notebook-sidebar-foot").getByRole("link", { name: "Links", exact: true });
const layout = async (page: Page) => {
  await page.waitForFunction(() => Boolean(window.bookGraphLayout));
  const measured = await page.evaluate(() => window.bookGraphLayout!);
  expect(measured.before.height).toBe(32);
  expect(measured.after).toEqual(measured.before);
  return measured.after;
};

test(`${browserName}: Book Links keeps the note and origin through reload, history and Close without moving its footer row`, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(new URL(noteHref, server.url).href);
    await page.locator("#notebook-book-content").waitFor({ state: "visible" });
    const before = await layout(page);
    expect(await linksItem(page).getAttribute("aria-current")).toBeNull();
    await linksItem(page).click();
    await page.waitForURL(new URL(graphHref, server.url).href);
    expect(await layout(page)).toEqual(before);
    expect(await linksItem(page).getAttribute("aria-current")).toBe("page");
    expect(await page.getByRole("link", { name: "Close graph", exact: true }).getAttribute("href")).toBe(noteHref);

    await page.reload();
    await page.waitForURL(new URL(graphHref, server.url).href);
    expect(await layout(page)).toEqual(before);
    expect(await linksItem(page).getAttribute("aria-current")).toBe("page");
    expect(await page.getByRole("link", { name: "Close graph", exact: true }).getAttribute("href")).toBe(noteHref);

    await page.goBack();
    await page.waitForURL(new URL(noteHref, server.url).href);
    await page.locator("#notebook-book-content").waitFor({ state: "visible" });
    await layout(page);
    await page.goForward();
    await page.waitForURL(new URL(graphHref, server.url).href);
    expect(await layout(page)).toEqual(before);
    await page.getByRole("link", { name: "Close graph", exact: true }).click();
    await page.waitForURL(new URL(noteHref, server.url).href);
    await page.locator("#notebook-book-content").waitFor({ state: "visible" });
    expect(await layout(page)).toEqual(before);
  } finally {
    await page.close();
  }
}, 30_000);
