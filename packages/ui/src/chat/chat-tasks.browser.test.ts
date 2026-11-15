import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { meterType } from "../../../../scripts/fixtures/type-meter";
import { launchBrowser, settled } from "../../test/browser";
import type {} from "../../test/chat-tasks.browser-harness";

const ui = resolve(import.meta.dir, "../..");
const assets = "http://k2b-ui.test/";
const fonts = readFileSync(resolve(ui, "dist/plex.css"), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, `url($1${assets}`);
const icons = readFileSync(resolve(ui, "dist/tabler.css"), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, `url($1${assets}`);

// Each case opens its own page and waits for real transitions.
setDefaultTimeout(20_000);

let browser: Browser;
let bundle: string;
let css: string;
beforeAll(async () => {
  const { transformAsync } = await import("@babel/core");
  const typescript = (await import("@babel/preset-typescript")).default;
  const solid = (await import("babel-preset-solid")).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../../test/chat-tasks.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "chat-tasks-dom",
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
  if (!build.success) throw new AggregateError(build.logs, "Chat tasks harness failed");
  bundle = await build.outputs[0]!.text();
  css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (width: number, options: { reduced?: boolean; dark?: boolean } = {}) => {
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: options.reduced ? "reduce" : "no-preference" });
  await page.route(`${assets}**`, (route) =>
    route.fulfill({
      path: resolve(ui, "dist", new URL(route.request().url()).pathname.slice(1)),
      headers: { "access-control-allow-origin": "*" },
    }),
  );
  await page.setContent(
    `<!doctype html><html lang="en"><head><style>${css}</style><style>${fonts}</style><style>${icons}</style>
      <style>body{margin:0} #root{padding:12px}</style></head>
      <body class="k2b-ui${options.dark ? " k2b-dark" : ""}"><div id="root"></div></body></html>`,
  );
  await page.addScriptTag({ content: bundle });
  await page.waitForSelector(".k2b-chat-tasks");
  await page.evaluate(() => document.fonts.ready);
  await settled(page);
  return page;
};

const box = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((node) => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height };
    });
const setTasks = async (page: Page, statuses: string[]) => {
  await page.evaluate((statuses) => {
    window.__setTasks(
      [
        ["write", "Write the change"],
        ["check", "Check what it may do"],
        ["examples", "Try the examples"],
        ["submit", "Submit the version"],
      ].map(([id, content], index) => ({ id: id!, content: content!, status: statuses[index] as "pending" })),
    );
  }, statuses);
  await settled(page);
};
/** Waits until no animation or transition runs inside the plan. */
const still = (page: Page) =>
  page.waitForFunction(() =>
    document
      .querySelector(".k2b-chat-tasks")!
      .getAnimations({ subtree: true })
      // Only document-timeline animations finish; the running ring loops on purpose.
      .filter((a) => a.timeline === document.timeline)
      .every((a) => a.playState !== "running" || a.effect?.getTiming().iterations === Number.POSITIVE_INFINITY),
  );

