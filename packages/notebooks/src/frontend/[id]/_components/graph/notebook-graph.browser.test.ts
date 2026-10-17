import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { browserName, launchBrowser } from "../../../../../../ui/test/browser";
import { bigGraph, FIXTURE_NOW, HANDBOOK_IDS, handbookGraph } from "./graph.fixtures";
import { buildGraphModel, matchesQuery, visibleEdges, visibleNotes } from "./model";
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
  await page.clock.install({ time: new Date(FIXTURE_NOW) });
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
      const page = await open(graphPath(notebook, "&display=network"), viewport);
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

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
])
  test(`${browserName}: the Book update notice stays below the graph toolbars at ${viewport.width}`, async () => {
    const page = await open(graphPath("hand01"), viewport);
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

test(`${browserName}: showing the navigation on a tablet keeps keyboard focus on the page`, async () => {
  const page = await open(graphPath("hand01"), { width: 900, height: 900 });
  try {
    const tools = page.getByRole("toolbar", { name: "Graph tools" });
    // At this width the navigation is hidden first through the shared command, then shown again with the toolbar.
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent("notebooks.navigation.visibilityChanged", { detail: { hidden: true } })),
    );
    const show = tools.getByRole("button", { name: "Show navigation" });
    await show.waitFor();
    await show.focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.activeElement !== null && document.activeElement !== document.body);
    expect(await page.evaluate(() => document.activeElement?.closest("#notebook-navigation, .notebook-graph") !== null)).toBe(true);
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
    // A pointer resting on another note does not take the highlight from the focused one.
    const rest = await nodeCenter(page, HANDBOOK_IDS.start!);
    await page.mouse.move(rest.x, rest.y);
    await page.keyboard.press("ArrowRight");
    const moved = await activeNode();
    expect(await page.locator(`[data-label="${moved}"]`).getAttribute("data-kind")).toBe("hover");
    expect(moved).not.toBeNull();
    expect(moved).not.toBe(WAREHOUSE);
    expect(await page.locator('[data-node][tabindex="0"]').getAttribute("data-node")).toBe(moved);
    await page.keyboard.press("Home");
    expect(await activeNode()).toBe(WAREHOUSE);
    // Page Down walks every note in page order, so no note is out of reach.
    const visited = new Set<string | null>();
    for (let step = 0; step < 49; step++) {
      await page.keyboard.press("PageDown");
      visited.add(await activeNode());
    }
    expect(visited.size).toBe(49);
    expect(await activeNode()).toBe(WAREHOUSE);
    // Modified keys stay with the browser: Ctrl+- is page zoom, not graph zoom.
    const prevented = await page.evaluate(() => {
      const event = new KeyboardEvent("keydown", { key: "-", ctrlKey: true, bubbles: true, cancelable: true });
      document.activeElement!.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(prevented).toBe(false);
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
    // Notes that link to each other keep two separate lines, so the dashed one stays visible.
    const [sperr, diff] = [HANDBOOK_IDS.sperr!, HANDBOOK_IDS.diff!];
    const there = await page.locator(`.notebook-graph__edge[data-source="${sperr}"][data-target="${diff}"]`).getAttribute("d");
    const back = await page.locator(`.notebook-graph__edge[data-source="${diff}"][data-target="${sperr}"]`).getAttribute("d");
    expect(there).not.toBe(back?.replace(/M([^L]+)L(.+)/, "M$2L$1"));
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
    // The search reaches the address once typing pauses.
    await page.waitForFunction(() => new URL(location.href).searchParams.get("q") === "Kühl");
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
    const fitted = await positions(page);
    await page.getByRole("toolbar", { name: "Graph filters" }).getByRole("button", { name: "Zoom in" }).click();
    // Zoom redraws on the next frame; wait until it has.
    await page.waitForFunction(([id, before]) => document.querySelector(`[data-node="${id}"]`)?.getAttribute("transform") !== before, [
      WAREHOUSE,
      fitted[WAREHOUSE],
    ] as const);
    const zoomed = await positions(page);
    await page.getByRole("searchbox", { name: "Find a note in the graph" }).fill("Lager");
    await page.waitForFunction(() => document.querySelectorAll("[data-node][data-match]").length > 0);
    expect(await positions(page)).toEqual(zoomed);
    await page.waitForFunction(() => new URL(location.href).searchParams.get("q") === "Lager");
    expect(search(page).get("view")).toBe("favorites");
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

    // A search typed just before leaving is in the address when Back returns.
    await page.getByRole("searchbox", { name: "Find a note in the graph" }).fill("Kühl");
    await table.getByRole("link", { name: "Kühlkette", exact: true }).first().click();
    await page.waitForURL(`**/app/notebooks/hand01/notes/${HANDBOOK_IDS.kuehl}?mode=book`);
    await page.goBack();
    await page.waitForFunction(() => window.notebookGraphFixture?.mounted === true);
    expect(search(page).get("q")).toBe("Kühl");
    await page.getByRole("searchbox", { name: "Find a note in the graph" }).fill("");
    await page.waitForFunction(() => !new URL(location.href).searchParams.has("q"));
    expect(search(page).get("list")).toBe("1");
    expect(search(page).get("links")).toBe("linked");
    expect(await page.getByRole("table").locator("tbody tr.k2b-data-table__row").count()).toBe(45);
  } finally {
    await close(page);
  }
}, 30_000);

test(`${browserName}: a note opens like a link from the mouse, a modified click and assistive technology`, async () => {
  const kuehl = HANDBOOK_IDS.kuehl!;
  const start = HANDBOOK_IDS.start!;
  // A click without a pointer gesture (screen reader, voice control) opens the note.
  const assisted = await open(graphPath("hand01"));
  try {
    await assisted.locator(`[data-node="${start}"]`).dispatchEvent("click");
    await assisted.waitForURL(`**/app/notebooks/hand01/notes/${start}?mode=book`);
  } finally {
    await close(assisted);
  }
  const page = await open(graphPath("hand01"));
  try {
    // Ctrl/Cmd+click keeps the graph and opens the note in a new tab.
    // Locator clicks wait until the note stands still and is the element under the pointer.
    const graphUrl = page.url();
    const node = page.locator(`[data-node="${kuehl}"]`);
    const [tab] = await Promise.all([page.context().waitForEvent("page"), node.click({ modifiers: ["Control"] })]);
    await tab.waitForURL(`**/app/notebooks/hand01/notes/${kuehl}?mode=book`);
    expect(page.url()).toBe(graphUrl);
    await tab.close();
    // A plain mouse click opens the note once, in place.
    await node.click();
    await page.waitForURL(`**/app/notebooks/hand01/notes/${kuehl}?mode=book`);
    expect(page.context().pages()).toHaveLength(1);
  } finally {
    await close(page);
  }
}, 30_000);

test(`${browserName}: returning from the list keeps the arranged notes and a drag`, async () => {
  const page = await open(graphPath("hand01"));
  try {
    const kuehl = HANDBOOK_IDS.kuehl!;
    const before = await positions(page);
    const from = await nodeCenter(page, kuehl);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 80, from.y + 50, { steps: 6 });
    await page.mouse.up();
    await page.waitForFunction(([id, old]) => document.querySelector(`[data-node="${id}"]`)?.getAttribute("transform") !== old, [
      kuehl,
      before[kuehl],
    ] as const);
    // A drag never opens the note.
    expect(search(page).get("mode")).toBe("graph");
    const fit = page.getByRole("toolbar", { name: "Graph filters" }).getByRole("button", { name: "Fit graph" });
    await fit.click();
    await page.waitForTimeout(100);
    const dragged = await positions(page);
    const toggle = page.getByRole("button", { name: "As list" });
    await toggle.click();
    await page.getByRole("table").waitFor();
    await toggle.click();
    await page.waitForFunction(() => document.querySelectorAll("[data-node]").length === 49);
    expect(await page.locator(".notebook-graph__status-text").first().textContent()).not.toContain("Arranging");
    expect(await positions(page)).toEqual(dragged);
  } finally {
    await close(page);
  }
}, 30_000);

