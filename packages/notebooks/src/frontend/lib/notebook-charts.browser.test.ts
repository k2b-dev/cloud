import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser, BrowserContextOptions, Locator, Page } from "playwright";
import { browserName, launchBrowser } from "../../../../ui/test/browser";
import { renderNotebookBook } from "../../lib/book-renderer";

const longTitle = "Umsatz und Kosten im Vergleich mit einem sehr langen Titel, der auf einem Telefon auf mehrere Zeilen umbricht";
const markdown = `@umsatz
| Monat | Umsatz | Kosten |
| --- | --- | --- |
| 1 | 1200 | 600 |
| 2 | 1500 | 750 |

:::chart
type: area
title: Umsatz
subtitle: Zwei Datenreihen
data: @umsatz
x: Monat
y: [Umsatz, Kosten]
tooltip:
  label: Betrag
  format: EUR
:::

:::chart
type: bar
title: Balken
columns: [Monat, Umsatz]
rows:
  - ["@team", 1200]
  - [Februar, -18]
x: Monat
y: Umsatz
tooltip:
  label: Betrag
  format: EUR
:::

:::chart
type: stat
title: Gesamt
value: 1200
tooltip:
  label: Betrag
  format: EUR
:::

:::chart
type: bar
title: ${longTitle}
columns: [Monat, Umsatz]
rows:
  - [Januar, 1200]
x: Monat
y: Umsatz
:::

:::chart
type: bar
title: Lange Tabelle
columns: [Tag, Umsatz]
rows:
${Array.from({ length: 40 }, (_, day) => `  - [Tag ${day + 1}, ${(day + 1) * 10}]`).join("\n")}
x: Tag
y: Umsatz
:::`;

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  const ui = `${resolve(import.meta.dir, "../../../../ui")}/`;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "notebook-charts.browser-harness.tsx")],
    target: "browser",
    conditions: ["browser"],
    format: "iife",
    plugins: [
      {
        name: "solid-notebook-charts-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the notebook chart harness.");
  const script = await build.outputs[0]!.text();
  const stylesheets = [resolve(import.meta.dir, "../../styles/app.css"), resolve(import.meta.dir, "../../../../../styles.css")];
  const css = [
    "@layer properties, theme, base, components, utilities;",
    ...(await Promise.all(
      stylesheets.map(async (entry) => {
        const built = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
        if (!built.success) throw new AggregateError(built.logs, `Could not compile ${entry}.`);
        return built.outputs[0]!.text();
      }),
    )),
  ].join("\n");
  const rendered = renderNotebookBook({ markdown, notebookId: "book01", locale: "de" });
  expect(rendered.diagnostics).toEqual([]);
  expect(rendered.html.match(/<figure /g)).toHaveLength(5);
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/harness.js")
        return new Response(script, { headers: { "content-type": "application/javascript" } });
      return new Response(
        `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="k2b-ui"><article class="notebook-book-content" id="notebook-book-content">${rendered.html}</article><p id="after">Nach den Diagrammen.</p><script src="/harness.js"></script></body></html>`,
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

const figures = (page: Page) => page.locator("figure.notebook-book-chart");
const drawing = (figure: Locator) => figure.locator(".k2b-chart");
const tooltip = (figure: Locator) => drawing(figure).getByRole("tooltip");
// Every amount of the note is whole, so a currency without decimals writes no cents.
const currency = (value: number) =>
  new Intl.NumberFormat("de", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(value);
const normalized = (text: string) => text.replace(/[\s\u00a0\u202f]+/g, " ").trim();
const open = async (options: BrowserContextOptions = {}) => {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, ...options });
  try {
    const page = await context.newPage();
    await page.goto(server.url.href);
    await page.waitForFunction(() => typeof window.enhance === "function");
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    return page;
  } catch (error) {
    await context.close();
    throw error;
  }
};
const enhance = (page: Page) => page.evaluate(() => window.enhance());
const showFirst = async (figure: Locator) => {
  await drawing(figure).focus();
  // Focus scrolls a chart below the fold into view, and the browser fires that scroll on the next frame. Inspection
  // closes on scroll, so a late scroll would close the tooltip Home opens and waitFor would never resolve (#1355).
  await figure.page().evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
  await drawing(figure).press("Home");
  await tooltip(figure).waitFor({ state: "visible" });
};
// Use the renderer's datum anchor, including SVG transforms. Line marks are invisible hit targets.
const markPoint = async (figure: Locator) => {
  const mark = figure.locator("[data-chart-datum]").first();
  await mark.scrollIntoViewIfNeeded();
  return mark.evaluate((element) => {
    if (!(element instanceof SVGGraphicsElement)) throw new Error("Expected an SVG mark.");
    const datum = JSON.parse(element.getAttribute("data-chart-datum")!);
    const point = new DOMPoint(...datum.anchor).matrixTransform(element.getScreenCTM()!);
    return { x: point.x, y: point.y };
  });
};
const boxes = (page: Page) =>
  page.evaluate(() =>
    Array.from(
      document.querySelectorAll(
        "figure.notebook-book-chart, figure figcaption, .notebook-book-chart__actions, .notebook-book-chart__viewport, .k2b-chart__svg, #after",
      ),
      (element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      },
    ),
  );
type Boxes = Awaited<ReturnType<typeof boxes>>;
const sameBoxes = (before: Boxes, after: Boxes) => {
  expect(after).toHaveLength(before.length);
  for (const [i, rect] of before.entries())
    for (const key of ["x", "y", "width", "height"] as const) {
      expect(Math.abs(rect[key] - after[i]![key]), `box ${i} ${key}`).toBeLessThanOrEqual(0.5);
    }
};

for (const width of [390, 1200])
  test(`${browserName}: enhancement and table view preserve chart layout at ${width}px`, async () => {
    const page = await open({ viewport: { width, height: 900 } });
    try {
      const before = await boxes(page);
      expect(before).toHaveLength(26);
      if (width === 390) expect((await figures(page).nth(3).locator("figcaption").boundingBox())!.height).toBeGreaterThan(24);
      await enhance(page);
      expect(await page.getByRole("button", { name: "Als Tabelle", exact: true }).count()).toBe(5);
      sameBoxes(before, await boxes(page));
      for (const figure of await figures(page).all()) {
        const viewport = figure.locator(".notebook-book-chart__viewport");
        // Bounding boxes are document-relative here, since clicking below the fold can scroll the page.
        const stable = () =>
          page.evaluate(() =>
            Array.from(document.querySelectorAll(".notebook-book-chart__viewport, #after"), (element) => {
              const rect = element.getBoundingClientRect();
              return { x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height };
            }),
          );
        const original = await stable();
        await figure.getByRole("button", { name: "Als Tabelle", exact: true }).click();
        expect(await viewport.locator("table").isVisible()).toBe(true);
        sameBoxes(original, await stable());
        await figure.getByRole("button", { name: "Als Tabelle", exact: true }).click();
        sameBoxes(original, await stable());
      }
      await page.evaluate(() => window.scrollTo(0, 0));
      sameBoxes(before, await boxes(page));
    } finally {
      await page.context().close();
    }
  }, 30_000);

test(`${browserName}: mouse inspection names the series, x label and formatted value`, async () => {
  const page = await open();
  try {
    await enhance(page);
    const figure = figures(page).first();
    const point = await markPoint(figure);
    await page.mouse.move(point.x, point.y);
    await tooltip(figure).waitFor({ state: "visible" });
    const text = normalized(await tooltip(figure).innerText());
    expect(text).toContain("Umsatz");
    expect(text).toContain("Monat: 1");
    expect(text).toContain(normalized(currency(1200)));
    expect(text).toContain("Kosten");
    expect(text).toContain(normalized(currency(600)));
    await page.mouse.move(1, 1);
    await tooltip(figure).waitFor({ state: "hidden" });
  } finally {
    await page.context().close();
  }
});

test(`${browserName}: keyboard order has two controls and one drawing stop per chart`, async () => {
  const page = await open();
  try {
    await enhance(page);
    for (let i = 0; i < 4; i++) {
      const figure = figures(page).nth(i);
      await page.keyboard.press("Tab");
      expect(
        await figure.getByRole("button", { name: "Daten kopieren", exact: true }).evaluate((node) => node === document.activeElement),
      ).toBe(true);
      await page.keyboard.press("Tab");
      expect(
        await figure.getByRole("button", { name: "Als Tabelle", exact: true }).evaluate((node) => node === document.activeElement),
      ).toBe(true);
      await page.keyboard.press("Tab");
      expect(await drawing(figure).evaluate((node) => node === document.activeElement)).toBe(true);
      if (i === 0) {
        // The shared inspector also shows a value on focus. Escape resets its cursor before arrow navigation.
        await page.keyboard.press("Escape");
        await tooltip(figure).waitFor({ state: "hidden" });
        await page.keyboard.press("ArrowRight");
        await tooltip(figure).waitFor({ state: "visible" });
        expect(normalized(await tooltip(figure).innerText())).toContain(`Monat: 1 Betrag: ${normalized(currency(1200))}`);
        await page.keyboard.press("ArrowRight");
        expect(normalized(await tooltip(figure).innerText())).toContain(`Monat: 2 Betrag: ${normalized(currency(1500))}`);
        await page.keyboard.press("Home");
        expect(normalized(await tooltip(figure).innerText())).toContain("Monat: 1");
        await page.keyboard.press("End");
        expect(normalized(await tooltip(figure).innerText())).toContain("Monat: 2");
        await page.keyboard.press("Escape");
        await tooltip(figure).waitFor({ state: "hidden" });
      }
    }
  } finally {
    await page.context().close();
  }
});

test(`${browserName}: touch inspection closes after a tap outside`, async () => {
  const page = await open({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  try {
    await enhance(page);
    const figure = figures(page).first();
    const point = await markPoint(figure);
    await page.touchscreen.tap(point.x, point.y);
    await tooltip(figure).waitFor({ state: "visible" });
    expect(normalized(await tooltip(figure).innerText())).toContain(normalized(currency(1200)));
    // Stay at the same scroll position: scrolling itself also dismisses inspection.
    await page.touchscreen.tap(2, 2);
    await tooltip(figure).waitFor({ state: "hidden" });
  } finally {
    await page.context().close();
  }
});

test(`${browserName}: table toggle shows the tooltip values in the same viewport`, async () => {
  const page = await open();
  try {
    await enhance(page);
    const figure = figures(page).first();
    await showFirst(figure);
    const value = normalized(await tooltip(figure).locator("b").nth(1).innerText());
    const toggle = figure.getByRole("button", { name: "Als Tabelle", exact: true });
    await toggle.click();
    expect(await toggle.getAttribute("aria-pressed")).toBe("true");
    const table = figure.locator(".notebook-book-chart__viewport").getByRole("table", { name: "Umsatz", exact: true });
    expect(await table.isVisible()).toBe(true);
    expect(await table.getByRole("columnheader").allTextContents()).toEqual(["Datenreihe", "Monat", "Betrag"]);
    expect((await table.getByRole("cell").allTextContents()).map(normalized)).toEqual([
      "Umsatz",
      "1",
      normalized(currency(1200)),
      "Umsatz",
      "2",
      normalized(currency(1500)),
      "Kosten",
      "1",
      normalized(currency(600)),
      "Kosten",
      "2",
      normalized(currency(750)),
    ]);
    expect(normalized(await table.innerText())).toContain(value);
    expect(await drawing(figure).isVisible()).toBe(false);
    await tooltip(figure).waitFor({ state: "hidden" });
    await toggle.click();
    expect(await toggle.getAttribute("aria-pressed")).toBe("false");
    expect(await figure.locator("table").count()).toBe(0);
    expect(await drawing(figure).isVisible()).toBe(true);
  } finally {
    await page.context().close();
  }
});

const clipboard = (page: Page, reject: boolean) =>
  page.addInitScript((reject) => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          if (reject) throw new Error("Clipboard denied");
          window.chartClipboard = text;
        },
      },
    });
  }, reject);

