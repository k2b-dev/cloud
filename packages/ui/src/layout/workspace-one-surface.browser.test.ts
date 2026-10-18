import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { Browser, Page } from "playwright";
import { createComponent, createSignal } from "solid-js";
import { Dynamic, renderToString } from "solid-js/web";
import { launchBrowser } from "../../test/browser";
import { clientFixture, type FixtureOptions, workspaceCss, workspaceFrames, workspaceTree } from "../../test/workspace-host-fixture";

const directory = mkdtempSync(resolve(tmpdir(), "k2b-workspace-one-surface-"));
const { plugin } = createConfig({ dev: true, rootDir: directory });
Bun.plugin(plugin());
process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
const { default: AppWorkspace } = await import("./AppWorkspace");
const script = await clientFixture();
const css = workspaceCss();
let browser: Browser;
setDefaultTimeout(30_000);
beforeAll(async () => {
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
});
const load = async (width: number, options: FixtureOptions = {}, hasTouch = false, dark = false) => {
  const page = await browser.newPage({ viewport: { width, height: width === 834 ? 1000 : 900 }, hasTouch, reducedMotion: "reduce" });
  try {
    // No extra named host: html supplies the viewport's app area.
    await page.setContent(`<!doctype html><html><head><style>${css}</style></head>
      <body class="k2b-ui" ${dark ? 'data-theme="dark"' : ""} style="margin:0">
        <script type="application/json" data-k2b-page-trail>{"title":"Messages","ancestors":[]}</script>
        <div id="app" style="height:100vh;margin-inline:64px"></div>
      </body></html>`);
    await page.evaluate((options) => {
      document.body.dataset.options = JSON.stringify(options);
    }, options);
    await page.addScriptTag({ content: script });
    await workspaceFrames(page);
    return page;
  } catch (error) {
    await page.close();
    throw error;
  }
};
const root = (page: Page) => page.locator(".k2b-app-workspace");
const main = (page: Page) => page.locator(".k2b-app-workspace__main");
const detail = (page: Page) => page.locator(".k2b-app-workspace__detail");
const toggle = (page: Page) => page.locator("[data-app-workspace-detail-toggle]");
const waiting = async (page: Page) => {
  expect(await detail(page).evaluate((element) => getComputedStyle(element).display)).toBe("none");
  expect(
    await detail(page).evaluate((element) => getComputedStyle(element).getPropertyValue("--k2b-workspace-detail-waiting").trim()),
  ).toBe("1");
  expect(await toggle(page).isVisible()).toBe(true);
  expect(await toggle(page).getAttribute("aria-controls")).toBe(await detail(page).getAttribute("id"));
  expect(await toggle(page).getAttribute("aria-expanded")).toBe("false");
};

for (const dark of [false, true]) {
  test(`1440: sidebar and Main share the workspace surface; Detail is an unraised column (${dark ? "dark" : "light"})`, async () => {
    const page = await load(1440, {}, false, dark);
    try {
      const colors = await root(page).evaluate((element) => {
        const sidebar = element.querySelector(".k2b-app-workspace__sidebar")!;
        const main = element.querySelector(".k2b-app-workspace__main")!;
        const background = (element: Element): string => {
          const own = getComputedStyle(element).backgroundColor;
          return own === "rgba(0, 0, 0, 0)" && element.parentElement ? background(element.parentElement) : own;
        };
        const probe = document.createElement("span");
        probe.style.background = "var(--k2b-surface-muted)";
        element.append(probe);
        const muted = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return {
          root: getComputedStyle(element).backgroundColor,
          sidebar: getComputedStyle(sidebar).backgroundColor,
          main: background(main),
          muted,
        };
      });
      expect(colors.sidebar).toBe(colors.root);
      expect(colors.main).toBe(colors.root);
      expect(colors.sidebar).not.toBe(colors.muted);
      expect(await detail(page).isVisible()).toBe(true);
      expect(
        await detail(page).evaluate((element) => ({
          shadow: getComputedStyle(element).boxShadow,
          fill: getComputedStyle(element).backgroundColor,
        })),
      ).toEqual({ shadow: "none", fill: "rgba(0, 0, 0, 0)" });
    } finally {
      await page.close();
    }
  });
}