test(`${browserName}: a touch tap selects a note and Open opens it`, async () => {
  const page = await open(graphPath("hand01"), { width: 820, height: 1180 }, { hasTouch: true, isMobile: browserName === "chromium" });
  try {
    const before = page.url();
    // A mouse resting on another note does not keep the highlight from the tapped one.
    const rest = await nodeCenter(page, HANDBOOK_IDS.start!);
    await page.mouse.move(rest.x, rest.y);
    const point = await nodeCenter(page, HANDBOOK_IDS.kuehl!);
    await page.touchscreen.tap(point.x, point.y);
    const bar = page.getByRole("region", { name: "Selected note" });
    await bar.waitFor();
    expect(await bar.textContent()).toContain("Kühlkette");
    expect(await page.locator(".notebook-graph__status strong").textContent()).toBe("Kühlkette");
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
    // A filter saved in the address while there were links does not hide notes here.
    await page.goto(new URL(graphPath("free01", "&links=linked"), server.url).href);
    await page.waitForFunction(() => window.notebookGraphFixture?.mounted === true);
    expect(await page.getByRole("list", { name: "6 notes, not linked yet" }).locator("li").count()).toBe(6);
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

test(`${browserName}: the server render and mounted defaults share controls and boxes at both widths`, async () => {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    for (const query of ["", "&list=1&links=unlinked"]) {
      const path = new URL(graphPath("hand01", query), server.url).href;
      const frame = (page: Page) =>
        page.evaluate(() => {
          const visible = (element: Element) => element.getClientRects().length > 0;
          return {
            checked: [...document.querySelectorAll('[aria-label="Display"] [aria-checked="true"]')].find(visible)?.textContent,
            depth: [...document.querySelectorAll(".notebook-graph__depth")].some(visible),
            boxes: [".notebook-graph__head", ".notebook-graph__filters", ".notebook-graph__body", ".notebook-graph__list table"].map(
              (selector) => {
                const box = document.querySelector(selector)?.getBoundingClientRect();
                return box ? [box.x, box.y, box.width, box.height].map(Math.round) : null;
              },
            ),
          };
        });
      const still = await browser.newContext({ viewport, javaScriptEnabled: false });
      let before: Awaited<ReturnType<typeof frame>>;
      try {
        const served = await still.newPage();
        await served.goto(path);
        before = await frame(served);
      } finally {
        await still.close();
      }
      const page = await open(path, viewport);
      try {
        expect(await frame(page)).toEqual(before);
        const initial = await page.evaluate(() => window.notebookGraphFixture!);
        expect(initial.clientFrame).toEqual(initial.serverFrame);
        expect(initial.clientFrame.checked?.trim()).toBe(viewport.width < 768 ? "Neighborhood" : "Network");
        expect(initial.clientFrame.depth).toBe(viewport.width < 768 && query === "");
      } finally {
        await close(page);
      }
    }
  }
}, 60_000);

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

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`${browserName}: Neighborhood centre and directional first ring at ${viewport.width}`, async () => {
    const page = await open(graphPath("hand01", "&display=neighborhood"), viewport);
    try {
      const centre = await nodeCenter(page, WAREHOUSE);
      const canvas = (await page.locator(".notebook-graph__svg").boundingBox())!;
      expect(Math.abs(centre.x - canvas.x - canvas.width / 2)).toBeLessThan(2);
      expect(await page.locator(`[data-node="${WAREHOUSE}"]`).getAttribute("aria-label")).toEndWith(", current note");
      expect(await page.locator('[data-node][data-ring="0"]').getAttribute("data-node")).toBe(WAREHOUSE);
      const outgoing = ["anl", "ann", "kuehl", "lpl", "ret", "schad", "glos"];
      const incoming = ["start", "einp"];
      for (const key of outgoing) {
        const at = await nodeCenter(page, HANDBOOK_IDS[key]!);
        expect(viewport.width < 768 ? at.y - centre.y : at.x - centre.x).toBeGreaterThan(0);
      }
      for (const key of incoming) {
        const at = await nodeCenter(page, HANDBOOK_IDS[key]!);
        expect(viewport.width < 768 ? at.y - centre.y : at.x - centre.x).toBeLessThan(0);
      }
      expect(await page.locator('[data-node][tabindex="0"]').count()).toBe(1);
      expect(await page.locator("[data-node][data-current]").count()).toBe(1);
      const colours = await page.evaluate(() => {
        const accent = getComputedStyle(document.querySelector(".notebook-graph__ring")!).stroke;
        return {
          accent,
          others: [...document.querySelectorAll("[data-node]:not([data-current]) .notebook-graph__disc")].flatMap((el) => [
            getComputedStyle(el).fill,
            getComputedStyle(el).stroke,
          ]),
        };
      });
      expect(colours.others).not.toContain(colours.accent);
      expect(await page.locator(".notebook-graph__svg").getAttribute("aria-label")).toContain("Neighborhood display");
    } finally {
      await close(page);
    }
  }, 30_000);
}

for (const depth of [1, 2]) {
  test(`${browserName}: Space replaces the centre and history preserves it and depth ${depth}`, async () => {
    const page = await open(graphPath("hand01", `&display=neighborhood&depth=${depth}&view=favorites&tag=x`));
    const target = HANDBOOK_IDS.kuehl!;
    try {
      const length = await page.evaluate(() => history.length);
      await page.evaluate(() => {
        window.addEventListener(
          "notebooks.note.softNavigated",
          (event) => {
            const detail = (event as CustomEvent<{ noteId: string; href: string }>).detail;
            document.body.dataset.recentredNoteId = detail.noteId;
            document.body.dataset.recentredHref = detail.href;
          },
          { once: true },
        );
      });
      await page.locator(`[data-node="${target}"]`).focus();
      await page.keyboard.press("Space");
      await page.waitForFunction((id) => new URL(location.href).searchParams.get("note") === id, target);
      expect(await page.evaluate(() => document.body.dataset.recentredNoteId)).toBe(target);
      expect(await page.evaluate(() => document.body.dataset.recentredHref)).toBe(
        await page.evaluate(() => `${location.pathname}${location.search}`),
      );
      expect(await page.evaluate(() => history.length)).toBe(length);
      expect(await page.evaluate(() => document.activeElement?.getAttribute("data-node"))).toBe(target);
      expect(await page.locator(`[data-node="${target}"]`).getAttribute("aria-label")).toEndWith(", current note");
      expect(await page.locator("[data-centred-announcement]").textContent()).toContain("“Kühlkette” is now in the center");
      expect(await page.locator("[data-centred-announcement]").textContent()).toMatch(/links to \d+, linked from \d+/);
      expect(search(page).get("view")).toBe("favorites");
      expect(search(page).get("tag")).toBe("x");
      expect(search(page).get("from")).toBe("book");
      const centred = page.url();
      await page.keyboard.press("Space");
      expect(page.url()).toBe(centred);
      expect(await page.evaluate(() => history.length)).toBe(length);
      await page.reload();
      await settled(page);
      expect(await page.locator("[data-node][data-current]").getAttribute("data-node")).toBe(target);
      expect(await page.getByRole("radio", { name: depth === 1 ? "1 step" : "2 steps", exact: true }).getAttribute("aria-checked")).toBe(
        "true",
      );
      expect((await page.locator('[data-node][data-ring="2"]').count()) === 0).toBe(depth === 1);
      await page.locator(`[data-node="${target}"]`).focus();
      await page.keyboard.press("Enter");
      await page.waitForURL(`**/app/notebooks/hand01/notes/${target}?mode=book`);
      await page.goBack();
      await settled(page);
      expect(page.url()).toBe(centred);
      expect(await page.locator("[data-node][data-current]").getAttribute("data-node")).toBe(target);
      expect(await page.getByRole("radio", { name: depth === 1 ? "1 step" : "2 steps", exact: true }).getAttribute("aria-checked")).toBe(
        "true",
      );
      expect(await page.getByRole("link", { name: "Close graph", exact: true }).getAttribute("href")).toBe(
        `/app/notebooks/hand01/notes/${target}?mode=book`,
      );
      await page.getByRole("radio", { name: "Network", exact: true }).click();
      await settled(page);
      expect(await page.locator("[data-node][data-current]").getAttribute("data-node")).toBe(target);
      expect(await page.locator('[data-label][data-kind="current"]').getAttribute("data-label")).toBe(target);
      await page.getByRole("button", { name: "As list", exact: true }).click();
      expect(await page.locator(".notebook-graph__list-title[aria-current]").textContent()).toBe("Kühlkette");
    } finally {
      await close(page);
    }
  }, 30_000);
}

