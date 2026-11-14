import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";

// On a phone a prompt rises from the bottom edge as a sheet with the sheet's own motion; from 48rem it stays the
// dialog in the middle. Where the frame sits and how it moves need a real engine.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "prompt-sheet.fixture.ts");
const fixture = `
import { prompts } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
window.prompts = prompts;
window.results = [];
window.ask = (kind, options) => {
  const open = {
    confirm: () => prompts.confirm("The file stays in the trash for 30 days.", { title: "Delete the offer?", confirmText: "Delete", variant: "danger", ...options }),
    phrase: () => prompts.confirm("This cannot be undone.", { title: "Delete the space?", confirmationPhrase: "Summer party", ...options }),
    alert: () => prompts.alert("The share went to Team Logistics.", { title: "Shared", ...options }),
    form: () => prompts.form({ title: "Rename folder", fields: { name: { type: "text", label: "Name", default: "Summer party" } }, ...options }),
  }[kind];
  void open().then((value) => window.results.push(value === undefined ? "dismissed" : value));
};
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the prompt sheet fixture.");
const script = await build.outputs[0]!.text();

type PromptWindow = Window & { ask: (kind: string, options?: Record<string, unknown>) => void; results: unknown[] };
const phone: BrowserContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const desktop: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (options: BrowserContextOptions, theme = "light"): Promise<Page> => {
  const tab = await (await browser.newContext({ reducedMotion: "reduce", ...options })).newPage();
  tab.setDefaultTimeout(10_000);
  await tab.setContent(
    `<!doctype html><html class="${theme === "dark" ? "dark" : ""}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="k2b-ui" data-theme="${theme}"><button id="opener">Delete</button></body></html>`,
  );
  await tab.addScriptTag({ content: script });
  return tab;
};
const ask = async (tab: Page, kind: string, options?: Record<string, unknown>) => {
  await tab.evaluate(([kind, options]) => (window as unknown as PromptWindow).ask(kind as string, options as Record<string, unknown>), [
    kind,
    options,
  ] as const);
  await tab.locator("dialog[open]").waitFor();
  await settled(tab);
};
const results = (tab: Page) => tab.evaluate(() => (window as unknown as PromptWindow).results);
/** The frame's place and look. */
const frame = (tab: Page) =>
  tab.evaluate(() => {
    const dialog = document.querySelector<HTMLElement>("dialog[open]")!;
    const box = dialog.getBoundingClientRect();
    return {
      sheet: dialog.classList.contains("k2b-bottom-sheet-frame"),
      handle: dialog.querySelector(".k2b-bottom-sheet__handle") !== null,
      left: Math.round(box.left),
      width: Math.round(box.width),
      bottom: Math.round(box.bottom),
      viewport: innerHeight,
      blur: getComputedStyle(dialog, "::backdrop").backdropFilter,
      focus: document.activeElement?.className ?? "",
    };
  });

test("on a phone a confirmation rises from the bottom edge as a sheet, without blur, and its buttons still answer", async () => {
  const tab = await open(phone);
  try {
    await ask(tab, "confirm");
    const place = await frame(tab);
    expect(place).toMatchObject({ sheet: true, handle: true, left: 0, width: 390, bottom: 844, blur: "none" });
    // The handle is no programmatic focus target: no ring on a phone.
    expect(place.focus).not.toContain("k2b-bottom-sheet__handle");
    await tab.getByRole("button", { name: "Delete" }).last().tap();
    await tab.waitForFunction(() => (window as unknown as PromptWindow).results.length === 1);
    expect(await results(tab)).toEqual([true]);
  } finally {
    await tab.context().close();
  }
});

test("the handle and Escape dismiss a phone prompt the way Escape always did", async () => {
  const tab = await open(phone);
  try {
    await ask(tab, "alert");
    await tab.locator(".k2b-bottom-sheet__handle").tap();
    await tab.waitForFunction(() => (window as unknown as PromptWindow).results.length === 1);
    await ask(tab, "confirm");
    await tab.keyboard.press("Escape");
    await tab.waitForFunction(() => (window as unknown as PromptWindow).results.length === 2);
    expect(await results(tab)).toEqual(["dismissed", "dismissed"]);
    // A prompt that must be answered keeps its sheet: the handle cannot dismiss it.
    await ask(tab, "confirm", { cancelBehavior: "ignore" });
    expect(await tab.locator(".k2b-bottom-sheet__handle").isDisabled()).toBe(true);
  } finally {
    await tab.context().close();
  }
});

