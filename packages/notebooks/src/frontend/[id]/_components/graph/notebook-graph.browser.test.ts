import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { browserName, launchBrowser } from "../../../../../../ui/test/browser";
import { FIXTURE_NOW, HANDBOOK_IDS } from "./graph.fixtures";
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
      await page.locator(`[data-node="${target}"]`).focus();
      await page.keyboard.press("Space");
      await page.waitForFunction((id) => new URL(location.href).searchParams.get("note") === id, target);
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
    await bar.getByRole("button", { name: "Move to center", exact: true }).click();
    expect(search(page).get("note")).toBe(target);
    expect(await bar.count()).toBe(0);
    expect(await page.locator("[data-node][data-current]").getAttribute("data-node")).toBe(target);
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
      expect(search(page).get("display")).toBe(expected === "network" ? "neighborhood" : "network");
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
    await page.getByRole("button", { name: "Show whole notebook", exact: true }).click();
    await settled(page);
    expect(search(page).get("display")).toBe("network");
    expect(await nodes(page).count()).toBe(49);
    await page.goto(new URL(graphPath("hand01", "&display=neighborhood&links=unlinked"), server.url).href);
    await page.waitForFunction(() => window.notebookGraphFixture?.mounted);
    expect(await page.getByText("No link of “Wareneingang” matches the filters", { exact: true }).isVisible()).toBe(true);
    expect(await page.getByText("The current filters hide all links of this note.", { exact: true }).isVisible()).toBe(true);
    await page.getByRole("button", { name: "Reset filters", exact: true }).click();
    await settled(page);
    expect(await page.locator('[data-ring="1"]').count()).toBeGreaterThan(0);
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
