import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../test/browser";
import { clientFixture, type FixtureOptions, workspaceCss, workspaceFrames, workspaceGeometry } from "../../test/workspace-host-fixture";

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
const load = async (host: number | null = 860, options: FixtureOptions = {}, viewport = 1440, gutter = 64) => {
  const page = await browser.newPage({ viewport: { width: viewport, height: 900 }, reducedMotion: "reduce" });
  await page.setContent(`<!doctype html><html><head><style>${css}</style></head>
    <body class="k2b-ui" style="margin:0;display:flex">
    <div id="host" style="flex:none;${host === null ? "width:100%" : `container:k2b-app-area / inline-size;width:${host}px`}">
      <div id="app" style="height:900px;margin-inline:${gutter}px"></div></div><div style="flex:1">Host panel</div></body></html>`);
  await page.evaluate((options) => {
    document.body.dataset.options = JSON.stringify(options);
  }, options);
  await page.addScriptTag({ content: script });
  await workspaceFrames(page);
  return page;
};
const toggle = (page: Page) => page.locator("[data-app-workspace-detail-toggle]");
const aside = (page: Page) => page.locator(".k2b-app-workspace__detail");
const root = (page: Page) => page.locator(".k2b-app-workspace");
const main = (page: Page) => page.locator(".k2b-app-workspace__main");
const resizeHost = async (page: Page, width: number) => {
  await page.locator("#host").evaluate((host, width) => {
    host.style.width = width + "px";
  }, width);
  await workspaceFrames(page);
};

test("1024px hosts reproduce default 1024px tracks and two visible levels", async () => {
  for (const scenario of ["open", "levels"]) {
    const page = await load(1024, { scenario });
    const reference = await load(null, { scenario }, 1024);
    try {
      const shape = await page.evaluate(workspaceGeometry);
      expect(shape).toEqual(await reference.evaluate(workspaceGeometry));
      expect(
        await root(page).evaluate((element) => getComputedStyle(element).getPropertyValue("--k2b-workspace-sidebar-form").trim()),
      ).toBe("column");
      if (scenario === "levels") expect(await page.locator("[data-workspace-level]:visible").count()).toBe(2);
    } finally {
      await page.close();
      await reference.close();
    }
  }
});

test("compact host navigation opens the overlay in a desktop viewport", async () => {
  const page = await load();
  try {
    await page.locator("[data-app-workspace-sidebar-toggle]").click();
    expect(await root(page).getAttribute("data-sidebar-overlay")).toBe("open");
    await resizeHost(page, 1440);
    expect(await root(page).getAttribute("data-sidebar-overlay")).toBeNull();
  } finally {
    await page.close();
  }
});

test("waiting detail is named, focusable and keeps Main wide", async () => {
  const page = await load();
  try {
    expect(await aside(page).isVisible()).toBe(false);
    expect(await toggle(page).isVisible()).toBe(true);
    expect(await toggle(page).getAttribute("aria-controls")).toBe(await aside(page).getAttribute("id"));
    expect(await toggle(page).getAttribute("aria-expanded")).toBe("false");
    expect(await toggle(page).innerText()).toBe("Details");
    await toggle(page).focus();
    expect(await toggle(page).evaluate((button) => document.activeElement === button)).toBe(true);
    const workspace = (await root(page).boundingBox())!;
    const content = (await main(page).boundingBox())!;
    expect(content.width).toBeGreaterThanOrEqual(320);
    expect(content.x + content.width).toBeCloseTo(workspace.x + workspace.width - 1, 1);
    await main(page).getByRole("button", { name: "Selected message" }).focus();
    await page.keyboard.press("F6");
    expect(
      await aside(page)
        .locator("h2")
        .evaluate((title) => document.activeElement === title),
    ).toBe(false);
    await page.keyboard.press("Escape");
    expect(await page.locator("body").getAttribute("data-closed")).toBeNull();
  } finally {
    await page.close();
  }
});

for (const activation of ["keyboard", "pointer"]) {
  test(`${activation} opens an edge drawer; Escape and toggle park without closing the app detail`, async () => {
    const page = await load();
    try {
      const before = await main(page).boundingBox();
      if (activation === "keyboard") {
        await toggle(page).focus();
        await page.keyboard.press("Enter");
      } else await toggle(page).click();
      expect(await aside(page).isVisible()).toBe(true);
      expect(await toggle(page).getAttribute("aria-expanded")).toBe("true");
      const panel = (await aside(page).boundingBox())!;
      const workspace = (await root(page).boundingBox())!;
      const head = (await page.locator(".k2b-app-workspace__head").boundingBox())!;
      expect(panel.x + panel.width).toBeCloseTo(workspace.x + workspace.width - 1, 1);
      expect(panel.y + panel.height).toBeCloseTo(workspace.y + workspace.height - 1, 1);
      expect(panel.y).toBeCloseTo(head.y + head.height, 1);
      expect(await main(page).boundingBox()).toEqual(before);
      const focus = activation === "keyboard" ? aside(page).locator("h2") : toggle(page);
      expect(await focus.evaluate((element) => document.activeElement === element)).toBe(true);
      await page.keyboard.press("Escape");
      expect(await aside(page).isVisible()).toBe(false);
      expect(await toggle(page).getAttribute("aria-expanded")).toBe("false");
      expect(await toggle(page).evaluate((button) => document.activeElement === button)).toBe(true);
      expect(await page.locator("body").getAttribute("data-closed")).toBeNull();
      await toggle(page).click();
      await toggle(page).click();
      expect(await aside(page).isVisible()).toBe(false);
    } finally {
      await page.close();
    }
  });
}

