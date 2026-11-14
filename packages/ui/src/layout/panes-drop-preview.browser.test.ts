import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser, settled } from "../../test/browser";

// The drop previews shown while a pane tab is dragged are a finished design (Valentin, 13.11.2026): every
// redesign of Panes leaves them exactly as they are. This test pins what a person sees while dragging: which
// targets appear, where they sit relative to their pane or tab, their colours at rest and under the pointer,
// and the floating tab that follows the pointer. The expected values were measured on the version before the
// arrangement redesign; a change here is a change to the drop previews and needs the maintainer's approval.

const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "panes-drop-preview.fixture.ts");
const source = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { LocaleProvider, Panes } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const [layout, setLayout] = createSignal({
  version: 2,
  root: {
    type: "split", direction: "horizontal", ratio: 0.5,
    first: { type: "group", items: ["draft"], active: "draft" },
    second: { type: "split", direction: "vertical", ratio: 0.5,
      first: { type: "group", items: ["history", "notes"], active: "history" },
      second: { type: "group", items: ["preview"], active: "preview" } },
  },
});
window.layout = layout;
const pane = (id, title, icon) => ({ id, title, icon, render: () => { const el = document.createElement("div"); el.className = "pane-body"; el.textContent = title; return el; } });
render(() => createComponent(LocaleProvider, { locale: "en", get children() {
  return createComponent(Panes, {
    get layout() { return layout(); },
    onLayoutChange: setLayout,
    // An open one-time hint must never cover a drop target or the floating tab while dragging.
    arrangeHint: { open: true, onDismiss: () => {} },
    items: [pane("draft", "Draft", "ti-pencil"), pane("history", "History", "ti-history"), pane("notes", "Notes", "ti-notes"), pane("preview", "Preview", "ti-eye")],
  });
} }), document.getElementById("app"));
`;
const build = await Bun.build({
  entrypoints: [entry],
  files: { [entry]: source },
  target: "browser",
  conditions: ["browser"],
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the Panes drop preview fixture.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async () => {
  const context = await browser.newContext({ viewport: { width: 1200, height: 760 } });
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html lang="en"><head><style>${css}</style><style>
    body { margin: 0; } #app { width: 1200px; height: 760px; display: flex; } .pane-body { padding: 1rem; }
    </style></head><body class="k2b-ui"><div id="app"></div></body></html>`);
  await page.addScriptTag({ content: script });
  await page.locator(".k2b-panes__tab-button").first().waitFor();
  return { page, context };
};

