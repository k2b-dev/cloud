import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { browserName, launchBrowser } from "../../../../../../ui/test/browser";
import { HANDBOOK_IDS } from "./graph.fixtures";
import { startGraphServer } from "./notebook-graph.browser-server";

let browser: Browser;
let server: Awaited<ReturnType<typeof startGraphServer>>;
beforeAll(async () => {
  server = await startGraphServer();
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  await server?.stop(true);
});

const WAREHOUSE = HANDBOOK_IDS.wein!;
const graphPath = (notebook: string, query = "") => `/app/notebooks/${notebook}?mode=graph&from=book${query}`;
const nodes = (page: Page) => page.locator("[data-node]");
/** Labels are placed once the fonts are ready; an empty or list state has no canvas. */
const settled = (page: Page) =>
  page.waitForFunction(() => !document.querySelector(".notebook-graph__svg") || document.querySelector(".notebook-graph__label") !== null);
const open = async (path: string, viewport = { width: 1440, height: 900 }, options: BrowserContextOptions = {}) => {
  const context = await browser.newContext({ viewport, ...options });
  const page = await context.newPage();
  await page.goto(new URL(path, server.url).href);
  await page.waitForFunction(() => window.notebookGraphFixture?.mounted === true);
  await settled(page);
  return page;
};
const close = (page: Page) => page.context().close();
const positions = (page: Page) =>
  nodes(page).evaluateAll((items) =>
    Object.fromEntries(items.map((item) => [item.getAttribute("data-node"), item.getAttribute("transform")])),
  );
