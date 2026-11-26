import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LocaleProvider } from "@k2b/ui";
import { WorkspaceLayout } from "@k2b/ui/v2";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import type { Browser, Locator, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, settled } from "../../../../../../ui/test/browser";
import { renderNotebookBook } from "../../../../lib/book-renderer";
import { bookNavigationState } from "../sidebar/sidebar-tree.test-fixture";
import "../detail/ssr-test-plugin";

// Book as Cloud serves it: the server renders the page with its islands' wrappers (`@k2b/ssr`), the browser mounts
// each island over its own wrapper, and the workspace attaches. The article is the server's markup throughout.
const { default: BookPage } = await import("./BookPage");

const ui = `${resolve(import.meta.dir, "../../../../../../ui")}/`;
const tree = [
  {
    id: "note01",
    title: "Überblick",
    children: [
      { id: "note02", title: "Wareneingang", children: [] },
      { id: "note03", title: "Kühlkette", children: [] },
    ],
  },
];
const sentence = "Die Schicht prüft jede Lieferung, bucht sie im System und meldet Abweichungen an die Leitung. ";
/** A dense page of the handbook, drawn by Book's own renderer, with a long section to read through. */
const OVERVIEW = renderNotebookBook({
  markdown: [
    "# Überblick",
    "So arbeitet das Lager: Ware kommt an Rampe 1 bis 3 an, wird geprüft, eingelagert und für den Versand kommissioniert. Jede Station hat eine eigene Seite mit Ablauf, Ansprechpersonen und Checklisten.",
    "## Stationen",
    "- **Wareneingang** – Annahme, Sichtprüfung, Buchung im System\n- **Einlagerung** – Hochregal Gang A bis F, Kühlbereich K1\n- **Kommissionierung** – Pick-by-Scan, zwei Schichten\n- **Versand** – Packplätze 1 bis 6, Abholung 16 Uhr",
    "## Zeiten",
    "| Bereich | Frühschicht | Spätschicht |\n| --- | --- | --- |\n| Wareneingang | 6:00–14:00 | 14:00–22:00 |\n| Kommissionierung | 6:00–14:00 | 14:00–22:00 |\n| Versand | 8:00–16:30 | – |",
    "[Weiter zum Wareneingang](/app/notebooks/book01/notes/note02?mode=book)",
    "## Ablauf",
    ...Array.from({ length: 24 }, (_, index) => `Schritt ${index + 1}: ${sentence.repeat(index === 12 ? 30 : 4)}`),
  ].join("\n\n"),
  notebookId: "book01",
  noteId: "note01",
  locale: "de",
}).html;
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

/** The page as the server renders it; the cookies say whether the person hid the sidebar or reads in full width. */
const pageMarkup = (sidebarCollapsed: boolean, fullWidth: boolean, reader: boolean) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return createComponent(WorkspaceLayout, {
          sidebarCollapsed,
          get children() {
            return createComponent(BookPage, {
              notebookId: "book01",
              notebookName: "Handbuch Lager",
              notebookIcon: null,
              selectedNoteId: "note01",
              navigation: bookNavigationState(tree, "note01"),
              tags: [{ tag: "lager", count: 3 }],
              currentHref: "/app/notebooks/book01/notes/note01?mode=book",
              navigationHidden: false,
              fullWidth,
              html: OVERVIEW,
              noteTitle: "Überblick",
              canWrite: !reader,
              // a reader of a note with open comments
              openComments: reader ? 2 : undefined,
              locked: false,
              historyIncomplete: false,
              cursor: null,
            });
          },
        });
      },
    }),
  );