test("1440: panes have 12px of space and sidebar/pane handles show only a grip on hover or keyboard focus", async () => {
  const page = await load(1440);
  try {
    const gap = await page.locator('.k2b-app-workspace__main-pane[data-surface="navigation"]').evaluate((pane) => {
      const style = getComputedStyle(pane);
      const primary = pane.parentElement!.querySelector(".k2b-app-workspace__main-primary")!;
      return {
        width: Number.parseFloat(style.borderRightWidth),
        color: style.borderRightColor,
        space:
          primary.getBoundingClientRect().left -
          (pane.getBoundingClientRect().right - Number.parseFloat(style.borderRightWidth) - Number.parseFloat(style.paddingRight)),
      };
    });
    expect(gap.width === 0 || /(?:rgba\([^)]*, 0\)|\/ 0\))$/.test(gap.color)).toBe(true);
    expect(gap.space).toBeGreaterThanOrEqual(12);
    for (const kind of ["pane", "sidebar"]) {
      const handle = page.locator(`[data-app-workspace-resize="${kind}"]`).first();
      const grip = handle.locator(":scope > span");
      await page.mouse.move(0, 0);
      expect(await grip.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
      expect(await handle.evaluate((element) => getComputedStyle(element, "::before").display)).toBe("none");
      await handle.hover();
      await page.waitForFunction(
        (kind) => getComputedStyle(document.querySelector(`[data-app-workspace-resize="${kind}"] > span`)!).opacity === "1",
        kind,
      );
      await page.mouse.move(0, 0);
      await page.keyboard.press("Tab");
      await handle.focus();
      expect(await handle.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
      await page.waitForFunction(
        (kind) => getComputedStyle(document.querySelector(`[data-app-workspace-resize="${kind}"] > span`)!).opacity === "1",
        kind,
      );
      await handle.evaluate((element) => (element as HTMLElement).blur());
    }
  } finally {
    await page.close();
  }
});

test("1194: Main's 760px minimum parks lg Detail; Details opens at the card edges, Escape parks, 1440 restores the column", async () => {
  const page = await load(1194, { mainMin: 760, detailWidth: "lg", sidebar: false });
  try {
    await waiting(page);
    expect((await main(page).boundingBox())!.width).toBeGreaterThanOrEqual(760);
    await toggle(page).click();
    expect(await toggle(page).getAttribute("aria-expanded")).toBe("true");
    expect(await detail(page).getAttribute("data-workspace-detail-drawer")).toBe("open");
    const edges = await root(page).evaluate((element) => {
      const box = element.getBoundingClientRect();
      const drawer = element.querySelector(".k2b-app-workspace__detail")!.getBoundingClientRect();
      const head = element.querySelector(".k2b-app-workspace__head")!.getBoundingClientRect();
      return {
        right: drawer.right - (box.right - Number.parseFloat(getComputedStyle(element).borderRightWidth)),
        top: drawer.top - head.bottom,
      };
    });
    expect(Math.abs(edges.right)).toBeLessThanOrEqual(1);
    expect(Math.abs(edges.top)).toBeLessThanOrEqual(1);
    await page.keyboard.press("Escape");
    await waiting(page);
    expect(await toggle(page).evaluate((element) => document.activeElement === element)).toBe(true);
    expect(await detail(page).getAttribute("hidden")).toBeNull();
    expect(await page.locator("body").getAttribute("data-closed")).toBeNull();
    await page.setViewportSize({ width: 1440, height: 900 });
    await workspaceFrames(page);
    expect(await detail(page).evaluate((element) => getComputedStyle(element).display)).toBe("flex");
    expect((await detail(page).boundingBox())!.x).toBeGreaterThanOrEqual(
      (await main(page).boundingBox())!.x + (await main(page).boundingBox())!.width,
    );
    expect(await toggle(page).isVisible()).toBe(false);
  } finally {
    await page.close();
  }
});

