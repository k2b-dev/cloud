import { afterAll, beforeAll, expect, test } from "bun:test";
import { launchBrowser, pageErrors, settled } from "../../../packages/ui/test/browser";

// Driven by the showcase registry: the real Fibel pages of the overview, every kind and both dashboards render on
// the server, hydrate without a console error into the same markup, and keep every frame in place while the state
// switch walks through data, loading, empty, error and stale, on a desktop and a phone.
type Browser = Awaited<ReturnType<typeof launchBrowser>>;
type Page = Awaited<ReturnType<Browser["newPage"]>>;

const { plugin } = await import("../ssr");
Bun.plugin(plugin());
// buildAssets regenerates the example registry, so the list below is the one the pages draw.
await (await import("../build-assets")).buildAssets();
const { showcaseDashboards } = await import("./demo-sections/charts/dashboards");
const { chartShowcaseKinds } = await import("./demo-sections/charts/examples");
const { default: app } = await import("../server");

let browser: Browser | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let origin: string;
beforeAll(async () => {
  browser = await launchBrowser();
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  origin = `http://127.0.0.1:${server.port}`;
}, 120_000);
afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    server?.stop(true);
  }
});

const states = ["Loading", "Empty", "Error", "Stale", "Data"];
/**
 * Island markup in a canonical form: @k2b/ssr renders islands again in the browser, so attribute order and the
 * generated ids (and the references to them) may differ; every element, attribute value and text must not.
 */
const islands = (page: Page) =>
  page.evaluate(() => {
    // Generated ids, and the marks of enhancements that run after mounting: tooltips move a title into their
    // popover, and scroll areas measure and mark their overflow.
    const generated = new Set([
      "id",
      "for",
      "aria-describedby",
      "aria-labelledby",
      "aria-controls",
      "data-hk",
      "title",
      "data-scrollbar-enhanced",
    ]);
    const canonical = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
      if (!(node instanceof Element)) return "";
      const attributes = [...node.attributes]
        .filter(
          (attribute) =>
            !generated.has(attribute.name) &&
            !attribute.name.startsWith("data-overflow") &&
            // The server writes an empty field's value; the browser sets the property instead.
            !(attribute.value === "" && (attribute.name === "style" || attribute.name === "class" || attribute.name === "value")),
        )
        .map((attribute) => {
          // The server writes class and style as text, the browser as tokens and declarations.
          const value =
            attribute.name === "class"
              ? attribute.value.split(/\s+/).filter(Boolean).sort().join(" ")
              : attribute.name === "style"
                ? attribute.value
                    .split(";")
                    .map((declaration) => declaration.replace(/\s+/g, ""))
                    // Tables measure their scroll bars and calendars their sticky header after mounting.
                    .filter(
                      (declaration) =>
                        declaration &&
                        !declaration.startsWith("--k2b-data-table-scroll") &&
                        !declaration.startsWith("--k2b-calendar-header"),
                    )
                    // The browser keeps fewer decimals: 12.000% reads 12%, 52.33333% reads 52.3333%.
                    .map((declaration) => declaration.replace(/\d+\.\d+/g, (number) => String(Number(Number(number).toFixed(3)))))
                    .sort()
                    .join(";")
                : // stdlib numbers sparkline gradients per process, so a server that rendered earlier pages counts on.
                  attribute.value.replace(/stdlib-spark-grad-\d+/g, "stdlib-spark-grad");
          return `${attribute.name}="${value}"`;
        })
        .sort()
        .join(" ");
      return `<${node.localName}${attributes ? ` ${attributes}` : ""}>${[...node.childNodes].map(canonical).join("")}</${node.localName}>`;
    };
    return [...document.querySelectorAll("solid-island")].map((island) => [...island.childNodes].map(canonical).join(""));
  });
const frames = (page: Page, scope: string) =>
  page.evaluate(
    (selector) =>
      [...document.querySelectorAll(selector)].map((frame) =>
        [
          frame,
          frame.querySelector(".k2b-chart-explorer__title"),
          frame.querySelector(".k2b-chart-explorer__description"),
          frame.querySelector(".k2b-chart-explorer__viewport"),
        ].map((element) => {
          const box = element?.getBoundingClientRect();
          return box ? [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)] : null;
        }),
      ),
    scope,
  );