let server: ReturnType<typeof Bun.serve>;
let browser: Browser;
beforeAll(async () => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "book-page.browser-harness.ts")],
    target: "browser",
    conditions: ["browser"],
    format: "esm",
    plugins: [
      {
        name: "solid-book-page-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the Book page harness.");
  const bundle = await build.outputs[0]!.text();
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", `${resolve(import.meta.dir, "../../../../../../cloud")}/`)))
    .default;
  const sheet = async (entry: string) => {
    const output = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
    if (!output.success) throw new AggregateError(output.logs, `Could not compile ${entry}.`);
    return output.outputs[0]!.text();
  };
  // the shipped page-head order and cascade: Cloud, the app, then v2, and the style `html()` of @k2b/ssr writes
  const css = [
    "@layer properties, theme, base, components, utilities;",
    await sheet(resolve(import.meta.dir, "../../../../styles/app.css")),
    await sheet(resolve(import.meta.dir, "../../../../../../../styles.css")),
    await Bun.file(fileURLToPath(import.meta.resolve("@k2b/ui/v2.css"))).text(),
    "solid-client,solid-island{display:contents}",
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
      const cookie = request.headers.get("cookie") ?? "";
      const collapsed = /(?:^|;\s*)book-sidebar=hidden/.test(cookie);
      const fullWidth = decodeURIComponent(cookie).includes('"fullWidth":true');
      return new Response(
        `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/plex.css"><link rel="stylesheet" href="/tabler.css"><style>${css}</style></head>` +
          `<body class="k2b-ui" style="margin:0"><div id="root" class="k2-ui" style="position:fixed;inset:0;display:flex">${pageMarkup(collapsed, fullWidth, url.searchParams.has("reader"))}</div>` +
          // what a full page load would lose, and the article the server sent
          `<script>window.bookPageMarker = "first load"; window.serverArticle = document.getElementById("notebook-book-content");</script>` +
          `<script type="module" src="/harness.js"></script></body></html>`,
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

type BookWindow = Window & { bookPageMarker?: string; serverArticle?: Element | null; bookReady?: boolean };
const errors: string[] = [];
afterEach(() => {
  expect(errors.splice(0)).toEqual([]);
});
const ready = async (page: Page) => {
  await page.waitForFunction(() => (window as BookWindow).bookReady === true);
  await page.evaluate(() => document.fonts.ready);
  await settled(page);
};
const open = async (width: number, path = "/app/notebooks/book01/notes/note01?mode=book", javaScriptEnabled = true, fullWidth = false) => {
  const context = await browser.newContext({
    viewport: { width, height: width < 600 ? 844 : 900 },
    isMobile: width < 600,
    hasTouch: width < 1024,
    javaScriptEnabled,
  });
  // the person's full-width preference, as the settings cookie keeps it
  if (fullWidth)
    await context.addCookies([
      { name: "settings-app-notebooks", value: encodeURIComponent(JSON.stringify({ fullWidth: true })), url: server.url.href },
    ]);
  const page = await context.newPage();
  // an error in the page fails the test that opened it (a view transition a navigation cuts short is the browser's)
  page.on("pageerror", (error) => {
    if (!error.message.includes("ViewTransition")) errors.push(error.message);
  });
  await page.goto(new URL(path, server.url).href);
  if (javaScriptEnabled) await ready(page);
  return page;
};
const close = (page: Page) => page.context().close();
const tabs = (page: Page) => page.locator('[data-k2-part="Tabs"] a');
const main = ".notebook-book-main";
/** Where the character at `share` of a block's text sits below the top of Book's scroll port: the line being read. */
const lineAt = (block: Locator, share: number) =>
  block.evaluate(
    (element, [port, at]) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let rest = Math.floor((element.textContent?.length ?? 0) * (at as number));
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const length = node.textContent?.length ?? 0;
        if (rest < length) {
          const range = document.createRange();
          range.setStart(node, rest);
          range.setEnd(node, rest + 1);
          return Math.round(range.getBoundingClientRect().top - document.querySelector(port as string)!.getBoundingClientRect().top);
        }
        rest -= length;
      }
      throw new Error("The block has no text at that share.");
    },
    [main, share] as const,
  );
/** Where an element sits below the top of Book's scroll port. */
const offset = (target: Locator) =>
  target.evaluate(
    (element, port) => Math.round(element.getBoundingClientRect().top - document.querySelector(port)!.getBoundingClientRect().top),
    main,
  );

for (const width of [1440, 390]) {
  test(`${width}: the frame, the head and the article come from the server and read before any script`, async () => {
    const page = await open(width, undefined, false);
    try {
      await page.locator("#notebook-book-content h1", { hasText: "Überblick" }).waitFor();
      // the article is plain markup, in no island; the head and the navigation stand in theirs
      expect(await page.locator("solid-island #notebook-book-content").count()).toBe(0);
      expect(await page.locator('solid-island[data-file="BookHead.island.tsx"] [data-k2-part="Tabs"]').count()).toBe(1);
      // a writer's head holds the views, as the note's head does; the sidebar names the notebook beside it
      expect(await page.locator('[data-k2-workspace] [data-slot="head"]').textContent()).not.toContain("Handbuch Lager");
      expect((await page.locator(main).boundingBox())!.height).toBeGreaterThan(400);
    } finally {
      await close(page);
    }
  }, 60_000);

  test(`${width}: Book is a clean v2 workspace, the islands keep the server's article, and the next note arrives in place`, async () => {
    const page = await open(width);
    try {
      const outline = await describeV2Page(page, "#root");
      expect(outline.includes("Problems (") ? outline : "").toBe("");
      // the pane; the sidebar keeps the v1 reading order (k2b-ui gap: Nav tree)
      expect((await measureV2Layout(page, { root: '[data-k2-part="Pane"]' })).problems).toEqual([]);
      expect((await measureV2Layout(page, { root: '[data-k2-workspace] [data-k2-part="Bar"]' })).problems).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      expect(await page.evaluate(() => (window as BookWindow).serverArticle === document.getElementById("notebook-book-content"))).toBe(
        true,
      );
      expect(await tabs(page).evaluateAll((links) => links.map((link) => link.textContent?.trim()))).toEqual([
        "Bearbeiten",
        "Lesen",
        "Buch",
      ]);
      expect(await tabs(page).first().getAttribute("href")).toBe("/app/notebooks/book01/notes/note01?mode=write");

      await page.getByRole("link", { name: "Weiter zum Wareneingang" }).click();
      await page.locator("#notebook-book-content h1", { hasText: "Wareneingang" }).waitFor();
      expect(new URL(page.url()).pathname).toBe("/app/notebooks/book01/notes/note02");
      expect(await page.evaluate(() => (window as BookWindow).bookPageMarker)).toBe("first load");
      await page.waitForFunction(
        () => document.querySelector('[data-k2-part="Tabs"] a')?.getAttribute("href") === "/app/notebooks/book01/notes/note02?mode=write",
      );
      // the note's open comments: their sign and number, named in words, leading into Read at the first one
      // k2b-ui gap: a v2 Button with words takes `label` only as its title, not as its name, so the name is the number until
      // the Button names it in words as its contract says
      const comments = page.locator('[data-k2-workspace] a[title="2 offene Kommentare"]');
      expect(await comments.getAttribute("href")).toBe("/app/notebooks/book01/notes/note02?mode=readonly&annotation=first");
      expect(await comments.textContent()).toContain("2");
      expect(await comments.isVisible()).toBe(true);
      // with the comments in it, the head still fits
      expect((await measureV2Layout(page, { root: '[data-k2-workspace] [data-k2-part="Bar"]' })).problems).toEqual([]);
      await page.goBack();
      await page.locator("#notebook-book-content h1", { hasText: "Überblick" }).waitFor();
      expect(await page.evaluate(() => (window as BookWindow).bookPageMarker)).toBe("first load");
    } finally {
      await close(page);
    }
  }, 60_000);
}

for (const width of [1440, 390]) {
  test(`${width}: a reader stays in Book and reaches the note's open comments from the head`, async () => {
    const page = await open(width, "/app/notebooks/book01/notes/note01?mode=book&reader=1");
    try {
      // no views into the workspace; the head names the notebook, the article its note
      expect(await tabs(page).count()).toBe(0);
      expect(await page.locator('[data-k2-workspace] [data-slot="head"]').textContent()).toContain("Handbuch Lager");
      // the comments: their sign and number in sight, named in words, also on the phone
      const comments = page.locator('[data-k2-workspace] a[title="2 offene Kommentare"]');
      expect(await comments.isVisible()).toBe(true);
      expect(await comments.locator(".ti-message-circle").count()).toBe(1);
      expect((await comments.textContent())?.trim()).toBe("2");
      expect(await comments.getAttribute("href")).toBe("/app/notebooks/book01/notes/note01?mode=readonly&annotation=first");
      expect((await measureV2Layout(page, { root: '[data-k2-workspace] [data-k2-part="Bar"]' })).problems).toEqual([]);
    } finally {
      await close(page);
    }
  }, 60_000);
}

test("an address with an anchor opens at its heading, and mounting the islands keeps it there", async () => {
  const page = await open(1440, "/app/notebooks/book01/notes/note01?mode=book#heading-ablauf");
  try {
    expect(await page.evaluate((port) => document.querySelector(port)!.scrollTop, main)).toBeGreaterThan(300);
    // the heading stands at the top of the port, below its own scroll margin
    const heading = page.locator("#heading-ablauf");
    const margin = await heading.evaluate((element) => Number.parseFloat(getComputedStyle(element).scrollMarginTop) || 0);
    expect(Math.abs((await offset(heading)) - margin)).toBeLessThanOrEqual(2);
  } finally {
    await close(page);
  }
}, 60_000);

test("a reload returns to where the reader was", async () => {
  const page = await open(1440);
  try {
    await page.locator(main).evaluate((port) => port.scrollTo(0, 1200));
    // the entry keeps the position once the scroll is reported
    await page.waitForFunction(
      () => (history.state as { notebooksBookScroll?: { top: number } } | null)?.notebooksBookScroll?.top === 1200,
    );
    await page.reload();
    await ready(page);
    expect(await page.locator(main).evaluate((port) => port.scrollTop)).toBe(1200);
  } finally {
    await close(page);
  }
}, 60_000);

test("the sidebar hides and shows with its button and keys, the text being read stays in place, and the next page comes hidden", async () => {
  // in full width the column bounds the article, so hiding the sidebar rewraps it
  const page = await open(1024, undefined, true, true);
  try {
    const workspace = page.locator("[data-k2-workspace]");
    const article = page.locator("#notebook-book-content");
    // the reader is near the end of a long step, where a rewrap moves the text furthest; the browser's own scroll
    // anchoring keeps only the step's top in place
    const step = article.locator("p", { hasText: "Schritt 13:" });
    await step.evaluate((element, port) => {
      const scroller = document.querySelector(port)!;
      scroller.scrollTop += element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + element.clientHeight * 0.85;
    }, main);
    await settled(page);
    const line = await step.evaluate((element) => Number.parseFloat(getComputedStyle(element).lineHeight));
    const reading = await lineAt(step, 0.85);
    const narrow = (await article.boundingBox())!.width;

    await page.getByRole("button", { name: "Seitenleiste ausblenden" }).click();
    expect(await workspace.getAttribute("data-collapsed")).toBe("");
    await settled(page);
    expect((await article.boundingBox())!.width).toBeGreaterThan(narrow);
    // the line being read stays at the top, give or take the line the rewrap moved it into
    expect(Math.abs((await lineAt(step, 0.85)) - reading)).toBeLessThanOrEqual(line);
    expect(await page.evaluate(() => document.cookie)).toContain("book-sidebar=hidden");

    // the server renders the next page with the sidebar hidden, so it comes with the right width
    await page.reload();
    await ready(page);
    expect(await workspace.getAttribute("data-collapsed")).toBe("");
    expect((await article.boundingBox())!.width).toBeGreaterThan(narrow);

    await page.keyboard.press("Control+Alt+KeyS");
    expect(await workspace.getAttribute("data-collapsed")).toBeNull();
    expect(await page.getByRole("button", { name: "Seitenleiste ausblenden" }).getAttribute("aria-expanded")).toBe("true");
    await settled(page);
    expect(Math.round((await article.boundingBox())!.width)).toBe(Math.round(narrow));
    expect(await page.evaluate(() => document.cookie)).toContain("book-sidebar=shown");
  } finally {
    await close(page);
  }
}, 60_000);

test("the reading order in the sidebar opens a note in place", async () => {
  const page = await open(1440);
  try {
    await page.locator('[role="tree"]').getByRole("link", { name: "Wareneingang" }).click();
    await page.locator("#notebook-book-content h1", { hasText: "Wareneingang" }).waitFor();
    expect(await page.evaluate(() => (window as BookWindow).bookPageMarker)).toBe("first load");
    expect(await page.locator('[role="tree"] [aria-current="page"]').textContent()).toContain("Wareneingang");
  } finally {
    await close(page);
  }
}, 60_000);
