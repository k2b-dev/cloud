import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type axeCore from "axe-core";
import type { Browser, BrowserContextOptions, Locator } from "playwright";
import { launchBrowser } from "../../test/browser";

declare global {
  interface Window {
    axe?: typeof axeCore;
  }
}

const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const axeSource = readFileSync(Bun.resolveSync("axe-core/axe.min.js", import.meta.dir), "utf8");
const entry = resolve(import.meta.dir, "rich-select.fixture.ts");
const fixture = `
import { createComponent, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { RichSelect, RichSelectFacts } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const items = [
  { value: "review", label: "Marketing · Review", description: "2 tags are dropped", color: "#8b5cf6" },
  { value: "print", label: "Print orders · Inbox", description: "A guest can see it, one assignee is dropped", color: "#f97316" },
  { value: "archive", label: "Archive · Done", description: "Nothing is dropped", icon: "ti ti-archive" },
  { value: "support", label: "Support · Backlog", disabledReason: "No write access", color: "#0ea5e9" },
];
const facts = {
  review: ["Visible to 8 members", "The tags Print and Q4 are dropped", "Comments and attachments move along"],
  print: ["A guest can see this card", "One assignee is dropped", "The tags Print and Q4 are dropped"],
  archive: ["Nothing is dropped"],
  support: ["Ask a Support manager for write access before moving this card."],
};
const [value, setValue] = createSignal(null);
const [targets, setTargets] = createSignal(items);
const [status, setStatus] = createSignal("ready");
const [disabled, setDisabled] = createSignal(false);
document.addEventListener("fixture:state", (event) => {
  const next = event.detail;
  if (next === "revoke") setTargets(items.map(item => item.value === "review" ? { ...item, disabledReason: "No write access" } : item));
  if (next === "remove") setTargets(items.filter(item => item.value !== "review"));
  if (next === "empty") { setTargets([]); setStatus("ready"); }
  if (next === "error" || next === "loading") setStatus(next);
  if (next === "disable") setDisabled(true);
  if (next === "revoke-on-choose") {
    const revoke = (event) => {
      if (!event.target.closest(".k2b-rich-select__choose")) return;
      document.removeEventListener("click", revoke, true);
      queueMicrotask(() => setTargets(items.map(item => ({ ...item, disabledReason: "No write access" }))));
    };
    document.addEventListener("click", revoke, true);
  }
});
const form = document.createElement("form");
form.addEventListener("submit", (event) => { event.preventDefault(); form.dataset.submitted = "true"; });
document.getElementById("app").append(form);
render(() => createComponent(RichSelect, {
  label: "Move card", title: "Move card", placeholder: "Move to …", value,
  onValueChange: setValue, get items() { return targets(); }, get status() { return status(); }, get disabled() { return disabled(); },
  onRetry: () => setStatus("ready"),
  footer: { label: "New target", create: { placeholder: "Target name", onCreate: (name) => { form.dataset.created = name; } } },
  renderPreview: (item) => createComponent(RichSelectFacts, { facts: facts[item.value].map(text => ({ icon: "ti ti-info-circle", text })) }),
}), form);
const many = Array.from({ length: 10 }, (_, index) => ({
  value: "target-" + index,
  label: "Target " + index + (index % 3 === 0 ? " · a destination name long enough to wrap onto a second line" : ""),
  description: index % 2 === 0 ? "A consequence that is long enough to wrap onto a second line in the list" : "Nothing is dropped",
  section: index < 4 ? "recent" : "more",
}));
const second = document.createElement("div");
document.getElementById("app").append(second);
render(() => createComponent(RichSelect, {
  label: "Many targets", value: null, onValueChange: () => {}, items: many,
  sections: [{ id: "recent", label: "Recent" }, { id: "more", label: "More" }],
  renderPreview: (item) => item.label,
}), second);
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the RichSelect browser fixture.");
const script = await build.outputs[0]!.text();
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  browser = await launchBrowser();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(
        `<!doctype html><html lang="en"><head><title>Rich selection fixture</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="k2b-ui"><main id="app" style="padding:32px"></main></body></html>`,
        { headers: { "content-type": "text/html" } },
      ),
  });
}, 30_000);
afterAll(async () => {
  await browser?.close();
  await server?.stop(true);
});
const open = async (options: BrowserContextOptions) => {
  const context = await browser.newContext(options);
  try {
    const page = await context.newPage();
    await page.goto(server.url.href);
    await page.addScriptTag({ content: script });
    return { page, close: () => context.close() };
  } catch (error) {
    await context.close();
    throw error;
  }
};
const box = async (locator: Locator) => {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error("Expected visible geometry");
  return bounds;
};

describe("RichSelect shipped browser contract", () => {
  for (const width of [1440, 1024, 390]) {
    for (const theme of ["light", "dark"]) {
      test(`ready, loading, error and empty states remain accessible (${width}px, ${theme})`, async () => {
        const { page, close } = await open({ viewport: { width, height: 900 }, isMobile: width === 390, hasTouch: width === 390 });
        try {
          await page.locator("body").evaluate((element, value) => element.setAttribute("data-theme", value), theme);
          await page.addScriptTag({ content: axeSource });
          await page.getByRole("combobox", { name: "Move card" }).click();
          for (const state of ["ready", "loading", "error", "empty"]) {
            if (state !== "ready")
              await page.evaluate((value) => document.dispatchEvent(new CustomEvent("fixture:state", { detail: value })), state);
            const violations = await page.evaluate(async () => {
              const result = await window.axe!.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } });
              return result.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(({ target }) => target) }));
            });
            expect(violations, state).toEqual([]);
          }
        } finally {
          await close();
        }
      }, 20_000);
    }
  }

  test("desktop preview, list, popover and trigger never move while keys and hover change the active row", async () => {
    const { page, close } = await open({ viewport: { width: 1440, height: 900 } });
    try {
      const trigger = page.getByRole("combobox", { name: "Move card" });
      const triggerBefore = await box(trigger);
      await trigger.click();
      const popover = page.locator(".k2b-rich-select__popover:popover-open");
      await popover.waitFor({ state: "visible" });
      // Positioning and the ResizeObserver run after the open handler.
      await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
      const list = page.getByRole("listbox");
      const preview = popover.locator(".k2b-rich-select__preview");
      const initial = [await box(popover), await box(list), await box(preview)];
      const labels = await page.getByRole("option").locator(".k2b-rich-select__label").allTextContents();
      const unchanged = async (label: string) => {
        expect(await preview.locator(".k2b-rich-select__preview-title").innerText()).toBe(label);
        // Exact equality: no tolerance, every x/y/width/height delta must be 0 px.
        expect([await box(popover), await box(list), await box(preview)]).toEqual(initial);
        expect(await box(trigger)).toEqual(triggerBefore);
      };
      await unchanged(labels[0]!);
      for (let index = 1; index <= labels.length; index++) {
        await page.keyboard.press("ArrowDown");
        await unchanged(labels[index % labels.length]!);
      }
      for (let index = labels.length - 1; index >= 0; index--) {
        await page.getByRole("option").nth(index).hover();
        await unchanged(labels[index]!);
      }
      await page.keyboard.press("Escape");
      expect(await trigger.getAttribute("aria-expanded")).toBe("false");
      expect(await trigger.evaluate((element) => document.activeElement === element)).toBe(true);
      expect(await box(trigger)).toEqual(triggerBefore);
    } finally {
      await close();
    }
  });

  test("wrapped rows in a scrolling list keep their full height and never overlap", async () => {
    const { page, close } = await open({ viewport: { width: 1440, height: 900 } });
    try {
      await page.getByRole("combobox", { name: "Many targets" }).click();
      const popover = page.locator(".k2b-rich-select__popover:popover-open");
      await popover.waitFor({ state: "visible" });
      const rows = await popover.locator('[role="option"]').evaluateAll((elements) =>
        elements.map((element) => {
          const rect = element.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom, height: rect.height, content: element.scrollHeight };
        }),
      );
      expect(rows).toHaveLength(10);
      for (const [index, row] of rows.entries()) {
        // A squeezed flex row is shorter than its content and overlaps the next one.
        expect(row.height).toBeGreaterThanOrEqual(row.content);
        if (index > 0) expect(row.top).toBeGreaterThanOrEqual(rows[index - 1]!.bottom);
      }
    } finally {
      await close();
    }
  });

  test("phone exposes disabled details, restores info focus with Back/Escape, then commits an enabled choice", async () => {
    const { page, close } = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    try {
      const trigger = page.getByRole("combobox", { name: "Move card" });
      await trigger.tap();
      const sheet = page.locator("dialog[open]");
      await sheet.waitFor({ state: "visible" });
      expect(await sheet.getByRole("list").getAttribute("aria-label")).toBe("Move card");
      const unavailable = sheet.getByRole("button", { name: "Support · Backlog", exact: true });
      expect(await unavailable.getAttribute("aria-disabled")).toBe("true");
      const description = await unavailable.getAttribute("aria-describedby");
      expect(await sheet.locator(`[id="${description}"]`).innerText()).toBe("No write access");
      const info = sheet.getByRole("button", { name: "Details: Support · Backlog", exact: true });
      await info.tap();
      expect(await sheet.getByRole("heading", { name: "Support · Backlog", exact: true }).count()).toBe(1);
      expect(await page.getByRole("dialog", { name: "Support · Backlog", exact: true }).count()).toBe(1);
      expect(await sheet.locator(".k2b-rich-select__facts").innerText()).toContain("Ask a Support manager for write access");
      expect(await sheet.getByRole("button", { name: "Choose", exact: true }).isDisabled()).toBe(true);
      await sheet.getByRole("button", { name: "Back", exact: true }).tap();
      expect(await info.evaluate((element) => element === document.activeElement)).toBe(true);
      await info.tap();
      await page.keyboard.press("Escape");
      expect(await sheet.isVisible()).toBe(true);
      expect(await info.evaluate((element) => element === document.activeElement)).toBe(true);
      await sheet.getByRole("button", { name: "Details: Marketing · Review", exact: true }).tap();
      expect(await sheet.getByRole("button", { name: "Choose", exact: true }).isEnabled()).toBe(true);
      await sheet.getByRole("button", { name: "Choose", exact: true }).tap();
      await sheet.waitFor({ state: "hidden" });
      await page.waitForFunction(() => document.querySelector('[role="combobox"]')?.getAttribute("aria-expanded") === "false");
      expect(await trigger.innerText()).toContain("Marketing · Review");
      expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(true);
    } finally {
      await close();
    }
  });

  test("phone details follow current access and removal instead of committing an old snapshot", async () => {
    const { page, close } = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    try {
      const trigger = page.getByRole("combobox", { name: "Move card" });
      await trigger.tap();
      const sheet = page.getByRole("dialog");
      expect(await trigger.getAttribute("aria-haspopup")).toBe("dialog");
      expect(await trigger.getAttribute("aria-controls")).toBe(await sheet.getAttribute("id"));
      await sheet.getByRole("button", { name: "Details: Marketing · Review", exact: true }).tap();
      const choose = sheet.getByRole("button", { name: "Choose", exact: true });
      expect(await choose.isEnabled()).toBe(true);
      await page.evaluate(() => document.dispatchEvent(new CustomEvent("fixture:state", { detail: "revoke" })));
      expect(await choose.isDisabled()).toBe(true);
      await page.evaluate(() => document.dispatchEvent(new CustomEvent("fixture:state", { detail: "remove" })));
      await sheet.getByRole("list").waitFor({ state: "visible" });
      expect(await sheet.getByRole("button", { name: "Marketing · Review", exact: true }).count()).toBe(0);
      expect(await sheet.evaluate((element) => element.contains(document.activeElement))).toBe(true);
      expect(
        await sheet
          .locator(".k2b-rich-select__sheet-row > button")
          .first()
          .evaluate((element) => element === document.activeElement),
      ).toBe(true);
      expect(await trigger.innerText()).toContain("Move to");
      await page.evaluate(() => document.dispatchEvent(new CustomEvent("fixture:state", { detail: "disable" })));
      await sheet.waitFor({ state: "hidden" });
      expect(await trigger.isDisabled()).toBe(true);
    } finally {
      await close();
    }
  });

  test("phone selection rechecks access after returning through dialog history", async () => {
    const { page, close } = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    try {
      const trigger = page.getByRole("combobox", { name: "Move card" });
      await trigger.tap();
      const sheet = page.getByRole("dialog");
      await sheet.getByRole("button", { name: "Details: Marketing · Review", exact: true }).tap();
      await page.evaluate(() => document.dispatchEvent(new CustomEvent("fixture:state", { detail: "revoke-on-choose" })));
      await sheet.getByRole("button", { name: "Choose", exact: true }).tap();
      await page.waitForFunction(() => document.querySelector('[role="combobox"]')?.getAttribute("aria-expanded") === "false");
      expect(await trigger.innerText()).toContain("Move to");
    } finally {
      await close();
    }
  });

  test("Retry supports Enter and Create from an empty list never submits the surrounding form", async () => {
    const { page, close } = await open({ viewport: { width: 1024, height: 900 } });
    try {
      await page.evaluate(() => document.dispatchEvent(new CustomEvent("fixture:state", { detail: "error" })));
      await page.getByRole("combobox", { name: "Move card" }).click();
      const retry = page.getByRole("button", { name: "Retry", exact: true });
      await retry.focus();
      await page.keyboard.press("Enter");
      await page.getByRole("listbox").waitFor({ state: "visible" });
      const trigger = page.getByRole("combobox", { name: "Move card" });
      expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(true);
      await page.keyboard.press("Enter");
      expect(await trigger.innerText()).toContain("Marketing · Review");
      await trigger.click();
      await page.evaluate(() => document.dispatchEvent(new CustomEvent("fixture:state", { detail: "empty" })));
      await page.getByRole("button", { name: "New target", exact: true }).click();
      await page.getByRole("textbox", { name: "New target", exact: true }).fill("  New campaign  ");
      await page.keyboard.press("Enter");
      expect(await page.locator("form").getAttribute("data-created")).toBe("New campaign");
      expect(await page.locator("form").getAttribute("data-submitted")).toBeNull();
    } finally {
      await close();
    }
  });
});