/** Clicks a segment of the named switch until the hydrated island has taken it. */
const pick = async (page: Page, group: string, label: string) => {
  // More than three examples read as one menu instead of segments.
  if (!(await page.getByRole("radiogroup", { name: group }).count())) {
    const trigger = page.getByRole("button", { name: group, exact: true });
    for (let attempt = 0; attempt < 40 && !(await trigger.textContent())?.includes(label); attempt++) {
      await trigger.click();
      const option = page.locator('[role="menuitemradio"], [role="option"]').filter({ hasText: label }).first();
      if (await option.isVisible()) await option.click();
      else await page.waitForTimeout(100);
    }
    expect(await trigger.textContent(), `${group}: ${label}`).toContain(label);
    await settled(page);
    return;
  }
  const option = page.getByRole("radiogroup", { name: group }).getByRole("radio", { name: label, exact: true });
  // A click before the island has mounted lands on server markup; try again until the island takes it.
  for (let attempt = 0; attempt < 40 && (await option.getAttribute("aria-checked")) !== "true"; attempt++) {
    await option.click();
    if ((await option.getAttribute("aria-checked")) !== "true") await page.waitForTimeout(100);
  }
  expect(await option.getAttribute("aria-checked"), `${group}: ${label}`).toBe("true");
  await settled(page);
};

const open = async (path: string, width: number) => {
  const plain = await browser!.newPage({ viewport: { width, height: 900 }, javaScriptEnabled: false });
  await plain.goto(`${origin}${path}`);
  const server = await islands(plain);
  await plain.close();
  const page = await browser!.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  const errors = pageErrors(page);
  page.on("console", (message) => {
    if (message.type() === "error" || (message.type() === "warning" && /hydrat/i.test(message.text()))) errors.push(message.text());
  });
  await page.goto(`${origin}${path}`, { waitUntil: "networkidle" });
  await settled(page);
  expect(server.length).toBeGreaterThan(0);
  expect(await islands(page)).toEqual(server);
  return { page, errors };
};

