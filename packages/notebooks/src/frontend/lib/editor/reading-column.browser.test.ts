import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser } from "../../../../../ui/test/browser";
import { renderNotebookBook } from "../../../lib/book-renderer";
import type { ReadingColumnHarness } from "./reading-column.browser-harness";

// Only a real browser measures the shipped cascade, line wrapping and CodeMirror's block widgets.
const prose =
  "Unser Team sammelt hier die Gedanken für die nächste gemeinsame Woche. Wir besprechen die Erfahrungen aus dem letzten Projekt und halten fest, welche Fragen noch offen sind. Everyone can read the same notes and add an explanation for everyone who joins the project. Gute Dokumentation gibt uns Zeit, sorgfältig zu arbeiten und unsere Entscheidungen später nachzuvollziehen. Am Freitag schauen wir gemeinsam auf die Ergebnisse und planen die nächsten Schritte. The shared notebook keeps the details close to the people who need them.";
// Shift word positions across the 704px column edge, including words whose trailing space would not fit.
// One lucky paragraph can have identical breaks even with CodeMirror's default break-spaces.
const paragraphPrefixes = ["Unser Team", ...Array.from({ length: 40 }, (_, index) => `${"w".repeat(index + 1)} Bei Regen`)];
const lineBreakDocument = [
  prose,
  ...paragraphPrefixes
    .slice(1)
    .map(
      (prefix) =>
        `${prefix} weichen wir in die **Kantine** aus. Die Entscheidung fällt *zwei Tage vorher* anhand der Wettervorhersage, und das Orga-Team schickt dann eine kurze Nachricht in den Team-Kanal.`,
    ),
  "Ende der Notiz.",
].join("\n\n");
const markdown = [
  "# Gemeinsam schreiben",
  "",
  "## Planung der Woche",
  "",
  "### Notes for everyone",
  "",
  prose,
  "",
  "Wir sammeln **wichtige Gedanken** und *leise Fragen* für unser Team.",
  "",
  "Der Befehl `cld notes list` zeigt alle Notizen.",
  "",
  "```js",
  "const team = await notes.list();",
  "```",
  "",
  ":::info",
  "Wir halten die nächsten Schritte gemeinsam fest.",
  ":::",
  "",
  "| Format | Verantwortlich | Beschreibung | Zeitpunkt | Rückmeldung | Dokumentation |",
  "| --- | --- | --- | --- | --- | --- |",
  `| ${Array.from({ length: 6 }, (_, index) => `UnbreakableColumn${index}WithLongReferenceNumber1234567890`).join(" | ")} |`,
  "",
  "![Wochenübersicht](/wide.png)",
  "",
  "![Explizite Größe](/wide.png =1600x400)",
  "",
  "```mermaid",
  "graph TD",
  "  A[Planung] --> B[Ergebnisse]",
  "```",
  "",
  "Ende der Notiz.",
].join("\n");

