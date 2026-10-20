import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { Browser, Page } from "playwright";
import { createComponent, createSignal } from "solid-js";
import { Dynamic, renderToString } from "solid-js/web";
import { launchBrowser } from "../../test/browser";
import {
  type FixtureOptions,
  uiDirectory,
  workspaceCss,
  workspaceDist,
  workspaceFrames,
  workspaceTree,
} from "../../test/workspace-host-fixture";

declare global {
  interface Window {
    mountHead: () => void;
    mountControls: () => void;
    headMountedFrame: ReturnType<typeof headGeometry>;
  }
}

setDefaultTimeout(30_000);
const directory = mkdtempSync(resolve(tmpdir(), "k2b-workspace-head-"));
const { plugin } = createConfig({ dev: true, rootDir: directory });
Bun.plugin(plugin());
process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
const { AppWorkspace, ViewTabs, FilterChip, IconButton, PageTrailProvider, Tabs, SegmentedControl } = await import("../index");
const components = { AppWorkspace, ViewTabs, FilterChip, IconButton, PageTrailProvider, createComponent, createSignal, Dynamic };
const css = workspaceCss();
const entry = resolve(uiDirectory, "src/layout/workspace-head.client-fixture.ts");
const build = await Bun.build({
  entrypoints: [entry],
  files: {
    [entry]: `
    import { createComponent, createSignal } from "solid-js";
    import { Dynamic, render } from "solid-js/web";
    import { AppWorkspace, ViewTabs, FilterChip, IconButton, PageTrailProvider, Tabs, SegmentedControl } from ${JSON.stringify(resolve(workspaceDist, "browser/index.js"))};
    const tree = ${workspaceTree.toString()};
    window.mountHead = () => {
      const root = document.getElementById("app");
      root.replaceChildren();
      render(() => tree({AppWorkspace, ViewTabs, FilterChip, IconButton, PageTrailProvider, createComponent, createSignal, Dynamic},
        JSON.parse(document.body.dataset.options)), root);
      window.headMountedFrame = (${headGeometry.toString()})();
    };
    window.mountControls = () => {
      render(() => {
        const [value, setValue] = createSignal("a");
        const options = [{value:"a",label:"List"},{value:"b",label:"Calendar"},{value:"c",label:"Board"}];
        return [createComponent(Tabs, {ariaLabel:"Panels",value,onValueChange:setValue,options}),
          createComponent(SegmentedControl, {ariaLabel:"Mode",value,onValueChange:setValue,options})];
      }, document.getElementById("controls"));
    };`,
  },
  target: "browser",
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle head row fixture");
const client = await build.outputs[0]!.text();
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

function headGeometry() {
  return [
    ...document.querySelectorAll<HTMLElement>(
      [
        ".k2b-app-workspace__head",
        ".k2b-app-workspace__head-lead",
        ".k2b-view-tabs__item > a",
        ".k2b-view-tabs__more",
        ".k2b-app-workspace__head-filters",
        ".k2b-filter-chip",
        ".k2b-app-workspace__head-count",
        ".k2b-app-workspace__head-actions",
        "[data-workspace-primary]",
      ].join(","),
    ),
  ].map((element) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
  });
}
const rect = async (page: Page, selector: string) => {
  const box = await page.locator(selector).boundingBox();
  expect(box, selector).not.toBeNull();
  return box!;
};
const center = (box: { y: number; height: number }) => box.y + box.height / 2;
const load = async (options: FixtureOptions = {}, viewport = 1440, host = viewport, mount = false) => {
  const page = await browser.newPage({
    viewport: { width: viewport, height: viewport < 768 ? 844 : 900 },
    isMobile: viewport < 768,
    reducedMotion: "reduce",
  });
  const fixture: FixtureOptions = { sidebarActive: true, ...options, head: { items: 4, ...options.head } };
  await page.route("http://workspace.test/**", (route) => {
    const reset = new URL(route.request().url()).searchParams.get("view") === "1";
    const responseOptions = reset ? { ...fixture, head: { ...fixture.head, filtered: false } } : fixture;
    const markup = renderToString(() => workspaceTree(components, responseOptions));
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head>
      <body class="k2b-ui" style="margin:0" data-options='${JSON.stringify(responseOptions)}'>
        <div id="app" style="container:k2b-app-area / inline-size;width:${host}px;height:${viewport < 768 ? 844 : 900}px">${markup}</div>
        <div id="controls" style="position:fixed;z-index:100;bottom:0;left:0;width:500px;background:#fff"></div></body></html>`,
    });
  });
  await page.goto("http://workspace.test/");
  await page.addScriptTag({ content: client });
  if (mount) await page.evaluate(() => window.mountHead());
  await workspaceFrames(page);
  return page;
};
// A count may leave its text below a one-line clipping box instead of using display:none.
const countVisible = async (page: Page) => {
  const count = page.locator(".k2b-app-workspace__head-count > span");
  if (!(await count.count())) return false;
  return count.evaluate((element) => {
    if (!element.checkVisibility()) return false;
    const text = element.getBoundingClientRect();
    let left = text.left,
      right = text.right,
      top = text.top,
      bottom = text.bottom;
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      const box = ancestor.getBoundingClientRect();
      if (style.overflowX !== "visible") {
        left = Math.max(left, box.left);
        right = Math.min(right, box.right);
      }
      if (style.overflowY !== "visible") {
        top = Math.max(top, box.top);
        bottom = Math.min(bottom, box.bottom);
      }
    }
    return right > left && bottom > top;
  });
};
const resizeHost = async (page: Page, width: number) => {
  await page.locator("#app").evaluate((element, width) => {
    element.style.width = `${width}px`;
  }, width);
  await workspaceFrames(page);
};

test("workspace width wraps filters while tabs and actions keep the first row", async () => {
  const page = await load();
  try {
    const tabs = await rect(page, ".k2b-view-tabs");
    const chips = await rect(page, ".k2b-filter-chip >> nth=0");
    const action = await rect(page, "[data-workspace-primary]");
    expect(Math.abs(center(tabs) - center(chips))).toBeLessThanOrEqual(2);
    expect(Math.abs(center(tabs) - center(action))).toBeLessThanOrEqual(2);
    await resizeHost(page, 640);
    const narrowTabs = await rect(page, ".k2b-view-tabs");
    expect((await rect(page, ".k2b-app-workspace__head-filters")).y).toBeGreaterThanOrEqual(narrowTabs.y + narrowTabs.height);
    expect(Math.abs(center(narrowTabs) - center(await rect(page, "[data-workspace-primary]")))).toBeLessThanOrEqual(2);
    expect(page.viewportSize()?.width).toBe(1440);
  } finally {
    await page.close();
  }
});

test("a waiting detail's Details button stays in the first row when the filters wrap to row 2", async () => {
  const page = await load({ head: { items: 4, detail: "sm" } }, 1440, 620);
  try {
    const toggle = await rect(page, "[data-app-workspace-detail-toggle]");
    const primary = await rect(page, "[data-workspace-primary]");
    const tabs = await rect(page, ".k2b-view-tabs");
    const filters = await rect(page, ".k2b-app-workspace__head-filters");
    const head = await rect(page, ".k2b-app-workspace__head");
    // The row wraps: the filters stand below the views, the head grows.
    expect(filters.y).toBeGreaterThanOrEqual(tabs.y + tabs.height);
    expect(head.height).toBeGreaterThan(80);
    // The button shares the first line with the actions, at the head's end.
    expect(Math.abs(center(toggle) - center(primary))).toBeLessThanOrEqual(2);
    expect(toggle.x).toBeGreaterThanOrEqual(primary.x + primary.width);
    expect(toggle.x + toggle.width).toBeLessThanOrEqual(head.x + head.width);
  } finally {
    await page.close();
  }
});

test("More lists exactly the CSS-hidden views at each level and always keeps the current view in the strip", async () => {
  const page = await load({ head: { items: 8, current: "7" } }, 1440, 1440, true);
  try {
    const current = page.locator('.k2b-view-tabs__item > a[aria-current="page"]');
    expect(await current.getAttribute("href")).toBe("?view=7");
    expect(await current.isVisible()).toBe(true);
    const more = page.locator(".k2b-view-tabs__more-trigger");
    expect(await more.locator('[data-level="wide"]').isVisible()).toBe(true);
    expect(await more.locator('[data-level="wide"]').textContent()).toBe("+3");
    await more.click();
    const menu = page.getByRole("menu", { name: "More views" });
    expect(await menu.getByRole("menuitem").evaluateAll((items) => items.map((item) => item.getAttribute("href")))).toEqual([
      "?view=5",
      "?view=6",
      "?view=8",
    ]);
    expect(await menu.locator("a").last().locator(".k2b-view-tabs__count").textContent()).toBe("3");
    await page.keyboard.press("Escape");
    await resizeHost(page, 760);
    expect(await current.isVisible()).toBe(true);
    expect(
      await page.locator("[data-compact-hidden]").evaluateAll((items) => items.every((item) => item.getClientRects().length === 0)),
    ).toBe(true);
    expect(await more.locator('[data-level="compact"]').isVisible()).toBe(true);
    expect(await more.locator('[data-level="compact"]').textContent()).toBe("+5");
    await more.click();
    expect(await menu.getByRole("menuitem").evaluateAll((items) => items.map((item) => item.getAttribute("href")))).toEqual([
      "?view=3",
      "?view=4",
      "?view=5",
      "?view=6",
      "?view=8",
    ]);
  } finally {
    await page.close();
  }
});

test("a narrow head opens More for views that fit the wide strip, at a narrow host and on a phone", async () => {
  for (const [viewport, host] of [
    [1440, 640],
    [390, 390],
  ] as const) {
    const page = await load({ head: { items: 4, current: "1" } }, viewport, host, true);
    try {
      const more = page.locator(".k2b-view-tabs__more-trigger");
      expect(await more.isVisible()).toBe(true);
      expect(await more.locator('[data-level="compact"]').textContent()).toBe("+1");
      expect(await page.locator('[data-view-tab="4"]').evaluate((item) => item.getClientRects().length)).toBe(0);
      await more.click();
      const menu = page.getByRole("menu", { name: "More views" });
      expect(await menu.getByRole("menuitem").evaluateAll((items) => items.map((item) => item.getAttribute("href")))).toEqual(["?view=4"]);
    } finally {
      await page.close();
    }
  }
});

test("the current view stays inside the strip's scrollport when long labels do not fit", async () => {
  for (const [viewport, host] of [
    [1440, 640],
    [390, 390],
  ] as const) {
    const page = await load({ head: { items: 8, current: "3", longLabels: true } }, viewport, host);
    try {
      const clip = await page.locator('.k2b-view-tabs__item > a[aria-current="page"]').evaluate((link) => {
        const list = link.closest(".k2b-view-tabs__list")!;
        const tab = link.getBoundingClientRect();
        const port = list.getBoundingClientRect();
        return { left: tab.left - port.left, right: port.right - tab.right, width: tab.width };
      });
      expect(clip.left).toBeGreaterThanOrEqual(-0.5);
      expect(clip.right).toBeGreaterThanOrEqual(-0.5);
      expect(clip.width).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  }
});

test("a page at the app's root keeps its title beside the overlay sidebar's button", async () => {
  const page = await load({ head: { root: true } }, 1440, 834);
  try {
    expect(await page.locator(".k2b-app-workspace__head-toggle").isVisible()).toBe(true);
    expect(await page.locator(".k2b-app-workspace__head .k2b-page-title").isVisible()).toBe(true);
  } finally {
    await page.close();
  }
  const wide = await load({ head: { root: true } }, 1440, 1440);
  try {
    expect(await wide.locator(".k2b-app-workspace__head .k2b-page-title").isVisible()).toBe(false);
  } finally {
    await wide.close();
  }
});

test("view, classic tab, and segment selection and hover never move neighbouring controls", async () => {
  const page = await load({ head: { items: 3, current: "1" } });
  const other = await load({ head: { items: 3, current: "2" } });
  const boxes = (page: Page, selector: string) =>
    page.locator(selector).evaluateAll((elements) =>
      elements.map((element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      }),
    );
  try {
    const before = await boxes(page, ".k2b-view-tabs__tab");
    expect(await boxes(other, ".k2b-view-tabs__tab")).toEqual(before);
    await page.locator(".k2b-view-tabs__tab").nth(1).hover();
    expect(await boxes(page, ".k2b-view-tabs__tab")).toEqual(before);
    await page.evaluate(() => window.mountControls());
    for (const selector of ['[role="tab"]', '[role="radio"]']) {
      const initial = await boxes(page, selector);
      await page.locator(selector).nth(1).hover();
      expect(await boxes(page, selector)).toEqual(initial);
      await page.locator(selector).nth(1).click();
      expect(await boxes(page, selector)).toEqual(initial);
      await page.locator(selector).first().click();
      expect(await boxes(page, selector)).toEqual(initial);
    }
  } finally {
    await page.close();
    await other.close();
  }
});

test("the quiet filtered count disappears before the chips wrap", async () => {
  const page = await load({ head: { items: 3 } });
  const unfiltered = await load({ head: { filtered: false } });
  try {
    expect(await unfiltered.locator(".k2b-app-workspace__head-count").count()).toBe(0);
    expect(await countVisible(page)).toBe(true);
    let firstChange = false;
    for (let width = 1420; width >= 600; width -= 20) {
      await resizeHost(page, width);
      const count = await countVisible(page);
      const tabs = await rect(page, ".k2b-view-tabs");
      const filters = await rect(page, ".k2b-app-workspace__head-filters");
      const wrapped = filters.y >= tabs.y + tabs.height;
      if (!count || wrapped) {
        expect(count, `first change at ${width}px`).toBe(false);
        expect(wrapped, `chips still in row one at ${width}px`).toBe(false);
        firstChange = true;
        break;
      }
    }
    expect(firstChange).toBe(true);
  } finally {
    await page.close();
    await unfiltered.close();
  }
});

test("active values are named and Reset works as a document link or hydrated callback", async () => {
  const page = await load();
  const callback = await load({ head: { reset: "callback" } }, 1440, 1440, true);
  try {
    expect(await page.getByRole("button", { name: "Tags: Customer", exact: true }).textContent()).toContain("Customer");
    expect(await page.locator(".k2b-filter-chip__dot").count()).toBe(1);
    expect(await page.getByRole("link", { name: "Reset", exact: true }).getAttribute("href")).toBe("?view=1");
    await page.getByRole("link", { name: "Reset", exact: true }).click();
    expect(new URL(page.url()).search).toBe("?view=1");
    expect(await page.locator(".k2b-app-workspace__head-reset").count()).toBe(0);
    expect(await page.getByRole("button", { name: "Tags", exact: true }).count()).toBe(1);
    await callback.getByRole("button", { name: "Reset", exact: true }).click();
    expect(await callback.locator("body").getAttribute("data-reset-calls")).toBe("1");
    expect(await callback.locator(".k2b-app-workspace__head-reset").count()).toBe(0);
    expect(await callback.locator(".k2b-app-workspace__head-count").count()).toBe(0);
    expect(await callback.getByRole("button", { name: "Tags", exact: true }).count()).toBe(1);
  } finally {
    await page.close();
    await callback.close();
  }
});

test("phone views stay at the top while Main scrolls and the primary is a named round button", async () => {
  const page = await load({}, 390);
  try {
    const tabs = await rect(page, ".k2b-view-tabs");
    const head = await rect(page, ".k2b-app-workspace__head");
    const workspace = await rect(page, ".k2b-app-workspace");
    expect(Math.abs(head.y - workspace.y)).toBeLessThanOrEqual(1);
    expect((await rect(page, ".k2b-app-workspace__head-filters")).y).toBeGreaterThanOrEqual(tabs.y + tabs.height);
    await page.locator(".k2b-app-workspace__main").evaluate((element) => {
      element.scrollTop = 400;
    });
    await workspaceFrames(page);
    expect(await page.locator(".k2b-app-workspace__main").evaluate((element) => element.scrollTop)).toBe(400);
    expect(await rect(page, ".k2b-view-tabs")).toEqual(tabs);
    const primary = page.getByRole("link", { name: "New task", exact: true });
    expect(await primary.count()).toBe(1);
    const box = (await primary.boundingBox())!;
    expect(Math.abs(box.width - box.height)).toBeLessThanOrEqual(0.5);
    const radius = await primary.evaluate((element) => parseFloat(getComputedStyle(element).borderRadius));
    expect(radius).toBeGreaterThanOrEqual(box.width / 2);
  } finally {
    await page.close();
  }
});

for (const actions of [true, false]) {
  for (const width of [320, 390]) {
    test(`phone root views keep their row with actions=${actions} at ${width}px`, async () => {
      const page = await load({ head: { root: true, actions } }, width);
      try {
        const assertRows = async () => {
          const views = await rect(page, ".k2b-app-workspace__head-views");
          const filters = await rect(page, ".k2b-app-workspace__head-filters");
          const current = await rect(page, '.k2b-view-tabs [aria-current="page"]');
          expect(filters.y).toBeGreaterThanOrEqual(views.y + views.height);
          expect(current.x).toBeGreaterThanOrEqual(views.x);
          expect(current.x + current.width).toBeLessThanOrEqual(views.x + views.width);
        };
        await assertRows();
        const before = await page.evaluate(headGeometry);
        await page.evaluate(() => window.mountHead());
        await workspaceFrames(page);
        expect(await page.evaluate(headGeometry)).toEqual(before);
        await assertRows();
      } finally {
        await page.close();
      }
    });
  }
}

test("keyboard order follows views, chips, Reset, secondary, primary with unclipped rings", async () => {
  const page = await load({ head: { items: 3 } });
  try {
    const expected = ["?view=1", "?view=2", "?view=3", "Tags: Customer", "Status", "?view=1", "Search", "?new=task"];
    for (const name of expected) {
      await page.keyboard.press("Tab");
      const focus = await page.evaluate(() => {
        const element = document.activeElement as HTMLElement;
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        const inset = parseFloat(style.outlineOffset) + parseFloat(style.outlineWidth);
        const clips: string[] = [];
        for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
          const clip = getComputedStyle(ancestor);
          const bounds = ancestor.getBoundingClientRect();
          if (clip.overflowX !== "visible" && (box.left - inset < bounds.left - 0.5 || box.right + inset > bounds.right + 0.5))
            clips.push(`${ancestor.className}:x`);
          if (clip.overflowY !== "visible" && (box.top - inset < bounds.top - 0.5 || box.bottom + inset > bounds.bottom + 0.5))
            clips.push(`${ancestor.className}:y`);
        }
        return {
          name: element.getAttribute("href") ?? element.getAttribute("aria-label") ?? element.textContent?.trim(),
          clips,
          outline: style.outlineStyle,
        };
      });
      expect(focus.name).toBe(name);
      expect(focus.outline).not.toBe("none");
      expect(focus.clips).toEqual([]);
    }
  } finally {
    await page.close();
  }
});

for (const width of [1440, 1194, 834, 390])
  test(`server, first mounted frame, and settled head agree at ${width}px`, async () => {
    const page = await load({ head: { items: 8, current: "7" } }, width);
    try {
      const before = await page.evaluate(headGeometry);
      await page.evaluate(() => window.mountHead());
      const mounted = await page.evaluate(() => window.headMountedFrame);
      await workspaceFrames(page);
      const after = await page.evaluate(headGeometry);
      expect(before.length).toBeGreaterThan(10);
      for (const frame of [mounted, after]) {
        expect(frame.length).toBe(before.length);
        for (const [index, box] of frame.entries())
          for (const key of ["x", "y", "width", "height"] as const)
            expect(Math.abs(box[key] - before[index]![key]), `${index}.${key}`).toBeLessThanOrEqual(0.5);
      }
    } finally {
      await page.close();
    }
  });

for (const theme of ["light", "dark"])
  test(`${theme}: tabs, chips, and segments keep the soft style contract`, async () => {
    const page = await load({}, 1440);
    try {
      await page.locator("html").evaluate((element, theme) => {
        element.classList.toggle("k2b-dark", theme === "dark");
        element.dataset.theme = theme;
      }, theme);
      const options = [
        { value: "a", label: "List" },
        { value: "b", label: "Calendar" },
      ];
      await page.locator("#controls").evaluate(
        (element, markup) => {
          element.innerHTML = markup;
        },
        renderToString(() => [
          createComponent(Tabs, { value: "a", onValueChange: () => {}, ariaLabel: "Panels", options }),
          createComponent(SegmentedControl, { value: "a", onValueChange: () => {}, ariaLabel: "Mode", options }),
        ]),
      );
      const styles = await page.evaluate(() => {
        const read = (selector: string, pseudo?: string) =>
          [...document.querySelectorAll(selector)].map((element) => {
            const css = getComputedStyle(element, pseudo);
            return {
              background: css.backgroundColor,
              shadow: css.boxShadow,
              borders: [css.borderTopWidth, css.borderRightWidth, css.borderBottomWidth, css.borderLeftWidth],
              weight: css.fontWeight,
              content: css.content,
              display: css.display,
            };
          });
        return {
          lists: read(".k2b-tabs__list,.k2b-view-tabs__list"),
          tabs: read('[role="tab"],.k2b-view-tabs__item > a'),
          chips: read(".k2b-filter-chip"),
          segments: read(".k2b-segmented-control"),
          selectedSegment: read('[role="radio"][aria-checked="true"]'),
          separators: read(".k2b-segmented-control__option", "::after"),
        };
      });
      for (const list of styles.lists) {
        expect(list.background).toBe("rgba(0, 0, 0, 0)");
        expect(list.shadow).toBe("none");
        expect(list.borders).toEqual(["0px", "0px", "0px", "0px"]);
      }
      for (const tab of styles.tabs) {
        expect(tab.shadow).toBe("none");
        expect(tab.borders[2]).toBe("0px");
      }
      expect(new Set(styles.tabs.map((tab) => tab.weight)).size).toBe(1);
      for (const chip of styles.chips) expect(chip.borders).toEqual(["0px", "0px", "0px", "0px"]);
      for (const segment of styles.segments) expect(segment.background).toBe("rgba(0, 0, 0, 0)");
      for (const segment of styles.selectedSegment) expect(segment.shadow).toBe("none");
      for (const separator of styles.separators)
        expect(separator.content === "none" || separator.content === "normal" || separator.display === "none").toBe(true);
    } finally {
      await page.close();
    }
  });

test("marked desktop objects suppress only the visible title, retaining the head and accessible heading", async () => {
  for (const scenario of [
    { host: 1440, collapsed: false, mainHeading: false, title: false },
    { host: 1440, collapsed: false, mainHeading: true, title: false },
    { host: 1440, collapsed: true, mainHeading: false, title: true },
    { host: 900, collapsed: false, mainHeading: false, title: true },
  ]) {
    const page = await load(
      { head: { mainHeading: scenario.mainHeading }, layoutState: { version: 2, sidebarCollapsed: scenario.collapsed } },
      1440,
      scenario.host,
    );
    try {
      expect(await page.locator('.k2b-app-workspace__sidebar [aria-current="page"]').count()).toBe(1);
      expect(await page.locator(".k2b-view-tabs").isVisible()).toBe(true);
      expect(await page.locator(".k2b-page-title").isVisible()).toBe(scenario.title);
      const headings = page.locator(".k2b-app-workspace__head-heading");
      // CSS excludes the fallback heading from rendering and the accessibility tree when Main owns h1.
      const heading = await headings.evaluate((element) => ({
        display: getComputedStyle(element).display,
        width: element.getBoundingClientRect().width,
        height: element.getBoundingClientRect().height,
      }));
      if (scenario.mainHeading) expect(heading.display).toBe("none");
      else {
        expect(heading.display).not.toBe("none");
        expect(heading.width).toBeLessThanOrEqual(1);
        expect(heading.height).toBeLessThanOrEqual(1);
      }
      if (scenario.host === 900) expect(await page.locator(".k2b-app-workspace__head-toggle").isVisible()).toBe(true);
    } finally {
      await page.close();
    }
  }
});
