import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser } from "../../test/browser";

// Whether a busy button keeps its size is a question of real layout, so the
// shipped browser build renders every kind of button idle and busy here.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
// Fonts load from the build through a routed origin, so icons and labels have their real size.
const assets = "http://k2b-ui.test/";
const fonts = ["plex.css", "tabler.css"]
  .map((file) => readFileSync(resolve(ui, "dist", file), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, `url($1${assets}`))
  .join("\n");
// Apps import Tailwind's utilities into the `utilities` layer.
const utilities = "@layer utilities { .absolute { position: absolute } .top-0 { top: 0 } .right-0 { right: 0 } }";
// Lives only in memory; its path makes bare imports resolve from this package.
const entry = resolve(import.meta.dir, "button-loading.fixture.ts");
const fixture = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { Button, CopyButton, IconButton, SplitButton } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const [busy, setBusy] = createSignal(false);
globalThis.setBusy = setBusy;
const icon = (name) => {
  const element = document.createElement("i");
  element.className = "ti ti-" + name;
  element.setAttribute("aria-hidden", "true");
  return element;
};
const button = (props) =>
  createComponent(Button, {
    ...props,
    get loading() {
      return busy();
    },
  });

const variants = ["primary", "secondary", "ghost", "text", "subtle", "input", "warning", "danger", "success", "ai"];
const sizes = ["xs", "sm", "md", "lg"];

render(
  () => [
    ...variants.flatMap((variant) =>
      sizes.flatMap((size) => [
        // A loading label longer and shorter than the label, and none.
        button({ variant, size, loadingLabel: "Saving every change to the server", children: "Save " + variant + " " + size }),
        button({ variant, size, loadingLabel: "…", children: "Publish " + variant + " " + size }),
        button({ variant, size, get children() { return [icon("send"), "Send " + variant + " " + size]; } }),
      ]),
    ),
    ...["ghost", "primary"].flatMap((variant) =>
      sizes.map((size) =>
        createComponent(IconButton, {
          size,
          variant,
          label: "Refresh " + variant + " " + size,
          loadingLabel: "Refreshing " + variant + " " + size,
          get loading() {
            return busy();
          },
          get children() {
            return icon("refresh");
          },
        }),
      ),
    ),
    // A caller's own name gives way to the loading label while busy.
    button({ "aria-label": "Create a contact book", loadingLabel: "Creating the book", children: "New" }),
    button({ wrap: true, style: "max-width: 9rem", loadingLabel: "Creating", children: "Create a new client with a long name" }),
    button({ align: "start", variant: "ghost", style: "width: 20rem", loadingLabel: "Opening", children: "Maria Kolb" }),
    createComponent(CopyButton, {
      text: "value",
      label: "Copy value",
      loadingLabel: "Copying the value to the clipboard",
      get loading() {
        return busy();
      },
    }),
    createComponent(CopyButton, {
      text: "value",
      loadingLabel: "Copying the token",
      get loading() {
        return busy();
      },
    }),
    createComponent(SplitButton, {
      menuLabel: "More send options",
      items: [{ label: "Send later", action: () => {} }],
      loadingLabel: "Sending the message",
      get loading() {
        return busy();
      },
      children: "Send now",
    }),
  ],
  document.getElementById("app"),
);

// A button placed by a utility class stays where it is while busy.
render(
  () => button({ class: "absolute top-0 right-0", variant: "secondary", loadingLabel: "Closing", children: "Close" }),
  document.getElementById("placed"),
);
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the button fixture for the browser.");
const script = await build.outputs[0]!.text();