const queryDocument = "Intro\n\n:::query\nsource: notes\ncolumns:\n  - $title\n:::\n\nEnde";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  const ui = `${resolve(import.meta.dir, "../../../../../ui")}/`;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "reading-column.browser-harness.ts")],
    target: "browser",
    conditions: ["browser"],
    format: "iife",
    plugins: [
      {
        name: "solid-reading-column-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the reading column harness.");
  const bundle = await build.outputs[0]!.text();
  // The page head's order: the app's stylesheet, then Cloud's global one.
  const outputs = await Promise.all(
    [resolve(import.meta.dir, "../../../styles/app.css"), resolve(import.meta.dir, "../../../../../../styles.css")].map(async (entry) => {
      const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
      if (!build.success) throw new AggregateError(build.logs, `Could not compile ${entry}.`);
      return build.outputs[0]!.text();
    }),
  );
  const css = ["@layer properties, theme, base, components, utilities;", ...outputs].join("\n");
  // A 1600 × 400 PNG: its intrinsic width must exceed the reading column.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAABkAAAAGQAQAAAADe7pGrAAABx0lEQVR4nO3PAQkAMAzAsPk3/ZsYvJxEQTvnE/M6YIuRGiM1RmqM1BipMVJjpMZIjZEaIzVGaozUGKkxUmOkxkiNkRojNUZqjNQYqTFSY6TGSI2RGiM1RmqM1BipMVJjpMZIjZEaIzVGaozUGKkxUmOkxkiNkRojNUZqjNQYqTFSY6TGSI2RGiM1RmqM1BipMVJjpMZIjZEaIzVGaozUGKkxUmOkxkiNkRojNUZqjNQYqTFSY6TGSI2RGiM1RmqM1BipMVJjpMZIjZEaIzVGaozUGKkxUmOkxkiNkRojNUZqjNQYqTFSY6TGSI2RGiM1RmqM1BipMVJjpMZIjZEaIzVGaozUGKkxUmOkxkiNkRojNUZqjNQYqTFSY6TGSI2RGiM1RmqM1BipMVJjpMZIjZEaIzVGaozUGKkxUmOkxkiNkRojNUZqjNQYqTFSY6TGSI2RGiM1RmqM1BipMVJjpMZIjZEaIzVGaozUGKkxUmOkxkiNkRojNUZqjNQYqTFSY6TGSI2RGiM1RmqM1BipMVJjpMZIjZEaIzVGaozUGKkxUmOkxkiNkRojNUZqjNQYqTFSY6TGSI2RGiM1RmqM1BipMVJjpOYCtptZukgocZUAAAAASUVORK5CYII=",
    "base64",
  );
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/harness.js")
        return new Response(bundle, { headers: { "content-type": "application/javascript; charset=utf-8" } });
      if (url.pathname === "/wide.png") return new Response(png, { headers: { "content-type": "image/png" } });
      const book = url.searchParams.get("mode") === "book";
      const rows = Number(url.searchParams.get("queryRows") ?? 0);
      const truncated = url.searchParams.has("queryTruncated");
      const note = url.searchParams.has("queryRows") ? queryDocument : url.searchParams.has("lineBreaks") ? lineBreakDocument : markdown;
      const result = renderNotebookBook({
        markdown: note,
        notebookId: "book01",
        locale: "de",
        queryResults: new Map([
          [
            3,
            {
              columns: ["$title"],
              items: Array.from({ length: rows }, (_, index) => ({
                id: `DEF45${index}`,
                title: `Notiz ${index}`,
                href: `/app/notebooks/book01/notes/DEF45${index}`,
                values: { $title: `Notiz ${index}` },
              })),
              total: truncated ? rows + 1 : rows,
              limit: truncated ? rows : 50,
              truncated,
              diagnostics: [],
            },
          ],
        ]),
      });
      const { html } = result;
      if (url.pathname === "/query-html")
        return new Response(result.blocks[0]!.html, { headers: { "content-type": "text/html; charset=utf-8" } });
      return new Response(
        `<!doctype html><html lang="de"${url.searchParams.has("dark") ? ' class="dark"' : ""}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>
      #layout { display:flex; height:100dvh; }
      #navigation { width:288px; flex:none; }
      #main { flex:1; min-width:0; min-height:0; display:flex; flex-direction:column; }
      #main.book { overflow-y:auto; display:block; }
      @media(max-width:600px) { #navigation { display:none; } }
    </style></head><body class="k2b-ui" style="margin:0"><div id="layout" class="notebook-book-shell"><nav id="navigation">Notizbuch</nav><main id="main"${book ? ' class="book"' : ""}>${book ? `<article class="notebook-book-content">${html}</article>` : ""}</main></div><script id="note-source" type="text/plain">${note}</script><script src="/harness.js"></script></body></html>`,
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

const open = async (
  mode: "write" | "book" | "source",
  width: number,
  dark = false,
  fixture: { queryRows?: number; queryTruncated?: boolean; lineBreaks?: boolean } = {},
  engine = browser,
) => {
  const page = await engine.newPage({ viewport: { width, height: 800 }, isMobile: width === 390, hasTouch: width === 390 });
  await page.goto(
    `${server.url}?mode=${mode}${dark ? "&dark" : ""}${fixture.queryRows === undefined ? "" : `&queryRows=${fixture.queryRows}`}${fixture.queryTruncated ? "&queryTruncated" : ""}${fixture.lineBreaks ? "&lineBreaks" : ""}`,
  );
  await page.waitForFunction(() => "harness" in window);
  await settle(page);
  return page;
};
const settle = (page: Page) => page.evaluate(() => (window as unknown as { harness: ReadingColumnHarness }).harness.settle());
const measure = (page: Page) => page.evaluate(() => (window as unknown as { harness: ReadingColumnHarness }).harness.measure());
const closeTo = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1);

