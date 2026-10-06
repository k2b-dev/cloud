import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../../packages/ui/test/browser";

// Safari colors the status bar of an installed web app from the page: it hit-tests a point just below
// the top edge and takes the first fixed or sticky layer there. For a layer that covers the whole
// viewport it keeps the color the edge already had, which is a dialog backdrop's dim once a dialog
// was open (WebKit `LocalFrameView::fixedContainerEdges`). No engine here paints that band, so this
// runs the real build at phone size and pins what decides it: outside dialogs no fixed or sticky
// layer reaches the top edge, and closing a dialog leaves theme-color and html and body as they were.

let root: string;
let server: ReturnType<typeof Bun.serve>;
let browser: Browser;
let sheet: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pwa-auth-status-bar-"));
  // In its own process: this suite resolves the browser condition, which gives Babel its browser build.
  const script = resolve(import.meta.dir, "../scripts/build.ts");
  const built = Bun.spawnSync({
    cmd: [
      process.execPath,
      "--eval",
      `await (await import(${JSON.stringify(script)})).build({ development: true, outdir: ${JSON.stringify(root)} });`,
    ],
    stdout: "ignore",
    stderr: "pipe",
  });
  if (built.exitCode !== 0) throw new Error(`Could not build Cloud Login:\n${built.stderr.toString()}`);
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const pathname = new URL(request.url).pathname;
      const path = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
      const file = Bun.file(path);
      if (relative(root, path).startsWith("..") || !(await file.exists())) return new Response(null, { status: 404 });
      return new Response(file);
    },
  });
  // A sign-in request opens a bottom sheet, which needs a paired Cloud. The same wrapper and sheet
  // open here from a script added to the running app, against the app's stylesheet.
  const entry = resolve(import.meta.dir, "status-bar.fixture.ts");
  const fixture = `
    import { createComponent } from "solid-js";
    import { BottomSheet, bottomSheetOptions, PanelDialog } from "@k2b/ui";
    import { openDialog } from "./dialog";
    window.openSheet = () =>
      void openDialog(
        (close, { requestDismiss }) =>
          createComponent(BottomSheet, {
            onDismiss: requestDismiss,
            get children() {
              return createComponent(PanelDialog.Header, { title: "Sign-in request", close: () => close() });
            },
          }),
        bottomSheetOptions,
      );
  `;
  const bundle = await Bun.build({
    entrypoints: [entry],
    files: { [entry]: fixture },
    target: "browser",
    conditions: ["browser"],
    format: "iife",
  });
  if (!bundle.success) throw new AggregateError(bundle.logs, "Could not bundle the bottom sheet fixture.");
  sheet = await bundle.outputs[0]!.text();
  browser = await launchBrowser();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop(true);
  if (root) await rm(root, { recursive: true, force: true });
});

/** What the status bar and the page chrome depend on. */
const state = (page: Page) =>
  page.evaluate(() => {
    let topEdge: string | null = null;
    for (let element = document.elementFromPoint(innerWidth / 2, 4); element && !topEdge; element = element.parentElement) {
      const { position } = getComputedStyle(element);
      if (position === "fixed" || position === "sticky") topEdge = [element.tagName.toLowerCase(), ...element.classList].join(".");
    }
    return {
      topEdge,
      themeColor: [...document.querySelectorAll('meta[name="theme-color"]')].map((meta) => meta.getAttribute("content")),
      html: document.documentElement.getAttribute("style"),
      htmlClass: document.documentElement.className,
      body: document.body.getAttribute("style"),
      bodyClass: document.body.className,
      theme: document.body.dataset.theme,
      background: getComputedStyle(document.body).backgroundColor,
      layers: document.querySelectorAll("dialog, :popover-open").length,
    };
  });

const closed = (page: Page) => page.waitForFunction(() => !document.querySelector("dialog, :popover-open"));

