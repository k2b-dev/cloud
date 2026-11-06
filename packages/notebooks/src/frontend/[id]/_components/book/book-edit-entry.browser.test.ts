import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser } from "../../../../../../ui/test/browser";
import { bookNavigationState } from "../sidebar/sidebar-tree.test-fixture";
import type { BookNavigatorProps } from "./BookNavigator.island";
import { BOOK_SNAPSHOT_EVENT, type BookMetadata } from "./book-state";

const bookHref = "/app/notebooks/book01/notes/note01?mode=book&tag=guide";
const noteText = "Our handbook explains how the team works together.";
const tree = [
  { id: "note01", title: "Guide", children: [] },
  { id: "note03", title: "Glossary", children: [] },
];
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  const ui = `${resolve(import.meta.dir, "../../../../../../ui")}/`;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "book-edit-entry.browser-harness.tsx")],
    target: "browser",
    conditions: ["browser"],
    format: "iife",
    plugins: [
      {
        name: "solid-book-edit-entry-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the Book edit entry harness.");
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
      const noteId = /^\/app\/notebooks\/book01\/notes\/(note01|note03)$/.exec(url.pathname)?.[1];
      const mode = url.searchParams.get("mode");
      if (!noteId || (mode !== "book" && mode !== "write")) return new Response("Not found", { status: 404 });
      const props: BookNavigatorProps = {
        notebookId: "book01",
        notebookName: "Handbook",
        notebookIcon: null,
        selectedNoteId: noteId,
        currentHref: url.pathname + url.search,
        canWrite: url.searchParams.get("access") !== "read",
        locked: false,
        navigationHidden: false,
        navigation: bookNavigationState(tree, noteId),
        tags: [],
      };
      // This fixture stands for the app router. The Write response identifies the route; it does not mount the editor.
      const content =
        mode === "write"
          ? `<main data-mode="write" data-note="${noteId}">Write ${noteId}</main>`
          : `<div id="root" style="height:100dvh;display:flex;flex-direction:column"></div><script id="book-props" type="application/json">${JSON.stringify(props).replace(/</g, "\\u003c")}</script><script src="/harness.js"></script>`;
      return new Response(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="k2b-ui" style="margin:0">${content}</body></html>`,
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

const open = async (href = bookHref): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(new URL(href, server.url).href);
    await page.locator("#notebook-book-content").waitFor({ state: "visible" });
    await page.waitForFunction(() => Boolean(document.querySelector("script[data-cloud-workspace-navigation]")));
    return page;
  } catch (error) {
    await page.close();
    throw error;
  }
};
const writeLink = (page: Page) => page.locator("#notebook-navigation").getByRole("link", { name: "Write", exact: true });

test(`${browserName}: Write opens the current note and Back restores its Book URL, filter and article`, async () => {
  const page = await open();
  try {
    expect(await writeLink(page).count()).toBe(1);
    await writeLink(page).click();
    await page.waitForURL((url) => url.pathname === "/app/notebooks/book01/notes/note01" && url.searchParams.get("mode") === "write");
    const writeUrl = new URL(page.url());
    expect(writeUrl.pathname).toBe("/app/notebooks/book01/notes/note01");
    expect(writeUrl.searchParams.get("mode")).toBe("write");
    expect(writeUrl.searchParams.get("tag")).toBe("guide");
    await page.locator('main[data-mode="write"][data-note="note01"]').waitFor({ state: "visible" });

    await page.goBack();
    await page.waitForURL(new URL(bookHref, server.url).href);
    expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(bookHref);
    const article = page.locator("#notebook-book-content");
    await article.waitFor({ state: "visible" });
    expect(await article.textContent()).toContain(noteText);
    await writeLink(page).waitFor({ state: "visible" });
    expect(await writeLink(page).count()).toBe(1);
  } finally {
    await page.close();
  }
}, 30_000);

test(`${browserName}: a reader has no Write sidebar link`, async () => {
  const page = await open(`${bookHref}&access=read`);
  try {
    expect(await page.getByRole("link", { name: "Write", exact: true }).count()).toBe(0);
    expect(await page.getByRole("link", { name: "Open workspace", exact: true }).count()).toBe(0);
    expect(await page.locator("#notebook-book-content").textContent()).toContain(noteText);
  } finally {
    await page.close();
  }
}, 30_000);

test(`${browserName}: a soft Book snapshot to a locked note swaps Write for Open workspace in the same place`, async () => {
  const page = await open();
  try {
    await page.evaluate(() => document.fonts.ready);
    const firstPage = page.locator('[data-k2b-nav-tree-id="note01"]');
    const before = { write: await writeLink(page).boundingBox(), page: await firstPage.boundingBox() };
    expect(before.write).not.toBeNull();
    expect(before.page).not.toBeNull();
    // The fixture renders client-only. Compare the same sidebar across a real snapshot event after mount:
    // a locked note swaps the entry, which must neither resize its row nor move the contents list.
    const next: BookMetadata = {
      href: "/app/notebooks/book01/notes/note03?mode=book",
      title: "Glossary",
      selectedNoteId: "note03",
      notebookName: "Handbook",
      hasNotes: true,
      tags: [],
      canWrite: true,
      locked: true,
      historyIncomplete: false,
      cursor: null,
    };
    await page.evaluate(({ event, detail }) => window.dispatchEvent(new CustomEvent(event, { detail })), {
      event: BOOK_SNAPSHOT_EVENT,
      detail: next,
    });
    await page.waitForFunction(
      () => document.querySelector('#notebook-navigation a[href="/app/notebooks/book01/notes/note03?mode=readonly"]') !== null,
    );
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(await writeLink(page).count()).toBe(0);
    const workspace = page.locator("#notebook-navigation").getByRole("link", { name: "Open workspace", exact: true });
    expect(await workspace.boundingBox()).toEqual(before.write);
    expect(await firstPage.boundingBox()).toEqual(before.page);
  } finally {
    await page.close();
  }
}, 30_000);