test(`${browserName}: Copy data writes formatted TSV and guards formula-like labels`, async () => {
  const page = await open();
  try {
    await clipboard(page, false);
    await page.reload();
    await page.waitForFunction(() => typeof window.enhance === "function");
    await enhance(page);
    await figures(page).first().getByRole("button", { name: "Daten kopieren", exact: true }).click();
    await page.waitForFunction(() => window.chartClipboard !== undefined);
    expect(await page.evaluate(() => window.chartClipboard)).toBe(
      `Datenreihe\tMonat\tBetrag\nUmsatz\t1\t${currency(1200)}\nUmsatz\t2\t${currency(1500)}\nKosten\t1\t${currency(600)}\nKosten\t2\t${currency(750)}`,
    );
    await page.evaluate(() => {
      delete window.chartClipboard;
    });
    await figures(page).nth(1).getByRole("button", { name: "Daten kopieren", exact: true }).click();
    await page.waitForFunction(() => window.chartClipboard !== undefined);
    expect(await page.evaluate(() => window.chartClipboard)).toBe(
      `Kategorie\tBetrag\n'@team\t${currency(1200)}\nFebruar\t${currency(-18)}`,
    );
  } finally {
    await page.context().close();
  }
});

test(`${browserName}: a clipboard rejection shows the German recovery message`, async () => {
  const page = await open();
  try {
    await clipboard(page, true);
    await page.reload();
    await page.waitForFunction(() => typeof window.enhance === "function");
    await enhance(page);
    await figures(page).first().getByRole("button", { name: "Daten kopieren", exact: true }).click();
    // toast.error creates its own shared toast rail; no separate host is required.
    await page
      .locator("[data-k2b-toast-container]")
      .getByText("Die Daten konnten nicht kopiert werden. Versuche es erneut oder markiere die Werte in der Tabelle.", { exact: true })
      .waitFor({ state: "visible" });
    expect(await page.evaluate(() => window.chartClipboard)).toBeUndefined();
  } finally {
    await page.context().close();
  }
});

