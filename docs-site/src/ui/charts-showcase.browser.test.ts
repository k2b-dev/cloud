import { afterAll, beforeAll, expect, test } from "bun:test";
import { launchBrowser, pageErrors, settled } from "../../../packages/ui/test/browser";
import { showcaseDashboards } from "./demo-sections/charts/dashboards";
import { chartShowcaseKinds } from "./demo-sections/charts/examples";

// Driven by the showcase registry: the real Fibel pages of the overview, every kind and both dashboards render on
// the server, hydrate without a console error into the same markup, and keep every frame in place while the state
// switch walks through data, loading, empty, error and stale, on a desktop and a phone.
type Browser = Awaited<ReturnType<typeof launchBrowser>>;
type Page = Awaited<ReturnType<Browser["newPage"]>>;

const { plugin } = await import("../ssr");
Bun.plugin(plugin());
await (await import("../build-assets")).buildAssets();
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
                    // Tables measure their scroll bars after mounting.
                    .filter((declaration) => declaration && !declaration.startsWith("--k2b-data-table-scroll"))
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
        expect(await page.locator(".ui-charts-slot").count(), kind.kind).toBe(0);
        for (const example of kind.examples) {
          if (kind.examples.length > 1) await pick(page, "Example", example.title);
          const before = await frames(page, ".ui-charts-stage .ui-charts-frame");
          expect(before.length, example.id).toBe(1);
          if (width === 1280) {
            // Focus inspects the first value: its tooltip names it, also for the first mark of the chart.
            await page.locator(".ui-charts-stage .k2b-chart[tabindex]").first().focus();
            const tooltip = page.locator('.ui-charts-stage [role="tooltip"]:popover-open');
            await tooltip.waitFor({ state: "visible" });
            expect((await tooltip.locator(".k2b-chart__tooltip-row").count()) > 0, example.id).toBe(true);
            await page.keyboard.press("Escape");
            // The table view lists the typed rows inside the same frame.
            await pick(page, "View", "Table");
            expect(await page.locator(".ui-charts-stage tbody tr").count(), example.id).toBeGreaterThan(0);
            expect(await frames(page, ".ui-charts-stage .ui-charts-frame").then((boxes) => boxes[0]![0])).toEqual(before[0]![0]);
            await pick(page, "View", "Chart");
          }
          for (const state of states) {
            await pick(page, "State", state);
            expect({ example: example.id, state, frames: await frames(page, ".ui-charts-stage .ui-charts-frame") }).toEqual({
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
    for (const width of [1280, 390]) {
      const { page, errors } = await open(`/en/ui/charts/dashboards/${dashboard.slug}`, width);
      try {
        const before = await frames(page, ".ui-charts-grid__cell > *, .ui-charts-tile");
        expect(before.length, dashboard.slug).toBeGreaterThan(4);
        for (const state of states) {
          await pick(page, "Preview state", state);
          expect({
            dashboard: dashboard.slug,
            width,
            state,
            frames: await frames(page, ".ui-charts-grid__cell > *, .ui-charts-tile"),
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