const nodeCenter = async (page: Page, id: string) => {
  const box = (await page.locator(`[data-node="${id}"] .notebook-graph__disc`).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
const search = (page: Page) => new URL(page.url()).searchParams;

test(`${browserName}: the network stands still: positions at mount equal positions a second later`, async () => {
  const page = await open(graphPath("hand01"));
  try {
    const before = await positions(page);
    expect(Object.keys(before)).toHaveLength(49);
    await page.waitForTimeout(1000);
    expect(await positions(page)).toEqual(before);
  } finally {
    await close(page);
  }
}, 30_000);

for (const [notebook, notes] of [
  ["hand01", 49],
  ["big001", 300],
] as const) {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    test(`${browserName}: labels of ${notes} notes never overlap and never leave the canvas at ${viewport.width}`, async () => {
      const page = await open(graphPath(notebook), viewport);
      try {
        const { boxes, canvas } = await page.evaluate(() => {
          const rect = (element: Element) => {
            const box = element.getBoundingClientRect();
            return { x0: box.left, y0: box.top, x1: box.right, y1: box.bottom };
          };
          return {
            boxes: [...document.querySelectorAll(".notebook-graph__label, .notebook-graph__area-label")].map(rect),
            canvas: rect(document.querySelector(".notebook-graph__svg")!),
          };
        });
        expect(boxes.length).toBeGreaterThan(5);
        for (const [index, a] of boxes.entries()) {
          expect(a.x0).toBeGreaterThanOrEqual(canvas.x0);
          expect(a.x1).toBeLessThanOrEqual(canvas.x1);
          expect(a.y0).toBeGreaterThanOrEqual(canvas.y0);
          expect(a.y1).toBeLessThanOrEqual(canvas.y1);
          for (const b of boxes.slice(index + 1)) {
            const overlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0.5 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0.5;
            expect(overlap).toBe(false);
          }
        }
        // The status line counts every note, also those without a label.
        expect(await page.locator(".notebook-graph__status").textContent()).toContain(`${notes} notes`);
        if (notebook === "hand01") expect(await page.locator(`[data-label="${WAREHOUSE}"]`).getAttribute("data-kind")).toBe("current");
        if (notebook === "big001")
          console.info(`${browserName} ${viewport.width}px: ${await page.locator(".notebook-graph__label").count()} of 300 notes labelled`);
      } finally {
        await close(page);
      }
    }, 30_000);
  }
}

test(`${browserName}: Close, zoom and the navigation toggle live in toolbars, not in corners`, async () => {
  const page = await open(graphPath("hand01"));
  try {
    const tools = page.getByRole("toolbar", { name: "Graph tools" });
    const filters = page.getByRole("toolbar", { name: "Graph filters" });
    const close = tools.getByRole("link", { name: "Close graph", exact: true });
    expect(await close.isVisible()).toBe(true);
    for (const name of ["Zoom out", "Zoom in", "Fit graph"]) expect(await filters.getByRole("button", { name }).isVisible()).toBe(true);
    const placement = await page.evaluate(() =>
      [...document.querySelectorAll('.notebook-graph [aria-label="Close graph"], .notebook-graph [aria-label^="Zoom"]')].map(
        (element) => getComputedStyle(element).position,
      ),
    );
    expect(placement.every((position) => position !== "absolute" && position !== "fixed")).toBe(true);
    const toggle = tools.getByRole("button", { name: "Hide navigation" });
    expect(await toggle.getAttribute("aria-controls")).toBe("notebook-navigation");
    await toggle.click();
    // The toolbar keeps the only way back; no second control appears in a corner of the graph.
    const show = page.locator('[aria-controls="notebook-navigation"]:visible');
    await page.waitForFunction(() => document.querySelectorAll('[aria-controls="notebook-navigation"][aria-expanded="false"]').length > 0);
    expect(await show.count()).toBe(1);
    expect(await tools.getByRole("button", { name: "Show navigation" }).isVisible()).toBe(true);
  } finally {
    await close(page);
  }
}, 30_000);

test(`${browserName}: the Book update notice stays below the graph toolbars`, async () => {
  const page = await open(graphPath("hand01"));
  try {
    await page.evaluate((notebookId) => {
      window.dispatchEvent(
        new CustomEvent("notebooks.workspace.event", {
          detail: {
            cursor: null,
            event: { type: "note.updated", notebookId },
            cover: (coverage: Promise<void>) => coverage.catch(() => {}),
          },
        }),
      );
    }, "hand01");
    const notice = page.getByRole("alert");
    await notice.waitFor();
    const box = (await notice.boundingBox())!;
    for (const name of ["Graph tools", "Graph filters"]) {
      const bar = (await page.getByRole("toolbar", { name }).boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(bar.y + bar.height);
    }
  } finally {
    await close(page);
  }
}, 30_000);

test(`${browserName}: the graph is one tab stop with arrows, Home and Enter inside`, async () => {
  const page = await open(graphPath("hand01"));
  try {
    const activeNode = () => page.evaluate(() => document.activeElement?.getAttribute("data-node") ?? null);
    await page.locator('.notebook-graph__filters [tabindex="0"]').first().focus();
    await page.keyboard.press("Tab");
    expect(await activeNode()).toBe(WAREHOUSE);
    expect(await page.locator(`[data-node="${WAREHOUSE}"]`).getAttribute("aria-label")).toBe(
      "Wareneingang, area Wareneingang, links to 7, linked from 2, current note",
    );
    expect(await page.locator(".notebook-graph__svg").getAttribute("aria-label")).toContain("49 notes");
    expect(await page.locator('[data-node][tabindex="0"]').count()).toBe(1);
    await page.keyboard.press("Tab");
    expect(await activeNode()).toBeNull();
    expect(await page.evaluate(() => document.activeElement?.closest(".notebook-graph__svg") ?? null)).toBeNull();
    await page.keyboard.press("Shift+Tab");
    expect(await activeNode()).toBe(WAREHOUSE);
    await page.keyboard.press("ArrowRight");
    const moved = await activeNode();
    expect(moved).not.toBeNull();
    expect(moved).not.toBe(WAREHOUSE);
    expect(await page.locator('[data-node][tabindex="0"]').getAttribute("data-node")).toBe(moved);
    await page.keyboard.press("Home");
    expect(await activeNode()).toBe(WAREHOUSE);
    await page.keyboard.press("ArrowDown");
    const target = await activeNode();
    await page.keyboard.press("Enter");
    await page.waitForURL(`**/app/notebooks/hand01/notes/${target}?mode=book`);
  } finally {
    await close(page);
  }
}, 30_000);

test(`${browserName}: only the current note takes the app accent, and it follows --app-accent`, async () => {
  const page = await open(graphPath("hand01"));
  try {
    const colours = () =>
      page.evaluate(() => {
        const ring = document.querySelector<SVGElement>(".notebook-graph__ring")!;
        const discs = [...document.querySelectorAll<SVGElement>("[data-node]:not([data-current]) .notebook-graph__disc")];
        return {
          ring: getComputedStyle(ring).stroke,
          others: discs.flatMap((disc) => [getComputedStyle(disc).fill, getComputedStyle(disc).stroke]),
        };
      });
    const yellow = await colours();
    expect(yellow.ring).toBe("rgb(234, 179, 8)");
    expect(yellow.others).not.toContain(yellow.ring);
    await page.evaluate(() => document.body.style.setProperty("--app-accent", "#16a34a"));
    const green = await colours();
    expect(green.ring).toBe("rgb(22, 163, 74)");
    expect(green.others).not.toContain(green.ring);
  } finally {
    await close(page);
  }
}, 30_000);

test(`${browserName}: pointing at a note keeps its neighbours, with incoming links dashed`, async () => {
  const page = await open(graphPath("hand01"));
  try {
    const point = await nodeCenter(page, WAREHOUSE);
    await page.mouse.move(point.x, point.y);
    await page.waitForSelector(".notebook-graph__svg[data-highlight]");
    const edges = await page.locator(".notebook-graph__edge[data-near]").evaluateAll((items) =>
      items.map((item) => ({
        source: item.getAttribute("data-source"),
        target: item.getAttribute("data-target"),
        near: item.getAttribute("data-near"),
        dash: getComputedStyle(item).strokeDasharray,
      })),
    );
    expect(edges.filter((edge) => edge.near === "out")).toHaveLength(7);
    expect(edges.filter((edge) => edge.near === "in")).toHaveLength(2);
    for (const edge of edges) {
      if (edge.near === "in") {
        expect(edge.target).toBe(WAREHOUSE);
        expect(edge.dash).not.toBe("none");
      } else {
        expect(edge.source).toBe(WAREHOUSE);
        expect(edge.dash).toBe("none");
      }
    }
    expect(await page.locator(".notebook-graph__status").textContent()).toContain("links to 7 · linked from 2");
  } finally {
    await close(page);
  }
}, 30_000);

test(`${browserName}: filters, an area toggle and the search change the notes and survive a reload`, async () => {
  const page = await open(graphPath("hand01"));
  try {
    await page.getByRole("button", { name: "Which notes" }).click();
    await page.getByRole("menuitemradio", { name: "Only linked" }).click();
    await page.waitForFunction(() => document.querySelectorAll("[data-node]").length === 45);
    expect(search(page).get("links")).toBe("linked");
    const safety = page.locator(".notebook-graph__area", { hasText: "Sicherheit" });
    await safety.click();
    await page.waitForFunction(() => document.querySelectorAll("[data-node]").length === 38);
    expect(await safety.getAttribute("aria-pressed")).toBe("false");
    expect(search(page).get("hide")).toBe(HANDBOOK_IDS.sich!);
    await page.getByRole("searchbox", { name: "Find a note in the graph" }).fill("Kühl");
    await page.waitForFunction(() => document.querySelectorAll("[data-node][data-match]").length === 1);
    // Enter in the search moves focus to the first match.
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-node"))).toBe(HANDBOOK_IDS.kuehl!);
    expect(search(page).get("q")).toBe("Kühl");
    expect(search(page).get("note")).toBeNull();
    expect(search(page).get("mode")).toBe("graph");

    await page.reload();
    await page.waitForFunction(() => window.notebookGraphFixture?.mounted === true);
    await settled(page);
    expect(await nodes(page).count()).toBe(38);
    expect(await page.locator(".notebook-graph__area", { hasText: "Sicherheit" }).getAttribute("aria-pressed")).toBe("false");
    expect(await page.getByRole("searchbox", { name: "Find a note in the graph" }).inputValue()).toBe("Kühl");
    expect(await page.getByRole("button", { name: "Which notes" }).textContent()).toContain("Only linked");
    expect(await page.locator("[data-node][data-match]").getAttribute("data-node")).toBe(HANDBOOK_IDS.kuehl!);
  } finally {
    await close(page);
  }
}, 30_000);

test(`${browserName}: searching keeps the zoom, and the sidebar's view filter stays in the address`, async () => {
  const page = await open(graphPath("hand01", "&view=favorites"));
  try {
    await page.getByRole("toolbar", { name: "Graph filters" }).getByRole("button", { name: "Zoom in" }).click();
    await page.waitForTimeout(100);
    const zoomed = await positions(page);
    await page.getByRole("searchbox", { name: "Find a note in the graph" }).fill("Lager");
    await page.waitForFunction(() => document.querySelectorAll("[data-node][data-match]").length > 0);
    expect(await positions(page)).toEqual(zoomed);
    expect(search(page).get("view")).toBe("favorites");
    expect(search(page).get("q")).toBe("Lager");
    expect(search(page).has("display")).toBe(false);
  } finally {
    await close(page);
  }
}, 30_000);

test(`${browserName}: As list shows the same notes as a table as wide as Main, and Back restores it`, async () => {
  const page = await open(graphPath("hand01", "&links=linked"));
  try {
    const toggle = page.getByRole("button", { name: "As list" });
    expect(await toggle.getAttribute("aria-pressed")).toBe("false");
    const bodyBefore = await page.locator(".notebook-graph__body").boundingBox();
    await toggle.click();
    expect(await toggle.getAttribute("aria-pressed")).toBe("true");
    const table = page.getByRole("table");
    await table.waitFor();
    // Nothing above the body moves when the list replaces the canvas.
    expect(await page.locator(".notebook-graph__body").boundingBox()).toEqual(bodyBefore);
    const widths = await page.evaluate(() => ({
      table: document.querySelector(".notebook-graph__list table")!.getBoundingClientRect().width,
      main: document.querySelector(".notebook-graph")!.getBoundingClientRect().width,
    }));
    expect(widths.table).toBeGreaterThan(widths.main - 40);
    expect(await table.locator("tbody tr.k2b-data-table__row").count()).toBe(45);
    expect(search(page).get("list")).toBe("1");
    expect(await table.locator('a[aria-current="page"]').textContent()).toBe("Wareneingang");

    await table.getByRole("link", { name: "Kühlkette", exact: true }).first().click();
    await page.waitForURL(`**/app/notebooks/hand01/notes/${HANDBOOK_IDS.kuehl}?mode=book`);
    await page.goBack();
    await page.waitForFunction(() => window.notebookGraphFixture?.mounted === true);
    expect(search(page).get("list")).toBe("1");
    expect(search(page).get("links")).toBe("linked");
    expect(await page.getByRole("table").locator("tbody tr.k2b-data-table__row").count()).toBe(45);
  } finally {
    await close(page);
  }
}, 30_000);

test(`${browserName}: a touch tap selects a note and Open opens it`, async () => {
  const page = await open(graphPath("hand01"), { width: 820, height: 1180 }, { hasTouch: true, isMobile: browserName === "chromium" });
  try {
    const before = page.url();
    const point = await nodeCenter(page, HANDBOOK_IDS.kuehl!);
    await page.touchscreen.tap(point.x, point.y);
    const bar = page.getByRole("region", { name: "Selected note" });
    await bar.waitFor();
    expect(await bar.textContent()).toContain("Kühlkette");
    expect(page.url()).toBe(before);
    await bar.getByRole("button", { name: "Open" }).click();
    await page.waitForURL(`**/app/notebooks/hand01/notes/${HANDBOOK_IDS.kuehl}?mode=book`);
  } finally {
    await close(page);
  }
}, 30_000);

test(`${browserName}: notebooks without links and filters that leave nothing show their way out`, async () => {
  const page = await open(graphPath("free01"));
  try {
    expect(await page.getByText("No links yet").isVisible()).toBe(true);
    expect(await page.getByRole("link", { name: "Back to note" }).isVisible()).toBe(true);
    expect(await page.getByRole("list", { name: "6 notes, not linked yet" }).locator("li").count()).toBe(6);
    expect(await page.getByRole("toolbar", { name: "Graph filters" }).count()).toBe(0);
    // The search still finds a note there: Enter focuses the first matching note link.
    await page.getByRole("searchbox", { name: "Find a note in the graph" }).fill("Kosten");
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Kosten");

    const hideAll = ["top", ...["wein", "komm", "vers", "inv", "sich", "onb"].map((id) => HANDBOOK_IDS[id])].join(",");
    await page.goto(new URL(graphPath("hand01", `&hide=${hideAll}`), server.url).href);
    await page.waitForFunction(() => window.notebookGraphFixture?.mounted === true);
    expect(await page.getByText("No note matches the filters").isVisible()).toBe(true);
    await page.getByRole("button", { name: "Reset filters" }).click();
    await page.waitForFunction(() => document.querySelectorAll("[data-node]").length === 49);
    expect(search(page).get("hide")).toBeNull();
  } finally {
    await close(page);
  }
}, 30_000);

test(`${browserName}: a no-links state taller than the canvas scrolls to its way back`, async () => {
  const page = await open(graphPath("free01"), { width: 390, height: 300 });
  try {
    const empty = page.locator(".notebook-graph__empty");
    expect(await empty.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    const back = page.getByRole("link", { name: "Back to note" });
    await back.scrollIntoViewIfNeeded();
    const box = (await back.boundingBox())!;
    const area = (await empty.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(area.y + area.height);
  } finally {
    await close(page);
  }
}, 30_000);

test(`${browserName}: the server render and the mounted graph share their boxes`, async () => {
  for (const query of ["", "&list=1&links=unlinked"]) {
    const path = new URL(graphPath("hand01", query), server.url).href;
    const boxes = (page: Page) =>
      page.evaluate(() =>
        [".notebook-graph__head", ".notebook-graph__filters", ".notebook-graph__body", ".notebook-graph__list table"].map((selector) => {
          const box = document.querySelector(selector)?.getBoundingClientRect();
          return box ? [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)] : null;
        }),
      );
    const still = await browser.newContext({ viewport: { width: 1440, height: 900 }, javaScriptEnabled: false });
    const served = await still.newPage();
    await served.goto(path);
    const before = await boxes(served);
    await still.close();
    const page = await open(path);
    try {
      expect(await boxes(page)).toEqual(before);
    } finally {
      await close(page);
    }
  }
}, 30_000);

test(`${browserName}: the layout of 300 notes is computed once, in bounded time`, async () => {
  const page = await open(graphPath("big001"));
  try {
    const runs: number[] = [];
    for (let run = 0; run < 3; run++) runs.push(await page.evaluate(() => window.notebookGraphFixture!.layoutMs()));
    console.info(`${browserName}: 300-note layout ${runs.map((ms) => `${ms.toFixed(0)} ms`).join(", ")}`);
    expect(Math.min(...runs)).toBeGreaterThan(0);
  } finally {
    await close(page);
  }
}, 60_000);
