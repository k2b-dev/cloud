import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";
import type {} from "../../test/chat-decision.browser-harness";

let browser: Browser;
let bundle: string;
let css: string;
beforeAll(async () => {
  const { transformAsync } = await import("@babel/core");
  const typescript = (await import("@babel/preset-typescript")).default;
  const solid = (await import("babel-preset-solid")).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../../test/chat-decision.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "chat-decision-dom",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            if (!result?.code) throw new Error(`Could not transform ${path}`);
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Chat decision harness failed");
  bundle = await build.outputs[0]!.text();
  css = await Bun.file(resolve(import.meta.dir, "../../dist/styles.css")).text();
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (width = 1440, dark = false, timelineWidth?: "narrow" | "wide") => {
  const page = await browser.newPage({ viewport: { width, height: 1100 } });
  await page.setContent(
    `<!doctype html><html${timelineWidth ? ` data-timeline-width="${timelineWidth}"` : ""}><head><style>${css}
      html { font-size:16px; } body { margin:0; font-family:Arial,sans-serif; }
      main { max-width:720px; margin:24px; }
    </style></head><body class="k2b-ui${dark ? " k2b-dark" : ""}"><div id="root"></div></body></html>`,
  );
  await page.addScriptTag({ content: bundle });
  await page.waitForSelector(".k2b-chat-decision__sentence");
  return page;
};

const running = "Sending the mail to Lea.";
const done =
  "Sent the mail to Lea. Mail took it over for sending and delivers it to every recipient listed above, including the copy for Tom, within the next few minutes. 09:41";
const activeOutcome = (page: Page) => page.locator('.k2b-chat-outcome__text[data-current="true"]');
const focusedOutcome = (page: Page) => page.locator(".k2b-chat-outcome").evaluate((e) => e === document.activeElement);
const spoken = (page: Page, text: string) =>
  page.waitForFunction((text) => document.querySelector('[role="status"]')?.textContent === text, text);
const boxes = (page: Page) =>
  page.evaluate(() =>
    ['.k2b-chat-outcome__text[data-current="true"]', ".k2b-chat-outcome", "#sentinel"].map((selector) => {
      const { x, y, height } = document.querySelector(selector)!.getBoundingClientRect();
      return { x, y, height };
    }),
  );

test("confirm collapses immediately, focuses and announces the outcome, and finishing shifts nothing (0px)", async () => {
  const page = await open();
  try {
    await page.getByRole("button", { name: "Send to Lea", exact: true }).click();
    expect(await page.locator(".k2b-chat-decision").first().getAttribute("data-state")).toBe("sending");
    expect(await activeOutcome(page).textContent()).toBe(running);
    expect(await focusedOutcome(page)).toBe(true);
    expect(await page.locator(".k2b-chat-outcome").getAttribute("data-enter")).toBe("true");
    await spoken(page, running);
    const before = await boxes(page);
    // The done text wraps to a second line; the outcome already reserved it while running.
    expect(before[1]!.height).toBeGreaterThan(60);
    await page.evaluate(() => window.__finish());
    await spoken(page, done);
    expect(await boxes(page)).toEqual(before);
    expect(await page.locator(".k2b-chat-outcome").getAttribute("data-tone")).toBe("done");
    // A line with buttons under it reserved their row from the start, so it moves nothing either.
    await page.evaluate(() => window.__check());
    await spoken(page, "Still checking whether the mail went out.");
    expect(await boxes(page)).toEqual(before);
  } finally {
    await page.close();
  }
});

test("Tab to decline and Enter transfers focus to the declined outcome", async () => {
  const page = await open();
  try {
    await page.getByRole("button", { name: "Send to Lea", exact: true }).focus();
    await page.keyboard.press("Tab");
    expect(await page.getByRole("button", { name: "Keep draft", exact: true }).evaluate((e) => e === document.activeElement)).toBe(true);
    await page.keyboard.press("Enter");
    expect(await focusedOutcome(page)).toBe(true);
    expect(await activeOutcome(page).textContent()).toBe("Kept the mail as a draft. You declined.");
    await spoken(page, "Kept the mail as a draft. You declined.");
  } finally {
    await page.close();
  }
});

test("an expired outcome action reopens and focuses the question sentence", async () => {
  const page = await open();
  try {
    await page.evaluate(() => window.__expire());
    await page.getByRole("button", { name: "Ask again", exact: true }).click();
    expect(await page.locator(".k2b-chat-decision").first().getAttribute("data-state")).toBe("open");
    expect(
      await page
        .locator(".k2b-chat-decision__sentence")
        .first()
        .evaluate((e) => e === document.activeElement),
    ).toBe(true);
    expect(await page.locator(".k2b-chat-decision__sentence").first().getAttribute("data-arrive")).toBe("true");
  } finally {
    await page.close();
  }
});

for (const width of [1440, 390])
  test(`question alignment, spacing, typography and 44px answer targets at ${width}px`, async () => {
    const page = await open(width);
    try {
      const metrics = await page.evaluate(() => {
        const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
        const left = box(".k2b-chat-decision").left;
        const sentence = box(".k2b-chat-decision__sentence");
        const reason = box(".k2b-chat-decision__reason");
        const preview = box(".k2b-chat-preview");
        const answers = box(".k2b-chat-decision__answers");
        const style = getComputedStyle(document.querySelector(".k2b-chat-decision__sentence")!);
        return {
          indent: Array.from(document.querySelectorAll(".k2b-chat-line__text, .k2b-chat-activity__copy strong")).map(
            (e) => e.getBoundingClientRect().left - left,
          ),
          flush: [
            ".k2b-chat-decision__sentence",
            ".k2b-chat-preview__title-line",
            ".k2b-chat-decision__answers",
            ".k2b-chat-decision__answer",
            ...Array.from(document.querySelectorAll(".k2b-chat-preview__header dl > div")).map(
              (_, i) => `.k2b-chat-preview__header dl > div:nth-child(${i + 1})`,
            ),
          ].map((selector) => box(selector).left - left),
          gaps: [reason.top - sentence.bottom, preview.top - reason.bottom, answers.top - preview.bottom],
          heights: Array.from(document.querySelectorAll(".k2b-chat-decision__answer")).map((e) => e.getBoundingClientRect().height),
          size: style.fontSize,
          weight: style.fontWeight,
        };
      });
      expect(metrics.indent.length).toBe(8); // two reasons, four decision preview lines, the later-marked line, activity
      for (const indent of metrics.indent) expect(Math.abs(indent - 24)).toBeLessThanOrEqual(0.5);
      for (const left of metrics.flush) expect(Math.abs(left)).toBeLessThanOrEqual(0.5);
      for (const [index, expected] of [4, 20, 20].entries()) expect(Math.abs(metrics.gaps[index]! - expected)).toBeLessThanOrEqual(0.5);
      for (const height of metrics.heights) expect(height).toBeGreaterThanOrEqual(44);
      expect(metrics.size).toBe(width === 1440 ? "18px" : "17px");
      expect(metrics.weight).toBe("400");
      await page.getByRole("button", { name: "Send to Lea", exact: true }).click();
      expect(
        await activeOutcome(page).evaluate(
          (e) => e.getBoundingClientRect().left - document.querySelector(".k2b-chat-decision")!.getBoundingClientRect().left,
        ),
      ).toBe(24);
    } finally {
      await page.close();
    }
  });

test("390px has no horizontal overflow, even with long chip titles and mail addresses", async () => {
  const page = await open(390);
  try {
    const overflow = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      outside: Array.from(document.querySelectorAll("body *"))
        .filter((e) => e.getBoundingClientRect().right > 390)
        .map((e) => `${e.tagName}.${e.className}`),
    }));
    expect(overflow.width).toBeLessThanOrEqual(390);
    expect(overflow.outside).toEqual([]);
    const title = `${"Quarterly".repeat(8)}.pdf`;
    const chip = page.getByRole("link", { name: title, exact: true });
    expect(await chip.count()).toBe(1);
    const visible = await chip.locator('span[aria-hidden="true"]').textContent();
    expect(visible!.length).toBe(40);
    expect(visible!.endsWith(".pdf")).toBe(true);
  } finally {
    await page.close();
  }
});