test("834 with a mouse: md Detail waits and Details opens a drawer", async () => {
  const page = await load(834);
  try {
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(false);
    await waiting(page);
    await toggle(page).click();
    expect(await detail(page).getAttribute("data-workspace-detail-drawer")).toBe("open");
    expect(await detail(page).isVisible()).toBe(true);
  } finally {
    await page.close();
  }
});

test("1194: selecting another item reopens a parked open Detail; live content alone leaves it parked", async () => {
  const page = await load(1194, { mainMin: 760, detailWidth: "lg", scenario: "selection" });
  try {
    await waiting(page);
    await toggle(page).click();
    await page.keyboard.press("Escape");
    await waiting(page);
    await page.evaluate(() => {
      const updateContact = (window as Window & { updateWorkspaceContact?: (title: string) => void }).updateWorkspaceContact;
      if (!updateContact) throw new Error("Selection fixture did not expose its contact update hook");
      updateContact("Live contact update");
    });
    await workspaceFrames(page);
    await waiting(page);
    const item = main(page).getByRole("button", { name: "Another message" });
    await item.click();
    await page.waitForFunction(() => document.querySelector('[data-workspace-detail-drawer="open"]'));
    expect(await detail(page).locator("h2").innerText()).toBe("Another contact");
    expect(await toggle(page).getAttribute("aria-expanded")).toBe("true");
    expect(await item.evaluate((element) => document.activeElement === element)).toBe(true);
  } finally {
    await page.close();
  }
});

test("1194: a saved 360px sidebar stays an overlay from the server frame through hydration", async () => {
  const options: FixtureOptions = { mainMin: 760, layoutState: { version: 2, sidebarWidth: 360 } };
  const html = renderToString(() => workspaceTree({ AppWorkspace, createComponent, createSignal, Dynamic }, options));
  const page = await browser.newPage({ viewport: { width: 1194, height: 900 }, reducedMotion: "reduce" });
  try {
    await page.setContent(`<!doctype html><html><head><style>${css}</style></head>
      <body class="k2b-ui" style="margin:0"><div id="app" style="height:100vh;margin-inline:64px">${html}</div></body></html>`);
    const sidebarFrame = () => {
      const root = document.querySelector<HTMLElement>(".k2b-app-workspace")!;
      const sidebar = root.querySelector(".k2b-app-workspace__sidebar")!;
      const toggle = root.querySelector<HTMLElement>(".k2b-app-workspace__head [data-app-workspace-sidebar-toggle]")!;
      return {
        form: getComputedStyle(sidebar).getPropertyValue("--k2b-workspace-sidebar-form").trim(),
        width: getComputedStyle(root).getPropertyValue("--k2b-workspace-sidebar-width").trim(),
        toggleVisible: toggle.getClientRects().length > 0 && getComputedStyle(toggle).visibility === "visible",
      };
    };
    const expected = { form: "overlay", width: "360px", toggleVisible: true };
    expect(await page.evaluate(sidebarFrame)).toEqual(expected);
    await page.evaluate((options) => {
      document.body.dataset.options = JSON.stringify(options);
    }, options);
    // Match the island mount: replace SSR markup, then capture the first client frame synchronously.
    await page.addScriptTag({
      content: `document.getElementById("app").innerHTML = "";\n${script}\nwindow.workspaceFirstSidebarFrame = (${sidebarFrame.toString()})();`,
    });
    expect(await page.evaluate(() => (window as Window & { workspaceFirstSidebarFrame?: unknown }).workspaceFirstSidebarFrame)).toEqual(
      expected,
    );
    await workspaceFrames(page);
    expect(await page.evaluate(sidebarFrame)).toEqual(expected);
  } finally {
    await page.close();
  }
});