const center = async (page: Page, selector: string) => {
  const box = (await page.locator(selector).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

/** Every visible drop target, placed relative to the pane or tab that owns it. */
const measureTargets = (page: Page) =>
  page.evaluate(() => {
    const round = (value: number) => Math.round(value * 10) / 10;
    return Array.from(document.querySelectorAll<HTMLElement>(".k2b-panes__drop-target")).map((target) => {
      const owner = target.closest<HTMLElement>(".k2b-panes__tab") ?? target.closest<HTMLElement>(".k2b-panes__group")!;
      const ownerRect = owner.getBoundingClientRect();
      const rect = target.getBoundingClientRect();
      const style = getComputedStyle(target);
      return {
        kind: target.dataset.kind,
        placement: target.dataset.placement,
        zone: target.dataset.zone ?? null,
        active: target.dataset.active === "true",
        owner: owner.classList.contains("k2b-panes__tab")
          ? `tab:${owner.querySelector(".k2b-panes__tab-button")?.getAttribute("aria-label")}`
          : `group:${owner.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute("aria-label")}`,
        left: target.dataset.placement === "tab-end" ? null : round(rect.left - ownerRect.left),
        top: round(rect.top - ownerRect.top),
        width: round(rect.width),
        height: round(rect.height),
        right: target.dataset.placement === "body" ? round(ownerRect.right - rect.right) : null,
        bottom: target.dataset.placement === "body" ? round(ownerRect.bottom - rect.bottom) : null,
        text: target.textContent?.trim() ?? "",
        icon: target.querySelector("i")?.className ?? null,
        color: style.color,
        background: style.backgroundColor,
        clipPath: style.clipPath,
        radius: style.borderRadius,
        font: `${style.fontSize} ${style.fontWeight}`,
        // Nothing paints over a target: the topmost element at its centre is the target or its content.
        onTop: (() => {
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          return !!hit && target.contains(hit);
        })(),
      };
    });
  });

const measurePreview = (page: Page) =>
  page.evaluate(() => {
    const preview = Array.from(document.querySelectorAll<HTMLElement>(".k2b-panes__drag-preview")).find(
      (element) => element.getAttribute("aria-hidden") === "true",
    );
    if (!preview) return null;
    const rect = preview.getBoundingClientRect();
    const style = getComputedStyle(preview);
    return {
      text: preview.textContent?.trim(),
      icons: Array.from(preview.querySelectorAll("i")).map((icon) => icon.className),
      height: Math.round(rect.height * 10) / 10,
      padding: style.padding,
      border: `${style.borderTopWidth} ${style.borderTopStyle} ${style.borderTopColor}`,
      radius: style.borderRadius,
      background: style.backgroundColor,
      shadow: style.boxShadow,
      font: `${style.fontSize} ${style.fontWeight}`,
      opacity: style.opacity,
    };
  });

describe(`Panes drop previews in ${browserName}`, () => {
  test("dragging a tab shows the same targets, places, colours and floating tab as before the redesign", async () => {
    const { page, context } = await open();
    try {
      await page.locator(".k2b-moved-hint").waitFor();
      const start = await center(page, '.k2b-panes__tab-button[aria-label="History"]');
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(start.x + 6, start.y + 6, { steps: 2 });
      await page.mouse.move(start.x + 40, start.y + 40, { steps: 4 });
      await page.locator(".k2b-panes__drop-target").first().waitFor();
      expect(await page.locator(".k2b-moved-hint").count()).toBe(0);

      // Over the middle of the draft pane: the "+" target there is active.
      const draftBody = (await page.locator(".k2b-panes__group").first().boundingBox())!;
      await page.mouse.move(draftBody.x + draftBody.width / 2, draftBody.y + draftBody.height / 2, { steps: 6 });
      await page.locator('.k2b-panes__drop-target[data-active="true"]').waitFor();
      await settled(page);
      const overGroup = await measureTargets(page);
      const preview = await measurePreview(page);

      // Over the left edge of the draft pane: the trapezoid there is active.
      await page.mouse.move(draftBody.x + 24, draftBody.y + draftBody.height / 2, { steps: 6 });
      await page.locator('.k2b-panes__drop-target[data-zone="left"][data-active="true"]').waitFor();
      await settled(page);
      const overEdge = (await measureTargets(page)).filter((target) => target.active);

      await page.keyboard.press("Escape");
      await page.mouse.up();

      expect({ overGroup, overEdge, preview }).toEqual(EXPECTED);
    } finally {
      await context.close();
    }
  }, 30_000);
});

// Measured on main before the redesign (Chromium); see the note at the top.
const EXPECTED = {
  overGroup: [
    {
      kind: "tab",
      placement: "tab",
      zone: null,
      active: false,
      owner: "tab:Draft",
      left: -12,
      top: 2,
      width: 24,
      height: 24,
      right: null,
      bottom: null,
      text: "",
      icon: "ti ti-spacing-horizontal",
      color: "rgb(4, 120, 87)",
      background: "color(srgb 0.92549 0.992157 0.960784 / 0.88)",
      clipPath: "none",
      radius: "8px",
      font: "11px 600",
      onTop: true,
    },
    {
      kind: "group",
      placement: "body",
      zone: null,
      active: true,
      owner: "group:Draft",
      left: 76,
      top: 108,
      width: 444,
      height: 576,
      right: 76,
      bottom: 76,
      text: "",
      icon: "ti ti-plus",
      color: "rgb(255, 255, 255)",
      background: "rgb(16, 185, 129)",
      clipPath: "none",
      radius: "6px",
      font: "16px 600",
      onTop: true,
    },
    {
      kind: "split",
      placement: "body",
      zone: "top",
      active: false,
      owner: "group:Draft",
      left: 20,
      top: 46,
      width: 556,
      height: 56,
      right: 20,
      bottom: 658,
      text: "Add top of Draft",
      icon: "ti ti-row-insert-top",
      color: "rgb(4, 120, 87)",
      background: "rgb(236, 253, 245)",
      clipPath: "polygon(round 6px, 0px 0px, 100% 0px, calc(100% - 56px) 100%, 56px 100%)",
      radius: "0px",
      font: "11px 600",
      onTop: true,
    },
    {
      kind: "split",
      placement: "body",
      zone: "right",
      active: false,
      owner: "group:Draft",
      left: 526,
      top: 52,
      width: 56,
      height: 688,
      right: 14,
      bottom: 20,
      text: "Add right of Draft",
      icon: "ti ti-column-insert-right",
      color: "rgb(4, 120, 87)",
      background: "rgb(236, 253, 245)",
      clipPath: "polygon(round 6px, 100% 0px, 0px 56px, 0px calc(100% - 56px), 100% 100%)",
      radius: "0px",
      font: "11px 600",
      onTop: true,
    },
    {
      kind: "split",
      placement: "body",
      zone: "bottom",
      active: false,
      owner: "group:Draft",
      left: 20,
      top: 690,
      width: 556,
      height: 56,
      right: 20,
      bottom: 14,
      text: "Add bottom of Draft",
      icon: "ti ti-row-insert-bottom",
      color: "rgb(4, 120, 87)",
      background: "rgb(236, 253, 245)",
      clipPath: "polygon(round 6px, 56px 0px, calc(100% - 56px) 0px, 100% 100%, 0px 100%)",
      radius: "0px",
      font: "11px 600",
      onTop: true,
    },
    {
      kind: "split",
      placement: "body",
      zone: "left",
      active: false,
      owner: "group:Draft",
      left: 14,
      top: 52,
      width: 56,
      height: 688,
      right: 526,
      bottom: 20,
      text: "Add left of Draft",
      icon: "ti ti-column-insert-left",
      color: "rgb(4, 120, 87)",
      background: "rgb(236, 253, 245)",
      clipPath: "polygon(round 6px, 0px 0px, 100% 56px, 100% calc(100% - 56px), 0px 100%)",
      radius: "0px",
      font: "11px 600",
      onTop: true,
    },
    {
      kind: "tab",
      placement: "tab-end",
      zone: null,
      active: false,
      owner: "group:History",
      left: null,
      top: 6,
      width: 24,
      height: 28,
      right: null,
      bottom: null,
      text: "",
      icon: null,
      color: "rgb(4, 120, 87)",
      background: "color(srgb 0.92549 0.992157 0.960784 / 0.88)",
      clipPath: "none",
      radius: "8px",
      font: "11px 600",
      onTop: true,
    },
    {
      kind: "split",
      placement: "body",
      zone: "top",
      active: false,
      owner: "group:History",
      left: 20,
      top: 46,
      width: 556,
      height: 56,
      right: 20,
      bottom: 274,
      text: "Add top of Notes",
      icon: "ti ti-row-insert-top",
      color: "rgb(4, 120, 87)",
      background: "rgb(236, 253, 245)",
      clipPath: "polygon(round 6px, 0px 0px, 100% 0px, calc(100% - 56px) 100%, 56px 100%)",
      radius: "0px",
      font: "11px 600",
      onTop: true,
    },
    {
      kind: "split",
      placement: "body",
      zone: "right",
      active: false,
      owner: "group:History",
      left: 526,
      top: 52,
      width: 56,
      height: 304,
      right: 14,
      bottom: 20,
      text: "Add right of Notes",
      icon: "ti ti-column-insert-right",
      color: "rgb(4, 120, 87)",
      background: "rgb(236, 253, 245)",
      clipPath: "polygon(round 6px, 100% 0px, 0px 56px, 0px calc(100% - 56px), 100% 100%)",
      radius: "0px",
      font: "11px 600",
      onTop: true,
    },
    {
      kind: "split",
      placement: "body",
      zone: "bottom",
      active: false,
      owner: "group:History",
      left: 20,
      top: 306,
      width: 556,
      height: 56,
      right: 20,
      bottom: 14,
      text: "Add bottom of Notes",
      icon: "ti ti-row-insert-bottom",
      color: "rgb(4, 120, 87)",
      background: "rgb(236, 253, 245)",
      clipPath: "polygon(round 6px, 56px 0px, calc(100% - 56px) 0px, 100% 100%, 0px 100%)",
      radius: "0px",
      font: "11px 600",
      onTop: true,
    },
    {
      kind: "split",
      placement: "body",
      zone: "left",
      active: false,
      owner: "group:History",
      left: 14,
      top: 52,
      width: 56,
      height: 304,
      right: 526,
      bottom: 20,
      text: "Add left of Notes",
      icon: "ti ti-column-insert-left",
      color: "rgb(4, 120, 87)",
      background: "rgb(236, 253, 245)",
      clipPath: "polygon(round 6px, 0px 0px, 100% 56px, 100% calc(100% - 56px), 0px 100%)",
      radius: "0px",
      font: "11px 600",
      onTop: true,
    },
    {
      kind: "tab",
      placement: "tab",
      zone: null,
      active: false,
      owner: "tab:Preview",
      left: -12,
      top: 2,
      width: 24,
      height: 24,
      right: null,
      bottom: null,
      text: "",
      icon: "ti ti-spacing-horizontal",
      color: "rgb(4, 120, 87)",
      background: "color(srgb 0.92549 0.992157 0.960784 / 0.88)",
      clipPath: "none",
      radius: "8px",
      font: "11px 600",
      onTop: true,
    },
    {
      kind: "group",
      placement: "body",
      zone: null,
      active: false,
      owner: "group:Preview",
      left: 76,
      top: 108,
      width: 444,
      height: 192,
      right: 76,
      bottom: 76,
      text: "",
      icon: "ti ti-plus",
      color: "rgb(4, 120, 87)",
      background: "rgb(236, 253, 245)",
      clipPath: "none",
      radius: "6px",
      font: "16px 600",
      onTop: true,
    },
    {
      kind: "split",
      placement: "body",
      zone: "top",
      active: false,
      owner: "group:Preview",
      left: 20,
      top: 46,
      width: 556,
      height: 56,
      right: 20,
      bottom: 274,
      text: "Add top of Preview",
      icon: "ti ti-row-insert-top",
      color: "rgb(4, 120, 87)",
      background: "rgb(236, 253, 245)",
      clipPath: "polygon(round 6px, 0px 0px, 100% 0px, calc(100% - 56px) 100%, 56px 100%)",
      radius: "0px",
      font: "11px 600",
      onTop: true,
    },
    {
      kind: "split",
      placement: "body",
      zone: "right",
      active: false,
      owner: "group:Preview",
      left: 526,
      top: 52,
      width: 56,
      height: 304,
      right: 14,
      bottom: 20,
      text: "Add right of Preview",
      icon: "ti ti-column-insert-right",
      color: "rgb(4, 120, 87)",
      background: "rgb(236, 253, 245)",
      clipPath: "polygon(round 6px, 100% 0px, 0px 56px, 0px calc(100% - 56px), 100% 100%)",
      radius: "0px",
      font: "11px 600",
      onTop: true,
    },
    {
      kind: "split",
      placement: "body",
      zone: "bottom",
      active: false,
      owner: "group:Preview",
      left: 20,
      top: 306,
      width: 556,
      height: 56,
      right: 20,
      bottom: 14,
      text: "Add bottom of Preview",
      icon: "ti ti-row-insert-bottom",
      color: "rgb(4, 120, 87)",
      background: "rgb(236, 253, 245)",
      clipPath: "polygon(round 6px, 56px 0px, calc(100% - 56px) 0px, 100% 100%, 0px 100%)",
      radius: "0px",
      font: "11px 600",
      onTop: true,
    },
    {
      kind: "split",
      placement: "body",
      zone: "left",
      active: false,
      owner: "group:Preview",
      left: 14,
      top: 52,
      width: 56,
      height: 304,
      right: 526,
      bottom: 20,
      text: "Add left of Preview",
      icon: "ti ti-column-insert-left",
      color: "rgb(4, 120, 87)",
      background: "rgb(236, 253, 245)",
      clipPath: "polygon(round 6px, 0px 0px, 100% 56px, 100% calc(100% - 56px), 0px 100%)",
      radius: "0px",
      font: "11px 600",
      onTop: true,
    },
  ],
  overEdge: [
    {
      kind: "split",
      placement: "body",
      zone: "left",
      active: true,
      owner: "group:Draft",
      left: 14,
      top: 52,
      width: 56,
      height: 688,
      right: 526,
      bottom: 20,
      text: "Add left of Draft",
      icon: "ti ti-column-insert-left",
      color: "rgb(255, 255, 255)",
      background: "rgb(16, 185, 129)",
      clipPath: "polygon(round 6px, 0px 0px, 100% 56px, 100% calc(100% - 56px), 0px 100%)",
      radius: "0px",
      font: "11px 600",
      onTop: true,
    },
  ],
  preview: {
    text: "History",
    icons: ["ti ti-history k2b-panes__icon"],
    height: 28,
    padding: "0px 10px",
    border: "1px solid rgb(228, 228, 231)",
    radius: "8px",
    background: "rgb(255, 255, 255)",
    shadow: "rgba(0, 0, 0, 0.28) 0px 12px 28px 0px",
    font: "12px 600",
    opacity: "0.92",
  },
};