test("dark question, done icon and added marks use the inherited dark tokens", async () => {
  const page = await open(1440, true);
  try {
    const colors = await page.evaluate(() => {
      const root = getComputedStyle(document.body);
      const probe = document.createElement("span");
      document.body.append(probe);
      const color = (value: string) => {
        probe.style.color = value;
        return getComputedStyle(probe).color;
      };
      const sentence = getComputedStyle(document.querySelector(".k2b-chat-decision__sentence")!).color;
      const mark = getComputedStyle(document.querySelector('.k2b-chat-mark[data-change="added"]')!).backgroundColor;
      const expectedText = color(root.getPropertyValue("--k2b-text"));
      probe.style.backgroundColor = `color-mix(in srgb, ${root.getPropertyValue("--k2b-ai-accent")} 22%, transparent)`;
      const expectedMark = getComputedStyle(probe).backgroundColor;
      const expectedSuccess = color(root.getPropertyValue("--k2b-success-text"));
      probe.remove();
      return { sentence, mark, expectedText, expectedMark, expectedSuccess };
    });
    expect(colors.sentence).toBe(colors.expectedText);
    expect(colors.mark).toBe(colors.expectedMark);
    await page.getByRole("button", { name: "Send to Lea", exact: true }).click();
    await page.evaluate(() => window.__finish());
    expect(await page.locator(".k2b-chat-outcome__icon i").evaluate((e) => getComputedStyle(e).color)).toBe(colors.expectedSuccess);
  } finally {
    await page.close();
  }
});

