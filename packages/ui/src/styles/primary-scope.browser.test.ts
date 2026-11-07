import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../test/browser";

const ui = resolve(import.meta.dir, "../..");
const repo = resolve(ui, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const catalogCss = readFileSync(resolve(repo, "docs-site/assets/ui-catalog.css"), "utf8");
const assets = "http://k2b-ui.test/";
const fonts = readFileSync(resolve(ui, "dist/plex.css"), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, `url($1${assets}`);
const entry = resolve(import.meta.dir, "primary-scope.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { createSignal } from "solid-js";
import { Button, Panes, createPanesLayout } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
import { getK2bPortalRoot } from ${JSON.stringify(resolve(ui, "dist/browser/internal/portal.js"))};
import { PrimaryScopeControls } from ${JSON.stringify(resolve(repo, "docs-site/src/ui/PrimaryScopeDemo.island.tsx"))};
import actions from ${JSON.stringify(resolve(repo, "docs-site/src/ui/demo-sections/actions.tsx"))};
import inputs from ${JSON.stringify(resolve(repo, "docs-site/src/ui/demo-sections/input.tsx"))};
render(() => createComponent(PrimaryScopeControls, {}), document.getElementById("controls"));
render(() => createComponent(Button, { children: "Outside action", id: "outside-action" }), document.getElementById("outside"));
render(() => [
  ...["buttons", "tabs", "segmented-control", "filters", "menus"].map(slug => actions[slug]({ markdownHtml: "" })),
  ...["boolean", "choice-list", "choice-tiles", "slider", "choice-slider"].map(slug => inputs[slug]({ markdownHtml: "" })),
], document.getElementById("catalog"));
const panes = document.createElement("div");
panes.id = "panes";
panes.style.height = "240px";
document.getElementById("catalog").append(panes);
render(() => {
  const [layout, setLayout] = createSignal(createPanesLayout(["draft", "sources"]));
  return createComponent(Panes, {
    get layout() { return layout(); }, onLayoutChange: setLayout,
    items: [{ id: "draft", title: "Draft", render: () => "Demo draft" }, { id: "sources", title: "Source notes", render: () => "Demo sources" }],
  });
}, panes);
const nested = document.getElementById("nested");
render(() => createComponent(Button, { children: "Nested action" }), nested);
const trigger = document.createElement("button");
trigger.id = "portal-trigger";
trigger.textContent = "Open portaled popover";
trigger.className = "k2b-button";
trigger.dataset.variant = "secondary";
trigger.addEventListener("mousedown", event => event.preventDefault());
trigger.onclick = () => {
  const popover = document.createElement("div");
  popover.id = "portal-popover";
  popover.setAttribute("popover", "auto");
  getK2bPortalRoot().append(popover);
  render(() => createComponent(Button, { children: "Portaled action" }), popover);
  popover.showPopover();
};
document.getElementById("controls").append(trigger);
`;
const { transformAsync } = await import("@babel/core");
const typescript = (await import("@babel/preset-typescript")).default;
const solid = (await import("babel-preset-solid")).default;
const build = await Bun.build({
  entrypoints: [entry],
  files: { [entry]: fixture },
  target: "browser",
  conditions: ["browser"],
  format: "iife",
  plugins: [
    {
      name: "primary-scope-catalog",
      setup(builder) {
        builder.onResolve({ filter: /^@k2b\/ui$/ }, () => ({ path: resolve(ui, "dist/browser/index.js") }));
        builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
          const result = await transformAsync(await Bun.file(path).text(), {
            filename: path,
            babelrc: false,
            configFile: false,
            presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
          });
          if (!result?.code) throw new Error(`Could not compile ${path}`);
          return { contents: result.code, loader: "js" };
        });
      },
    },
  ],
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the primary scope catalog fixture");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const tokens = [
  "action",
  "action-hover",
  "action-solid",
  "action-solid-hover",
  "focus-ring",
  "edge-focus",
  "selected",
  "hover",
  "focus-fill",
  "link-accent",
  "row-selected",
  "app-workspace-active",
  "app-workspace-selected",
  "selection",
];
const palette = (page: Page, selector: string) =>
  page.locator(selector).evaluate((element, names) => {
    const style = getComputedStyle(element);
    return Object.fromEntries(names.map((name) => [name, style.getPropertyValue(`--k2b-${name}`).trim()]));
  }, tokens);

for (const theme of ["light", "dark"] as const) {
  const expectedAction = theme === "light" ? "#8e1b6f" : "#f0abdc";
  for (const width of [1440, 390]) {
    test(`${theme} ${width}: catalog, nested roots, portals, and unchanged blue outside`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      const errors = pageErrors(page);
      try {
        await page.route(`${assets}**`, (route) =>
          route.fulfill({
            path: resolve(ui, "dist", new URL(route.request().url()).pathname.slice(1)),
            headers: { "access-control-allow-origin": "*" },
          }),
        );
        await page.setContent(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${catalogCss}</style><style>${fonts}</style>
          <style>*,*::before,*::after{transition:none!important;animation:none!important}body{margin:0}#evidence{padding:24px;max-width:1000px;margin:auto}#outside{margin-bottom:24px}#scope{padding:24px;border:1px solid var(--k2b-border);border-radius:12px}#catalog{padding:24px}#nested{margin-top:16px}</style></head>
          <body class="k2b-ui" data-theme="${theme}"><main id="evidence"><h1>Primary scope · ${theme}</h1><section id="outside"></section><section id="scope" data-k2b-primary="ai"><h2>AI primary</h2><div id="controls"></div><div class="k2b-ui" id="nested"></div></section></main><section id="catalog" data-k2b-primary="ai"></section></body></html>`);
        const before = await palette(page, "#outside");
        await page.addScriptTag({ content: script });
        await page.getByRole("slider", { name: "Detail level", exact: true }).waitFor();
        await page.evaluate(() => document.fonts.ready);
        await page.mouse.move(0, 0);
        await settled(page);
        expect(await palette(page, "#outside")).toEqual(before);
        expect(before.action).toBe(theme === "light" ? "#1d4ed8" : "#93c5fd");
        const inside = await palette(page, "#scope");
        expect(inside.action).toBe(expectedAction);
        expect(inside["action-solid"]).toBe(theme === "light" ? "#8e1b6f" : "#b7408f");
        expect(inside["focus-ring"]).toBe(theme === "light" ? "#c4519f" : "#f0abdc");
        const nested = await palette(page, "#nested");
        for (const name of tokens.filter((name) => name !== "focus-fill")) expect(nested[name]).toBe(inside[name]);
        expect(await page.locator("#catalog .ui-demo-card__preview").count()).toBeGreaterThanOrEqual(10);
        const boxes = () =>
          page.locator("#controls :is(button, input, [role='tab'], [role='slider'])").evaluateAll((nodes) =>
            nodes.map((node) => {
              const { x, y, width, height } = node.getBoundingClientRect();
              return { x, y, width, height };
            }),
          );
        const scopedBoxes = await boxes();
        await page.locator("#scope").evaluate((node) => node.removeAttribute("data-k2b-primary"));
        expect(await boxes()).toEqual(scopedBoxes);
        await page.locator("#scope").evaluate((node) => node.setAttribute("data-k2b-primary", "ai"));
        expect(await boxes()).toEqual(scopedBoxes);
        const leaks = await page.evaluate(() => {
          const canvas = document.createElement("canvas").getContext("2d")!;
          const rgba = (value: string) => {
            canvas.clearRect(0, 0, 1, 1);
            canvas.fillStyle = value;
            canvas.fillRect(0, 0, 1, 1);
            return [...canvas.getImageData(0, 0, 1, 1).data].join(",");
          };
          const ramp = new Set(
            ["#eff6ff", "#dbeafe", "#bfdbfe", "#93c5fd", "#60a5fa", "#3b82f6", "#2563eb", "#1d4ed8", "#1e40af", "#1e3a8a", "#172554"].map(
              rgba,
            ),
          );
          const leaks: string[] = [];
          for (const node of document.querySelectorAll("#scope *, #catalog .ui-demo-card__preview, #catalog .ui-demo-card__preview *")) {
            for (const pseudo of [null, "::before", "::after", "::selection"]) {
              const style = getComputedStyle(node, pseudo);
              for (const key of [
                "color",
                "background-color",
                "border-top-color",
                "outline-color",
                "accent-color",
                "text-decoration-color",
              ]) {
                const value = style.getPropertyValue(key);
                if (value && CSS.supports("color", value) && ramp.has(rgba(value)))
                  leaks.push(`${node.className} ${pseudo ?? ""} ${key}=${value}`);
              }
            }
          }
          return leaks;
        });
        expect(leaks).toEqual([]);
        const primary = page.locator("#controls").getByRole("button", { name: "Save notes", exact: true });
        const primaryPaint = await primary.evaluate((node) => ({
          fill: getComputedStyle(node).backgroundColor,
          text: getComputedStyle(node).color,
        }));
        expect(primaryPaint).toEqual({ fill: theme === "light" ? "rgb(142, 27, 111)" : "rgb(183, 64, 143)", text: "rgb(255, 255, 255)" });
        const primaryBox = await primary.boundingBox();
        await primary.hover();
        expect(await primary.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(
          theme === "light" ? "rgb(112, 21, 86)" : "rgb(142, 27, 111)",
        );
        expect(await primary.boundingBox()).toEqual(primaryBox);
        const field = page.locator("#controls input").first();
        const initialBox = await field.boundingBox();
        await field.hover();
        await field.focus();
        await settled(page);
        expect(await field.boundingBox()).toEqual(initialBox);
        expect(
          await field.evaluate((node) => getComputedStyle(node.closest(".k2b-input-shell")!).getPropertyValue("--k2b-edge-color").trim()),
        ).toBe(expectedAction);
        const screenshotDir = process.env.K2B_PRIMARY_SCOPE_SCREENSHOTS;
        if (screenshotDir) {
          mkdirSync(screenshotDir, { recursive: true });
          const evidence = (await page.locator("#evidence").boundingBox())!;
          await page.screenshot({
            path: resolve(screenshotDir, `primary-scope-controls-${theme}-${width}.png`),
            clip: { x: 0, y: 0, width, height: Math.ceil(evidence.height) },
          });
        }
        await page.locator("#outside-action").focus();
        await page.locator("#portal-trigger").click();
        expect(await palette(page, "#portal-popover")).toEqual(inside);
        expect(await page.locator("#portal-popover").evaluate((node) => node.closest("#scope"))).toBeNull();
        await page.keyboard.press("Escape");
        await page.locator("#controls").getByRole("button", { name: "More actions", exact: true }).click();
        const menu = page.locator("#controls [popover]");
        expect(await menu.evaluate((node) => node.matches(":popover-open"))).toBe(true);
        expect((await palette(page, "#controls [popover]")).action).toBe(expectedAction);
        await page.keyboard.press("Escape");
        await page.locator("#scope").evaluate((node, theme) => {
          node.classList.add("k2b-ui");
          node.setAttribute("data-theme", theme);
          node.style.transform = "translateZ(0)";
        }, theme);
        await page.locator("#controls [aria-label='Note menu']").click({ button: "right" });
        expect((await palette(page, ".k2b-context-menu")).action).toBe(expectedAction);
        expect(await page.locator(".k2b-context-menu").evaluate((node) => getComputedStyle(node).position)).toBe("fixed");
        expect(await page.locator(".k2b-context-menu").evaluate((node) => node.closest("#scope"))).toBeNull();
        await page.keyboard.press("Escape");
        await page.locator("#outside-action").focus();
        await page
          .locator("#controls")
          .getByRole("button", { name: "Preview", exact: true })
          .evaluate((node) => node.addEventListener("mousedown", (event) => event.preventDefault()));
        await page.locator("#controls").getByRole("button", { name: "Preview", exact: true }).click();
        await page.getByRole("button", { name: "Close preview", exact: true }).waitFor();
        expect((await palette(page, ".k2b-floating-window")).action).toBe(expectedAction);
        expect(await page.locator(".k2b-floating-window").evaluate((node) => node.closest("#scope"))).toBeNull();
        await page.getByRole("button", { name: "Close preview", exact: true }).click();
        await page.locator("#outside-action").focus();
        await page
          .locator("#controls")
          .getByRole("button", { name: "Save notes", exact: true })
          .evaluate((node) => node.addEventListener("mousedown", (event) => event.preventDefault()));
        await page.locator("#controls").getByRole("button", { name: "Save notes", exact: true }).click();
        await page.locator("dialog[open]").waitFor();
        expect((await palette(page, "dialog[open]")).action).toBe(expectedAction);
        await page.keyboard.press("Escape");
        const tab = page.locator("#panes [role='tab']").first();
        await tab.scrollIntoViewIfNeeded();
        const tabBox = (await tab.boundingBox())!;
        await page.mouse.move(tabBox.x + tabBox.width / 2, tabBox.y + tabBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(tabBox.x + tabBox.width / 2 + 30, tabBox.y + tabBox.height / 2 + 30, { steps: 5 });
        const ghost = page.locator("body > .k2b-panes__drag-preview[aria-hidden='true']");
        await ghost.waitFor();
        const ghostPalette = await palette(page, "body > .k2b-panes__drag-preview[aria-hidden='true']");
        expect(ghostPalette.action).toBe(expectedAction);
        expect(ghostPalette["action-solid"]).toBe(inside["action-solid"]);
        await page.keyboard.press("Escape");
        await page.mouse.up();
        await ghost.waitFor({ state: "detached" });
        // The same attribute also works directly on a theme root (the docs demo).
        await page.locator("#scope").evaluate((node, theme) => {
          node.classList.add("k2b-ui");
          node.setAttribute("data-theme", theme);
        }, theme);
        expect(await palette(page, "#scope")).toEqual(inside);
        expect(await palette(page, "#outside")).toEqual(before);
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    }, 30_000);
  }
}