test(`${browserName}: reduced motion shows the tooltip without transitions or animations`, async () => {
  const page = await open({ reducedMotion: "reduce" });
  try {
    await enhance(page);
    const figure = figures(page).first();
    await showFirst(figure);
    const durations = await tooltip(figure).evaluate((node) => {
      const css = getComputedStyle(node);
      return { transition: css.transitionDuration, animation: css.animationDuration };
    });
    for (const duration of Object.values(durations)) expect(duration.split(",").every((value) => value.trim() === "0s")).toBe(true);
    expect(normalized(await tooltip(figure).innerText())).toContain(normalized(currency(1200)));
  } finally {
    await page.context().close();
  }
});

test(`${browserName}: dark mode keeps chart inspection visible`, async () => {
  const page = await open({ colorScheme: "dark" });
  try {
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await enhance(page);
    const figure = figures(page).first();
    await showFirst(figure);
    expect(normalized(await tooltip(figure).innerText())).toContain(normalized(currency(1200)));
    expect(await tooltip(figure).isVisible()).toBe(true);
  } finally {
    await page.context().close();
  }
});

test(`${browserName}: repeated enhancement mounts once and cleanup restores the server figures`, async () => {
  const page = await open();
  try {
    const original = await figures(page).evaluateAll((nodes) => nodes.map((node) => node.outerHTML));
    await enhance(page);
    await enhance(page);
    expect(await page.getByRole("button", { name: "Als Tabelle", exact: true }).count()).toBe(5);
    expect(await page.getByRole("button", { name: "Daten kopieren", exact: true }).count()).toBe(5);
    for (const figure of await figures(page).all()) {
      await showFirst(figure);
      // By keyboard: a pointer left on this button would rest over the next chart once focus scrolls it into view,
      // and WebKit's hover update after that scroll closes the inspection (#1355).
      await figure.getByRole("button", { name: "Als Tabelle", exact: true }).press("Enter");
    }
    await page.evaluate(() => window.restore());
    expect(await figures(page).evaluateAll((nodes) => nodes.map((node) => node.outerHTML))).toEqual(original);
    expect(
      await figures(page).locator("button, table, .k2b-chart[role], .k2b-chart[aria-label], [data-interactive], [tabindex]").count(),
    ).toBe(0);
    expect(await page.locator("figure[data-enhanced], figure[data-view]").count()).toBe(0);
    await enhance(page);
    expect(await page.getByRole("button", { name: "Als Tabelle", exact: true }).count()).toBe(5);
    await page.evaluate(() => {
      window.restore();
      window.restore();
    });
    expect(await figures(page).evaluateAll((nodes) => nodes.map((node) => node.outerHTML))).toEqual(original);
  } finally {
    await page.context().close();
  }
});