test("widening restores the column and a second narrowing waits again", async () => {
  const page = await load();
  try {
    await toggle(page).click();
    await resizeHost(page, 1440);
    expect(await aside(page).isVisible()).toBe(true);
    expect(await aside(page).getAttribute("data-workspace-detail-drawer")).toBeNull();
    expect(await toggle(page).isVisible()).toBe(false);
    await resizeHost(page, 860);
    expect(await aside(page).isVisible()).toBe(false);
    expect(await toggle(page).getAttribute("aria-expanded")).toBe("false");
  } finally {
    await page.close();
  }
});

test("the host can park a drawer through the public helper", async () => {
  const page = await load();
  try {
    await toggle(page).click();
    await aside(page).locator("button:visible").focus();
    await page.evaluate(() => {
      const api = window as Window & { parkDetails?: () => void };
      api.parkDetails!();
    });
    expect(await aside(page).isVisible()).toBe(false);
    expect(await toggle(page).getAttribute("aria-expanded")).toBe("false");
    expect(await toggle(page).evaluate((button) => document.activeElement === button)).toBe(true);
  } finally {
    await page.close();
  }
});

test("the sm token at 860px and the default desktop host retain columns", async () => {
  for (const [host, detailWidth] of [
    [860, "sm"],
    [null, "md"],
  ] as const) {
    const page = await load(host, { detailWidth });
    try {
      expect(await aside(page).isVisible()).toBe(true);
      expect(await toggle(page).isVisible()).toBe(false);
      if (host === 860) expect(await page.locator("[data-app-workspace-sidebar-toggle]").isVisible()).toBe(true);
      expect((await main(page).boundingBox())!.width).toBeLessThan((await root(page).boundingBox())!.width - 320);
    } finally {
      await page.close();
    }
  }
});

test("a full-width workspace switches its track exactly at each token's content-width threshold", async () => {
  for (const [detailWidth, threshold] of [
    ["sm", 648],
    ["md", 744],
    ["lg", 808],
    ["xl", 872],
  ] as const) {
    // The workspace has a 1px border on each side; queries measure the content box.
    const page = await load(threshold + 2, { detailWidth }, 1440, 0);
    try {
      expect(await aside(page).isVisible()).toBe(true);
      expect(await toggle(page).isVisible()).toBe(false);
      const columnMain = (await main(page).boundingBox())!.width;
      await resizeHost(page, threshold + 2 - 1 / 64);
      expect(await aside(page).isVisible()).toBe(false);
      expect(await toggle(page).isVisible()).toBe(true);
      expect((await main(page).boundingBox())!.width).toBeGreaterThan(columnMain);
      await toggle(page).click();
      const drawerWidth = (await aside(page).boundingBox())!.width;
      expect(
        await page
          .locator(".k2b-app-workspace__content")
          .evaluate((element) => Number.parseFloat(getComputedStyle(element).getPropertyValue("--k2b-detail-space"))),
      ).toBeCloseTo(drawerWidth, 1);
      await page.keyboard.press("Escape");
      expect(
        await page
          .locator(".k2b-app-workspace__content")
          .evaluate((element) => Number.parseFloat(getComputedStyle(element).getPropertyValue("--k2b-detail-space"))),
      ).toBe(0);
    } finally {
      await page.close();
    }
  }
});

test("a host change closes the overlay even when the workspace keeps its width", async () => {
  const page = await load(860, { scenario: "closed" });
  try {
    await page.locator("#app").evaluate((app) => {
      app.style.width = "640px";
      app.style.flex = "none";
    });
    await workspaceFrames(page);
    await page.locator("[data-app-workspace-sidebar-toggle]").click();
    expect(await root(page).getAttribute("data-sidebar-overlay")).toBe("open");
    const before = (await root(page).boundingBox())!.width;
    await resizeHost(page, 1100);
    expect((await root(page).boundingBox())!.width).toBe(before);
    expect(await root(page).getAttribute("data-sidebar-overlay")).toBeNull();
    expect(await page.locator(".k2b-app-workspace__content").getAttribute("inert")).toBeNull();
  } finally {
    await page.close();
  }
});

test("focus in a column that starts waiting moves to its Details button", async () => {
  const page = await load(1440);
  try {
    await aside(page).getByRole("button", { name: "Contact action" }).focus();
    await resizeHost(page, 860);
    expect(await aside(page).isVisible()).toBe(false);
    expect(await toggle(page).evaluate((button) => document.activeElement === button)).toBe(true);
  } finally {
    await page.close();
  }
});

test("a width token that fits again clears the drawer without any resize", async () => {
  const page = await load();
  try {
    await toggle(page).click();
    expect(await aside(page).getAttribute("data-workspace-detail-drawer")).toBe("open");
    await aside(page).evaluate((element) => element.setAttribute("data-width", "sm"));
    await workspaceFrames(page);
    expect(await aside(page).getAttribute("data-workspace-detail-drawer")).toBeNull();
    expect(await toggle(page).getAttribute("aria-expanded")).toBe("false");
    await aside(page).evaluate((element) => element.setAttribute("data-width", "md"));
    await workspaceFrames(page);
    expect(await aside(page).isVisible()).toBe(false);
  } finally {
    await page.close();
  }
});

test("a drawer removed with its panel leaves no space in Content", async () => {
  const page = await load();
  try {
    await toggle(page).click();
    const space = () =>
      page.locator(".k2b-app-workspace__content").evaluate((element) => element.style.getPropertyValue("--k2b-detail-space"));
    expect(await space()).not.toBe("");
    await aside(page).evaluate((element) => element.remove());
    await workspaceFrames(page);
    expect(await space()).toBe("");
  } finally {
    await page.close();
  }
});