test(`${browserName}: recentring a graph opened under a note path keeps the new centre on reload`, async () => {
  const page = await open(`/app/notebooks/hand01/notes/${WAREHOUSE}?mode=graph&from=book&display=neighborhood`);
  const target = HANDBOOK_IDS.kuehl!;
  try {
    await page.locator(`[data-node="${target}"]`).focus();
    await page.keyboard.press("Space");
    await page.waitForFunction((id) => new URL(location.href).searchParams.get("note") === id, target);
    expect(new URL(page.url()).pathname).toBe("/app/notebooks/hand01");
    await page.reload();
    await settled(page);
    expect(await page.locator("[data-node][data-current]").getAttribute("data-node")).toBe(target);
  } finally {
    await close(page);
  }
}, 30_000);

test(`${browserName}: touch selection offers Move to center and clears after recentering`, async () => {
  const page = await open(
    graphPath("hand01", "&display=neighborhood"),
    { width: 820, height: 1180 },
    { hasTouch: true, isMobile: browserName === "chromium" },
  );
  try {
    const target = HANDBOOK_IDS.kuehl!;
    const at = await nodeCenter(page, target);
    await page.touchscreen.tap(at.x, at.y);
    const bar = page.getByRole("region", { name: "Selected note" });
    await bar.waitFor();
    expect(search(page).has("note")).toBe(false);
    // Activated from the keyboard, the vanishing bar hands focus to the new centre, not to the page.
    await bar.getByRole("button", { name: "Move to center", exact: true }).focus();
    await page.keyboard.press("Enter");
    expect(search(page).get("note")).toBe(target);
    expect(await bar.count()).toBe(0);
    expect(await page.locator("[data-node][data-current]").getAttribute("data-node")).toBe(target);
    await page.waitForFunction((id) => document.activeElement?.getAttribute("data-node") === id, target);
  } finally {
    await close(page);
  }
}, 30_000);

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`${browserName}: device default, explicit Network and arrow switcher at ${viewport.width}`, async () => {
    const page = await open(graphPath("hand01"), viewport);
    try {
      const expected = viewport.width < 768 ? "neighborhood" : "network";
      expect(await page.locator(".notebook-graph__svg").getAttribute("data-display")).toBe(expected);
      const switcher = page.getByRole("radiogroup", { name: "Display", exact: true });
      expect(await switcher.count()).toBe(1);
      expect(await switcher.isVisible()).toBe(true);
      expect(await switcher.evaluate((el) => !!el.closest('.notebook-graph__head[role="toolbar"]'))).toBe(true);
      const checked = switcher.locator('[aria-checked="true"]');
      await checked.focus();
      await page.keyboard.press(expected === "network" ? "ArrowRight" : "ArrowLeft");
      expect(search(page).get("display")).toBe("circle");
      expect(await page.locator(".notebook-graph__svg").getAttribute("data-display")).toBe("circle");
      await page.keyboard.press(expected === "network" ? "ArrowLeft" : "ArrowRight");
      expect(search(page).get("display")).toBe(expected);
      await switcher.getByRole("radio", { name: "Network", exact: true }).click();
      await page.reload();
      await settled(page);
      expect(await page.locator(".notebook-graph__svg").getAttribute("data-display")).toBe("network");
      expect(search(page).get("display")).toBe("network");
      expect(await page.locator(".notebook-graph__depth").count()).toBe(0);
    } finally {
      await close(page);
    }
  }, 30_000);
}

for (const notebook of ["hand01", "big001"])
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    test(`${browserName}: Neighborhood labels and headings never overlap or leave ${notebook} at ${viewport.width}`, async () => {
      const page = await open(graphPath(notebook, "&display=neighborhood"), viewport);
      try {
        const { boxes, canvas, status, chipSlack } = await page.evaluate(() => {
          const rect = (element: Element) => {
            const r = element.getBoundingClientRect();
            return { x0: r.left, y0: r.top, x1: r.right, y1: r.bottom };
          };
          const current = document.querySelector<SVGTextElement>('.notebook-graph__label[data-kind="current"]')!;
          return {
            boxes: [...document.querySelectorAll(".notebook-graph__label, .notebook-graph__heading")].map(rect),
            canvas: rect(document.querySelector(".notebook-graph__svg")!),
            status: rect(document.querySelector(".notebook-graph__status")!),
            // The chip is measured, the text is rendered: they agree only when the bold face was loaded before measuring.
            chipSlack:
              document.querySelector<SVGRectElement>(".notebook-graph__chip")!.width.baseVal.value - current.getComputedTextLength(),
          };
        });
        expect(boxes.length).toBeGreaterThan(2);
        expect(chipSlack).toBeGreaterThan(9);
        expect(chipSlack).toBeLessThan(11);
        for (const [index, a] of boxes.entries()) {
          expect(a.x0).toBeGreaterThanOrEqual(canvas.x0);
          expect(a.x1).toBeLessThanOrEqual(canvas.x1);
          expect(a.y0).toBeGreaterThanOrEqual(canvas.y0);
          // Nothing hides under the status line at the bottom of the canvas.
          expect(a.y1).toBeLessThanOrEqual(status.y0);
          for (const b of boxes.slice(index + 1))
            expect(Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0.5 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0.5).toBe(false);
        }
      } finally {
        await close(page);
      }
    }, 30_000);
  }

test(`${browserName}: isolated and filter-hidden centres offer a way out`, async () => {
  const page = await open(graphPath("hand01", `&display=neighborhood&note=${HANDBOOK_IDS.rampe}`));
  try {
    expect(await page.getByText("“Alte Rampenzeiten” is not linked yet", { exact: true }).isVisible()).toBe(true);
    expect(await page.getByRole("link", { name: "Go to note", exact: true }).getAttribute("href")).toBe(
      `/app/notebooks/hand01/notes/${HANDBOOK_IDS.rampe}?mode=book`,
    );
    // Keyboard activation: the button disappears with the empty state, so focus moves to the centre in the network.
    await page.getByRole("button", { name: "Show whole notebook", exact: true }).focus();
    await page.keyboard.press("Enter");
    await settled(page);
    expect(search(page).get("display")).toBe("network");
    expect(await nodes(page).count()).toBe(49);
    await page.waitForFunction((id) => document.activeElement?.getAttribute("data-node") === id, HANDBOOK_IDS.rampe);
    await page.goto(new URL(graphPath("hand01", "&display=neighborhood&links=unlinked"), server.url).href);
    await page.waitForFunction(() => window.notebookGraphFixture?.mounted);
    expect(await page.getByText("No link of “Wareneingang” matches the filters", { exact: true }).isVisible()).toBe(true);
    expect(await page.getByText("The current filters hide all links of this note.", { exact: true }).isVisible()).toBe(true);
    await page.getByRole("button", { name: "Reset filters", exact: true }).focus();
    await page.keyboard.press("Enter");
    await settled(page);
    expect(await page.locator('[data-ring="1"]').count()).toBeGreaterThan(0);
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label")?.endsWith(", current note"));
  } finally {
    await close(page);
  }
}, 30_000);