for (const width of [2560, 1280, 900]) {
  test(`Write and Book center a text column of at most 704px at ${width}px`, async () => {
    for (const mode of ["write", "book"] as const) {
      const page = await open(mode, width);
      try {
        const result = await measure(page);
        expect(result.width).toBeLessThanOrEqual(704);
        if (width !== 900) closeTo(result.width, 704);
        closeTo(result.gaps[0]!, result.gaps[1]!);
      } finally {
        await page.close();
      }
    }
  });
}
for (const width of [2560, 1280]) {
  test(`Write and Book break every shifted paragraph into identical lines at ${width}px`, async () => {
    const write = await open("write", width, false, { lineBreaks: true });
    const book = await open("book", width, false, { lineBreaks: true });
    try {
      const paragraphs = async (page: Page, scroll: boolean) =>
        page.evaluate(
          async ({ prefixes, scroll }) => {
            const harness = (window as unknown as { harness: ReadingColumnHarness }).harness;
            const results = [];
            for (const prefix of prefixes) {
              if (scroll) {
                harness.scrollTo(prefix);
                await harness.settle();
              }
              results.push(harness.measure(prefix));
            }
            return results;
          },
          { prefixes: paragraphPrefixes, scroll },
        );
      const written = await paragraphs(write, true);
      const read = await paragraphs(book, false);
      expect(written).toHaveLength(paragraphPrefixes.length);
      expect(read).toHaveLength(paragraphPrefixes.length);
      written.forEach((a, index) => {
        const b = read[index]!;
        const context = `Paragraph ${index}: ${paragraphPrefixes[index]}`;
        expect(a.width).toBe(704);
        expect(b.width).toBe(704);
        expect(a.lines.length).toBeGreaterThan(1);
        expect(a.lines, context).toHaveLength(b.lines.length);
        expect(a.breaks, context).toEqual(b.breaks);
        a.lines.forEach((line, index) => closeTo(line, b.lines[index]!));
      });
    } finally {
      await write.close();
      await book.close();
    }
  }, 30_000);
}
for (const mode of ["write", "book"] as const) {
  test(`${mode}: hiding navigation moves the column without rewrapping at 2560px`, async () => {
    const page = await open(mode, 2560);
    try {
      const before = await measure(page);
      await page.evaluate(() => (window as unknown as { harness: ReadingColumnHarness }).harness.hideNavigation());
      await settle(page);
      const after = await measure(page);
      expect(after.width).toBe(before.width);
      expect(after.height).toBe(before.height);
      expect(after.lines).toEqual(before.lines);
      expect(before.left - after.left).toBeGreaterThan(100);
    } finally {
      await page.close();
    }
  });
  for (const width of [2560, 390]) {
    test(`${mode}: wide tables scroll inside the column at ${width}px`, async () => {
      const page = await open(mode, width);
      try {
        await page.locator(".md-table-wrap").scrollIntoViewIfNeeded();
        await settle(page);
        const result = await page.evaluate((mode) => {
          const table = document.querySelector<HTMLElement>(".md-table-wrap")!;
          const owners =
            mode === "write"
              ? [document.querySelector<HTMLElement>(".cm-scroller")!, document.querySelector<HTMLElement>(".k2b-scroll-area")!]
              : [document.scrollingElement!, document.querySelector("article")!];
          return {
            owners: owners.map((element) => element.scrollWidth - element.clientWidth),
            table: table.scrollWidth - table.clientWidth,
            overflow: getComputedStyle(table).overflowX,
          };
        }, mode);
        expect(result.owners).toEqual([0, 0]);
        expect(result.table).toBeGreaterThan(0);
        expect(result.overflow).toBe("auto");
      } finally {
        await page.close();
      }
    });
  }
  // Playwright hides scrollbars by default; Windows and Linux desktops draw classic ones that take presses.
  test.skipIf(mode === "book" || browserName !== "chromium")(
    `${mode}: dragging a wide table's classic scrollbar scrolls it and keeps the preview`,
    async () => {
      const engine = await launchBrowser({ ignoreDefaultArgs: ["--hide-scrollbars"] });
      try {
        const page = await open(mode, 1280, false, {}, engine);
        const wrap = page.locator(".cm-table-widget .md-table-wrap");
        await wrap.scrollIntoViewIfNeeded();
        await settle(page);
        const anchor = await page.evaluate(() => (window as unknown as { harness: ReadingColumnHarness }).harness.anchor());
        const bar = await wrap.evaluate((element) => {
          if (!(element instanceof HTMLElement)) throw new Error("Not a table wrap.");
          const rect = element.getBoundingClientRect();
          return {
            track: element.offsetHeight - element.clientHeight,
            x: rect.left + element.clientLeft + 20,
            y: rect.top + element.clientTop + element.clientHeight + (element.offsetHeight - element.clientHeight) / 2,
          };
        });
        expect(bar.track).toBeGreaterThan(0);
        await page.mouse.move(bar.x, bar.y);
        await page.mouse.down();
        await page.mouse.move(bar.x + 100, bar.y, { steps: 10 });
        await page.mouse.up();
        expect(await page.locator(".cm-table-widget").count()).toBe(1);
        expect(await wrap.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
        expect(await page.evaluate(() => (window as unknown as { harness: ReadingColumnHarness }).harness.anchor())).toBe(anchor);
      } finally {
        await engine.close();
      }
    },
  );
  for (const dark of [false, true]) {
    test(`${mode}: headings, bold and italic inherit body color (${dark ? "dark" : "light"})`, async () => {
      const page = await open(mode, 2560, dark);
      try {
        const result = await page.evaluate((mode) => {
          const color = (element: Element) => getComputedStyle(element).color;
          const lines = Array.from(document.querySelectorAll(".cm-line"));
          const plain =
            mode === "book" ? document.querySelector("article > p")! : lines.find((line) => line.textContent?.startsWith("Unser Team"))!;
          const styled =
            mode === "book"
              ? Array.from(document.querySelectorAll("article h1, article strong, article em"))
              : ["Gemeinsam schreiben", "wichtige Gedanken", "leise Fragen"].map((text) => {
                  const span = Array.from(document.querySelectorAll(".cm-line span")).find((span) => span.textContent === text);
                  if (!span) throw new Error(`No highlight span for ${text}.`);
                  return span;
                });
          return { body: color(plain), colors: styled.map(color) };
        }, mode);
        expect(result.colors).toHaveLength(3);
        expect(result.colors).toEqual(result.colors.map(() => result.body));
        if (dark) expect(result.colors[0]).not.toBe("rgb(210, 168, 255)");
      } finally {
        await page.close();
      }
    });
  }
  test(`${mode}: body, headings, code, notices and tables use the shared type scale`, async () => {
    const page = await open(mode, 2560);
    try {
      const body = await measure(page);
      expect(body.fontSize).toBe("16px");
      expect(body.lineHeight).toBe("25.6px");
      const sizes = await page.evaluate((mode) => {
        const headings =
          mode === "book"
            ? ["h1", "h2", "h3"].map((selector) => document.querySelector(`article ${selector}`)!)
            : ["Gemeinsam schreiben", "Planung der Woche", "Notes for everyone"].map(
                (text) => Array.from(document.querySelectorAll(".cm-line span")).find((span) => span.textContent === text)!,
              );
        return {
          headings: headings.map((element) => getComputedStyle(element).fontSize),
          notice: getComputedStyle(document.querySelector(".k2b-notice-card__body")!).fontSize,
          code: (mode === "book"
            ? [document.querySelector("article p code")!, document.querySelector("article pre")!]
            : ["cld notes list", "const team"].map(
                (text) => Array.from(document.querySelectorAll(".cm-line .cm-md-code")).find((span) => span.textContent?.includes(text))!,
              )
          ).map((element) => getComputedStyle(element).fontSize),
          cells: Array.from(
            document.querySelectorAll(mode === "book" ? "article td" : ".cm-table-widget .md-table-cell"),
            (element) => getComputedStyle(element).fontSize,
          ),
        };
      }, mode);
      expect(sizes.headings).toEqual(["30px", "24px", "20px"]);
      expect(sizes.notice).toBe("16px");
      // Inline code at 0.9em and code blocks at 0.85em, as in the Book.
      expect(sizes.code).toEqual(["14.4px", "13.6px"]);
      expect(sizes.cells.length).toBeGreaterThan(0);
      expect(sizes.cells).toEqual(sizes.cells.map(() => "14px"));
    } finally {
      await page.close();
    }
  });
  test(`${mode}: the phone keeps its 16px text inset`, async () => {
    const page = await open(mode, 390);
    try {
      const result = await measure(page);
      closeTo(result.width, 358);
      closeTo(result.left, 16);
    } finally {
      await page.close();
    }
  });
  for (const width of [2560, 390]) {
    test(`${mode}: ${mode === "book" ? "natural and explicitly sized images" : "the natural image and diagram"} align with and fit the column at ${width}px`, async () => {
      const page = await open(mode, width);
      try {
        const column = await measure(page);
        const images = mode === "book" ? ["Wochenübersicht", "Explizite Größe"] : ["Wochenübersicht"];
        for (const alt of images) {
          if (mode === "write") {
            await page.evaluate((text) => (window as unknown as { harness: ReadingColumnHarness }).harness.scrollTo(text), `![${alt}]`);
            await settle(page);
          }
          await page.locator(`img[alt="${alt}"]`).scrollIntoViewIfNeeded();
          await page.locator(`img[alt="${alt}"]`).evaluate(async (image) => {
            if (!(image instanceof HTMLImageElement)) throw new Error("Not an image.");
            await image.decode();
          });
          await settle(page);
          const image = await page.locator(`img[alt="${alt}"]`).evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return { left: rect.left, width: rect.width };
          });
          closeTo(image.left, column.left);
          expect(image.width).toBeGreaterThan(0);
          expect(image.width).toBeLessThanOrEqual(column.width);
        }
        if (mode === "write") {
          await page.locator(".cm-mermaid-widget").scrollIntoViewIfNeeded();
          await settle(page);
          expect(await page.locator(".cm-mermaid-widget").evaluate((element) => element.getBoundingClientRect().width)).toBeLessThanOrEqual(
            column.width,
          );
        }
      } finally {
        await page.close();
      }
    });
  }
}