test("1194: sidebar plus 900px Main minimum uses an overlay and a visible page title in the head", async () => {
  const page = await load(1194, { mainMin: 900 });
  try {
    const sidebar = page.locator(".k2b-app-workspace__sidebar");
    expect(await sidebar.evaluate((element) => getComputedStyle(element).getPropertyValue("--k2b-workspace-sidebar-form").trim())).toBe(
      "overlay",
    );
    expect(await sidebar.isVisible()).toBe(false);
    const head = page.locator(".k2b-app-workspace__head");
    expect(await head.isVisible()).toBe(true);
    expect(await head.locator(".k2b-page-title").isVisible()).toBe(true);
    expect(await head.locator(".k2b-page-title__text").innerText()).toBe("Messages");
    expect((await head.locator(".k2b-page-title").boundingBox())!.width).toBeGreaterThan(1);
    await head.locator("[data-app-workspace-sidebar-toggle]").click();
    expect(await root(page).getAttribute("data-sidebar-overlay")).toBe("open");
    expect(await sidebar.isVisible()).toBe(true);
    await page.keyboard.press("Escape");
    expect(await sidebar.isVisible()).toBe(false);
  } finally {
    await page.close();
  }
});

for (const interaction of ["pointer", "keyboard", "load"]) {
  test(`1194: waiting Detail opens directly only after a fresh ${interaction} selection`, async () => {
    const page = await load(1194, { mainMin: 760, detailWidth: "lg", scenario: interaction === "load" ? "open" : "closed" });
    try {
      if (interaction === "load") {
        await waiting(page);
        return;
      }
      const item = main(page).getByRole("button", { name: "Selected message" });
      const before = await main(page).boundingBox();
      if (interaction === "keyboard") {
        await item.focus();
        await page.keyboard.press("Enter");
      } else await item.click();
      await page.waitForFunction(() => document.querySelector('[data-workspace-detail-drawer="open"]'));
      expect(await toggle(page).getAttribute("aria-expanded")).toBe("true");
      expect(await main(page).boundingBox()).toEqual(before);
      if (interaction === "keyboard")
        await page.waitForFunction(() => document.activeElement === document.querySelector(".k2b-app-workspace__detail h2"));
      else expect(await item.evaluate((element) => document.activeElement === element)).toBe(true);
    } finally {
      await page.close();
    }
  });
}

test("834 with touch: swiping an open waiting drawer parks it without closing the app detail", async () => {
  const page = await load(834, {}, true);
  try {
    await waiting(page);
    await toggle(page).click();
    await detail(page).getByRole("button", { name: "Contact action" }).focus();
    // Synthetic TouchEvents exercise the controller on Chromium and WebKit alike.
    await detail(page).evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const sample = (x: number) => ({ identifier: 7, target: element, clientX: x, clientY: rect.top + 80 });
      for (const [type, x] of [
        ["touchstart", rect.left + 30],
        ["touchmove", rect.left + 160],
        ["touchend", rect.left + 160],
      ] as const) {
        const event = new TouchEvent(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : [sample(x)] });
        element.dispatchEvent(event);
      }
    });
    await waiting(page);
    expect(await detail(page).getAttribute("hidden")).toBeNull();
    expect(await page.locator("body").getAttribute("data-closed")).toBeNull();
    expect(await toggle(page).evaluate((element) => document.activeElement === element)).toBe(true);
  } finally {
    await page.close();
  }
});

test("1194: dragging and keyboard resizing reserve 760px for Main and keep the sidebar a column", async () => {
  const page = await load(1194, { mainMin: 760, detailWidth: "lg" });
  try {
    const handle = page.locator('[data-app-workspace-resize="sidebar"]');
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(1190, box.y + box.height / 2, { steps: 12 });
    await workspaceFrames(page);
    const column = async () => {
      expect(
        await page
          .locator(".k2b-app-workspace__sidebar")
          .evaluate((element) => getComputedStyle(element).getPropertyValue("--k2b-workspace-sidebar-form").trim()),
      ).toBe("column");
      const available = await root(page).evaluate(
        (element) =>
          element.getBoundingClientRect().width -
          Number.parseFloat(getComputedStyle(element).borderLeftWidth) -
          Number.parseFloat(getComputedStyle(element).borderRightWidth),
      );
      expect(Number(await handle.getAttribute("aria-valuemax"))).toBeLessThanOrEqual(available - 760);
      expect((await main(page).boundingBox())!.width).toBeGreaterThanOrEqual(760);
    };
    await column();
    await page.mouse.up();
    await handle.focus();
    for (let i = 0; i < 50; i++) await page.keyboard.press("ArrowRight");
    await workspaceFrames(page);
    await column();
  } finally {
    await page.close();
  }
});