test("a rejected outcome action reaches onActionError instead of going unhandled", async () => {
  const page = await open();
  const unhandled: string[] = [];
  page.on("pageerror", (error) => unhandled.push(error.message));
  try {
    await page.evaluate(() => window.__fail());
    const again = page.getByRole("button", { name: "Send again", exact: true });
    await again.click();
    // A second press while the first is still running does not repeat it.
    await again.click();
    await page.waitForFunction(() => window.__errors.length === 1);
    expect(await page.evaluate(() => window.__calls)).toBe(1);
    expect(await page.evaluate(() => window.__errors)).toEqual(["Error: offline"]);
    expect(unhandled).toEqual([]);
  } finally {
    await page.close();
  }
});

test("marking a line later keeps its retained children in place", async () => {
  const page = await open();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.evaluate(() => window.__mark());
    expect(errors).toEqual([]);
    expect(await page.locator('.k2b-chat-mark[data-change="added"] #retained').textContent()).toBe("Retained words");
  } finally {
    await page.close();
  }
});

test("a focus moved to the sentence from elsewhere lights it up; a press on the sentence itself does not", async () => {
  const page = await open();
  try {
    const sentence = page.locator(".k2b-chat-decision__sentence").first();
    await sentence.click();
    expect(await sentence.evaluate((e) => e === document.activeElement)).toBe(true);
    expect(await sentence.getAttribute("data-arrive")).toBeNull();
    await page.getByRole("button", { name: "Send to Lea", exact: true }).focus();
    // A jump from a list of waiting questions focuses the sentence by script.
    await sentence.evaluate((e) => (e as HTMLElement).focus({ preventScroll: true }));
    expect(await sentence.getAttribute("data-arrive")).toBe("true");
  } finally {
    await page.close();
  }
});

test("a reopen from elsewhere after an unrelated outcome action leaves the focus alone", async () => {
  const page = await open();
  try {
    await page.evaluate(() => window.__request());
    await page.getByRole("button", { name: "Open the request", exact: true }).click();
    await page.evaluate(() => window.__reopen());
    const sentence = page.locator(".k2b-chat-decision__sentence").first();
    expect(await sentence.evaluate((e) => e === document.activeElement)).toBe(false);
    expect(await sentence.getAttribute("data-arrive")).toBeNull();
  } finally {
    await page.close();
  }
});

test("a line action that switches lines keeps the focus on the outcome instead of a hidden link", async () => {
  const page = await open();
  try {
    await page.evaluate(() => window.__sendFailed());
    await page.getByRole("button", { name: "Retry sending", exact: true }).focus();
    await page.keyboard.press("Enter");
    expect(await activeOutcome(page).textContent()).toBe("Sending the request again.");
    expect(await focusedOutcome(page)).toBe(true);
    await spoken(page, "Asked the managers again.");
    expect(await focusedOutcome(page)).toBe(true);
  } finally {
    await page.close();
  }
});

test("a question the host returns from sending to open gives the focus back to its sentence", async () => {
  const page = await open();
  try {
    await page.getByRole("button", { name: "Send to Lea", exact: true }).click();
    expect(await focusedOutcome(page)).toBe(true);
    await page.evaluate(() => window.__reopen());
    const sentence = page.locator(".k2b-chat-decision__sentence").first();
    expect(await sentence.evaluate((e) => e === document.activeElement)).toBe(true);
    // The answers work again.
    await page.getByRole("button", { name: "Keep draft", exact: true }).click();
    expect(await focusedOutcome(page)).toBe(true);
  } finally {
    await page.close();
  }
});

test("a reopen that passes through sending still returns the focus to the sentence", async () => {
  const page = await open();
  try {
    await page.evaluate(() => window.__expireSlow());
    await page.getByRole("button", { name: "Load and ask again", exact: true }).click();
    expect(await page.locator(".k2b-chat-decision").first().getAttribute("data-state")).toBe("sending");
    await page.waitForFunction(() => document.querySelector(".k2b-chat-decision")?.getAttribute("data-state") === "open");
    expect(
      await page
        .locator(".k2b-chat-decision")
        .first()
        .locator(".k2b-chat-decision__sentence")
        .evaluate((e) => e === document.activeElement),
    ).toBe(true);
  } finally {
    await page.close();
  }
});

for (const timelineWidth of ["narrow", "wide"] as const)
  test(`a ${timelineWidth} timeline owns decision typography and answer growth on a 1440px window`, async () => {
    const page = await open(1440, false, timelineWidth);
    try {
      await settled(page);
      const metrics = await page.evaluate(() => ({
        window: window.innerWidth,
        timeline: document.querySelector(".k2b-chat-timeline")!.getBoundingClientRect().width,
        sentence: getComputedStyle(document.querySelector(".k2b-chat-decision__sentence")!).fontSize,
        answers: Array.from(document.querySelectorAll(".k2b-chat-decision__answer")).map((e) => getComputedStyle(e).flexGrow),
      }));
      expect(metrics.window).toBe(1440);
      expect(metrics.timeline).toBe((timelineWidth === "narrow" ? 22 : 60) * 16);
      expect(metrics.sentence).toBe(timelineWidth === "narrow" ? "17px" : "18px");
      expect(metrics.answers).toEqual(timelineWidth === "narrow" ? ["1", "1"] : ["0", "0"]);
    } finally {
      await page.close();
    }
  });