for (const width of [1440, 390]) {
  describe(`Chat.Tasks at ${width}`, () => {
    test("rows are 32 px, the white highlight sits on the current row and follows it", async () => {
      const page = await open(width);
      try {
        const rows = await page
          .locator(".k2b-chat-tasks .k2b-chat-task")
          .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
        expect(rows).toEqual([32, 32, 32, 32]);
        const glide = page.locator(".k2b-chat-tasks__glide");
        await glide.waitFor();
        expect(await box(page, ".k2b-chat-tasks__glide")).toEqual(
          await box(page, '.k2b-chat-tasks .k2b-chat-task[data-status="in_progress"]'),
        );
        expect(await glide.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe("rgb(255, 255, 255)");
        await setTasks(page, ["completed", "in_progress", "pending", "pending"]);
        await still(page);
        expect(await box(page, ".k2b-chat-tasks__glide")).toEqual(
          await box(page, '.k2b-chat-tasks .k2b-chat-task[data-status="in_progress"]'),
        );
        expect(await page.locator(".k2b-chat-tasks__count").textContent()).toBe("1 of 4");
        expect(
          await page
            .locator(".k2b-chat-tasks__ring")
            .evaluate((node) => getComputedStyle(node).getPropertyValue("--k2b-chat-tasks-progress").trim()),
        ).toBe("25%");
      } finally {
        await page.close();
      }
    });

    test("a step that starts after the last one finished glides from the old place", async () => {
      const page = await open(width);
      try {
        await page.locator(".k2b-chat-tasks__glide").evaluate((node) => node.setAttribute("data-probe", "same"));
        await setTasks(page, ["completed", "pending", "pending", "pending"]);
        expect(await page.locator(".k2b-chat-tasks__glide").getAttribute("data-hidden")).toBe("");
        await setTasks(page, ["completed", "in_progress", "pending", "pending"]);
        const glide = page.locator(".k2b-chat-tasks__glide");
        expect(await glide.getAttribute("data-probe")).toBe("same");
        expect(await glide.getAttribute("data-hidden")).toBeNull();
        expect(await glide.evaluate((node) => getComputedStyle(node).transitionProperty)).toContain("transform");
        await still(page);
        expect(await box(page, ".k2b-chat-tasks__glide")).toEqual(
          await box(page, '.k2b-chat-tasks .k2b-chat-task[data-status="in_progress"]'),
        );
      } finally {
        await page.close();
      }
    });

    test("header text and row text share one edge", async () => {
      const page = await open(width);
      try {
        const title = await box(page, ".k2b-chat-tasks__title");
        const row = await box(page, ".k2b-chat-tasks .k2b-chat-task__content");
        expect(title.x).toBe(row.x);
      } finally {
        await page.close();
      }
    });

    test("finishing a step changes no row and moves nothing outside the plan (0 px)", async () => {
      const page = await open(width);
      try {
        const watched = ["#last-message", "#composer", ".k2b-chat-tasks__header", ".k2b-chat-tasks"];
        const before = await Promise.all(watched.map((selector) => box(page, selector)));
        for (const statuses of [
          ["completed", "in_progress", "pending", "pending"],
          ["completed", "completed", "in_progress", "pending"],
          ["completed", "completed", "completed", "completed"],
        ]) {
          await setTasks(page, statuses);
          await still(page);
          expect(await Promise.all(watched.map((selector) => box(page, selector)))).toEqual(before);
        }
        expect(await page.locator(".k2b-chat-tasks__title").textContent()).toBe("All tasks done");
        // With no current step the highlight keeps its last place, hidden.
        expect(await page.locator(".k2b-chat-tasks__glide").getAttribute("data-hidden")).toBe("");
      } finally {
        await page.close();
      }
    });

    test("folding changes only the list's height: the header and the composer stay put", async () => {
      const page = await open(width);
      try {
        const composer = await box(page, "#composer");
        const header = await box(page, ".k2b-chat-tasks__header");
        const plan = await box(page, ".k2b-chat-tasks");
        await page.locator(".k2b-chat-tasks__header").click();
        await still(page);
        expect(await page.locator(".k2b-chat-tasks__header").getAttribute("aria-expanded")).toBe("false");
        expect(await box(page, "#composer")).toEqual(composer);
        expect(await box(page, ".k2b-chat-tasks__header")).toEqual(header);
        const folded = await box(page, ".k2b-chat-tasks");
        expect(folded.y + folded.height).toBe(plan.y + plan.height);
        expect(folded.height).toBe(plan.height - 4 * 32);
        // Folded, the current step shows beside the title and the rows leave the tab order.
        expect(await page.locator(".k2b-chat-tasks__now").evaluate((node) => getComputedStyle(node).visibility)).toBe("visible");
        expect(await page.locator(".k2b-chat-tasks__fold").evaluate((node) => (node as HTMLElement).inert)).toBe(true);
        await page.locator(".k2b-chat-tasks__header").focus();
        await page.keyboard.press("Enter");
        await still(page);
        expect(await page.locator(".k2b-chat-tasks__header").getAttribute("aria-expanded")).toBe("true");
        expect(await box(page, ".k2b-chat-tasks")).toEqual(plan);
        expect(await page.locator(".k2b-chat-tasks__now").evaluate((node) => getComputedStyle(node).visibility)).toBe("hidden");
      } finally {
        await page.close();
      }
    });

    test("type holds the rule: three styles from the steps, signs on one axis", async () => {
      const page = await open(width);
      try {
        const type = await meterType(page, ".k2b-chat-tasks", { signs: ".k2b-chat-tasks__ring, .k2b-chat-task__mark" });
        expect(type.styles).toEqual(["12/400", "13/400", "13/600"]);
        expect(type.offSizes).toEqual([]);
        expect(type.axes).toHaveLength(1);
        const still = await meterType(page, ".k2b-chat-task-list", { signs: ".k2b-chat-task__mark" });
        expect(still.styles).toEqual(["13/400"]);
        expect(still.axes).toHaveLength(1);
      } finally {
        await page.close();
      }
    });
  });
}

// Evidence for reviews: K2B_CHAT_TASKS_SCREENSHOTS=<dir> writes the plan in its states at both widths.
const screenshotDir = process.env.K2B_CHAT_TASKS_SCREENSHOTS;
test.if(Boolean(screenshotDir))(
  "screenshots of the plan in its states",
  async () => {
    mkdirSync(screenshotDir!, { recursive: true });
    for (const width of [1440, 390]) {
      const page = await open(width, { reduced: true });
      try {
        await page.setViewportSize({ width, height: width === 1440 ? 900 : 780 });
        await setTasks(page, ["completed", "in_progress", "pending", "pending"]);
        await page.screenshot({ path: `${screenshotDir}/tasks-open-${width}.png` });
        await page.evaluate(() => window.__setOpen(false));
        await settled(page);
        await page.screenshot({ path: `${screenshotDir}/tasks-folded-${width}.png` });
        await setTasks(page, ["completed", "completed", "completed", "completed"]);
        await page.screenshot({ path: `${screenshotDir}/tasks-done-${width}.png` });
      } finally {
        await page.close();
      }
    }
  },
  60_000,
);

test("long plans wrap rows, show about six, and scroll inside the list", async () => {
  const page = await open(390);
  try {
    await page.evaluate(() =>
      window.__setTasks(
        Array.from({ length: 12 }, (_, index) => ({
          id: `t${index}`,
          content:
            index === 1 ? "A long step that wraps onto a second line because the plan names its target in full" : `Step ${index + 1}`,
          status: index < 9 ? "completed" : index === 9 ? "in_progress" : "pending",
        })),
      ),
    );
    await settled(page);
    await page.waitForFunction(() => {
      const list = document.querySelector<HTMLElement>(".k2b-chat-tasks__list")!;
      const row = list.querySelector<HTMLElement>('[data-status="in_progress"]')!;
      return row.offsetTop >= list.scrollTop && row.offsetTop + row.offsetHeight <= list.scrollTop + list.clientHeight;
    });
    const list = await box(page, ".k2b-chat-tasks__list");
    expect(list.height).toBe(196);
    expect(
      (await page
        .locator(".k2b-chat-task")
        .nth(1)
        .evaluate((node) => node.getBoundingClientRect().height)) > 32,
    ).toBe(true);
    expect(await box(page, ".k2b-chat-tasks__glide")).toEqual(await box(page, '.k2b-chat-tasks .k2b-chat-task[data-status="in_progress"]'));
  } finally {
    await page.close();
  }
});

test("statuses read as words, the ring stops while paused, and reduced motion lands at once", async () => {
  const page = await open(1440, { reduced: true });
  try {
    expect(await page.locator(".k2b-chat-tasks .k2b-chat-task").first().textContent()).toBe("Write the changeIn progress");
    const mark = page.locator('.k2b-chat-tasks .k2b-chat-task[data-status="in_progress"] .k2b-chat-task__mark');
    expect(await mark.evaluate((node) => getComputedStyle(node).animationName)).toBe("k2b-chat-task-spin");
    expect(await mark.evaluate((node) => getComputedStyle(node).animationDuration)).toBe("0s");
    await page.evaluate(() => window.__setPaused(true));
    await settled(page);
    expect(await mark.evaluate((node) => getComputedStyle(node).animationName)).toBe("none");
    // Every timed change of the plan lands at once.
    const durations = await page
      .locator(".k2b-chat-tasks, .k2b-chat-tasks *")
      .evaluateAll((nodes) => [...new Set(nodes.flatMap((node) => getComputedStyle(node).transitionDuration.split(", ")))]);
    expect(durations).toEqual(["0s"]);
    await setTasks(page, ["completed", "in_progress", "pending", "pending"]);
    expect(
      await page.locator(".k2b-chat-tasks .k2b-chat-task__mark > i[data-fresh]").evaluate((node) => getComputedStyle(node).opacity),
    ).toBe("1");
  } finally {
    await page.close();
  }
});

test("dark: the tray keeps its plum tint and the highlight its surface", async () => {
  const page = await open(1440, { dark: true });
  try {
    const colours = await page.evaluate(() => {
      const style = (selector: string) => getComputedStyle(document.querySelector(selector)!).backgroundColor;
      const probe = document.createElement("span");
      document.querySelector(".k2b-chat-tasks")!.append(probe);
      probe.style.background = "var(--k2b-ai-surface)";
      const tray = getComputedStyle(probe).backgroundColor;
      probe.style.background = "var(--k2b-surface)";
      const surface = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { plan: style(".k2b-chat-tasks"), tray, glide: style(".k2b-chat-tasks__glide"), surface };
    });
    expect(colours.plan).toBe(colours.tray);
    expect(colours.glide).toBe(colours.surface);
  } finally {
    await page.close();
  }
});