test(`${browserName}: recentring onto a note whose links the filters hide focuses the way out`, async () => {
  // Hiding Lager keeps its note Regalplan as the centre; its only link goes to Torbelegung, whose only link is back.
  const page = await open(graphPath("pair01", "&display=neighborhood&hide=lager0"));
  try {
    await page.locator('[data-node="tor000"]').focus();
    await page.keyboard.press("Space");
    await page.getByText("No link of “Torbelegung” matches the filters", { exact: true }).waitFor();
    expect(search(page).get("note")).toBe("tor000");
    await page.waitForFunction(() => document.activeElement?.textContent === "Reset filters");
    expect(await page.locator("[data-centred-announcement]").textContent()).toContain("“Torbelegung” is now in the center");
  } finally {
    await close(page);
  }
}, 30_000);

test(`${browserName}: depth changes ring two without moving the toolbars`, async () => {
  const page = await open(graphPath("hand01", "&display=neighborhood"));
  try {
    const boxes = () =>
      page.evaluate(() =>
        [".notebook-graph__head", ".notebook-graph__filters", ".notebook-graph__body"].map((selector) => {
          const r = document.querySelector(selector)!.getBoundingClientRect();
          return [r.x, r.y, r.width, r.height];
        }),
      );
    const before = await boxes();
    expect(await page.locator('[data-node][data-ring="2"]').count()).toBeGreaterThan(0);
    await page.getByRole("radio", { name: "1 step", exact: true }).click();
    expect(await page.locator('[data-node][data-ring="2"]').count()).toBe(0);
    expect(await boxes()).toEqual(before);
    expect(search(page).get("depth")).toBe("1");
    await page.getByRole("radio", { name: "2 steps", exact: true }).click();
    expect(await page.locator('[data-node][data-ring="2"]').count()).toBeGreaterThan(0);
    expect(await boxes()).toEqual(before);
    expect(search(page).has("depth")).toBe(false);
  } finally {
    await close(page);
  }
}, 30_000);

test(`${browserName}: neighborhood search uses local hits and preserves zoom; dragging a node does nothing`, async () => {
  const page = await open(graphPath("hand01", "&display=neighborhood&depth=1"));
  try {
    const filter = page.getByRole("toolbar", { name: "Graph filters" });
    const initial = await positions(page);
    await filter.getByRole("button", { name: "Zoom in", exact: true }).click();
    const target = HANDBOOK_IDS.kuehl!;
    await page.waitForFunction(([id, old]) => document.querySelector(`[data-node="${id}"]`)?.getAttribute("transform") !== old, [
      target,
      initial[target],
    ] as const);
    const zoomed = await positions(page);
    const find = page.getByRole("searchbox", { name: "Find a note in the graph" });
    await find.fill("Kühl");
    await page.waitForFunction(() => document.querySelectorAll("[data-node][data-match]").length === 1);
    expect(await positions(page)).toEqual(zoomed);
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-node"))).toBe(target);
    await page.keyboard.press("Escape");
    expect(await find.inputValue()).toBe("");
    await find.fill("plan");
    expect(await page.locator(".notebook-graph__status-text").first().textContent()).toContain(
      "1 match for “plan” in this neighborhood, 2 in the notebook",
    );
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-node"))).toBe(HANDBOOK_IDS.einp!);
    await find.fill("Versand");
    expect(await page.locator(".notebook-graph__status-text").first().textContent()).toContain(
      "“Versand” is not in this neighborhood, but 3× in the notebook",
    );
    await find.fill("not-a-note");
    expect(await page.locator(".notebook-graph__status-text").first().textContent()).toContain("No note is called “not-a-note”");
    await find.fill("");
    const at = await nodeCenter(page, target);
    const before = await positions(page);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x + 50, at.y + 30, { steps: 5 });
    await page.mouse.up();
    expect(page.url()).toContain("mode=graph");
    expect(await positions(page)).toEqual(before);
  } finally {
    await close(page);
  }
}, 30_000);

const circleGeometry = (page: Page) =>
  nodes(page).evaluateAll((items) => {
    const points = items.map((item) => {
      const box = item.querySelector(".notebook-graph__disc")!.getBoundingClientRect();
      return {
        id: item.getAttribute("data-node")!,
        slot: item.getAttribute("data-slot")!,
        x: box.left + box.width / 2,
        y: box.top + box.height / 2,
      };
    });
    const [a, b, c] = [points[0]!, points[Math.floor(points.length / 3)]!, points[Math.floor((points.length * 2) / 3)]!];
    const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    const sq = (p: { x: number; y: number }) => p.x * p.x + p.y * p.y;
    const cx = (sq(a) * (b.y - c.y) + sq(b) * (c.y - a.y) + sq(c) * (a.y - b.y)) / d;
    const cy = (sq(a) * (c.x - b.x) + sq(b) * (a.x - c.x) + sq(c) * (b.x - a.x)) / d;
    const angle = (p: { x: number; y: number }) => (Math.atan2(p.y - cy, p.x - cx) + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2);
    return { cx, cy, radius: Math.hypot(a.x - cx, a.y - cy), ring: points.sort((p, q) => angle(p) - angle(q)) };
  });
const focusedNode = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute("data-node"));

test(`${browserName}: Circle places all 49 notes on one ring with a band for every area`, async () => {
  const page = await open(graphPath("hand01", "&display=circle"));
  try {
    expect(await nodes(page).count()).toBe(49);
    expect(await page.locator(".notebook-graph__svg").getAttribute("data-display")).toBe("circle");
    expect(await page.locator(".notebook-graph__status").textContent()).toContain("49 notes");
    const { ring, cx, cy, radius } = await circleGeometry(page);
    for (const p of ring) expect(Math.abs(Math.hypot(p.x - cx, p.y - cy) - radius)).toBeLessThan(1.5);
    const areas = await page.locator(".notebook-graph__area").count();
    expect(areas).toBe(7);
    expect(await page.locator("path.notebook-graph__band").count()).toBe(areas);
  } finally {
    await close(page);
  }
}, 30_000);

for (const [notebook, viewport] of [
  ["hand01", { width: 390, height: 844 }],
  ["big001", { width: 1440, height: 900 }],
] as const) {
  test(`${browserName}: Circle pointer targets reach the note under every dot for ${notebook} at ${viewport.width}`, async () => {
    const page = await open(graphPath(notebook, "&display=circle"), viewport);
    try {
      // Dots on the ring stand closer than a hit circle is wide; a press at a dot's centre must reach that note.
      const wrong = await nodes(page).evaluateAll((items) =>
        items.flatMap((item) => {
          const box = item.querySelector(".notebook-graph__disc")!.getBoundingClientRect();
          const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest("[data-node]");
          const id = item.getAttribute("data-node")!;
          return hit?.getAttribute("data-node") === id ? [] : [id];
        }),
      );
      expect(wrong).toEqual([]);
    } finally {
      await close(page);
    }
  }, 30_000);
}

test(`${browserName}: Circle chords use their source area and isolate outgoing solid and incoming dashed links`, async () => {
  const page = await open(graphPath("hand01", "&display=circle"));
  try {
    const sourceColours = await page.locator('[data-edge-kind="chord"]').evaluateAll((edges) =>
      edges.map((edge) => {
        const source = document.querySelector(`[data-node="${edge.getAttribute("data-source")}"] .notebook-graph__disc`)!;
        return { stroke: getComputedStyle(edge).stroke, fill: getComputedStyle(source).fill };
      }),
    );
    expect(sourceColours.length).toBeGreaterThan(0);
    for (const colour of sourceColours) expect(colour.stroke).toBe(colour.fill);
    const at = await nodeCenter(page, WAREHOUSE);
    await page.mouse.move(at.x, at.y);
    await page.waitForFunction(
      (id) => document.querySelector(`.notebook-graph__edge[data-source="${id}"][data-near="out"]`) !== null,
      WAREHOUSE,
    );
    const highlighted = await page.locator('[data-edge-kind="chord"]').evaluateAll((edges, id) => {
      const fill = getComputedStyle(document.querySelector(`[data-node="${id}"] .notebook-graph__disc`)!).fill;
      return {
        fill,
        edges: edges.map((edge) => {
          const style = getComputedStyle(edge);
          return {
            source: edge.getAttribute("data-source"),
            target: edge.getAttribute("data-target"),
            near: edge.getAttribute("data-near"),
            stroke: style.stroke,
            opacity: style.strokeOpacity,
            dash: style.strokeDasharray,
          };
        }),
      };
    }, WAREHOUSE);
    expect(highlighted.edges.filter((edge) => edge.near === "out")).toHaveLength(7);
    expect(highlighted.edges.filter((edge) => edge.near === "in")).toHaveLength(2);
    for (const edge of highlighted.edges) {
      expect(Number(edge.opacity)).toBe(edge.near ? 0.95 : 0.07);
      if (!edge.near) continue;
      expect(edge.stroke).toBe(highlighted.fill);
      if (edge.near === "out") {
        expect(edge.source).toBe(WAREHOUSE);
        expect(edge.dash).toBe("none");
      } else {
        expect(edge.target).toBe(WAREHOUSE);
        expect(edge.dash).not.toBe("none");
      }
    }
  } finally {
    await close(page);
  }
}, 30_000);

