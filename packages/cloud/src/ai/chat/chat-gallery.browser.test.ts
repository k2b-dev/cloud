import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../../../ui/test/browser";
import { startChatGallery } from "./chat-gallery.browser-fixture";

// The Gustav chat's details are measured in a real browser: sizes, corners, and baselines depend on fonts and layout.
let browser: Browser;
let gallery: Awaited<ReturnType<typeof startChatGallery>>;
beforeAll(async () => {
  gallery = await startChatGallery();
  browser = await launchBrowser();
}, 120_000);
afterAll(async () => {
  await browser?.close();
  gallery?.close();
});

const open = async (scene: string, width: number, theme: "light" | "dark" = "light") => {
  const context = await browser.newContext({ viewport: { width, height: width < 768 ? 780 : 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto(`${gallery.url}?scene=${scene}&theme=${theme}`);
  await page.waitForSelector("body[data-ready]", { state: "attached" });
  await settled(page);
  return { page, close: () => context.close() };
};

const box = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        width: rect.width,
        height: rect.height,
        top: rect.top,
        bottom: rect.bottom,
        radius: style.borderRadius,
        background: style.backgroundColor,
        color: style.color,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
      };
    });

for (const width of [1440, 390])
  test(`an answer cites its sources with numbered chips and lists them under the text (${width} px)`, async () => {
    const { page, close } = await open("antwort", width);
    try {
      // A citation: a bold number in a grey 18 px chip with 6 px corners, 2 px above the line's baseline.
      const cite = await box(page, "a.ai-cite");
      expect(cite.height).toBe(18);
      expect(cite.width).toBeGreaterThanOrEqual(18);
      expect(cite.radius).toBe("6px");
      expect(cite.fontWeight).toBe("600");
      const muted = await page.evaluate(() => {
        const probe = document.createElement("span");
        probe.style.background = "var(--k2b-surface-muted)";
        document.body.append(probe);
        const value = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return value;
      });
      expect(cite.background).toBe(muted);
      expect(await page.locator("a.ai-cite").first().getAttribute("aria-label")).toBe("Quelle 1");
      expect(await page.locator("a.ai-cite").first().getAttribute("href")).toBe("/open/mail.thread/~messestand-koeln");
      const lift = await page
        .locator("a.ai-cite")
        .first()
        .evaluate((node) => getComputedStyle(node).verticalAlign);
      expect(lift).toBe("2px");

      // The source row: one pill per source, 26 px high and round, its number in an 18 px white circle, the app tile, and
      // the title the result gave the object.
      expect(await page.locator(".ai-sources__label").textContent()).toBe("Quellen");
      const pills = page.locator(".ai-source");
      expect(await pills.count()).toBe(2);
      expect(await pills.allTextContents()).toEqual(["1Messestand Köln · Jana Berger", "2Angebot-2026-118.pdf"]);
      const pill = await box(page, ".ai-source");
      expect(pill.height).toBe(26);
      expect(pill.background).toBe(muted);
      const number = await box(page, ".ai-source__number");
      expect([number.width, number.height]).toEqual([18, 18]);
      expect(number.radius).toBe("50%");
      expect(number.background).toBe("rgb(255, 255, 255)");
      const tile = await box(page, ".ai-source .ai-app-tile");
      expect([tile.width, tile.height, tile.radius]).toEqual([20, 20, "6px"]);
      expect(await page.locator(".ai-source").first().getAttribute("aria-label")).toBe("Quelle 1: Messestand Köln · Jana Berger");

      // The person's message: a neutral grey bubble with 16 px corners and a 5 px corner toward the composer.
      const bubble = await box(page, ".k2b-chat-message[data-role=user] .k2b-chat-message__bubble");
      expect(bubble.background).toBe(muted);
      expect(bubble.radius).toBe("16px 16px 5px");
      const own = page.locator(".k2b-chat-message[data-role=user] .k2b-chat-message__actions button");
      expect(await own.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")))).toEqual([
        "Kopieren",
        "Bearbeiten und neu senden",
      ]);

      // Under the answer: copy, answer again, helpful, needs improvement, and "More" with the rest.
      const answer = page.locator(".k2b-chat-message[data-role=assistant] .k2b-chat-message__actions").last();
      expect(
        await answer.locator("button[aria-label]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label"))),
      ).toEqual(["Kopieren", "Neu antworten", "Hilfreich", "Verbesserungswürdig", "Mehr"]);
      // Quiet 15 px icons in 32 px buttons; the first glyph starts on the answer's text edge.
      const icons = await answer.evaluate((row) => {
        const button = row.querySelector("button")!;
        const glyph = button.querySelector("i")!.getBoundingClientRect();
        const text = document.querySelector(".ai-turn__text .assistant-markdown-block")!.getBoundingClientRect();
        return {
          size: getComputedStyle(button).fontSize,
          button: button.getBoundingClientRect().height,
          offset: Math.abs(glyph.left - text.left),
        };
      });
      expect(icons.size).toBe("15px");
      expect(icons.button).toBe(32);
      expect(icons.offset).toBeLessThan(2);
      await answer.getByRole("button", { name: "Mehr" }).click();
      expect(await page.getByRole("menuitem").allTextContents()).toEqual([
        "Ausführlicher",
        "Kürzer",
        "In neuem Chat fortsetzen",
        "Details zur Antwort",
      ]);
      // The menu keeps the menu's own text size, not the icons' 15 px.
      expect(
        await page
          .getByRole("menuitem")
          .first()
          .evaluate((node) => getComputedStyle(node).fontSize),
      ).not.toBe("15px");
      await page.getByRole("menuitem", { name: "Kürzer" }).click();
      expect(await page.evaluate(() => (window as unknown as { retried: unknown[] }).retried)).toEqual([
        { id: "gallery-1", mode: "concise" },
      ]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally {
      await close();
    }
  }, 60_000);

test("sources and the grey bubble keep their surfaces in dark mode", async () => {
  const { page, close } = await open("antwort", 1440, "dark");
  try {
    const pill = await box(page, ".ai-source");
    const number = await box(page, ".ai-source__number");
    expect(pill.background).not.toBe(number.background);
    expect(number.background).not.toBe("rgb(255, 255, 255)");
    const bubble = await box(page, ".k2b-chat-message[data-role=user] .k2b-chat-message__bubble");
    expect(bubble.background).toBe(pill.background);
  } finally {
    await close();
  }
}, 60_000);

test("a delivered routine result offers no answer again, so a retry never targets the person's earlier message", async () => {
  const { page, close } = await open("routine", 1440);
  try {
    const rows = page.locator(".k2b-chat-message[data-role=assistant] .k2b-chat-message__actions");
    expect(await rows.count()).toBe(2);
    const labels = (index: number) =>
      rows
        .nth(index)
        .locator("button[aria-label]")
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")));
    expect(await labels(0)).toContain("Neu antworten");
    expect(await labels(1)).not.toContain("Neu antworten");
  } finally {
    await close();
  }
}, 60_000);