test("the overview hydrates its live cards without a console error", async () => {
  const { page, errors } = await open("/en/ui/charts", 1280);
  try {
    expect(await page.locator(".ui-charts-card").count()).toBe(chartShowcaseKinds.length);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 120_000);

for (const width of [1280, 390]) {
  test(`every kind's examples keep their frame in every state at ${width} px`, async () => {
    for (const kind of chartShowcaseKinds) {
      const { page, errors } = await open(`/en/ui/charts/${kind.slug}`, width);
      try {
        // Every kind that has a page today draws; slots belong only to dashboards waiting for other lanes.
        expect(await page.locator(".ui-charts-slot").count(), kind.kind).toBe(0);
        for (const example of kind.examples) {
          if (kind.examples.length > 1) await pick(page, "Example", example.title);
          const before = await frames(page, ".ui-charts-stage > :first-child");
          expect(before.length, example.id).toBe(1);
          // Charts inspect and turn into tables; blocks such as key figures draw with their own components.
          const block =
            Array.isArray(example.spec) || (typeof example.spec === "object" && example.spec !== null && "block" in example.spec);
          if (width === 1280 && !block) {
            // Focus inspects the first value: its tooltip names it, also for the first mark of the chart.
            await page.locator(".ui-charts-stage .k2b-chart[tabindex]").first().focus();
            const tooltip = page.locator('.ui-charts-stage [role="tooltip"]:popover-open');
            await tooltip.waitFor({ state: "visible" });
            expect((await tooltip.locator(".k2b-chart__tooltip-row").count()) > 0, example.id).toBe(true);
            await page.keyboard.press("Escape");
            // The table view lists the typed rows inside the same frame.
            await pick(page, "View", "Table");
            expect(await page.locator(".ui-charts-stage tbody tr").count(), example.id).toBeGreaterThan(0);
            expect(await frames(page, ".ui-charts-stage > :first-child").then((boxes) => boxes[0]![0])).toEqual(before[0]![0]);
            await pick(page, "View", "Chart");
          }
          for (const state of states) {
            await pick(page, "State", state);
            expect({ example: example.id, state, frames: await frames(page, ".ui-charts-stage > :first-child") }).toEqual({
              example: example.id,
              state,
              frames: before,
            });
          }
        }
        expect(errors, kind.kind).toEqual([]);
      } finally {
        await page.close();
      }
    }
  }, 600_000);
}

test("both dashboards keep every panel in place in every state", async () => {
  for (const dashboard of showcaseDashboards) {
    for (const width of [1440, 390]) {
      const { page, errors } = await open(`/en/ui/charts/dashboards/${dashboard.slug}`, width);
      try {
        const before = await frames(page, ".k2b-dashboard-section__grid > .k2b-dashboard-frame, .k2b-stat-cell");
        expect(before.length, dashboard.slug).toBeGreaterThan(4);
        // Every panel keeps its title and its controls on one row, also in a third of the grid and on a phone.
        const wrapped = await page.$$eval(".k2b-chart-explorer > .k2b-chart-explorer__header", (headers) =>
          headers.flatMap((header) => {
            const parts = [...header.children].map((part) => part.getBoundingClientRect());
            return parts.length > 1 && parts.at(-1)!.top >= parts[0]!.bottom - 2
              ? [header.querySelector(".k2b-chart-explorer__title")?.textContent ?? ""]
              : [];
          }),
        );
        expect({ dashboard: dashboard.slug, width, wrapped }).toEqual({ dashboard: dashboard.slug, width, wrapped: [] });
        for (const state of states) {
          await pick(page, "Preview state", state);
          expect({
            dashboard: dashboard.slug,
            width,
            state,
            frames: await frames(page, ".k2b-dashboard-section__grid > .k2b-dashboard-frame, .k2b-stat-cell"),
          }).toEqual({
            dashboard: dashboard.slug,
            width,
            state,
            frames: before,
          });
        }
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    }
  }
}, 600_000);

// Geometry comes from the real server document. Keep hydration in open()/the
// parity tests: starting every overview island is unrelated to these bounds.
// A script-src 'none' policy keeps the document exactly the server markup while
// test evaluation (settled, measurements) still runs.
const openServerGeometry = async (width: number, height: number, path: string) => {
  const page = await browser!.newPage({ viewport: { width, height }, reducedMotion: "reduce" });
  await page.route(`${origin}${path}`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": "script-src 'none'" } });
  });
  const response = await page.goto(`${origin}${path}`, { waitUntil: "load" });
  expect(response!.ok()).toBe(true);
  await settled(page);
  return { page, response: response! };
};

for (const width of [390, 800, 1440, 1920]) {
  for (const path of ["/en/ui/charts/calendar", "/en/ui/charts/dashboards/newsletter", "/en/ui/charts"]) {
    test(`calendar starts flush with newest weeks in ${path} at ${width}px`, async () => {
      const { page, response } = await openServerGeometry(width, 1000, path);
      const errors = pageErrors(page);
      try {
        const selector = ".k2b-chart__svg > svg[data-calendar]";
        const serverSvg = await page.evaluate(
          (html) => new DOMParser().parseFromString(html, "text/html").querySelector(".k2b-chart__svg > svg[data-calendar]")!.outerHTML,
          await response!.text(),
        );
        expect(
          await page
            .locator(selector)
            .first()
            .evaluate((e) => e.outerHTML),
        ).toBe(serverSvg);
        const calendar = page
          .locator(".k2b-chart")
          .filter({ has: page.locator("svg[data-calendar]") })
          .first();
        expect(await calendar.count(), path).toBe(1);
        const geometry = await calendar.evaluate((element) => {
          const viewport = element.getBoundingClientRect();
          const drawing = element.querySelector(".k2b-chart__svg")!.getBoundingClientRect();
          const newest = element.querySelectorAll("[data-chart-datum] rect");
          const last = newest[newest.length - 1]!.getBoundingClientRect();
          const label = element.querySelector("[data-calendar-weekdays] text")!.getBoundingClientRect();
          const firstVisible = [...newest]
            .map((e) => e.getBoundingClientRect())
            .filter((b) => b.left >= label.right - 0.1)
            .sort((a, b) => a.left - b.left)[0]!;
          return {
            left: element.scrollLeft,
            gap: drawing.width > viewport.width ? drawing.right - viewport.right : drawing.left - viewport.left,
            lastRight: last.right - viewport.right,
            lastLeft: last.left - viewport.left,
            cell: last.width,
            square: Math.abs(last.width - last.height),
            labelGap: firstVisible.left - label.right,
            labelLeft: label.left - viewport.left,
            railLeft: element.querySelector("[data-calendar-weekdays] > rect")!.getBoundingClientRect().left - viewport.left,
            height: drawing.height,
            viewportHeight: viewport.height,
          };
        });
        expect(Math.abs(geometry.gap), path).toBeLessThan(1);
        expect(geometry.labelGap, path).toBeGreaterThanOrEqual(0);
        expect(geometry.labelGap, path).toBeLessThanOrEqual(8);
        expect(geometry.labelLeft, path).toBeGreaterThanOrEqual(0);
        expect(geometry.railLeft, path).toBeLessThanOrEqual(0);
        expect(geometry.left, path).toBe(0);
        expect(geometry.lastRight, path).toBeLessThanOrEqual(1);
        expect(geometry.lastLeft, path).toBeGreaterThanOrEqual(0);
        expect(geometry.cell, path).toBeLessThanOrEqual(32.1);
        expect(geometry.square, path).toBeLessThan(0.2);
        expect(geometry.viewportHeight - geometry.height, path).toBeGreaterThanOrEqual(-1);
        expect(geometry.viewportHeight - geometry.height, path).toBeLessThanOrEqual(17);
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    });
  }
}

for (const width of [390, 1440]) {
  test(`distribution overview cards keep axes and name/value blocks inside at ${width}px`, async () => {
    // This guard measures server SVGs. Hydrating every overview card belongs to
    // the separate parity test and must not consume this geometry test's budget.
    const { page } = await openServerGeometry(width, 900, "/en/ui/charts");
    const errors = pageErrors(page);
    try {
      const pareto = page.locator('[data-chart-kind="pareto"]');
      expect(await pareto.count()).toBe(1);
      expect(await pareto.locator("svg > text").count()).toBeGreaterThan(0);
      const ticks = await pareto.evaluate((e) => {
        const b = e.getBoundingClientRect();
        return Array.from(e.querySelectorAll("svg > text")).every((t) => {
          const r = t.getBoundingClientRect();
          return r.left >= b.left - 1 && r.right <= b.right + 1;
        });
      });
      expect(ticks).toBe(true);
      const treemap = page.locator('[data-chart-kind="treemap"]');
      expect(await treemap.count()).toBe(1);
      expect(await treemap.locator("[data-treemap-name]").count()).toBeGreaterThan(0);
      expect(await treemap.locator("[data-treemap-value]").count()).toBeGreaterThan(0);
      const fits = await treemap.locator("[data-chart-datum]").evaluateAll((groups) =>
        groups.every((g) => {
          const text = g.querySelector("[data-treemap-name]");
          if (!text) return true;
          const cell = g.querySelector("rect")!.getBoundingClientRect(),
            name = text.getBoundingClientRect(),
            value = g.querySelector("[data-treemap-value]")?.getBoundingClientRect();
          return (
            name.left >= cell.left - 1 &&
            name.right <= cell.right + 1 &&
            name.bottom <= cell.bottom + 1 &&
            (!value ||
              (name.bottom <= value.top && value.left >= cell.left - 1 && value.right <= cell.right + 1 && value.bottom <= cell.bottom + 1))
          );
        }),
      );
      expect(fits).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
}

for (const width of [390, 1440]) {
  test(`small Sankey card keeps its source label inside the initial viewport at ${width}px`, async () => {
    const { page } = await openServerGeometry(width, 900, "/en/ui/charts");
    const errors = pageErrors(page);
    try {
      const card = page.locator(".ui-charts-card").filter({ has: page.getByRole("heading", { name: "Sankey", exact: true }) });
      const scroller = card.locator(".ui-charts-card__chart");
      expect(await scroller.evaluate((e) => e.scrollLeft)).toBe(0);
      const source = card
        .locator("[data-chart-datum]")
        .filter({ has: page.locator("rect") })
        .first()
        .locator("text");
      expect(await source.textContent()).toContain("Clicked");
      const viewport = await scroller.boundingBox(),
        label = await source.boundingBox();
      expect(label!.x).toBeGreaterThanOrEqual(viewport!.x);
      expect(label!.x + label!.width).toBeLessThanOrEqual(viewport!.x + viewport!.width);
      const inside = await card.locator("[data-chart-datum] text").evaluateAll((nodes) =>
        nodes.every((e) => {
          const b = (e as SVGGraphicsElement).getBBox(),
            svg = e.closest("svg") as SVGSVGElement;
          return b.x >= 0 && b.x + b.width <= svg.viewBox.baseVal.width;
        }),
      );
      expect(inside).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
}
