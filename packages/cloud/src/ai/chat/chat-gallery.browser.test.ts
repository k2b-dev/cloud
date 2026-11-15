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

const open = async (scene: string, width: number, theme: "light" | "dark" = "light", motion: "reduce" | "no-preference" = "reduce") => {
  const context = await browser.newContext({ viewport: { width, height: width < 768 ? 780 : 900 }, reducedMotion: motion });
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
        left: rect.left,
        right: rect.right,
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
      // The question reads in the answer's size (v12 image 02), not in a smaller bubble type.
      const sizes = await page.evaluate(() => {
        const size = (selector: string) => {
          const node = document.querySelector(selector);
          return node ? [getComputedStyle(node).fontSize, getComputedStyle(node).lineHeight] : null;
        };
        return {
          question: size(
            ".k2b-chat-message[data-role=user] .k2b-chat-message__bubble p, .k2b-chat-message[data-role=user] .k2b-chat-message__bubble",
          ),
          answer: size(".ai-turn__text .assistant-markdown-block p"),
        };
      });
      expect(sizes.question?.[0]).toBe("15.5px");
      expect(sizes.answer?.[0]).toBe("15.5px");
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
      await settled(page);
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

test("what a message brings along stands above it: images as previews, files as tiles with name and size", async () => {
  for (const width of [1440, 390]) {
    const { page, close } = await open("anhaenge", width);
    try {
      const image = await box(page, '.k2b-chat-message__attachment[data-kind="image"]');
      expect([image.width, image.height, image.radius]).toEqual([148, 110, "12px"]);
      // Without its preview the image shows its sign in the quiet third grey, not in full ink.
      const ink = await page.locator('.k2b-chat-message__attachment[data-kind="image"] > i').evaluate((node) => {
        const probe = document.createElement("span");
        probe.style.color = "var(--k2b-text-subtle)";
        node.parentElement!.append(probe);
        const subtle = getComputedStyle(probe).color;
        probe.remove();
        return { icon: getComputedStyle(node).color, subtle };
      });
      expect(ink.icon).toBe(ink.subtle);
      const file = page.locator('.k2b-chat-message__attachment[data-kind="file"]');
      expect((await file.innerText()).replace(/\s+/g, " ").trim()).toMatch(/^Nachlass-Liste\.pdf 12\d\S* [KkM]i?B$/);
      const tile = await box(page, '.k2b-chat-message__attachment[data-kind="file"]');
      // Grey tiles without an edge, on the bubble's right edge.
      expect(tile.radius).toBe("12px");
      expect(await file.evaluate((node) => getComputedStyle(node).borderTopWidth)).toBe("0px");
      const bubble = await box(page, ".k2b-chat-message[data-role=user] .k2b-chat-message__bubble");
      expect(Math.abs(tile.right - bubble.right)).toBeLessThan(1);
    } finally {
      await close();
    }
  }
}, 60_000);

for (const width of [1440, 390])
  test(`the work line says in one line what the turn did, with ✦ and app tiles, and opens the steps in words (${width} px)`, async () => {
    const { page, close } = await open("antwort", width);
    try {
      const line = ".ai-turn-work > summary";
      expect(await page.locator(`${line} .ai-turn-work__text`).textContent()).toBe(
        "In Mail und Dateien nachgesehen · 5 Schritte, 1 ohne Zugriff",
      );
      // The sentence gives way first: the step count and what did not go through are never cut.
      const whole = await page.locator(`${line} .ai-turn-work__steps`).evaluate((node) => node.scrollWidth <= node.clientWidth + 0.5);
      expect(whole).toBe(true);
      // On a phone the plain step count gives way to the sentence; what did not go through stays.
      const visible = (await page.locator(`${line} .ai-turn-work__steps`).innerText()).replace(/\s+/g, " ").trim();
      expect(visible).toBe(width < 768 ? "· 1 ohne Zugriff" : "· 5 Schritte, 1 ohne Zugriff");
      // ✦ in the AI colour, then one 20 px tile per app that went through, in the app's colour on its tint.
      const spark = await page.locator(`${line} .ai-turn-work__lead > i`).evaluate((node) => getComputedStyle(node).color);
      const plum = await page.evaluate(() => {
        const probe = document.createElement("span");
        probe.style.color = "var(--k2b-ai-accent)";
        document.body.append(probe);
        const value = getComputedStyle(probe).color;
        probe.remove();
        return value;
      });
      expect(spark).toBe(plum);
      const tiles = page.locator(`${line} .ai-app-tile`);
      expect(await tiles.count()).toBe(2);
      const tile = await box(page, `${line} .ai-app-tile`);
      expect([tile.width, tile.height, tile.radius]).toEqual([20, 20, "6px"]);
      // One line in 13 px, the time in 12 px tabular figures on the right, the chevron last.
      const row = await box(page, line);
      expect(row.height).toBe(28);
      expect(await page.locator(`${line} .ai-turn-work__text`).evaluate((node) => getComputedStyle(node).fontSize)).toBe("13px");
      const time = page.locator(`${line} .ai-turn-work__meta`);
      expect(await time.evaluate((node) => [getComputedStyle(node).fontSize, getComputedStyle(node).fontVariantNumeric])).toEqual([
        "12px",
        "tabular-nums",
      ]);
      const ends = await page.locator(line).evaluate((node) => {
        const chevron = node.querySelector(".k2b-chat-activity__chevron")!.getBoundingClientRect();
        const meta = node.querySelector(".ai-turn-work__meta")!.getBoundingClientRect();
        const words = node.querySelector(".ai-turn-work__text")!.getBoundingClientRect();
        return {
          chevronAfterTime: chevron.left >= meta.right,
          rowRight: node.getBoundingClientRect().right - chevron.right,
          timeAfterWords: meta.left - words.right,
        };
      });
      expect(ends.chevronAfterTime).toBe(true);
      expect(ends.rowRight).toBeLessThan(12);
      // The time follows the sentence (v12), not a column at the far end.
      expect(ends.timeAfterWords).toBeGreaterThanOrEqual(0);
      expect(ends.timeAfterWords).toBeLessThan(16);

      // Opened: the steps in words, each with its tile on one axis; a refused step says why and what followed.
      await page.locator(line).click();
      await settled(page);
      const steps = page.locator(".ai-turn-steps > .k2b-chat-activity");
      expect(await steps.count()).toBe(5);
      expect(await steps.first().innerText()).toContain("Nachgedacht");
      // Finished reading steps say what happened, in the app's own past form (v12 image 03).
      expect(await steps.nth(1).innerText()).toContain("In Mail gesucht");
      expect(await steps.nth(2).innerText()).toContain("Unterhaltung gelesen");
      expect(await steps.nth(3).innerText()).toContain("Datei gelesen");
      const axis = await steps.evaluateAll((nodes) =>
        nodes.map((node) => Math.round(node.querySelector(".ai-app-tile")!.getBoundingClientRect().left)),
      );
      expect(new Set(axis).size).toBe(1);
      const denied = steps.last();
      expect(await denied.innerText()).toContain("Kein Zugriff. Ohne dieses Ergebnis weitergearbeitet.");
      expect(await denied.locator("small").evaluate((node) => getComputedStyle(node).color)).not.toBe(
        await steps
          .nth(1)
          .locator("small")
          .evaluate((node) => getComputedStyle(node).color),
      );
      expect(await page.locator(".ai-turn-steps").innerText()).not.toContain("FORBIDDEN");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally {
      await close();
    }
  }, 60_000);

test("the running work line has the finished line's height, shimmers in 2.2 s, and stands still with reduced motion", async () => {
  const finished = await open("antwort", 1440);
  const height = (await box(finished.page, ".ai-turn-work > *")).height;
  await finished.close();
  for (const motion of ["no-preference", "reduce"] as const) {
    const { page, close } = await open("arbeitet", 1440, "light", motion);
    try {
      const line = ".ai-turn-work .k2b-chat-activity__row";
      expect((await box(page, line)).height).toBe(height);
      expect(await page.locator(`${line} .ai-turn-work__sentence`).innerText()).toContain("Nutzt Dateien");
      // The message's progress dots give way to the work line.
      expect(await page.locator(".k2b-chat-progress-dots").evaluate((node) => getComputedStyle(node).visibility)).toBe("hidden");
      const sentence = await page.locator(`${line} .ai-turn-work__sentence`).evaluate((node) => ({
        name: getComputedStyle(node).animationName,
        duration: getComputedStyle(node).animationDuration,
      }));
      if (motion === "reduce") expect(sentence.name).toBe("none");
      else expect(sentence).toEqual({ name: "k2b-chat-activity-shimmer", duration: "2.2s" });
      // Tiles keep their colours while the sentence shimmers.
      expect(await page.locator(`${line} .k2b-chat-activity__leading`).evaluate((node) => getComputedStyle(node).animationName)).toBe(
        "none",
      );
    } finally {
      await close();
    }
  }
}, 60_000);

test("a stopped answer ends with a quiet line and Answer again; a failed one says what stays", async () => {
  for (const width of [1440, 390]) {
    const stopped = await open("gestoppt", width);
    try {
      // The answer it had begun stays in its place, not folded into the work line.
      expect(await stopped.page.locator(".ai-turn__text").innerText()).toContain("Jana Berger fragt zwei Dinge");
      const line = stopped.page.locator(".ai-turn__stopped");
      expect(await line.innerText()).toContain("Du hast gestoppt. Der Text bis hier bleibt.");
      // "Answer again" follows the sentence instead of standing at the far edge.
      const sentence = await line.locator(".k2b-chat-activity__copy").boundingBox();
      const again = await line.getByRole("button", { name: "Neu antworten" }).boundingBox();
      expect(again!.x - (sentence!.x + sentence!.width)).toBeLessThan(16);
      // A quiet line, not a warning: no notice card at the end of a stopped answer.
      expect(await stopped.page.locator(".ai-turn__notice").count()).toBe(0);
      await line.getByRole("button", { name: "Neu antworten" }).click();
      expect(await stopped.page.evaluate(() => (window as unknown as { retried: unknown[] }).retried)).toEqual([
        { id: "gallery-1", mode: "retry" },
      ]);
    } finally {
      await stopped.close();
    }
    const failed = await open("fehler", width);
    try {
      expect(await failed.page.locator(".ai-turn__text").innerText()).toContain("Jana Berger fragt zwei Dinge");
      const notice = failed.page.locator(".ai-turn__notice");
      const said = await notice.innerText();
      expect(said).toContain("Die Antwort wurde unterbrochen: Der KI-Dienst hat nicht geantwortet.");
      expect(said).toContain("Was bis hier steht, bleibt erhalten.");
      // Said once: the reason does not repeat what stays.
      expect(said).not.toContain("Die bisherigen Ergebnisse bleiben erhalten.");
      expect(await notice.locator(".ti-alert-circle").count()).toBe(1);
      // The notice ends the turn, below the text that stays.
      expect(
        await failed.page.evaluate(() => document.querySelector(".ai-turn")?.lastElementChild?.classList.contains("ai-turn__notice")),
      ).toBe(true);
    } finally {
      await failed.close();
    }
  }
}, 60_000);

test("the Gustav column is 812 px with 764 px for turns and composer, and prose stops at 44 rem", async () => {
  const { page, close } = await open("antwort", 1440);
  try {
    const content = await box(page, ".k2b-chat-timeline__content");
    expect(content.width).toBe(812);
    const prose = await box(page, ".ai-turn__text .assistant-markdown-block");
    expect(prose.width).toBeLessThanOrEqual(704);
    // Headings stand out by size: 18 px in the answer.
    expect(await page.locator(".ai-turn__text h2").evaluate((node) => getComputedStyle(node).fontSize)).toBe("18px");
  } finally {
    await close();
  }
}, 60_000);