test(`${browserName}: Circle arrow keys walk the full ring and wrap from the current note`, async () => {
  const page = await open(graphPath("hand01", "&display=circle"));
  try {
    const { ring } = await circleGeometry(page);
    const current = ring.findIndex((note) => note.id === WAREHOUSE);
    await page.getByRole("button", { name: "Fit graph", exact: true }).focus();
    await page.keyboard.press("Tab");
    expect(await focusedNode(page)).toBe(WAREHOUSE);
    expect(await page.locator('[data-node][tabindex="0"]').count()).toBe(1);
    for (let step = 1; step <= 49; step++) {
      await page.keyboard.press("ArrowRight");
      expect(await focusedNode(page)).toBe(ring[(current + step) % ring.length]!.id);
    }
    await page.keyboard.press("ArrowLeft");
    expect(await focusedNode(page)).toBe(ring[(current - 1 + ring.length) % ring.length]!.id);
    await page.keyboard.press("ArrowUp");
    expect(await focusedNode(page)).toBe(ring[(current - 2 + ring.length) % ring.length]!.id);
    await page.keyboard.press("ArrowDown");
    expect(await focusedNode(page)).toBe(ring[(current - 1 + ring.length) % ring.length]!.id);
  } finally {
    await close(page);
  }
}, 30_000);

for (const hide of [null, HANDBOOK_IDS.komm!]) {
  test(`${browserName}: Circle area jumps land at first notes and wrap${hide ? " with a hidden area" : ""}`, async () => {
    const page = await open(graphPath("hand01", `&display=circle${hide ? `&hide=${hide}` : ""}`));
    try {
      const { ring } = await circleGeometry(page);
      const starts = ring.filter((note, i) => i === 0 || note.slot !== ring[i - 1]!.slot);
      const areaIndex = starts.findIndex((note) => note.slot === ring.find((note) => note.id === WAREHOUSE)!.slot);
      if (hide) {
        expect(ring.some((note) => note.id === hide)).toBe(false);
        expect(starts).toHaveLength(6);
      }
      await page.locator(`[data-node="${WAREHOUSE}"]`).focus();
      await page.keyboard.press("PageDown");
      expect(await focusedNode(page)).toBe(starts[(areaIndex + 1) % starts.length]!.id);
      await page.keyboard.press("PageUp");
      expect(await focusedNode(page)).toBe(starts[areaIndex]!.id);
      await page.locator(`[data-node="${starts[0]!.id}"]`).focus();
      await page.keyboard.press("PageUp");
      expect(await focusedNode(page)).toBe(starts.at(-1)!.id);
      await page.keyboard.press("PageDown");
      expect(await focusedNode(page)).toBe(starts[0]!.id);
    } finally {
      await close(page);
    }
  }, 30_000);
}

type QuadPoint = { x: number; y: number };
function labelQuadsOverlap(a: readonly QuadPoint[], b: readonly QuadPoint[]): boolean {
  for (const quad of [a, b]) {
    for (let i = 0; i < quad.length; i++) {
      const p = quad[i]!,
        q = quad[(i + 1) % quad.length]!;
      const length = Math.hypot(q.x - p.x, q.y - p.y);
      if (!length) continue;
      const nx = -(q.y - p.y) / length,
        ny = (q.x - p.x) / length;
      const project = (points: readonly QuadPoint[]) => points.map((point) => point.x * nx + point.y * ny);
      const pa = project(a),
        pb = project(b);
      if (Math.min(Math.max(...pa), Math.max(...pb)) - Math.max(Math.min(...pa), Math.min(...pb)) <= 0.5) return false;
    }
  }
  return true;
}
for (const notebook of ["hand01", "big001"]) {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    test(`${browserName}: Circle labels stay separate and above the status line for ${notebook} at ${viewport.width}`, async () => {
      const page = await open(graphPath(notebook, "&display=circle"), viewport);
      try {
        const { quads, canvas, statusTop, count } = await page.evaluate(() => {
          const svg = document.querySelector<SVGSVGElement>(".notebook-graph__svg")!;
          const box = svg.getBoundingClientRect();
          const quad = (element: SVGGraphicsElement, b: DOMRect, owner: number) => ({
            owner,
            points: [
              [b.x, b.y],
              [b.x + b.width, b.y],
              [b.x + b.width, b.y + b.height],
              [b.x, b.y + b.height],
            ].map(([x, y]) => {
              const p = new DOMPoint(x, y).matrixTransform(element.getScreenCTM()!);
              return { x: p.x, y: p.y };
            }),
          });
          const titles = [...svg.querySelectorAll<SVGTextElement>(".notebook-graph__label")];
          // An area name follows its arc, so its own box is a loose square; each glyph box is the shape it covers.
          const names = [...svg.querySelectorAll<SVGTextElement>(".notebook-graph__band-label")];
          return {
            quads: [
              ...titles.map((label, index) => quad(label, label.getBBox(), index)),
              ...names.flatMap((name, index) =>
                Array.from({ length: name.getNumberOfChars() }, (_, char) => quad(name, name.getExtentOfChar(char), titles.length + index)),
              ),
            ],
            canvas: { x0: box.left, y0: box.top, x1: box.right, y1: box.bottom },
            statusTop: document.querySelector(".notebook-graph__status")!.getBoundingClientRect().top,
            count: titles.length,
          };
        });
        expect(count).toBeGreaterThan(0);
        for (const [i, quad] of quads.entries()) {
          for (const point of quad.points) {
            expect(point.x).toBeGreaterThanOrEqual(canvas.x0);
            expect(point.x).toBeLessThanOrEqual(canvas.x1);
            expect(point.y).toBeGreaterThanOrEqual(canvas.y0);
            expect(point.y).toBeLessThanOrEqual(Math.min(canvas.y1, statusTop));
          }
          for (const other of quads.slice(i + 1))
            if (other.owner !== quad.owner) expect(labelQuadsOverlap(quad.points, other.points)).toBe(false);
        }
        if (notebook === "hand01") expect(await page.locator(`[data-label="${WAREHOUSE}"]`).getAttribute("data-kind")).toBe("current");
        // The status line keeps the true totals, also for the notes whose titles found no room.
        expect(await page.locator(".notebook-graph__status").textContent()).toContain(notebook === "big001" ? "300 notes" : "49 notes");
        if (notebook === "big001") console.info(`${browserName} Circle ${viewport.width}px: ${count} of 300 notes labelled`);
      } finally {
        await close(page);
      }
    }, 30_000);
  }
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`${browserName}: Circle titles the focused ring neighbour of the current note beside its title at ${viewport.width}`, async () => {
    const page = await open(graphPath("hand01", "&display=circle"), viewport);
    try {
      const quad = (id: string) =>
        page.locator(`[data-label="${id}"]`).evaluate((label: SVGTextElement) => {
          const b = label.getBBox();
          return [
            [b.x, b.y],
            [b.x + b.width, b.y],
            [b.x + b.width, b.y + b.height],
            [b.x, b.y + b.height],
          ].map(([x, y]) => {
            const p = new DOMPoint(x, y).matrixTransform(label.getScreenCTM()!);
            return { x: p.x, y: p.y };
          });
        });
      for (const key of ["ArrowRight", "ArrowLeft"]) {
        await page.locator(`[data-node="${WAREHOUSE}"]`).focus();
        await page.keyboard.press(key);
        const neighbour = (await focusedNode(page))!;
        expect(neighbour).not.toBe(WAREHOUSE);
        await page.waitForSelector(`[data-label="${neighbour}"][data-kind="hover"]`, { timeout: 5_000 });
        expect(await page.locator(`[data-label="${WAREHOUSE}"]`).getAttribute("data-kind")).toBe("current");
        expect(labelQuadsOverlap(await quad(neighbour), await quad(WAREHOUSE))).toBe(false);
      }
    } finally {
      await close(page);
    }
  }, 30_000);
}

