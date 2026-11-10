import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { hoverInPlace, launchBrowser, settled } from "../../test/browser";

// A card with an icon and actions keeps one text edge, wraps its actions on a narrow card, and lines its actions up
// across a grid row. Those are questions of real layout, so the shipped browser build renders here.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "notice-card.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { Button, NoticeCard } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const button = (variant, children) => createComponent(Button, { variant, size: "sm", children });
const notices = [
  { tone: "info", icon: "ti ti-file-import", title: "Import ready", detail: "12 rows validated.", actions: button("primary", "Start import") },
  {
    tone: "warning",
    icon: true,
    title: "Review needed",
    meta: "Due Friday",
    detail: "2 rows have no owner. They are published once someone owns them and the review is complete.",
    actions: [button("warning", "Assign owners"), button("secondary", "Show rows")],
  },
  { tone: "danger", icon: true, title: "Source unavailable", detail: "Retrying in the background.", actions: button("danger", "Retry now") },
];
const grid = document.getElementById("grid");
render(
  () => createComponent(NoticeCard.Grid, { items: notices, children: (notice) => createComponent(NoticeCard, { ...notice, layout: "card" }) }),
  grid,
);
render(
  () => createComponent(NoticeCard, { tone: "warning", icon: true, title: "Status line", detail: "An icon alone keeps the line." }),
  document.getElementById("line"),
);
render(
  () => createComponent(NoticeCard, { title: "Release note", detail: "Version 2.4 is available.", actions: button("primary", "Read what changed") }),
  document.getElementById("plain"),
);
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the notice card fixture for the browser.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async (width: number, theme: "light" | "dark" = "light") => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.setContent(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
      `<body class="k2b-ui" data-theme="${theme}" style="margin:0"><main style="display:grid;gap:12px;padding:16px;max-width:1200px">` +
      `<div id="grid"></div><div id="line"></div><div id="plain"></div></main></body></html>`,
  );
  await page.addScriptTag({ content: script });
  await page.locator("#plain .k2b-notice-card").waitFor();
  await settled(page);
  return page;
};

type Page = Awaited<ReturnType<typeof load>>;

/** Every grid card's box, its icon, text edge, title line, and actions, relative to the card. */
const measure = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("#grid .k2b-notice-card")].map((card) => {
      const root = card.getBoundingClientRect();
      const box = (selector: string) => card.querySelector(selector)!.getBoundingClientRect();
      const icon = box(".k2b-notice-card__icon");
      const title = box(".k2b-notice-card__title");
      const actions = box(".k2b-notice-card__actions");
      const buttons = [...card.querySelectorAll(".k2b-button")].map((button) => button.getBoundingClientRect());
      return {
        top: Math.round(root.top),
        height: Math.round(root.height),
        iconLeft: Math.round(icon.left - root.left),
        iconMiddle: Math.round(icon.top + icon.height / 2),
        titleMiddle: Math.round(title.top + title.height / 2),
        textEdges: [title, box(".k2b-notice-card__description"), actions].map((edge) => Math.round(edge.left - root.left)),
        actionsBottom: Math.round(root.bottom - actions.bottom),
        buttonTops: buttons.map((button) => Math.round(button.top)),
        buttonLefts: buttons.map((button) => Math.round(button.left - root.left)),
        buttonHeight: Math.round(buttons[0]!.height),
        titleInk: getComputedStyle(card.querySelector(".k2b-notice-card__title")!).color,
        iconInk: getComputedStyle(card.querySelector(".k2b-notice-card__icon")!).color,
      };
    }),
  );

describe("@k2b/ui NoticeCard with an icon and actions", () => {
  test("in a wide grid row the cards share one height, one text edge, and the bottom edge of their actions", async () => {
    const page = await load(1440);
    try {
      const cards = await measure(page);
      expect(cards).toHaveLength(3);
      expect(new Set(cards.map((card) => card.top)).size).toBe(1);
      expect(new Set(cards.map((card) => card.height)).size).toBe(1);
      for (const card of cards) {
        // The 1px forced-colours border and the 18px side padding, the icon on the title line, then one text edge.
        expect(card.iconLeft).toBe(19);
        expect(Math.abs(card.iconMiddle - card.titleMiddle)).toBeLessThanOrEqual(1);
        expect(new Set(card.textEdges).size).toBe(1);
        expect(card.textEdges[0]).toBe(19 + 20 + 12);
        expect(card.buttonLefts[0]).toBe(card.textEdges[0]);
        expect(card.actionsBottom).toBe(17);
        expect(card.buttonHeight).toBe(32);
        // Title keeps the calm primary ink; only the icon takes the tone.
        expect(card.titleInk).not.toBe(card.iconInk);
      }
      // The shorter cards' actions sit on the same line as the tallest card's.
      expect(new Set(cards.map((card) => card.buttonTops[0])).size).toBe(1);
      // An icon without layout="card" is still the compact status line, and a card without an icon is a column.
      const line = await page.evaluate(() => {
        const card = document.querySelector<HTMLElement>("#line .k2b-notice-card")!;
        const style = getComputedStyle(card);
        return { display: style.display, padding: style.padding };
      });
      expect(line).toMatchObject({ display: "grid", padding: "10px 14px" });
      const plain = await page.evaluate(() => {
        const card = document.querySelector<HTMLElement>("#plain .k2b-notice-card")!;
        const root = card.getBoundingClientRect();
        const actions = card.querySelector(".k2b-notice-card__actions")!.getBoundingClientRect();
        return { left: Math.round(actions.left - root.left), bottom: Math.round(root.bottom - actions.bottom) };
      });
      expect(plain).toEqual({ left: 19, bottom: 17 });
    } finally {
      await page.close();
    }
  });

  test("on a phone the actions wrap below the text and the page does not widen", async () => {
    const page = await load(320);
    try {
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
      const warning = (await measure(page))[1]!;
      expect(new Set(warning.textEdges).size).toBe(1);
      // Two actions that no longer fit side by side wrap onto a second row on the text edge.
      expect(warning.buttonTops[1]).toBeGreaterThan(warning.buttonTops[0]!);
      const edge = warning.textEdges[0]!;
      expect(warning.buttonLefts).toEqual([edge, edge]);
    } finally {
      await page.close();
    }
  });

  for (const theme of ["light", "dark"] as const) {
    test(`hover and keyboard focus on an action move nothing (${theme})`, async () => {
      const page = await load(1440, theme);
      try {
        const before = await measure(page);
        const button = page.locator("#grid .k2b-notice-card").nth(1).getByRole("button", { name: "Assign owners" });
        await hoverInPlace(button);
        await settled(page);
        expect(await measure(page)).toEqual(before);
        await page.locator("#grid .k2b-notice-card").first().getByRole("button", { name: "Start import" }).focus();
        await page.keyboard.press("Tab");
        expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Assign owners");
        await settled(page);
        expect(await measure(page)).toEqual(before);
      } finally {
        await page.close();
      }
    });
  }
});