test("source mode keeps 14px mono and centers the text column together with its gutter", async () => {
  const page = await open("source", 2560);
  try {
    const result = await page.evaluate(() => {
      const content = document.querySelector(".cm-content")!.getBoundingClientRect();
      const gutter = document.querySelector(".cm-gutters")!.getBoundingClientRect();
      const scroller = document.querySelector(".cm-scroller")!.getBoundingClientRect();
      const style = getComputedStyle(document.querySelector(".cm-line")!);
      return {
        width: content.width,
        gaps: [gutter.left - scroller.left - 16, scroller.right - 16 - content.right],
        font: style.fontFamily,
        mono: getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim(),
        size: style.fontSize,
        lineHeight: style.lineHeight,
      };
    });
    expect(result.width).toBeLessThanOrEqual(704);
    closeTo(result.width, 704);
    closeTo(result.gaps[0]!, result.gaps[1]!);
    expect(result.size).toBe("14px");
    expect(result.lineHeight).toBe("19.6px");
    expect(result.font).toContain("monospace");
    expect(result.font.replaceAll('"', "")).toBe(result.mono.replaceAll('"', ""));
  } finally {
    await page.close();
  }
});

const widgetDocument =
  "Start\n\n| A | B |\n| --- | --- |\n| a | b |\n| c | d |\n\n| Empty | Table |\n| --- | --- |\n\n:::info Hinweis\nEin Satz.\nNoch ein Satz.\n:::\n\n:::info\nEin Satz.\n:::\n\n@daten\n:::data\nname: Ada\nteam: Cloud\n:::\n\n:::data\nname: Ada\n:::\n\n```mermaid\ngraph TD\nA --> B\n```\n\nEnde";

