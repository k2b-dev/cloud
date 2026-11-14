import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../test/browser";

// The card's size across loading and loaded states, its focus and the phone sheet need real layout.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "person-popover.fixture.ts");
const fixture = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { PersonPopover } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const [anchor, setAnchor] = createSignal(null);
const [data, setData] = createSignal({});
window.calls = [];
window.setData = setData;
const trigger = document.getElementById("sender");
trigger.addEventListener("click", () => setAnchor(anchor() ? null : trigger));
const actions = [
  { label: "All messages from this sender", icon: "ti ti-search", onSelect: () => window.calls.push("search") },
  { label: "Open contact", icon: "ti ti-address-book", href: "#contact" },
  { label: "Block sender", icon: "ti ti-ban", onSelect: () => window.calls.push("block") },
];
render(() => createComponent(PersonPopover, {
  get anchor() { return anchor(); },
  onClose: () => setAnchor(null),
  actions,
  get name() { return data().name; },
  get email() { return data().email; },
  get detail() { return data().detail; },
  get phones() { return data().phones; },
  get loading() { return data().loading; },
  get error() { return data().error ? { message: "Contact details could not be loaded.", onRetry: () => window.calls.push("retry") } : undefined; },
  get list() { return data().list; },
}), document.getElementById("app"));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the person popover fixture.");
const script = await build.outputs[0]!.text();

declare global {
  interface Window {
    setData: (data: Record<string, unknown>) => void;
    calls: string[];
  }
}

const loaded = {
  name: "Mara Lindqvist",
  email: "mara@lindqvist-holzbau.example",
  detail: "Lindqvist Holzbau · Owner",
  phones: [{ number: "0461 555 0142", label: "Office" }],
  list: {
    title: "Earlier conversations",
    items: [
      { label: "Plane repair", meta: "3 messages · 14.09.2026", href: "#a" },
      { label: "Dovetail course", meta: "2 messages · 02.06.2026", href: "#b" },
    ],
  },
};
const loading = {
  name: "Mara Lindqvist",
  email: "mara@lindqvist-holzbau.example",
  loading: true,
  list: { title: "Earlier conversations", loading: true },
};

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (width: number, height: number): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent(
    `<!doctype html><html><head><style>${css}</style></head>` +
      `<body class="k2b-ui"><main id="app" style="padding:40px"><button id="sender" type="button">Mara Lindqvist</button></main></body></html>`,
  );
  await page.addScriptTag({ content: script });
  return page;
};
const card = (page: Page) => page.locator(".k2b-anchored-popover", { has: page.locator(".k2b-person-popover__content") });
const size = (page: Page) =>
  card(page).evaluate((element) => {
    const { width, height } = element.getBoundingClientRect();
    return { width, height };
  });
/** The browser hides the card at once but reports the toggle a task later; the card is closed only after it. */
const closed = async (page: Page) => {
  await card(page).waitFor({ state: "hidden" });
  await page.evaluate(() => new Promise((done) => setTimeout(done, 0)));
};
const focused = (page: Page) =>
  page.evaluate(() => document.activeElement?.getAttribute("aria-label") || document.activeElement?.textContent?.trim() || "");

describe("@k2b/ui PersonPopover", () => {
  test("opens from the keyboard, moves between rows with arrows, and Escape returns the focus", async () => {
    const page = await open(1280, 800);
    try {
      await page.evaluate((value) => window.setData(value), loaded);
      await page.focus("#sender");
      await page.keyboard.press("Enter");
      await card(page).waitFor();
      expect(await card(page).getAttribute("aria-label")).toBe("Mara Lindqvist");
      expect(await card(page).evaluate((element) => element.contains(document.activeElement))).toBe(true);
      expect(await card(page).getByRole("link", { name: "0461 555 0142" }).getAttribute("href")).toBe("tel:04615550142");
      expect(await card(page).getByRole("button", { name: "Copy" }).count()).toBe(1);

      await page.keyboard.press("ArrowDown");
      expect(await focused(page)).toBe("Copy");
      await page.keyboard.press("ArrowUp");
      expect(await focused(page)).toBe("Block sender");

      await page.keyboard.press("Escape");
      await closed(page);
      expect(await focused(page)).toBe("Mara Lindqvist");

      // Choosing an action runs it and closes the card.
      await page.keyboard.press("Enter");
      await card(page).getByRole("button", { name: "All messages from this sender" }).click();
      await card(page).waitFor({ state: "hidden" });
      expect(await page.evaluate(() => window.calls)).toEqual(["search"]);
    } finally {
      await page.close();
    }
  });

  test("placeholders hold the final size, so nothing moves when the details arrive", async () => {
    const page = await open(1280, 800);
    try {
      await page.evaluate((value) => window.setData(value), loading);
      await page.click("#sender");
      await card(page).waitFor();
      const before = await size(page);
      const position = await card(page).boundingBox();
      expect(await card(page).getByRole("status").textContent()).toBe("Loading...");
      await page.evaluate((value) => window.setData(value), loaded);
      expect(await card(page).getByText("Plane repair").count()).toBe(1);
      expect(await size(page)).toEqual(before);
      expect(await card(page).boundingBox()).toEqual(position);
      expect(await card(page).getByRole("status").textContent()).toBe("");
    } finally {
      await page.close();
    }
  });

  test("without contact data only the address and the actions show; a failed load offers a retry", async () => {
    const page = await open(1280, 800);
    try {
      await page.evaluate(() => window.setData({ email: "info@sawmill.example" }));
      await page.click("#sender");
      await card(page).waitFor();
      expect(await card(page).getByRole("heading", { level: 2 }).textContent()).toBe("info@sawmill.example");
      expect(await card(page).getByRole("button", { name: "Copy" }).count()).toBe(1);
      expect(await card(page).locator(".k2b-person-popover__contacts").count()).toBe(0);
      expect(await card(page).locator(".k2b-person-popover__action").count()).toBe(3);

      await page.evaluate(() => window.setData({ email: "info@sawmill.example", error: true }));
      await card(page).getByRole("button", { name: "Retry" }).click();
      expect(await page.evaluate(() => window.calls)).toEqual(["retry"]);
      expect(await card(page).getByText("Contact details could not be loaded.").count()).toBe(1);
    } finally {
      await page.close();
    }
  });

  test("is a bottom sheet across a phone screen", async () => {
    const page = await open(390, 844);
    try {
      await page.evaluate((value) => window.setData(value), loaded);
      await page.click("#sender");
      await card(page).waitFor();
      const box = await card(page).boundingBox();
      expect(await card(page).getAttribute("data-sheet")).toBe("");
      expect(box?.x).toBe(0);
      expect(box?.width).toBe(390);
      expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBe(844);
    } finally {
      await page.close();
    }
  });
});