test(`${browserName}: a long table scrolls by keyboard inside the chart frame`, async () => {
  const page = await open();
  try {
    await enhance(page);
    const figure = figures(page).last();
    const toggle = figure.getByRole("button", { name: "Als Tabelle", exact: true });
    await toggle.click();
    const region = figure.getByRole("region", { name: "Lange Tabelle", exact: true });
    expect(await region.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
    await toggle.focus();
    await page.keyboard.press("Tab");
    expect(await region.evaluate((node) => node === document.activeElement)).toBe(true);
    await page.keyboard.press("PageDown");
    await page.waitForFunction(() => document.activeElement!.scrollTop > 0);
  } finally {
    await page.context().close();
  }
});

test(`${browserName}: printing a chart switched to its table prints every row without overlap`, async () => {
  const page = await open();
  try {
    await enhance(page);
    const figure = figures(page).last();
    await figure.getByRole("button", { name: "Als Tabelle", exact: true }).click();
    const viewport = figure.locator(".notebook-book-chart__viewport");
    const screenHeight = (await viewport.boundingBox())!.height;
    await page.emulateMedia({ media: "print" });
    try {
      expect(await figure.locator(".notebook-book-chart__actions").isVisible()).toBe(false);
      const table = (await figure.locator("table").boundingBox())!;
      const frame = (await viewport.boundingBox())!;
      expect(frame.height).toBeGreaterThan(screenHeight);
      expect(frame.y + frame.height).toBeGreaterThanOrEqual(table.y + table.height - 0.5);
      expect((await page.locator("#after").boundingBox())!.y).toBeGreaterThanOrEqual(table.y + table.height - 0.5);
    } finally {
      await page.emulateMedia({ media: "screen" });
    }
    expect(Math.abs((await viewport.boundingBox())!.height - screenHeight)).toBeLessThanOrEqual(0.5);
  } finally {
    await page.context().close();
  }
});
