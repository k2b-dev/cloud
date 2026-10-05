import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Browser, chromium, type Page } from "playwright";

// Scrolling, touch-action, the toast rail's place, and the room a persistent toast takes are layout results, which
// happy-dom does not model, so a real engine runs the built package at phone size.
const packageRoot = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(packageRoot, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "mobile-shell.fixture.ts");
const fixture = `
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { Button, dialogCore, IconButton, MobileShell, PanelDialog, SegmentedControl, TabBar, TextInput, toast } from ${JSON.stringify(resolve(packageRoot, "dist/browser/index.js"))};

const rows = () => Array.from({ length: 40 }, (_, index) => {
  const row = document.createElement("p");
  row.className = "row";
  row.style.cssText = "margin:0;height:48px";
  row.textContent = "Task " + (index + 1);
  return row;
});
render(
  () =>
    createComponent(MobileShell, {
      get header() {
        return createComponent(MobileShell.Header, {
          title: "Tasks",
          back: window.fixtureHeader === "back" ? { href: "#start", label: "Start" } : undefined,
          get actions() {
            if (window.fixtureHeader !== "actions") return undefined;
            const glyph = document.createElement("i");
            glyph.className = "ti ti-settings";
            return createComponent(IconButton, { label: "Settings", tooltip: false, children: glyph });
          },
        });
      },
      get footer() {
        return createComponent(TabBar, {
          label: "App",
          items: [
            { id: "start", label: "Start", icon: "ti ti-home", href: window.fixtureTabs?.start ?? "#start", current: true },
            { id: "tasks", label: "Tasks", title: "My tasks", icon: "ti ti-checkbox", href: window.fixtureTabs?.tasks ?? "#tasks" },
          ],
        });
      },
      get children() {
        return [createComponent(TextInput, { label: "Search", value: () => "", onValueChange: () => {} }), ...rows()];
      },
    }),
  document.getElementById("root"),
);
/** Shared controls at the end of the content and in a dialog, to read the phone's type scale from. */
const typeSamples = () => {
  const host = document.createElement("div");
  host.className = "samples";
  document.querySelector(".k2b-mobile-shell__body").append(host);
  render(
    () => [
      createComponent(Button, { children: "Save" }),
      createComponent(SegmentedControl, {
        ariaLabel: "Language",
        options: [{ value: "en", label: "English" }, { value: "de", label: "Deutsch" }],
        value: () => "en",
        onValueChange: () => {},
      }),
      createComponent(TextInput, { label: "Name", value: () => "", onValueChange: () => {}, error: "Too long" }),
    ],
    host,
  );
  void dialogCore.open(() => createComponent(PanelDialog, { get children() { return createComponent(PanelDialog.Header, { title: "Scan code" }); } }));
};
window.ui = { toast, dialogCore, typeSamples };
`;
const build = await Bun.build({
  entrypoints: [entry],
  files: { [entry]: fixture },
  target: "browser",
  conditions: ["browser"],
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the MobileShell fixture for the browser.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

type ToastHandle = {
  dismiss: () => void;
  update: (text: string, options?: { progress?: number | null; duration?: number }) => void;
};
type Ui = {
  toast: ((text: string, options?: { duration?: number; progress?: number | "indeterminate" | null }) => ToastHandle) & {
    dismissAll: () => void;
    custom: (content: HTMLElement) => { dismiss: () => void };
  };
  /** A toast a test keeps between two `page.evaluate` calls. */
  kept?: ToastHandle;
  dialogCore: { open: (view: () => Node) => Promise<unknown>; close: () => void };
  typeSamples: () => void;
};
declare const ui: Ui;

/** Opens the fixture; `header` adds Back or one action to the header. */
const open = async (header?: "back" | "actions"): Promise<Page> => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.setContent(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>${css}</style></head><body class="k2b-ui"><div id="root"></div></body></html>`,
  );
  if (header) await page.addScriptTag({ content: `window.fixtureHeader = ${JSON.stringify(header)};` });
  await page.addScriptTag({ content: script });
  await page.locator(".k2b-tab-bar").waitFor();
  return page;
};

const geometry = (page: Page) =>
  page.evaluate(() => {
    const rect = (selector: string) => document.querySelector(selector)?.getBoundingClientRect();
    const body = document.querySelector<HTMLElement>(".k2b-mobile-shell__body")!;
    return {
      footerTop: rect(".k2b-tab-bar")!.top,
      footerHeight: getComputedStyle(document.body).getPropertyValue("--k2b-mobile-shell-footer-height"),
      inset: getComputedStyle(document.querySelector(".k2b-mobile-shell")!).getPropertyValue("--k2b-mobile-shell-toast-inset"),
      bodyBottom: body.getBoundingClientRect().bottom,
      cards: [...document.querySelectorAll("[data-k2b-toast-container] [data-k2b-toast]:not([data-closing])")].map((card) => {
        const box = card.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom };
      }),
    };
  });

/** Scrolls the content to its end and reports where the last row ends. */
const lastRowBottom = (page: Page) =>
  page.evaluate(() => {
    const body = document.querySelector<HTMLElement>(".k2b-mobile-shell__body")!;
    body.scrollTop = body.scrollHeight;
    return [...document.querySelectorAll(".row")].at(-1)!.getBoundingClientRect().bottom;
  });

describe("MobileShell in a phone browser", () => {
  test("only the content scrolls; the page, the header, and the tab bar stay put", async () => {
    const page = await open();
    try {
      const layout = await page.evaluate(() => {
        let topEdge: string | null = null;
        for (let element = document.elementFromPoint(innerWidth / 2, 4); element && !topEdge; element = element.parentElement) {
          const { position } = getComputedStyle(element);
          if (position === "fixed" || position === "sticky") topEdge = element.className;
        }
        const body = document.querySelector<HTMLElement>(".k2b-mobile-shell__body")!;
        return {
          html: [getComputedStyle(document.documentElement).overflow, getComputedStyle(document.documentElement).overscrollBehavior],
          page: [getComputedStyle(document.body).overflow, getComputedStyle(document.body).overscrollBehavior],
          documentScrolls: document.scrollingElement!.scrollHeight > innerHeight,
          contentScrolls: body.scrollHeight > body.clientHeight,
          root: getComputedStyle(document.querySelector(".k2b-mobile-shell")!).position,
          tabBar: getComputedStyle(document.querySelector(".k2b-tab-bar")!).position,
          tabBarBottom: document.querySelector(".k2b-tab-bar")!.getBoundingClientRect().bottom,
          topEdge,
        };
      });
      expect(layout).toEqual({
        html: ["hidden", "none"],
        page: ["hidden", "none"],
        documentScrolls: false,
        contentScrolls: true,
        root: "absolute",
        tabBar: "static",
        tabBarBottom: 844,
        topEdge: null,
      });
    } finally {
      await page.context().close();
    }
  });

  test("the header keeps one height with a title alone, with Back, and with an action", async () => {
    const layouts: { header: number; title: number; content: number }[] = [];
    for (const header of [undefined, "back", "actions"] as const) {
      const page = await open(header);
      try {
        layouts.push(
          await page.evaluate(() => {
            const top = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
            return {
              header: top(".k2b-mobile-shell__header").height,
              title: top(".k2b-mobile-shell__title").top,
              content: top(".k2b-mobile-shell__body").top,
            };
          }),
        );
      } finally {
        await page.context().close();
      }
    }
    expect(layouts[0]!.header).toBeGreaterThanOrEqual(68);
    expect(layouts[1]).toEqual(layouts[0]!);
    expect(layouts[2]).toEqual(layouts[0]!);
  });

  test("shared text and controls follow the phone's type scale, in the content and in dialogs", async () => {
    const page = await open("actions");
    try {
      await page.evaluate(() => ui.typeSamples());
      await page.locator("dialog h2").waitFor();
      const sizes = await page.evaluate(() => {
        const size = (selector: string) => getComputedStyle(document.querySelector(selector)!).fontSize;
        return {
          title: size(".k2b-mobile-shell__title"),
          text: size(".row"),
          button: size(".samples .k2b-button"),
          segment: size(".samples .k2b-segmented-control__option"),
          label: size(".samples .k2b-field__label"),
          error: size(".samples .k2b-field__error"),
          dialogTitle: size("dialog h2"),
          tab: size(".k2b-tab-bar a"),
          action: size(".k2b-mobile-shell__actions .k2b-icon-button"),
        };
      });
      expect(sizes).toEqual({
        title: "18px",
        text: "16px",
        button: "16px",
        segment: "14px",
        label: "14px",
        error: "14px",
        dialogTitle: "18px",
        tab: "11px",
        action: "22px",
      });
    } finally {
      await page.context().close();
    }
  });

  test("turns off pinch zoom in content and dialogs, and keeps fields at 16 px", async () => {
    const page = await open();
    try {
      await page.evaluate(() => {
        void ui.dialogCore.open(() => {
          const button = document.createElement("button");
          button.textContent = "Inside";
          return button;
        });
      });
      await page.locator("dialog").waitFor();
      const touch = await page.evaluate(() => {
        // An application's own single-class rule claims a gesture, as a drag handle does.
        const style = document.createElement("style");
        style.textContent = ".grip { touch-action: none; }";
        document.head.append(style);
        const grip = document.createElement("span");
        grip.className = "grip";
        document.querySelector(".k2b-mobile-shell__body")!.append(grip);
        return {
          row: getComputedStyle(document.querySelector(".row")!).touchAction,
          dialog: getComputedStyle(document.querySelector("dialog button")!).touchAction,
          grip: getComputedStyle(grip).touchAction,
          input: getComputedStyle(document.querySelector("input")!).fontSize,
        };
      });
      expect(touch).toEqual({ row: "pan-x pan-y", dialog: "pan-x pan-y", grip: "none", input: "16px" });
    } finally {
      await page.context().close();
    }
  });

  test("toasts sit above the tab bar, and a persistent toast keeps the last row reachable", async () => {
    const page = await open();
    try {
      const before = await geometry(page);
      const footer = await page.locator(".k2b-tab-bar").boundingBox();
      expect(before.footerHeight).toBe(`${footer!.height}px`);
      const free = await lastRowBottom(page);
      expect(free).toBeLessThanOrEqual(before.footerTop);

      await page.evaluate(() => void ui.toast("Saved"));
      await page.waitForTimeout(400);
      const timed = await geometry(page);
      expect(timed.cards).toHaveLength(1);
      expect(timed.cards[0]!.bottom).toBeLessThanOrEqual(timed.footerTop);
      expect(timed.cards[0]!.bottom).toBeGreaterThan(timed.footerTop - 48);
      expect(timed.inset).toBe("0px");

      await page.evaluate(() => void ui.toast("You're offline", { duration: 0 }));
      await page.waitForTimeout(400);
      const sticky = await geometry(page);
      const covered = Math.min(...sticky.cards.map((card) => card.top));
      expect(Number.parseFloat(sticky.inset)).toBeCloseTo(sticky.bodyBottom - covered, 0);
      expect(await lastRowBottom(page)).toBeLessThanOrEqual(covered + 1);

      await page.evaluate(() => ui.toast.dismissAll());
      await page.waitForTimeout(400);
      expect((await geometry(page)).inset).toBe("0px");
    } finally {
      await page.context().close();
    }
  });

  test("running progress and a custom slot keep the last row reachable too", async () => {
    const page = await open();
    try {
      await page.evaluate(() => {
        ui.kept = ui.toast("Uploading", { progress: "indeterminate" });
      });
      await page.waitForTimeout(400);
      const running = await geometry(page);
      const covered = Math.min(...running.cards.map((card) => card.top));
      expect(Number.parseFloat(running.inset)).toBeCloseTo(running.bodyBottom - covered, 0);
      expect(await lastRowBottom(page)).toBeLessThanOrEqual(covered + 1);

      // Ending the progress gives the toast its timer back, so it no longer pads the content.
      await page.evaluate(() => ui.kept?.update("Uploaded", { progress: null, duration: 60_000 }));
      await page.waitForTimeout(400);
      expect((await geometry(page)).inset).toBe("0px");
      await page.evaluate(() => ui.toast.dismissAll());
      await page.waitForTimeout(400);

      await page.evaluate(() => {
        const panel = document.createElement("div");
        panel.style.height = "120px";
        panel.textContent = "3 files";
        ui.toast.custom(panel);
      });
      await page.waitForTimeout(400);
      const custom = await geometry(page);
      const panelTop = Math.min(...custom.cards.map((card) => card.top));
      expect(Number.parseFloat(custom.inset)).toBeCloseTo(custom.bodyBottom - panelTop, 0);
      expect(await lastRowBottom(page)).toBeLessThanOrEqual(panelTop + 1);
    } finally {
      await page.context().close();
    }
  });

  test("a modal dialog takes the bottom edge back, so toasts move to the top", async () => {
    const page = await open();
    try {
      await page.evaluate(() => void ui.dialogCore.open(() => document.createTextNode("Dialog")));
      await page.locator("dialog").waitFor();
      await page.evaluate(() => void ui.toast("Link copied", { duration: 0 }));
      await page.waitForTimeout(400);
      const { cards, inset } = await geometry(page);
      expect(cards[0]!.top).toBeLessThan(100);
      expect(inset).toBe("0px");
    } finally {
      await page.context().close();
    }
  });
});

describe("Tab bar taps in a phone browser", () => {
  test("a tap selects the tab while its page loads, and further taps do not start the load over", async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    // While a load is pending, Playwright's evaluations wait for it, so the page reports the tabs after each tap: after
    // the click of a link, and for other content at the end of the tap itself, before any click, because iOS sends
    // none there.
    const report = `const tabs = () => console.log(JSON.stringify(Object.fromEntries(
      [...document.querySelectorAll(".k2b-tab-bar a")].map((link) => [link.dataset.tab, { color: getComputedStyle(link).color, pending: link.hasAttribute("data-k2b-pending") }]),
    )));
    addEventListener("click", (event) => event.target.closest("a") && setTimeout(tabs));
    addEventListener("pointerup", (event) => event.target.closest("a") || tabs());`;
    const start = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>${css}</style></head><body class="k2b-ui"><div id="root"></div><script>window.fixtureTabs = { start: "/start", tasks: "/tasks" };</script><script>${script}</script><script>${report}</script></body></html>`;
    type Tabs = Record<string, { color: string; pending: boolean }>;
    const reports: Tabs[] = [];
    page.on("console", (message) => {
      if (message.text().startsWith("{")) reports.push(JSON.parse(message.text()));
    });
    let release!: () => void;
    const loading = new Promise<void>((resolve) => {
      release = resolve;
    });
    let tasksRequests = 0;
    await page.route("https://app.test/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/start") return route.fulfill({ contentType: "text/html", body: start });
      if (path !== "/tasks") return route.fulfill({ status: 404 });
      tasksRequests++;
      // The page arrives only after every tap, as on a slow connection. A cancelled load has no one to answer.
      await loading;
      await route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Tasks</title>" }).catch(() => undefined);
    });
    try {
      await page.goto("https://app.test/start");
      const before = await page.evaluate(() =>
        Object.fromEntries(
          [...document.querySelectorAll<HTMLElement>(".k2b-tab-bar a")].map((link) => [link.dataset.tab, getComputedStyle(link).color]),
        ),
      );
      const box = (await page.locator('.k2b-tab-bar a[data-tab="tasks"]').boundingBox())!;
      const title = (await page.locator(".k2b-mobile-shell__title").boundingBox())!;
      const tap = async (count: number) => {
        await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
        while (reports.length < count) await Bun.sleep(10);
      };

      await tap(1);
      // The tapped tab looks selected and the open page's tab no longer does, before the new page exists.
      expect(reports[0]).toEqual({
        start: { color: before.tasks!, pending: false },
        tasks: { color: before.start!, pending: true },
      });

      await tap(2);
      await tap(3);
      expect(reports[2]!.tasks!.pending).toBe(true);
      // Any other tap ends the wait, also on content without an action, so a link that answered with a download or a
      // load that stalled cannot stay stuck.
      await page.touchscreen.tap(title.x + title.width / 2, title.y + title.height / 2);
      while (reports.length < 4) await Bun.sleep(10);
      expect(reports[3]!.tasks!.pending).toBe(false);
      release();
      await page.waitForURL("https://app.test/tasks");
      expect(tasksRequests).toBe(1);
    } finally {
      release();
      await context.close();
    }
  });

  test("a press on a tab shows its page's frame at once, and the end of the tap loads the page", async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    // While a load is pending, Playwright's evaluations wait for it, so the page reports its frame itself. The content
    // also holds bare text and an element that shows itself, as a running pull-to-refresh spinner does.
    const report = `const body = document.querySelector(".k2b-mobile-shell__body");
    const spinner = document.createElement("span");
    spinner.style.visibility = "visible";
    spinner.textContent = "Refreshing";
    body.append("Bare text", spinner);
    const frame = () => {
      const shell = document.querySelector(".k2b-mobile-shell");
      const title = shell.querySelector(".k2b-mobile-shell__title");
      const after = getComputedStyle(title, "::after");
      return {
        switching: shell.hasAttribute("data-k2b-switching"),
        title: after.visibility === "visible" && after.content !== "none" ? after.content : title.textContent,
        titleLeft: title.getBoundingClientRect().left,
        back: shell.querySelector(".k2b-mobile-shell__back") ? getComputedStyle(shell.querySelector(".k2b-mobile-shell__back")).display : null,
        content: [body, ...body.querySelectorAll("*")].every((node) => getComputedStyle(node).visibility === "hidden"),
        header: shell.querySelector(".k2b-mobile-shell__header").getBoundingClientRect().height,
        footerTop: shell.querySelector(".k2b-tab-bar").getBoundingClientRect().top,
      };
    };
    const tell = () => console.log(JSON.stringify(frame()));
    addEventListener("pointerdown", () => setTimeout(tell));
    requestAnimationFrame(tell);`;
    const document = (header: string) =>
      `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>${css}</style></head><body class="k2b-ui"><div id="root"></div><script>${header} window.fixtureTabs = { start: "/start", tasks: "/tasks" };</script><script>${script}</script><script>${report}</script></body></html>`;
    type Frame = {
      switching: boolean;
      title: string;
      titleLeft: number;
      back: string | null;
      content: boolean;
      header: number;
      footerTop: number;
    };
    const frames: Frame[] = [];
    page.on("console", (message) => {
      if (message.text().startsWith("{")) frames.push(JSON.parse(message.text()));
    });
    let tasksRequests = 0;
    await page.route("https://app.test/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/plain") return route.fulfill({ contentType: "text/html", body: document("") });
      if (path === "/start") return route.fulfill({ contentType: "text/html", body: document('window.fixtureHeader = "back";') });
      if (path !== "/tasks") return route.fulfill({ status: 404 });
      tasksRequests++;
      // The page arrives at once, as on a fast connection, so a load started during the press would end before it.
      await route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Tasks</title>" });
    });
    const next = async (count: number) => {
      while (frames.length < count) await Bun.sleep(10);
      return frames[count - 1]!;
    };
    try {
      // A page without Back shows where a page's title belongs. The tab sits at the same place on both pages.
      await page.goto("https://app.test/plain");
      const plain = await next(1);
      const box = (await page.locator('.k2b-tab-bar a[data-tab="tasks"]').boundingBox())!;
      // Opened without a touch, as is every page that a tab has just opened. Playwright's own calls into a page count
      // as the person's action, so none reaches this page before the press.
      await page.goto("https://app.test/start");
      const before = await next(2);
      expect(before).toMatchObject({ switching: false, title: "Tasks", back: "flex", content: false });

      const cdp = await context.newCDPSession(page);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }],
      });
      // The finger is still down: the shell shows the page's frame where that page will have it, without this page's
      // Back or any of its content, and with nothing else moving.
      expect(await next(3)).toEqual({
        switching: true,
        title: '"My tasks"',
        titleLeft: plain.titleLeft,
        back: "none",
        content: true,
        header: before.header,
        footerTop: before.footerTop,
      });
      // The page loads only with the click at the end of the tap, which the browser counts as the person's action.
      // A page that arrived before it would drop this one from the history, so Back would skip it.
      await Bun.sleep(200);
      expect(tasksRequests).toBe(0);

      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForURL("https://app.test/tasks");
      expect(tasksRequests).toBe(1);
      // The browser's own Back, which skips pages left without the person's action, returns to the pressed page.
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 100, y: 300 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 100, y: 300, button: "back", buttons: 8, clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 100, y: 300, button: "back", buttons: 0, clickCount: 1 });
      await page.waitForURL((url) => url.pathname !== "/tasks");
      expect(new URL(page.url()).pathname).toBe("/start");
    } finally {
      await context.close();
    }
  }, 20_000);

  test("a press on a tab that turns into a scroll takes its frame back and loads nothing", async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const home = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>${css}</style></head><body class="k2b-ui"><div id="root"></div><script>window.fixtureTabs = { start: "/start", tasks: "/tasks" };</script><script>${script}</script></body></html>`;
    const requests: string[] = [];
    await page.route("https://app.test/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      requests.push(path);
      if (path === "/home") return route.fulfill({ contentType: "text/html", body: home });
      return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Tasks</title>" });
    });
    const frame = () =>
      page.evaluate(() => ({
        switching: document.querySelector(".k2b-mobile-shell")!.hasAttribute("data-k2b-switching"),
        pending: document.querySelectorAll("[data-k2b-pending]").length,
      }));
    try {
      await page.goto("https://app.test/home");
      const box = (await page.locator('.k2b-tab-bar a[data-tab="tasks"]').boundingBox())!;
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      const cdp = await context.newCDPSession(page);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      expect(await frame()).toEqual({ switching: true, pending: 1 });
      for (let step = 1; step <= 8; step++) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - step * 15 }] });
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      expect(await frame()).toEqual({ switching: false, pending: 0 });
      expect(requests).toEqual(["/home"]);
    } finally {
      await context.close();
    }
  });

  test("a tap on another tab while a page loads opens that tab, also in a browser that paints nothing meanwhile", async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    // WebKit paints no frame, and so runs no animation frame callback, once a page load has started. Chromium paints
    // on, so this page stops its animation frames at the start of a load.
    const frozen = `let loading = false;
    navigation.addEventListener("navigate", () => { loading = true; });
    const animationFrame = requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => animationFrame((time) => { if (!loading) callback(time); });`;
    const home = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>${css}</style></head><body class="k2b-ui"><div id="root"></div><script>${frozen}</script><script>window.fixtureTabs = { start: "/start", tasks: "/tasks" };</script><script>${script}</script></body></html>`;
    const requests: string[] = [];
    let release!: () => void;
    const loading = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("https://app.test/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      requests.push(path);
      if (path === "/home") return route.fulfill({ contentType: "text/html", body: home });
      if (path === "/start") return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Start</title>" });
      if (path !== "/tasks") return route.fulfill({ status: 404 });
      // The tasks page does not arrive while the test runs. A cancelled load has no one to answer.
      await loading;
      await route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Tasks</title>" }).catch(() => undefined);
    });
    try {
      await page.goto("https://app.test/home");
      const center = async (id: string) => {
        const box = (await page.locator(`.k2b-tab-bar a[data-tab="${id}"]`).boundingBox())!;
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      };
      const tasks = await center("tasks");
      const start = await center("start");

      await page.touchscreen.tap(tasks.x, tasks.y);
      while (!requests.includes("/tasks")) await Bun.sleep(10);
      await page.touchscreen.tap(start.x, start.y);
      await page.waitForURL("https://app.test/start");
      expect(requests).toEqual(["/home", "/tasks", "/start"]);
    } finally {
      release();
      await context.close();
    }
  }, 20_000);

  test("a page restored from the back/forward cache shows its own frame again", async () => {
    const page = await open("back");
    try {
      await page.evaluate(() => {
        const shell = document.querySelector<HTMLElement>(".k2b-mobile-shell")!;
        // As a press on a tab leaves the page when it is put into the cache.
        shell.setAttribute("data-k2b-switching", "");
        shell.querySelector(".k2b-mobile-shell__title")!.setAttribute("data-k2b-next-title", "My tasks");
        document.querySelector('.k2b-tab-bar a[data-tab="tasks"]')!.setAttribute("data-k2b-pending", "");
        window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      });
      expect(
        await page.evaluate(() => ({
          switching: document.querySelector(".k2b-mobile-shell")!.hasAttribute("data-k2b-switching"),
          next: document.querySelector(".k2b-mobile-shell__title")!.hasAttribute("data-k2b-next-title"),
          pending: document.querySelectorAll("[data-k2b-pending]").length,
          back: getComputedStyle(document.querySelector(".k2b-mobile-shell__back")!).display,
        })),
      ).toEqual({ switching: false, next: false, pending: 0, back: "flex" });
    } finally {
      await page.context().close();
    }
  });
});