const viewports: Record<string, BrowserContextOptions> = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  "reduced motion": { viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" },
};

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async (options: BrowserContextOptions) => {
  const page = await browser.newPage(options);
  await page.route(`${assets}**`, (route) =>
    route.fulfill({ path: resolve(ui, "dist", new URL(route.request().url()).pathname.slice(1)) }),
  );
  await page.setContent(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<style>${css}</style><style>${fonts}</style><style>${utilities}</style></head>` +
      `<body class="k2b-ui" style="margin:0"><main id="app" style="display:flex;flex-wrap:wrap;align-items:flex-start;gap:8px;padding:16px"></main>` +
      `<div id="placed" style="position:relative;height:6rem;margin:16px"></div></body></html>`,
  );
  await page.addScriptTag({ content: script });
  await page.getByRole("button", { name: "Send now" }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  return page;
};

/** Waits two frames, so layout and paint follow the state change. */
const settle = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

const setBusy = async (page: Page, busy: boolean) => {
  await page.evaluate((value) => (globalThis as unknown as { setBusy: (busy: boolean) => void }).setBusy(value), busy);
  await settle(page);
};

/** Every button's border box, rounded to 1/100 px, keyed by its idle label. */
const boxes = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>(":is(#app, #placed) .k2b-button"), (button) => {
      const box = button.getBoundingClientRect();
      return {
        label: button.getAttribute("aria-label") ?? button.querySelector(".k2b-button__label")?.textContent ?? "",
        box: [box.x, box.y, box.width, box.height].map((value) => Math.round(value * 100) / 100),
      };
    }),
  );

describe("@k2b/ui a busy button keeps its box", () => {
  for (const [name, options] of Object.entries(viewports)) {
    test(`${name}: every variant and size keeps its position and size while loading`, async () => {
      const page = await load(options);
      try {
        const idle = await boxes(page);
        expect(idle.length).toBeGreaterThan(130);
        // The placed button sits in the corner of its container, out of the flow.
        const placed = await page.getByRole("button", { name: "Close", exact: true }).evaluate((button) => {
          const box = button.getBoundingClientRect();
          const container = button.parentElement!.getBoundingClientRect();
          return [Math.round(container.right - box.right), Math.round(box.top - container.top)];
        });
        expect(placed).toEqual([0, 0]);
        await setBusy(page, true);
        const busy = await boxes(page);
        expect(busy.map((entry) => entry.box)).toEqual(idle.map((entry) => entry.box));
        await setBusy(page, false);
        expect((await boxes(page)).map((entry) => entry.box)).toEqual(idle.map((entry) => entry.box));
      } finally {
        await page.close();
      }
    });
  }

  test("the spinner sits centered over invisible idle content", async () => {
    const page = await load(viewports["reduced motion"]!);
    try {
      await setBusy(page, true);
      const state = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>('#app .k2b-button[aria-busy="true"]'), (button) => {
          const box = button.getBoundingClientRect();
          const spinner = button.querySelector<HTMLElement>(".k2b-button__busy > .k2b-spin")!.getBoundingClientRect();
          const label = button.querySelector<HTMLElement>(".k2b-button__label")!;
          return {
            spinner: [spinner.width, spinner.height],
            offset: [
              Math.abs(spinner.x + spinner.width / 2 - (box.x + box.width / 2)),
              Math.abs(spinner.y + spinner.height / 2 - (box.y + box.height / 2)),
            ],
            opacity: getComputedStyle(label).opacity,
            animation: getComputedStyle(button.querySelector(".k2b-spin")!).animationName,
          };
        }),
      );
      expect(state.length).toBeGreaterThan(130);
      for (const entry of state) {
        // The icon font draws a real glyph: the spinner is visible and has a size.
        expect(entry.spinner[0]).toBeGreaterThan(8);
        expect(entry.spinner[1]).toBeGreaterThan(8);
        expect(entry.offset[0]).toBeLessThan(1);
        expect(entry.offset[1]).toBeLessThan(1);
        expect(entry.opacity).toBe("0");
        // Reduced motion keeps a still spinner.
        expect(entry.animation).toBe("none");
      }
    } finally {
      await page.close();
    }
  });

  test("a busy button is named by its loading label, or by its idle label without one", async () => {
    const page = await load(viewports.desktop!);
    try {
      await setBusy(page, true);
      const saving = page.getByRole("button", { name: "Saving every change to the server", exact: true });
      expect(await saving.count()).toBe(40);
      expect(await saving.first().getAttribute("aria-busy")).toBe("true");
      expect(await saving.first().isDisabled()).toBe(true);
      expect(await page.getByRole("button", { name: "Send primary md", exact: true }).getAttribute("aria-busy")).toBe("true");
      expect(await page.getByRole("button", { name: "Refreshing primary md", exact: true }).count()).toBe(1);
      expect(await page.getByRole("button", { name: "Creating the book", exact: true }).count()).toBe(1);
      expect(await page.getByRole("button", { name: "Copying the value to the clipboard", exact: true }).count()).toBe(1);
      expect(await page.getByRole("button", { name: "Copying the token", exact: true }).count()).toBe(1);
      expect(await page.getByRole("button", { name: "Sending the message", exact: true }).count()).toBe(1);

      await setBusy(page, false);
      expect(await saving.count()).toBe(0);
      expect(await page.getByRole("button", { name: "Save primary md", exact: true }).isEnabled()).toBe(true);
      expect(await page.getByRole("button", { name: "Create a contact book", exact: true }).count()).toBe(1);
      expect(await page.getByRole("button", { name: "Refresh primary md", exact: true }).count()).toBe(1);
    } finally {
      await page.close();
    }
  });
});