test("a phone sheet slides in by transform, and with reduced motion it is in place at once", async () => {
  const moving = await open({ ...phone, reducedMotion: "no-preference" });
  try {
    await moving.evaluate(() => (window as unknown as PromptWindow).ask("confirm"));
    await moving.locator("dialog[open]").waitFor();
    // settled: the first frames of the slide are the subject.
    const first = await moving.evaluate(() => {
      const dialog = document.querySelector<HTMLElement>("dialog[open]")!;
      return { motion: dialog.hasAttribute("data-sheet-motion"), height: dialog.offsetHeight, top: dialog.getBoundingClientRect().top };
    });
    expect(first.motion).toBe(true);
    await settled(moving);
    const rest = await moving.evaluate(() => {
      const dialog = document.querySelector<HTMLElement>("dialog[open]")!;
      return { height: dialog.offsetHeight, top: dialog.getBoundingClientRect().top };
    });
    // It slid up into place with one layout height.
    expect(rest.height).toBe(first.height);
    expect(rest.top).toBeLessThanOrEqual(first.top);
  } finally {
    await moving.context().close();
  }
  const still = await open(phone);
  try {
    await still.evaluate(() => (window as unknown as PromptWindow).ask("confirm"));
    await still.locator("dialog[open]").waitFor();
    // settled: with reduced motion the first frame is already the rest.
    const first = await frame(still);
    expect(first.bottom).toBe(844);
    expect(
      await still.evaluate(() => document.getAnimations().filter((animation) => animation.timeline === document.timeline).length),
    ).toBe(0);
  } finally {
    await still.context().close();
  }
});

test("a form on a phone focuses its first field, and a typed confirmation its phrase", async () => {
  const tab = await open(phone);
  try {
    await ask(tab, "form");
    expect(await tab.evaluate(() => (document.activeElement as HTMLInputElement | null)?.value)).toBe("Summer party");
    expect((await frame(tab)).bottom).toBe(844);
    await tab.keyboard.press("Escape");
    await tab.waitForFunction(() => (window as unknown as PromptWindow).results.length === 1);
    await ask(tab, "phrase");
    expect(await tab.evaluate(() => document.activeElement?.getAttribute("autocomplete"))).toBe("off");
  } finally {
    await tab.context().close();
  }
});

test("from 48rem, and for a full-screen or bare prompt, the prompt keeps its dialog frame", async () => {
  const tab = await open(desktop);
  try {
    await ask(tab, "confirm");
    const place = await frame(tab);
    expect(place).toMatchObject({ sheet: false, handle: false });
    expect(Math.abs(place.left + place.width / 2 - 720)).toBeLessThanOrEqual(1);
  } finally {
    await tab.context().close();
  }
  const small = await open(phone);
  try {
    await ask(small, "alert", { size: "full" });
    expect(await frame(small)).toMatchObject({ sheet: false, handle: false });
  } finally {
    await small.context().close();
  }
});

test("in dark mode the phone sheet keeps the dialog's surface behind its panel", async () => {
  const tab = await open({ ...phone, colorScheme: "dark" }, "dark");
  try {
    await ask(tab, "confirm", { variant: undefined });
    const colours = await tab.evaluate(() => {
      const dialog = document.querySelector<HTMLElement>("dialog[open]")!;
      const panel = dialog.querySelector<HTMLElement>(".k2b-dialog__panel")!;
      return { frame: getComputedStyle(dialog).backgroundColor, panel: getComputedStyle(panel).backgroundColor };
    });
    expect(colours.panel === colours.frame || colours.panel === "rgba(0, 0, 0, 0)").toBe(true);
  } finally {
    await tab.context().close();
  }
});