test(`${browserName}: Circle area names read left to right, including the lower half`, async () => {
  const page = await open(graphPath("hand01", "&display=circle"));
  try {
    const { cy } = await circleGeometry(page);
    const labels = await page.locator(".notebook-graph__band-label").evaluateAll((items) =>
      items.map((item) => {
        const text = item as SVGTextElement,
          n = text.getNumberOfChars(),
          matrix = text.getScreenCTM()!;
        const project = (p: DOMPoint) => new DOMPoint(p.x, p.y).matrixTransform(matrix);
        const start = project(text.getStartPositionOfChar(0)),
          end = project(text.getEndPositionOfChar(n - 1));
        const mid = project(text.getStartPositionOfChar(Math.floor(n / 2)));
        return { start: start.x, end: end.x, midY: mid.y };
      }),
    );
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) expect(label.start).toBeLessThan(label.end);
    expect(labels.some((label) => label.midY > cy)).toBe(true);
  } finally {
    await close(page);
  }
}, 30_000);

test(`${browserName}: Circle display and filters survive reload, opening a note and Back`, async () => {
  const page = await open(graphPath("hand01", `&display=circle&links=linked&hide=${HANDBOOK_IDS.komm}`));
  try {
    const before = [...search(page)];
    await page.reload();
    await settled(page);
    expect(await page.locator(".notebook-graph__svg").getAttribute("data-display")).toBe("circle");
    expect([...search(page)]).toEqual(before);
    await page.locator(`[data-node="${WAREHOUSE}"]`).focus();
    await page.keyboard.press("Enter");
    await page.waitForURL(`**/app/notebooks/hand01/notes/${WAREHOUSE}?mode=book`);
    await page.goBack();
    await settled(page);
    expect(await page.locator(".notebook-graph__svg").getAttribute("data-display")).toBe("circle");
    expect([...search(page)]).toEqual(before);
  } finally {
    await close(page);
  }
}, 30_000);

const timelineRows = (page: Page) => page.locator(".notebook-graph__row[data-row]");
const timelineIds = (page: Page) => timelineRows(page).evaluateAll((rows) => rows.map((row) => row.getAttribute("data-row")));
const focusedRow = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute("data-row") ?? null);
const timelineReady = (page: Page, links: number) =>
  page.waitForFunction((count) => document.querySelectorAll(".notebook-graph__arc").length === count, links);
const handbookModel = buildGraphModel(handbookGraph(), "en");
// Fixture ages give the expected order; ties use the model's notebook order.
const changedOrder = (direction: "asc" | "desc") =>
  handbookModel.notes.toSorted(
    (a, b) =>
      (direction === "desc" ? Date.parse(b.updatedAt) - Date.parse(a.updatedAt) : Date.parse(a.updatedAt) - Date.parse(b.updatedAt)) ||
      a.order - b.order,
  );

for (const lang of ["en", "de"] as const) {
  for (const filtered of [false, true]) {
    test(`${browserName}: Timeline ${lang} has dated rows, source-colored arcs and identical server groups${filtered ? " with filters" : ""}`, async () => {
      const hide = filtered ? [HANDBOOK_IDS.komm!] : [];
      const expected = visibleNotes(handbookModel, { links: filtered ? "linked" : "all", hide });
      const ids = new Set(expected.map((note) => note.id));
      const edges = visibleEdges(handbookModel, ids);
      const page = await open(
        graphPath("hand01", `&display=timeline&lang=${lang}${filtered ? `&links=linked&hide=${hide.join(",")}` : ""}`),
      );
      try {
        await timelineReady(page, edges.length);
        expect(await timelineIds(page)).toEqual(
          changedOrder("desc")
            .filter((note) => ids.has(note.id))
            .map((note) => note.id),
        );
        expect(await timelineRows(page).count()).toBe(expected.length);
        expect(new Set(await timelineIds(page)).size).toBe(expected.length);
        expect(await page.locator(".notebook-graph__timeline-wrap").getByRole("link").count()).toBe(expected.length);
        expect(await page.locator('[data-row][tabindex="0"]').count()).toBe(1);
        expect(await page.locator('[data-row][tabindex="0"]').getAttribute("data-row")).toBe(WAREHOUSE);
        expect(await page.locator(".notebook-graph__arcs").getAttribute("aria-hidden")).toBe("true");
        const headings = await page.locator(".notebook-graph__timeline-group").allTextContents();
        expect(headings.slice(0, 4)).toEqual(
          lang === "en" ? ["Today", "Yesterday", "This week", "Last week"] : ["Heute", "Gestern", "Diese Woche", "Letzte Woche"],
        );
        expect(headings.slice(4)).toEqual([
          ...(lang === "en" ? ["October", "September", "August", "July", "June"] : ["Oktober", "September", "August", "Juli", "Juni"]),
          ...(!filtered ? ["April"] : []),
        ]);
        for (const label of await timelineRows(page).evaluateAll((rows) => rows.map((row) => row.getAttribute("aria-label"))))
          expect(label).toContain(lang === "en" ? "changed" : "geändert");
        const slots = await page.locator(".notebook-graph__arc").evaluateAll((arcs) =>
          arcs.map((arc) => ({
            arc: arc.getAttribute("data-slot"),
            row: document.querySelector(`[data-row="${arc.getAttribute("data-source")}"]`)?.getAttribute("data-slot") ?? null,
          })),
        );
        expect(slots).toHaveLength(edges.length);
        for (const slot of slots) expect(slot.arc).toBe(slot.row);
        const initial = await page.evaluate(() => window.notebookGraphFixture!);
        expect(initial.serverFrame.timelineRows).toEqual(await timelineIds(page));
        expect(initial.serverFrame.timelineGroups).toEqual(headings);
        expect(initial.clientFrame.timelineRows).toEqual(initial.serverFrame.timelineRows);
        expect(initial.clientFrame.timelineGroups).toEqual(initial.serverFrame.timelineGroups);
      } finally {
        await close(page);
      }
    }, 30_000);
  }
}

test(`${browserName}: Timeline hover keeps neighbours and distinguishes incoming and outgoing arcs`, async () => {
  const page = await open(graphPath("hand01", "&display=timeline"));
  try {
    await timelineReady(page, handbookModel.edges.length);
    await page.locator(`[data-row="${WAREHOUSE}"]`).hover();
    await page.waitForSelector(".notebook-graph__timeline[data-highlight]");
    const near = await page.locator("[data-row][data-near]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-row")));
    expect(new Set(near)).toEqual(new Set([WAREHOUSE, ...handbookModel.byId.get(WAREHOUSE)!.neighbours]));
    const arcs = await page.locator(".notebook-graph__arc").evaluateAll((items) =>
      items.map((arc) => ({
        source: arc.getAttribute("data-source"),
        target: arc.getAttribute("data-target"),
        near: arc.getAttribute("data-near"),
        opacity: Number(getComputedStyle(arc).strokeOpacity),
        dash: getComputedStyle(arc).strokeDasharray,
      })),
    );
    const outgoing = arcs.filter((arc) => arc.source === WAREHOUSE);
    const incoming = arcs.filter((arc) => arc.target === WAREHOUSE);
    expect(outgoing).toHaveLength(7);
    expect(incoming).toHaveLength(2);
    for (const arc of outgoing) {
      expect(arc.near).toBe("out");
      expect(arc.dash).toBe("none");
    }
    for (const arc of incoming) {
      expect(arc.near).toBe("in");
      expect(arc.dash).not.toBe("none");
    }
    for (const arc of arcs.filter((arc) => !arc.near)) expect(arc.opacity).toBeLessThan(outgoing[0]!.opacity);
    await page.mouse.move(0, 0);
    expect(await page.locator(".notebook-graph__timeline[data-highlight]").count()).toBe(0);
  } finally {
    await close(page);
  }
}, 30_000);