for (const height of [500, 800, 1440]) {
  test(`block estimates cover the rendered single-line metrics at ${height}px viewport height`, async () => {
    const page = await open("write", 1280);
    try {
      await page.setViewportSize({ width: 1280, height });
      await page.evaluate(async (doc) => {
        const harness = (window as unknown as { harness: ReadingColumnHarness }).harness;
        harness.loadDocument(doc);
        await harness.settle();
      }, widgetDocument);
      const measurements = await page.evaluate(() => {
        const harness = (window as unknown as { harness: ReadingColumnHarness }).harness;
        return { actual: harness.widgetHeights(), estimates: harness.widgetEstimates() };
      });
      for (const [kind, widget] of [
        ["cm-table-widget", "TableWidget"],
        ["cm-notice-card-widget", "InfoBlockWidget"],
        ["cm-data-block-widget", "DataBlockWidget"],
        ["cm-mermaid-widget", "MermaidWidget"],
      ]) {
        const actual = measurements.actual.filter((entry) => entry.kind === kind);
        const estimates = measurements.estimates.filter((entry) => entry.kind === widget);
        expect(actual.length).toBeGreaterThan(0);
        actual.forEach((entry, index) => {
          const estimate = estimates[index]!.height;
          expect(estimate).toBeGreaterThanOrEqual(entry.height);
          expect(estimate - entry.height).toBeLessThanOrEqual(1);
        });
      }
    } finally {
      await page.close();
    }
  });
}

