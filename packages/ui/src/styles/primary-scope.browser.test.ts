import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../test/browser";
import { auditPrimaryColors } from "../../test/primary-scope-audit";

const ui = resolve(import.meta.dir, "../..");
const repo = resolve(ui, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const catalogCss = readFileSync(resolve(repo, "docs-site/assets/ui-catalog.css"), "utf8");
const assets = "http://k2b-ui.test/";
const fonts = readFileSync(resolve(ui, "dist/plex.css"), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, `url($1${assets}`);
const icons = readFileSync(resolve(ui, "dist/tabler.css"), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, `url($1${assets}`);
const entry = resolve(import.meta.dir, "primary-scope.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { createSignal } from "solid-js";
import { Button, Panes, createPanesLayout, prompts, toast } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
import { getK2bPortalRoot } from ${JSON.stringify(resolve(ui, "dist/browser/internal/portal.js"))};
import { PrimaryScopeControls } from ${JSON.stringify(resolve(repo, "docs-site/src/ui/PrimaryScopeDemo.island.tsx"))};
import aiDemos from ${JSON.stringify(resolve(repo, "docs-site/src/ui/demo-sections/ai.tsx"))};
import inputDemos from ${JSON.stringify(resolve(repo, "docs-site/src/ui/demo-sections/input.tsx"))};
import actionsDemos from ${JSON.stringify(resolve(repo, "docs-site/src/ui/demo-sections/actions.tsx"))};
import layoutDemos from ${JSON.stringify(resolve(repo, "docs-site/src/ui/demo-sections/layout.tsx"))};
import surfacesDemos from ${JSON.stringify(resolve(repo, "docs-site/src/ui/demo-sections/surfaces.tsx"))};
import feedbackDemos from ${JSON.stringify(resolve(repo, "docs-site/src/ui/demo-sections/feedback.tsx"))};
import contentDemos from ${JSON.stringify(resolve(repo, "docs-site/src/ui/demo-sections/content.tsx"))};
import widgetsDemos from ${JSON.stringify(resolve(repo, "docs-site/src/ui/demo-sections/widgets.tsx"))};
import cloudDemos from ${JSON.stringify(resolve(repo, "docs-site/src/ui/demo-sections/cloud.tsx"))};
import * as charts from ${JSON.stringify(resolve(repo, "docs-site/src/ui/demo-sections/charts.tsx"))};
render(() => createComponent(PrimaryScopeControls, {}), document.getElementById("controls"));
render(() => [
 createComponent(Button, { children: "Outside action", id: "outside-action", onClick: () => void prompts.confirm("Outside notes", {title: "Outside dialog"}) }),
 createComponent(Button, { children: "Outside toast", id: "outside-toast", onClick: () => toast("Outside toast", {duration: 0}) }),
], document.getElementById("outside"));
const sections = Object.entries({ai: aiDemos, input: inputDemos, actions: actionsDemos, layout: layoutDemos, surfaces: surfacesDemos, feedback: feedbackDemos, content: contentDemos, widgets: widgetsDemos, cloud: cloudDemos, charts});
const disposals = [];
for (const [section, demos] of sections) {
 const host = document.createElement("section");
 host.dataset.demoSection = section;
 document.getElementById("catalog").append(host);
}
document.addEventListener("primary-scope-demo", event => {
  for (const dispose of disposals.splice(0)) dispose();
  const [section, demos] = sections.find(([name]) => name === event.detail);
  const host = document.querySelector('[data-demo-section="' + section + '"]');
  disposals.push(render(() => Object.values(demos).map(demo => createComponent(demo, {markdownHtml: "", window: "1h"})), host));
});
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
  getK2bPortalRoot(document.body).append(popover);
  render(() => createComponent(Button, { children: "Portaled action" }), popover);
  popover.showPopover();
};
document.getElementById("controls").append(trigger);
const frame = document.createElement("iframe");
frame.id = "foreign-document";
document.body.append(frame);
const frameSource = frame.contentDocument.createElement("button");
frameSource.dataset.k2bPrimary = "ai";
frame.contentDocument.body.append(frameSource);
getK2bPortalRoot(frame.contentDocument.body, frameSource, frame.contentDocument).id = "foreign-portal";

`;
const { transformAsync } = await import("@babel/core");
const typescript = (await import("@babel/preset-typescript")).default;
const solid = (await import("babel-preset-solid")).default;
const build = await Bun.build({
  entrypoints: [entry],
  files: { [entry]: fixture },
  target: "browser",
  define: { "import.meta.url": JSON.stringify(assets) },
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
let script = await build.outputs[0]!.text();
// File-loader workers need a browser URL even in this self-contained fixture.
for (const asset of build.outputs.slice(1)) {
  const name = asset.path.split("/").pop()!;
  const data = `data:${asset.type || "text/javascript"};base64,${Buffer.from(await asset.arrayBuffer()).toString("base64")}`;
  script = script.replaceAll(`../${name}`, data).replaceAll(`./${name}`, data);
}

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
const palette = async (page: Page, selector: string) => {
  await settled(page);
  return page.locator(selector).evaluate((element, names) => {
    const style = getComputedStyle(element);
    return Object.fromEntries(names.map((name) => [name, style.getPropertyValue(`--k2b-${name}`).trim()]));
  }, tokens);
};

for (const theme of ["light", "dark"] as const) {
  const expectedAction = theme === "light" ? "#8e1b6f" : "#f0abdc";
  for (const width of [1440, 390]) {
    describe(`${theme} ${width}`, () => {
      let page: Page;
      afterAll(async () => {
        await page?.close();
      });
      test("nested roots, portals, and unchanged blue outside", async () => {
        page = await browser.newPage({ viewport: { width, height: 1000 } });
        const errors = pageErrors(page);
        await page.route(`${assets}**`, (route) =>
          route.fulfill({
            path: resolve(ui, "dist", new URL(route.request().url()).pathname.slice(1)),
            headers: { "access-control-allow-origin": "*" },
          }),
        );
        await page.setContent(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${catalogCss}</style><style>${fonts}</style><style>${icons}</style>
          <style>*,*::before,*::after{transition:none!important;animation:none!important}body{margin:0}#evidence{padding:24px;max-width:1000px;margin:auto}#outside{margin-bottom:24px}#scope{padding:24px;border:1px solid var(--k2b-border);border-radius:12px}#catalog{padding:24px}#nested{margin-top:16px}</style></head>
          <body class="k2b-ui" data-theme="${theme}"><main id="evidence"><h1>Primary scope · ${theme}</h1><section id="outside"></section><section id="scope" data-k2b-primary="ai"><h2>AI primary</h2><div id="controls"></div><div class="k2b-ui" id="nested"></div></section></main><section id="catalog" data-k2b-primary="ai"></section></body></html>`);
        await settled(page);
        const before = await palette(page, "#outside");
        await page.evaluate(() => {
          // Pin Date alone; timers, animation frames and performance keep running.
          const at = Date.parse("2026-11-07T12:00:00Z");
          const RealDate = Date;
          class PinnedDate extends RealDate {
            constructor(...args: ConstructorParameters<DateConstructor> | []) {
              if (args.length === 0) super(at);
              else super(...(args as ConstructorParameters<DateConstructor>));
            }
            static override now() {
              return at;
            }
          }
          globalThis.Date = PinnedDate as DateConstructor;
          let seed = 17;
          Math.random = () => {
            seed = (seed * 16807) % 2147483647;
            return seed / 2147483647;
          };
        });
        await page.addScriptTag({ content: script });
        await page.getByRole("slider", { name: "Detail level", exact: true }).waitFor();
        await page.evaluate(() => document.fonts.ready);
        await page.mouse.move(0, 0);
        await settled(page);
        expect(await palette(page, "#outside")).toEqual(before);
        expect(before.action).toBe(theme === "light" ? "#1d4ed8" : "#93c5fd");
        const inside = await palette(page, "#scope");
        expect(inside.action).toBe(expectedAction);
        expect(inside.hover).not.toBe(inside.selected);
        if (theme === "dark") expect(inside.hover).toBe(before.hover);
        expect(
          await page.locator("#foreign-document").evaluate((node) => {
            const doc = (node as HTMLIFrameElement).contentDocument!;
            const portal = doc.getElementById("foreign-portal");
            return {
              ownDocument: portal?.ownerDocument === doc,
              parent: portal?.parentElement === doc.body,
              primary: portal?.dataset.k2bPrimary,
            };
          }),
        ).toEqual({ ownDocument: true, parent: true, primary: "ai" });
        expect(inside["action-solid"]).toBe(theme === "light" ? "#8e1b6f" : "#b7408f");
        expect(inside["focus-ring"]).toBe(theme === "light" ? "#c4519f" : "#f0abdc");
        const nested = await palette(page, "#nested");
        for (const name of tokens.filter((name) => name !== "focus-fill")) expect(nested[name]).toBe(inside[name]);
        const boxes = () =>
          page.locator("#controls :is(button, input, [role='tab'], [role='slider'])").evaluateAll((nodes) =>
            nodes.map((node) => {
              const { x, y, width, height } = node.getBoundingClientRect();
              return { x, y, width, height };
            }),
          );
        const scopedBoxes = await boxes();
        await page.locator("#scope").evaluate((node) => node.removeAttribute("data-k2b-primary"));
        await settled(page);
        expect(await boxes()).toEqual(scopedBoxes);
        await page.locator("#scope").evaluate((node) => node.setAttribute("data-k2b-primary", "ai"));
        await settled(page);
        expect(await boxes()).toEqual(scopedBoxes);
        expect(await page.locator("[data-demo-section]").count()).toBe(10);
        // Prove the detector rejects a hard-coded, translucent blue focus ring.
        await page.locator("#portal-trigger").focus();
        await settled(page);
        await page
          .locator("#portal-trigger")
          .evaluate((node) => (node.style.outline = "2px solid color-mix(in srgb, #2563eb 50%, transparent)"));
        await settled(page);
        expect((await page.evaluate(auditPrimaryColors, "#portal-trigger")).some((leak) => leak.includes("outline-color"))).toBe(true);
        await page.locator("#portal-trigger").evaluate((node) => node.style.removeProperty("outline"));
        await page.locator("#evidence").scrollIntoViewIfNeeded();

        const primary = page.locator("#controls").getByRole("button", { name: "Save notes", exact: true });
        await settled(page);
        const primaryPaint = await primary.evaluate((node) => ({
          fill: getComputedStyle(node).backgroundColor,
          text: getComputedStyle(node).color,
        }));
        expect(primaryPaint).toEqual({ fill: theme === "light" ? "rgb(142, 27, 111)" : "rgb(183, 64, 143)", text: "rgb(255, 255, 255)" });
        const primaryBox = await primary.boundingBox();
        await primary.hover();
        await settled(page);
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
        const scopedOpen = page.locator("#controls").getByRole("button", { name: "Save notes", exact: true });
        const outsideOpen = page.locator("#outside-action");
        for (const [first, second, firstAction, secondAction] of [
          [outsideOpen, scopedOpen, before.action, expectedAction],
          [scopedOpen, outsideOpen, expectedAction, before.action],
        ] as const) {
          await first.evaluate((node) => {
            if (node instanceof HTMLElement) node.click();
          });
          await page.locator("dialog[open]").waitFor();
          expect((await palette(page, "dialog[open]")).action).toBe(firstAction);
          const element = await page.locator("dialog[open]").elementHandle();
          // Dispatch from the other source while the shared dialog is connected.
          await second.evaluate((node) => {
            if (node instanceof HTMLElement) node.click();
          });
          expect(await page.locator("dialog[open]").evaluate((node, original) => node === original, element)).toBe(true);
          expect((await palette(page, "dialog[open]")).action).toBe(secondAction);
          await page.keyboard.press("Escape");
          await settled(page);
          expect((await palette(page, "dialog[open]")).action).toBe(firstAction);
          await page.keyboard.press("Escape");
          await settled(page);
          await page.locator("dialog[open]").waitFor({ state: "detached" });
          await element?.dispose();
        }
        const scopedToast = page.locator("#controls").getByRole("button", { name: "Show notification", exact: true });
        for (const order of [
          [page.locator("#outside-toast"), scopedToast],
          [scopedToast, page.locator("#outside-toast")],
        ]) {
          for (const source of order) await source.click();
          expect(await page.locator("#k2b-ui-toast-container").count()).toBe(1);
          expect((await palette(page, '.k2b-toast:has-text("Outside toast")')).action).toBe(before.action);
          expect((await palette(page, '.k2b-toast:has-text("Scoped suggestions are ready.")')).action).toBe(expectedAction);
          expect(await page.evaluate(auditPrimaryColors, '.k2b-toast[data-k2b-primary="ai"], .k2b-toast[data-k2b-primary="ai"] *')).toEqual(
            [],
          );
          for (const close of await page.locator(".k2b-toast button").all()) await close.click();
          await page.waitForFunction(() => !document.querySelector(".k2b-toast"));
        }
        await page.locator("#outside-action").focus();
        await page.locator("#portal-trigger").click();
        await settled(page);
        expect(await palette(page, "#portal-popover")).toEqual(inside);
        expect(await page.locator("#portal-popover").evaluate((node) => node.closest("#scope"))).toBeNull();
        await page.keyboard.press("Escape");
        await settled(page);
        await page.locator("#controls").getByRole("button", { name: "More actions", exact: true }).click();
        await settled(page);
        const menu = page.locator("#controls [popover]");
        expect(await menu.evaluate((node) => node.matches(":popover-open"))).toBe(true);
        expect((await palette(page, "#controls [popover]")).action).toBe(expectedAction);
        await page.keyboard.press("Escape");
        await settled(page);
        await page.locator("#scope").evaluate((node, theme) => {
          node.classList.add("k2b-ui");
          node.setAttribute("data-theme", theme);
          node.style.transform = "translateZ(0)";
        }, theme);
        await page.locator("#controls [aria-label='Note menu']").click({ button: "right" });
        await settled(page);
        expect((await palette(page, ".k2b-context-menu")).action).toBe(expectedAction);
        expect(await page.locator(".k2b-context-menu").evaluate((node) => getComputedStyle(node).position)).toBe("fixed");
        expect(await page.locator(".k2b-context-menu").evaluate((node) => node.closest("#scope"))).toBeNull();
        await page.keyboard.press("Escape");
        await settled(page);
        await page.locator("#controls [aria-label='Note menu']").click({ button: "right" });
        await page.getByRole("menuitem", { name: "Select note", exact: true }).click();
        await page.locator("dialog[open]").waitFor();
        expect(await page.locator(".k2b-context-menu").count()).toBe(0);
        expect((await palette(page, "dialog[open]")).action).toBe(expectedAction);
        await page.keyboard.press("Escape");
        await settled(page);
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
        await settled(page);
        const tab = page.locator("#panes [role='tab']").first();
        await tab.scrollIntoViewIfNeeded();
        await settled(page);
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
        await settled(page);
        await page.mouse.up();
        await ghost.waitFor({ state: "detached" });
        // The same attribute also works directly on a theme root (the docs demo).
        await page.locator("#scope").evaluate((node, theme) => {
          node.classList.add("k2b-ui");
          node.setAttribute("data-theme", theme);
        }, theme);
        await settled(page);
        expect(await palette(page, "#scope")).toEqual(inside);
        expect(await palette(page, "#outside")).toEqual(before);
        expect(errors).toEqual([]);
      }, 30_000);
      for (const section of ["ai", "input", "actions", "layout", "surfaces", "feedback", "content", "widgets", "cloud", "charts"]) {
        test(`${section}: every demo and keyboard focus follows the scope`, async () => {
          const area = `[data-demo-section="${section}"] .ui-demo-card__preview`;
          await page.evaluate((section) => document.dispatchEvent(new CustomEvent("primary-scope-demo", { detail: section })), section);
          await page.locator(area).first().waitFor();
          await settled(page);
          expect(await page.evaluate(auditPrimaryColors, `${area}, ${area} *`)).toEqual([]);
          // Every tabbable receives a real Tab transition, including offscreen demos.
          const tabbables = await page
            .locator(`${area} :is(button,a[href],input,select,textarea,[tabindex],[contenteditable])`)
            .evaluateAll((nodes) => {
              return nodes
                .filter(
                  (node) =>
                    node instanceof HTMLElement &&
                    !node.matches(":disabled,[inert] *") &&
                    node.getClientRects().length &&
                    getComputedStyle(node).visibility === "visible",
                )
                .map((node, index) => {
                  node.setAttribute("data-primary-focus-probe", String(index));
                  return String(index);
                });
            });
          for (const id of tabbables) {
            const target = page.locator(`[data-primary-focus-probe="${id}"]`);
            await target.evaluate((node) => {
              const sentinel = document.createElement("button");
              sentinel.id = "primary-tab-sentinel";
              sentinel.onkeydown = (event) => event.stopPropagation();
              sentinel.style.cssText = "position:fixed;width:1px;height:1px;opacity:0";
              node.setAttribute("data-primary-original-tabindex", node.getAttribute("tabindex") ?? "absent");
              if (node instanceof HTMLElement) node.tabIndex = 0;
              node.before(sentinel);
              sentinel.focus();
            });
            await page.keyboard.press("Tab");
            await settled(page);
            await page.locator("#primary-tab-sentinel").evaluate((node) => node.remove());
            expect(await target.evaluate((node) => node === document.activeElement)).toBe(true);
            expect(
              await page.evaluate(
                auditPrimaryColors,
                `[data-primary-focus-probe="${id}"], [data-primary-focus-probe="${id}"] *, #catalog .ui-demo-card__preview :focus-within, #catalog .ui-demo-card__preview :focus-within > *`,
              ),
            ).toEqual([]);
            await target.evaluate((node) => {
              const original = node.getAttribute("data-primary-original-tabindex");
              if (original === "absent") node.removeAttribute("tabindex");
              else if (original !== null) node.setAttribute("tabindex", original);
              node.removeAttribute("data-primary-focus-probe");
            });
          }
        }, 30_000);
      }
    });
  }
}