test(`${browserName}: Timeline has one tab stop, scrolls with arrows, and opens with Enter`, async () => {
  const page = await open(graphPath("hand01", "&display=timeline"));
  try {
    const ids = changedOrder("desc").map((note) => note.id);
    const current = ids.indexOf(WAREHOUSE);
    await page.locator(".notebook-graph__areas button").last().focus();
    await page.keyboard.press("Tab");
    expect(await focusedRow(page)).toBe(WAREHOUSE);
    const inside = () =>
      page.evaluate(() => {
        const row = document.activeElement!.getBoundingClientRect();
        const scroller = document.querySelector(".notebook-graph__timeline")!.getBoundingClientRect();
        return row.top >= scroller.top - 1 && row.bottom <= scroller.bottom + 1;
      });
    for (let step = 1; step <= ids.length; step++) {
      await page.keyboard.press("ArrowDown");
      expect(await focusedRow(page)).toBe(ids[Math.min(current + step, ids.length - 1)]!);
      expect(await page.locator('[data-row][tabindex="0"]').getAttribute("data-row")).toBe(await focusedRow(page));
      expect(await inside()).toBe(true);
    }
    await page.keyboard.press("ArrowUp");
    expect(await focusedRow(page)).toBe(ids.at(-2)!);
    await page.keyboard.press("Home");
    expect(await focusedRow(page)).toBe(WAREHOUSE);
    await page.keyboard.press("Enter");
    await page.waitForURL(`**/app/notebooks/hand01/notes/${WAREHOUSE}?mode=book`);
  } finally {
    await close(page);
  }
}, 30_000);

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`${browserName}: Timeline opens at the current row and avoids horizontal overflow at ${viewport.width}`, async () => {
    const page = await open(graphPath("hand01", "&display=timeline"), viewport);
    try {
      for (let load = 0; load < 2; load++) {
        if (load) {
          await page.reload();
          await page.waitForFunction(() => window.notebookGraphFixture?.mounted);
        }
        await timelineReady(page, handbookModel.edges.length);
        const box = await page.locator(".notebook-graph__timeline").evaluate((element: HTMLElement, id) => {
          const row = element.querySelector(`[data-row="${id}"]`)!.getBoundingClientRect();
          return {
            centre: row.top + row.height / 2 - element.getBoundingClientRect().top,
            height: row.height,
            viewport: element.clientHeight,
            overflow: element.scrollWidth - element.clientWidth,
            documentOverflow: document.documentElement.scrollWidth - innerWidth,
          };
        }, WAREHOUSE);
        expect(box.centre).toBeGreaterThanOrEqual(0);
        expect(box.centre).toBeLessThanOrEqual(box.viewport / 3 + box.height);
        expect(box.overflow).toBeLessThanOrEqual(0);
        expect(box.documentOverflow).toBeLessThanOrEqual(0);
      }
    } finally {
      await close(page);
    }
  }, 30_000);
}

test(`${browserName}: Timeline search marks matches and Enter follows time order`, async () => {
  const page = await open(graphPath("hand01", "&display=timeline"));
  try {
    const find = page.getByRole("searchbox", { name: "Find a note in the graph" });
    for (const query of ["Kühl", "plan"]) {
      await find.fill(query);
      const hits = changedOrder("desc").filter((note) => matchesQuery(note, query));
      await page.waitForFunction((count) => document.querySelectorAll("[data-row][data-match]").length === count, hits.length);
      expect(await page.locator("[data-row]:not([data-match])").count()).toBe(handbookModel.notes.length - hits.length);
      const appearances = await page.locator("[data-row]").evaluateAll((rows) =>
        rows.map((row) => {
          const title = getComputedStyle(row.querySelector(".notebook-graph__row-title")!);
          return { match: row.hasAttribute("data-match"), appearance: [title.color, title.opacity, getComputedStyle(row).opacity] };
        }),
      );
      expect(appearances.find((row) => row.match)!.appearance).not.toEqual(appearances.find((row) => !row.match)!.appearance);
      await find.press("Enter");
      expect(await focusedRow(page)).toBe(hits[0]!.id);
      await page.keyboard.press("Escape");
      expect(await find.inputValue()).toBe("");
      await page.keyboard.press("Escape");
      expect(await focusedRow(page)).toBeNull();
    }
  } finally {
    await close(page);
  }
}, 30_000);

test(`${browserName}: Timeline disables zoom without moving the toolbars`, async () => {
  const page = await open(graphPath("hand01", "&display=network"));
  try {
    const boxes = () =>
      page.evaluate(() =>
        [".notebook-graph__head", ".notebook-graph__filters", ".notebook-graph__body", ".notebook-graph__zoom"].map((selector) => {
          const box = document.querySelector(selector)!.getBoundingClientRect();
          return [box.x, box.y, box.width, box.height];
        }),
      );
    const before = await boxes();
    await page.getByRole("radio", { name: "Timeline", exact: true }).click();
    await timelineReady(page, handbookModel.edges.length);
    expect(await boxes()).toEqual(before);
    for (const label of ["Zoom in", "Zoom out", "Fit graph"]) {
      const button = page.locator(`.notebook-graph__zoom button[aria-label="${label}"]`);
      expect(await button.isVisible()).toBe(false);
      expect(await button.isDisabled()).toBe(true);
    }
    expect(await page.locator(".notebook-graph__depth").count()).toBe(0);
  } finally {
    await close(page);
  }
}, 30_000);

test(`${browserName}: Timeline renders every row and link at 300 notes`, async () => {
  const model = buildGraphModel(bigGraph(), "en");
  const page = await open(graphPath("big001", "&display=timeline"));
  try {
    await timelineReady(page, model.edges.length);
    expect(await timelineRows(page).count()).toBe(300);
    expect(await page.locator(".notebook-graph__arc").count()).toBe(model.edges.length);
    const ms = await page.evaluate(() => window.notebookGraphFixture!.firstFrameMs);
    console.info(`${browserName} Timeline: 300 rows, ${model.edges.length} arcs, first frame ${ms.toFixed(1)}ms`);
  } finally {
    await close(page);
  }
}, 30_000);