for (const direction of ["down", "up"]) {
  test(`scrolling ${direction} past estimated tables and blocks keeps the visible anchor in place`, async () => {
    const page = await open("write", 1280);
    try {
      const doc = Array.from({ length: 6 }, (_, index) =>
        [
          ...Array.from({ length: 35 }, (_, line) => `Paragraph ${index + 1}.${line + 1}`),
          widgetDocument.replace(/(?:@daten\n)?:::data\n[\s\S]*?:::\n\n/g, ""),
          `Anchor ${index + 1}`,
          ...Array.from({ length: 35 }, (_, line) => `Following ${index + 1}.${line + 1}`),
        ].join("\n\n"),
      ).join("\n\n");
      await page.evaluate(async (doc) => {
        const harness = (window as unknown as { harness: ReadingColumnHarness }).harness;
        harness.loadDocument(doc);
        await harness.settle();
      }, doc);
      expect(await page.locator(".cm-table-widget").count()).toBeLessThan(6);
      for (const index of direction === "down" ? [2, 4, 6] : [6, 4, 2]) {
        const result = await page.evaluate(
          (text) => (window as unknown as { harness: ReadingColumnHarness }).harness.scrollAnchor(text),
          `Anchor ${index}`,
        );
        expect(result.painted.length).toBeGreaterThan(0);
        for (const top of result.painted) closeTo(top, result.expected);
      }
    } finally {
      await page.close();
    }
  });
}

for (const { rows, truncated } of [
  { rows: 1, truncated: false },
  { rows: 2, truncated: false },
  { rows: 2, truncated: true },
]) {
  test(`query tables with ${rows} result rows${truncated ? " (truncated)" : ""} estimate their 14px table type and controls`, async () => {
    const page = await open("write", 1280, false, { queryRows: rows, queryTruncated: truncated });
    try {
      await page.waitForSelector(".cm-query-block-widget .md-table");
      await settle(page);
      expect(await page.locator(".cm-query-block-preview .notebook-book-empty").count()).toBe(truncated ? 1 : 0);
      if (truncated) {
        const count = await page.locator(".cm-query-block-preview .notebook-book-empty").evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            height: element.getBoundingClientRect().height,
            fontSize: style.fontSize,
            lineHeight: style.lineHeight,
            marginTop: style.marginTop,
            marginBottom: style.marginBottom,
          };
        });
        expect(count.fontSize).toBe("16px");
        expect(count.lineHeight).toBe("25.6px");
        expect(count.marginTop).toBe("16px");
        expect(count.marginBottom).toBe("16px");
        closeTo(count.height, 25.6);
      }
      const result = await page.evaluate(() => {
        const harness = (window as unknown as { harness: ReadingColumnHarness }).harness;
        return {
          actual: harness.widgetHeights().find((entry) => entry.kind === "cm-query-block-widget")!.height,
          estimate: harness.widgetEstimates().find((entry) => entry.kind === "QueryBlockWidget")!.height,
        };
      });
      expect(result.estimate).toBeGreaterThanOrEqual(result.actual);
      expect(result.estimate - result.actual).toBeLessThanOrEqual(1);
    } finally {
      await page.close();
    }
  });
}

for (const width of [390, 1280]) {
  test(`spaces typed where a line wraps never scroll the text sideways at ${width}px`, async () => {
    const page = await open("write", width);
    try {
      const before = await page.evaluate(() => (window as unknown as { harness: ReadingColumnHarness }).harness.sideways());
      await page.evaluate(() => (window as unknown as { harness: ReadingColumnHarness }).harness.caretAtWrap("Unser Team"));
      // Book and Write let trailing spaces hang past the column; the caret may follow them, the text stays put.
      await page.keyboard.type(" ".repeat(40));
      await settle(page);
      const after = await page.evaluate(() => (window as unknown as { harness: ReadingColumnHarness }).harness.sideways());
      expect(after.offsets).toEqual(after.offsets.map(() => 0));
      closeTo(after.left, before.left);
    } finally {
      await page.close();
    }
  });
}