/** The page without any dialog: no layer at the top edge, and chrome in the page's own color. */
const expectPage = async (page: Page, theme: "light" | "dark") => {
  const now = await state(page);
  expect(now).toMatchObject({ topEdge: null, theme, layers: 0, bodyClass: "k2b-ui", htmlClass: "" });
  expect(now.themeColor).toEqual([now.background, now.background]);
  expect(now.html).toBe(`background-color: ${now.background};`);
  expect(await page.evaluate(() => [document.documentElement.style.overflow, document.body.style.overflow])).toEqual(["", ""]);
  return now;
};

const dialogs: Record<string, { open: (page: Page) => Promise<void>; close: (page: Page) => Promise<void> }> = {
  menu: {
    open: async (page) => {
      await page.getByRole("button", { name: "Menu" }).click();
      await page.getByRole("menuitem", { name: "Settings" }).waitFor();
    },
    close: (page) => page.keyboard.press("Escape"),
  },
  "settings dialog": {
    open: async (page) => {
      await page.getByRole("button", { name: "Menu" }).click();
      await page.getByRole("menuitem", { name: "Settings" }).click();
      await page.getByRole("dialog").waitFor();
    },
    close: (page) => page.getByRole("button", { name: "Done" }).click(),
  },
  "PIN dialog": {
    open: async (page) => {
      await page.getByRole("button", { name: "Add Cloud" }).click();
      await page.getByRole("dialog").waitFor();
    },
    close: (page) => page.keyboard.press("Escape"),
  },
  "bottom sheet": {
    open: async (page) => {
      await page.evaluate(() => (window as unknown as { openSheet: () => void }).openSheet());
      await page.locator("dialog.k2b-bottom-sheet-frame").waitFor();
    },
    close: (page) => page.getByRole("button", { name: "Close" }).first().click(),
  },
};

const cases = [
  { colorScheme: "light", chosen: "system", theme: "light", other: "Dark" },
  { colorScheme: "dark", chosen: "system", theme: "dark", other: "Light" },
  { colorScheme: "light", chosen: "dark", theme: "dark", other: "Light" },
  { colorScheme: "dark", chosen: "light", theme: "light", other: "Dark" },
] as const;

describe("Cloud Login gives the status bar back to the page after every dialog", () => {
  for (const { colorScheme, chosen, theme, other } of cases) {
    test(`${colorScheme} system, ${chosen} chosen, at 390 px`, async () => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        colorScheme,
      });
      try {
        if (chosen !== "system") {
          await context.addInitScript(
            (value) =>
              localStorage.setItem("pwa-auth.preferences", JSON.stringify({ language: "en", theme: value, _key: "pwa-auth.preferences" })),
            chosen,
          );
        }
        const page = await context.newPage();
        await page.goto(server.url.href);
        await page.addScriptTag({ content: sheet });
        // First launch in a browser opens the install introduction.
        await page.getByRole("dialog").waitFor();
        expect((await state(page)).topEdge).toMatch(/^dialog\./);
        await page.getByRole("button", { name: "Continue in browser" }).click();
        await closed(page);
        const before = await expectPage(page, theme);

        for (const [name, dialog] of Object.entries(dialogs)) {
          await dialog.open(page);
          // Dialogs dim the edge while they are open; the menu stays below it.
          expect((await state(page)).topEdge, name).toEqual(name === "menu" ? null : expect.stringMatching(/^dialog\./));
          await dialog.close(page);
          await closed(page);
          expect(await state(page), name).toEqual(before);
        }

        // A theme chosen in a dialog reaches the status bar once the dialog closes.
        await dialogs["settings dialog"]!.open(page);
        await page.getByRole("radio", { name: other }).click();
        await dialogs["settings dialog"]!.close(page);
        await closed(page);
        const switched = await expectPage(page, theme === "light" ? "dark" : "light");
        expect(switched.background).not.toBe(before.background);
      } finally {
        await context.close();
      }
    }, 60_000);
  }
});