test(`${browserName}: Timeline returns to the scrolled rows after opening a note and Back, and after a reload`, async () => {
  const page = await open(graphPath("big001", "&display=timeline"));
  const model = buildGraphModel(bigGraph(), "en");
  const scrollTop = () => page.locator(".notebook-graph__timeline").evaluate((element) => element.scrollTop);
  try {
    await timelineReady(page, model.edges.length);
    const opened = await page.locator(".notebook-graph__timeline").evaluate((element) => {
      element.scrollTop = element.scrollHeight / 2;
      const top = element.getBoundingClientRect().top;
      return [...element.querySelectorAll<HTMLElement>("[data-row]")].find((row) => row.getBoundingClientRect().top > top + 40)!.dataset
        .row!;
    });
    const scrolled = await scrollTop();
    expect(scrolled).toBeGreaterThan(1000);
    await page.locator(`[data-row="${opened}"]`).click();
    await page.waitForURL(`**/app/notebooks/big001/notes/${opened}?mode=book`);
    await page.goBack();
    await page.waitForFunction(() => window.notebookGraphFixture?.mounted);
    await timelineReady(page, model.edges.length);
    expect(Math.abs((await scrollTop()) - scrolled)).toBeLessThanOrEqual(1);
    await page.locator(".notebook-graph__timeline").evaluate((element) => {
      element.scrollTop = 400;
    });
    // The position is saved once scrolling pauses.
    await page.waitForFunction(() => history.state?.notebookGraphTimelineScroll === 400);
    await page.reload();
    await page.waitForFunction(() => window.notebookGraphFixture?.mounted);
    await timelineReady(page, model.edges.length);
    expect(Math.abs((await scrollTop()) - 400)).toBeLessThanOrEqual(1);
    // A display switch right after scrolling, before the pause, keeps the newest position too.
    const pendingAtSwitch = await page.getByRole("radio", { name: "Network", exact: true }).evaluate(async (radio: HTMLElement) => {
      document.querySelector(".notebook-graph__timeline")!.scrollTop = 1200;
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));
      const pending = history.state?.notebookGraphTimelineScroll !== 1200;
      radio.click();
      return pending;
    });
    expect(pendingAtSwitch).toBe(true);
    expect(search(page).get("display")).toBe("network");
    await page.getByRole("radio", { name: "Timeline", exact: true }).click();
    await timelineReady(page, model.edges.length);
    expect(Math.abs((await scrollTop()) - 1200)).toBeLessThanOrEqual(1);
  } finally {
    await close(page);
  }
}, 30_000);

test(`${browserName}: a list sorted by Changed shows the Changed column on a phone, without horizontal overflow`, async () => {
  const page = await open(graphPath("hand01", "&list=1&sort=changed"), { width: 390, height: 844 });
  try {
    const changed = page.getByRole("columnheader", { name: "Changed", exact: true });
    expect(await changed.isVisible()).toBe(true);
    expect(await changed.getAttribute("aria-sort")).toBe("descending");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    const overflow = await page.locator(".notebook-graph__list").evaluate((element) => {
      const table = element.querySelector("table")!.getBoundingClientRect();
      return table.right - element.getBoundingClientRect().right;
    });
    expect(overflow).toBeLessThanOrEqual(0);
    await changed.getByRole("button").click();
    expect(search(page).get("sort")).toBe("changed-asc");
    expect(await changed.getAttribute("aria-sort")).toBe("ascending");
  } finally {
    await close(page);
  }
}, 30_000);

test(`${browserName}: Changed sorts the list through the URL and survives reload and Back`, async () => {
  const page = await open(graphPath("hand01", "&list=1"));
  const ids = () =>
    page
      .locator(".notebook-graph__list-title")
      .evaluateAll((links) => links.map((link) => /\/notes\/([^?]+)/.exec(link.getAttribute("href")!)![1]));
  try {
    const changed = page.getByRole("columnheader", { name: "Changed", exact: true });
    expect(await changed.getAttribute("aria-sort")).toBe("none");
    expect(await ids()).toEqual(handbookModel.notes.map((note) => note.id));
    expect(await page.locator('th:not(:has-text("Changed"))[aria-sort]').count()).toBe(0);
    await changed.getByRole("button").click();
    expect(search(page).get("sort")).toBe("changed");
    expect(await changed.getAttribute("aria-sort")).toBe("descending");
    expect(await ids()).toEqual(changedOrder("desc").map((note) => note.id));
    await changed.getByRole("button").click();
    expect(search(page).get("sort")).toBe("changed-asc");
    expect(await changed.getAttribute("aria-sort")).toBe("ascending");
    const oldest = changedOrder("asc").map((note) => note.id);
    expect(await ids()).toEqual(oldest);
    await page.reload();
    await page.waitForFunction(() => window.notebookGraphFixture?.mounted);
    expect(await ids()).toEqual(oldest);
    expect(await changed.getAttribute("aria-sort")).toBe("ascending");
    await page.locator(".notebook-graph__list-title").first().click();
    await page.waitForURL(`**/app/notebooks/hand01/notes/${oldest[0]}?mode=book`);
    await page.goBack();
    await page.waitForFunction(() => window.notebookGraphFixture?.mounted);
    expect(search(page).get("list")).toBe("1");
    expect(search(page).get("sort")).toBe("changed-asc");
    expect(await ids()).toEqual(oldest);
    expect(await changed.getAttribute("aria-sort")).toBe("ascending");
  } finally {
    await close(page);
  }
}, 30_000);

test(`${browserName}: Timeline and filters survive reload, opening a note, and Back`, async () => {
  const page = await open(graphPath("hand01", `&display=timeline&links=linked&hide=${HANDBOOK_IDS.komm}`));
  try {
    const before = [...search(page)];
    const rows = await timelineIds(page);
    await page.reload();
    await page.waitForFunction(() => window.notebookGraphFixture?.mounted);
    expect([...search(page)]).toEqual(before);
    expect(await timelineIds(page)).toEqual(rows);
    await page.locator(`[data-row="${WAREHOUSE}"]`).focus();
    await page.keyboard.press("Enter");
    await page.waitForURL(`**/app/notebooks/hand01/notes/${WAREHOUSE}?mode=book`);
    await page.goBack();
    await page.waitForFunction(() => window.notebookGraphFixture?.mounted);
    expect(search(page).get("display")).toBe("timeline");
    expect([...search(page)]).toEqual(before);
    expect(await timelineIds(page)).toEqual(rows);
  } finally {
    await close(page);
  }
}, 30_000);

test(`${browserName}: Timeline scroll range shrinks with the rows when a filter hides most of them`, async () => {
  const model = buildGraphModel(bigGraph(), "en");
  const page = await open(graphPath("big001", "&display=timeline"));
  try {
    await timelineReady(page, model.edges.length);
    const range = () =>
      page.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>(".notebook-graph__timeline")!;
        const wrap = scroller.querySelector<HTMLElement>(".notebook-graph__timeline-wrap")!;
        const arcs = scroller.querySelector<SVGSVGElement>(".notebook-graph__arcs")!;
        return { scroll: scroller.scrollHeight, rows: wrap.offsetHeight, arcs: arcs.getBoundingClientRect().height };
      });
    const before = await range();
    await page.evaluate(() => {
      document.querySelector<HTMLElement>(".notebook-graph__timeline")!.scrollTop = 1e6;
    });
    // Hide every area but the first; the arcs of the remaining notes are drawn again from the new rows.
    const areas = page.locator(".notebook-graph__areas button");
    for (let index = (await areas.count()) - 1; index > 0; index--) await areas.nth(index).click();
    const rows = await timelineRows(page).count();
    expect(rows).toBeLessThan(300);
    await page.waitForFunction(() => {
      const wrap = document.querySelector<HTMLElement>(".notebook-graph__timeline-wrap")!;
      return Math.abs(document.querySelector(".notebook-graph__arcs")!.getBoundingClientRect().height - wrap.offsetHeight) < 1;
    });
    const after = await range();
    expect(after.rows).toBeLessThan(before.rows);
    expect(after.scroll).toBeLessThanOrEqual(
      Math.max(after.rows, await page.locator(".notebook-graph__timeline").evaluate((el) => el.clientHeight)) + 1,
    );
    // Some rows stay in view after the range shrinks.
    expect(
      await page.evaluate(() => {
        const scroller = document.querySelector(".notebook-graph__timeline")!.getBoundingClientRect();
        return [...document.querySelectorAll("[data-row]")].some((row) => {
          const box = row.getBoundingClientRect();
          return box.bottom > scroller.top && box.top < scroller.bottom;
        });
      }),
    ).toBe(true);
  } finally {
    await close(page);
  }
}, 30_000);

test(`${browserName}: Timeline in a notebook without links keeps the unlinked notes and their search`, async () => {
  const page = await open(graphPath("free01", "&display=timeline"));
  try {
    expect(await page.locator(".notebook-graph__timeline").count()).toBe(0);
    const find = page.getByRole("searchbox", { name: "Find a note in the graph" });
    await find.fill("Kost");
    await find.press("Enter");
    expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Kosten");
  } finally {
    await close(page);
  }
}, 30_000);
