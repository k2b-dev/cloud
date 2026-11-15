import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../../../ui/test/browser";

// Layout and painted styles at the shared ApprovalCard seam require a real browser.
const ui = resolve(import.meta.dir, "../../../../ui");

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "action-question.browser-harness.tsx")],
    target: "browser",
    // MapView's lazy worker uses import.meta; keep the shared chat harness a module.
    format: "esm",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-action-question-test",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Action question harness build failed");
  return build.outputs[0]!.text();
};

let browser: Browser;
let harness: string;
let icons: { css: string; font: string };
let css = "";
beforeAll(async () => {
  const [bundle, styles] = await Promise.all([
    buildHarness(),
    Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../../styles.css")], plugins: [tailwind] }),
  ]);
  if (!styles.success) throw new AggregateError(styles.logs, "Could not compile the global stylesheet.");
  css = await styles.outputs[0]!.text();
  harness = bundle;
  const iconCss = fileURLToPath(import.meta.resolve("@k2b/ui/icons/tabler.css"));
  const iconSource = await Bun.file(iconCss).text();
  const font = iconSource.match(/url\((\.\/[^)"']+\.woff2)[^)]*\)/)?.[1];
  if (!font) throw new Error("The Tabler preset references no WOFF2 file.");
  icons = { css: iconSource.replace(font, "/tabler.woff2"), font: resolve(dirname(iconCss), font) };
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (width: number, query = "", reducedMotion: "reduce" | "no-preference" = "reduce", theme = "light") => {
  const context = await browser.newContext({ viewport: { width, height: 1100 }, reducedMotion });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Pin dates without replacing timers or animation frames: this test measures a real transition.
  await page.addInitScript((at) => {
    const RealDate = Date;
    globalThis.Date = new Proxy(RealDate, {
      construct(target, args) {
        return Reflect.construct(target, args.length ? args : [at]);
      },
      get(target, key, receiver) {
        return key === "now" ? () => at : Reflect.get(target, key, receiver);
      },
    });
  }, Date.parse("2026-10-17T12:02:00.000Z"));
  const origin = "https://cloud.example.test";
  await page.route(`${origin}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/harness.js") return route.fulfill({ contentType: "text/javascript", body: harness });
    if (path === "/tabler.css") return route.fulfill({ contentType: "text/css", body: icons.css });
    if (path === "/tabler.woff2") return route.fulfill({ path: icons.font });
    if (path === "/api/approvals/counts") return route.fulfill({ json: { total: 1, apps: { mail: 1 } } });
    if (path !== "/") return route.fulfill({ status: 404 });
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="de" class="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/tabler.css"><style>${css}</style></head><body class="k2b-ui${theme === "dark" ? " k2b-dark" : ""}" style="margin:0"><script type="module" src="/harness.js"></script></body></html>`,
    });
  });
  await page.goto(`${origin}/?${query}`);
  await page.locator(".k2b-chat-decision").first().waitFor();
  await settled(page);
  return { page, errors, close: () => context.close() };
};
const decision = (page: Page) => page.locator('[data-host="chat"] .k2b-chat-decision');

describe("ApprovalCard draft and host parity", () => {
  for (const motion of ["reduce", "no-preference"] as const)
    test(`draft → approval keeps its box at 764 px (${motion})`, async () => {
      const { page, errors, close } = await open(1100, "draft=1", motion);
      try {
        const card = decision(page);
        const before = (await card.boundingBox())!;
        const sentenceHeight = () => card.locator(".k2b-chat-decision__sentence").evaluate((node) => node.getBoundingClientRect().height);
        const sentenceBefore = await sentenceHeight();
        expect(before.width).toBe(764);
        const geometry = () =>
          card.evaluate((node) => {
            const css = getComputedStyle(node);
            return Object.fromEntries(
              ["padding", "margin", "borderWidth", "borderRadius", "fontSize", "lineHeight", "display"].map((key) => [
                key,
                css.getPropertyValue(key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)),
              ]),
            );
          });
        const stable = await geometry();
        const transition = await card.evaluate((node) => ({
          property: getComputedStyle(node).transitionProperty,
          duration: getComputedStyle(node).transitionDuration,
        }));
        if (motion === "reduce") expect(transition.duration).toBe("0s");
        else {
          expect(transition.property.split(", ").sort()).toEqual(["background-color", "border-color", "box-shadow"]);
          expect(transition.duration.split(", ").every((value) => value === "0.2s")).toBe(true);
        }
        await card.getByRole("button", { name: "An Lea Berg senden …", exact: true }).click();
        await page.waitForFunction(
          () => document.querySelector('[data-host="chat"] .k2b-chat-decision')?.getAttribute("data-mode") === "approve",
        );
        await settled(page);
        const after = (await card.boundingBox())!;
        // The question may be worded longer than the draft's intent and then grows downwards only; every other part,
        // the fields and the answer row above all, keeps its size.
        const grown = (await sentenceHeight()) - sentenceBefore;
        for (const key of ["x", "y", "width"] as const) expect(Math.abs(after[key] - before[key])).toBeLessThanOrEqual(1);
        expect(Math.abs(after.height - before.height - grown)).toBeLessThanOrEqual(1);
        expect(await geometry()).toEqual(stable);
        expect(errors).toEqual([]);
      } finally {
        await close();
      }
    });

  test("approval fields reject typing and Change restores editing", async () => {
    const { page, close } = await open(1100, "draft=1");
    try {
      const card = decision(page);
      const subject = card.getByLabel("Betreff", { exact: true });
      const body = card.getByLabel("Text", { exact: true });
      await subject.fill("Geänderter Betreff");
      await body.fill("Geänderter Text");
      await card.getByRole("button", { name: "An Lea Berg senden …", exact: true }).click();
      await page.waitForFunction(() => document.querySelector(".k2b-chat-decision")?.getAttribute("data-mode") === "approve");
      for (const field of [subject, body]) {
        expect(await field.getAttribute("readonly")).not.toBeNull();
        const value = await field.inputValue();
        await field.focus();
        await field.pressSequentially("should not change");
        expect(await field.inputValue()).toBe(value);
      }
      await card.getByRole("button", { name: "Ändern", exact: true }).click();
      expect(await subject.getAttribute("readonly")).toBeNull();
      await subject.fill("Wieder bearbeitbar");
      expect(await subject.inputValue()).toBe("Wieder bearbeitbar");
    } finally {
      await close();
    }
  });

  for (const theme of ["light", "dark"])
    test(`same approval has the same computed surface in chat, flat blue panel and page (${theme})`, async () => {
      const { page, errors, close } = await open(1100, "", "reduce", theme);
      try {
        const styles = await page.locator(".k2b-chat-decision").evaluateAll((nodes) =>
          nodes.map((node) => {
            const css = getComputedStyle(node);
            const approve = node.querySelector('.k2b-chat-decision__answer[data-variant="ai"]')!;
            return {
              background: css.backgroundColor,
              radius: css.borderRadius,
              padding: css.padding,
              approve: getComputedStyle(approve).backgroundColor,
            };
          }),
        );
        expect(styles).toHaveLength(3);
        expect(styles[1]).toEqual(styles[0]);
        expect(styles[2]).toEqual(styles[0]);
        expect(styles[0]!.background).not.toBe("rgba(0, 0, 0, 0)");
        expect(styles[0]!.radius).toBe("14px");
        expect(errors).toEqual([]);
      } finally {
        await close();
      }
    });

  test("390 px: answers fill the row above the facts in every host", async () => {
    const { page, close } = await open(390);
    try {
      const layouts = await page.locator(".k2b-chat-decision").evaluateAll((nodes) =>
        nodes.map((node) => {
          const answers = node.querySelector(".k2b-chat-decision__answers")!.getBoundingClientRect();
          const buttons = node.querySelector(".k2b-chat-decision__buttons")!.getBoundingClientRect();
          const facts = node.querySelector(".k2b-chat-decision__meta")!.getBoundingClientRect();
          return { row: answers.width, width: buttons.width, bottom: buttons.bottom, factsTop: facts.top };
        }),
      );
      expect(layouts).toHaveLength(3);
      for (const layout of layouts) {
        expect(Math.abs(layout.width - layout.row)).toBeLessThanOrEqual(1);
        expect(layout.factsTop).toBeGreaterThanOrEqual(layout.bottom);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    } finally {
      await close();
    }
  });
});
