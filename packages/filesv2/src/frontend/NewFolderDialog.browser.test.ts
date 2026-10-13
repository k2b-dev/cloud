import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";
import type { FolderBatchResult, FolderResult } from "../contracts";

// Crumb truncation, fixed preview heights and keyboard focus need a real layout engine.
const ui = new URL("../../../ui/", import.meta.url).pathname;
const appCss = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8")
  // Tailwind directives; the dialog uses only its own classes and @k2b/ui.
  .replace(/^@(import|source|custom-variant)[^\n]*\n/gm, "");

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./NewFolderDialog.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-new-folder-test",
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
  if (!build.success) throw new AggregateError(build.logs, "New folder harness build failed");
  return build.outputs[0]!.text();
};

const harness = await buildHarness();
const assets: Record<string, [string, string | Buffer]> = {
  "/harness.js": ["text/javascript; charset=utf-8", harness],
  // As in Cloud: the app sheet first, @k2b/ui after it.
  "/app.css": ["text/css", appCss],
  "/styles.css": ["text/css", readFileSync(`${ui}dist/styles.css`, "utf8")],
  "/tabler.css": ["text/css", readFileSync(`${ui}dist/tabler.css`, "utf8")],
};
const page = (lang: string) =>
  `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<link rel="stylesheet" href="/tabler.css"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/styles.css">` +
  `</head><body class="k2b-ui" data-theme="light"><div id="root"></div><script src="/harness.js"></script></body></html>`;

const desktop: BrowserContextOptions = { viewport: { width: 1366, height: 768 } };
const phone: BrowserContextOptions = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const endpoint = "/api/filesv2/bases/base-1/directories/batch";
const folder = ".filesv2-new-folder";
const input = `${folder} input`;
const summary = `${folder}__summary`;
const label = `${folder}__label > span`;
const rows = `${folder}__row`;
const preview = `${folder}__preview`;
const cancel = `${folder}__actions button[type="button"]`;
const submit = `${folder}__actions button[type="submit"]`;
const paths = (...names: string[]) => names.map((name) => `Projects/2026/${name}`);

type BatchRequest = { paths: string[]; dryRun?: boolean };
const base: FolderBatchResult["base"] = {
  id: "base-1",
  area: "cloud",
  kind: "users",
  name: "My files",
  status: "existing",
  reason: null,
  indexEnabled: false,
  versioningEnabled: false,
};

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (options: BrowserContextOptions, lang = "en", parent?: string) => {
  const requests: BatchRequest[] = [];
  const model = { existing: new Set(paths("Reports")), failures: new Set<string>(), requests };
  const context = await browser.newContext({ ...options, reducedMotion: "reduce" });
  const tab = await context.newPage();
  await tab.route("http://new-folder.test/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/") return route.fulfill({ contentType: "text/html", body: page(lang) });
    if (path === endpoint && request.method() === "POST") {
      const body: BatchRequest = request.postDataJSON();
      model.requests.push(body);
      let stopped = false;
      const results = body.paths.map((path): FolderResult => {
        if (stopped) return { path, state: "skipped" };
        if (model.existing.has(path)) return { path, state: "existing" };
        if (body.dryRun) return { path, state: "planned" };
        if (model.failures.has(path)) {
          stopped = true;
          return { path, state: "failed", error: "forbidden", message: "No permission" };
        }
        model.existing.add(path);
        return { path, state: "created" };
      });
      return route.fulfill({ status: 200, json: { base, results } satisfies FolderBatchResult });
    }
    const asset = assets[path] ?? (path.endsWith(".woff2") ? ["font/woff2", readFileSync(`${ui}dist${path}`)] : null);
    return asset ? route.fulfill({ contentType: asset[0], body: asset[1] }) : route.fulfill({ status: 404 });
  });
  await tab.goto("http://new-folder.test/");
  await tab.waitForFunction(() => !!window.newFolder);
  await show(tab, parent);
  return { tab, model };
};
const show = async (tab: Page, parent?: string) => {
  await tab.evaluate((parent) => window.newFolder.open({ parent }), parent);
  await tab.waitForSelector("dialog[open] .filesv2-new-folder");
  await tab.waitForFunction(() => document.activeElement === document.querySelector(".filesv2-new-folder input"));
  await tab.evaluate(() => document.fonts.ready.then(() => undefined));
};
const fill = async (tab: Page, value: string, expected: string[]) => {
  const checked = tab.waitForRequest((request) => {
    if (new URL(request.url()).pathname !== endpoint || request.method() !== "POST") return false;
    const body: BatchRequest = request.postDataJSON();
    return body.dryRun === true && JSON.stringify(body.paths) === JSON.stringify(expected);
  });
  await tab.locator(input).fill(value);
  const response = await (await checked).response();
  expect(response?.status()).toBe(200);
  await response?.finished();
};
const text = async (tab: Page, selector: string, value: string) => {
  await tab.waitForFunction(({ selector, value }) => document.querySelector(selector)?.textContent === value, { selector, value });
  expect(await tab.textContent(selector)).toBe(value);
};
const names = (tab: Page) => tab.$$eval(`${folder}__name`, (elements) => elements.map((element) => element.textContent));

/** Unrounded boxes: half a pixel is the most any reserved surface may move. */
const boxes = (tab: Page, selectors = ["dialog[open]", `${folder}__crumb`, input, preview, `${folder}__tree`, cancel, submit]) =>
  tab.evaluate(
    (selectors) =>
      Object.fromEntries(
        selectors.map((selector) => {
          const box = document.querySelector(selector)!.getBoundingClientRect();
          return [selector, [box.left, box.top, box.width, box.height]];
        }),
      ),
    selectors,
  );
const unchanged = (before: Record<string, number[]>, after: Record<string, number[]>) => {
  for (const [selector, box] of Object.entries(before)) {
    for (const [index, value] of box.entries()) expect(Math.abs(after[selector]![index]! - value)).toBeLessThanOrEqual(0.5);
  }
};
const crumb = (tab: Page) =>
  tab.evaluate(() => {
    const element = document.querySelector<HTMLElement>(".filesv2-new-folder__crumb")!;
    return {
      text: element.textContent,
      typed: element.querySelector(".filesv2-new-folder__typed")?.textContent ?? "",
      height: element.getBoundingClientRect().height,
      overflow: element.scrollWidth - element.clientWidth,
      whiteSpace: getComputedStyle(element).whiteSpace,
    };
  });

describe("new folder dialog in a browser", () => {
  for (const [device, options] of [
    ["desktop", desktop],
    ["phone", phone],
  ] as const) {
    test(`on ${device} the live crumb and every reserved box hold still through each keystroke`, async () => {
      const { tab } = await open(options);
      try {
        const first = await boxes(tab);
        let value = "";
        for (const character of "Reports/Q1,Q2, Q3") {
          await tab.keyboard.type(character, { delay: 0 });
          value += character;
          expect(await tab.inputValue(input)).toBe(value);
          const location = await crumb(tab);
          expect(location.typed).toBe(value.split("/").join(" / "));
          expect(location.text).toBe(`My files/Projects / 2026/${value.split("/").join(" / ")}`);
          expect(location.height).toBe(24);
          expect(location.whiteSpace).toBe("nowrap");
          expect(location.overflow).toBeLessThanOrEqual(0);
          unchanged(first, await boxes(tab));
        }
        await text(tab, summary, "Creates 3 folders");
        unchanged(first, await boxes(tab));
      } finally {
        await tab.context().close();
      }
    });

    test(`on ${device} a long parent gives way while the base and typed ending stay visible`, async () => {
      const parent = Array.from({ length: 8 }, (_, index) => `Segment${index}-${"x".repeat(11)}`).join("/");
      const { tab } = await open(options, "en", parent);
      try {
        const value = "Quarterly planning and supporting documents/Final report for the autumn review";
        await tab.locator(input).fill(value);
        const location = await crumb(tab);
        expect(location.typed).toBe(value.split("/").join(" / "));
        expect(location.height).toBe(24);
        expect(location.whiteSpace).toBe("nowrap");
        expect(location.overflow).toBeLessThanOrEqual(0);
        const layout = await tab.evaluate(() => {
          const crumb = document.querySelector(".filesv2-new-folder__crumb")!.getBoundingClientRect();
          const parent = document.querySelector<HTMLElement>(".filesv2-new-folder__parent")!;
          const base = document.querySelector<HTMLElement>(".filesv2-new-folder__base")!;
          const typed = document.querySelector<HTMLElement>(".filesv2-new-folder__typed")!;
          return {
            parentOverflow: parent.scrollWidth - parent.clientWidth,
            baseWidth: base.getBoundingClientRect().width,
            baseLeft: base.getBoundingClientRect().left,
            baseRight: base.getBoundingClientRect().right,
            typedRight: typed.getBoundingClientRect().right,
            typedWidth: typed.getBoundingClientRect().width,
            direction: getComputedStyle(typed).direction,
            ellipsis: getComputedStyle(typed).textOverflow,
            left: crumb.left,
            right: crumb.right,
          };
        });
        expect(layout.parentOverflow).toBeGreaterThan(0);
        expect(layout.baseWidth).toBeGreaterThan(0);
        expect(await tab.isVisible(`${folder}__base`)).toBeTrue();
        expect(layout.baseLeft).toBeGreaterThanOrEqual(layout.left);
        expect(layout.baseRight).toBeLessThanOrEqual(layout.right);
        expect(layout.typedWidth).toBeGreaterThan(0);
        expect(layout.typedRight).toBeLessThanOrEqual(layout.right);
        expect(layout.direction).toBe("rtl");
        expect(layout.ellipsis).toBe("ellipsis");
      } finally {
        await tab.context().close();
      }
    });

    test(`on ${device} the preview counts new folders and the comma mode works by keyboard`, async () => {
      const { tab } = await open(options);
      try {
        await fill(tab, "Reports/Q1,Q2, Q3", paths("Reports", "Reports/Q1", "Reports/Q2", "Reports/Q3"));
        await text(tab, `${rows}:nth-child(1) ${folder}__note`, "exists");
        expect(await names(tab)).toEqual(["Reports", "Q1", "Q2", "Q3"]);
        const icons = await tab.$$eval(`${rows} > i`, (elements) => elements.map((element) => element.getBoundingClientRect().left));
        for (const left of icons.slice(1)) expect(left).toBeGreaterThan(icons[0]!);
        await text(tab, summary, "Creates 3 folders");
        await text(tab, label, "Create 3 folders");
        expect(await tab.isVisible('[role="radiogroup"][aria-label="Comma"]')).toBeTrue();
        await tab.focus(input);
        await tab.keyboard.press("Tab");
        expect(await tab.evaluate(() => document.activeElement?.textContent)).toBe("Separates folders");
        await tab.keyboard.press("ArrowRight");
        expect(await tab.evaluate(() => document.activeElement?.textContent)).toBe("Part of the name");
        expect(await tab.getAttribute('[role="radio"]:has-text("Part of the name")', "aria-checked")).toBe("true");
        expect(await names(tab)).toEqual(["Reports", "Q1,Q2, Q3"]);
        await text(tab, label, "Create folder");
        await tab.keyboard.press("ArrowLeft");
        expect(await names(tab)).toEqual(["Reports", "Q1", "Q2", "Q3"]);
        await text(tab, label, "Create 3 folders");
      } finally {
        await tab.context().close();
      }
    });

    test(`on ${device} invalid names and duplicates block submission`, async () => {
      const { tab, model } = await open(options);
      try {
        await tab.locator(input).fill("A//B");
        await text(tab, `${rows}:nth-child(2) ${folder}__note`, "Empty name");
        expect(await tab.getAttribute(`${rows}:nth-child(2) ${folder}__name`, "data-empty")).toBe("true");
        expect(await tab.isDisabled(submit)).toBeTrue();
        await tab.keyboard.press("Enter");
        expect(model.requests.filter((request) => !request.dryRun)).toEqual([]);
        expect(await tab.isVisible("dialog[open]")).toBeTrue();
        await tab.locator(input).fill("A/B,B");
        expect(await names(tab)).toEqual(["A", "B", "B"]);
        await text(tab, `${rows}:nth-child(3) ${folder}__note`, "Listed twice");
        expect(await tab.isDisabled(submit)).toBeTrue();
        expect(model.requests.filter((request) => !request.dryRun)).toEqual([]);
      } finally {
        await tab.context().close();
      }
    });

    test(`on ${device} Enter creates the exact plan and Escape cancels a fresh dialog`, async () => {
      const { tab, model } = await open(options);
      try {
        const expected = paths("Reports", "Reports/Q1", "Reports/Q2");
        await fill(tab, "Reports/Q1,Q2", expected);
        await text(tab, summary, "Creates 2 folders");
        await tab.keyboard.press("Enter");
        await tab.waitForFunction(() => window.newFolder.result !== null);
        expect(model.requests.filter((request) => !request.dryRun)).toEqual([{ paths: expected }]);
        expect(await tab.isVisible("dialog[open]")).toBeFalse();
        const result = await tab.evaluate(() => window.newFolder.result);
        if (!result || result === "cancelled") throw new Error("Missing folder batch result");
        expect(result.results).toEqual(
          expected.map((path, index): FolderResult => ({ path, state: index === 0 ? "existing" : "created" })),
        );
        expect(await tab.evaluate(() => window.newFolder.partials)).toBe(0);
        const beforeCancel = model.requests.length;
        await show(tab);
        expect(await tab.evaluate(() => window.newFolder.result)).toBeNull();
        await tab.keyboard.press("Escape");
        await tab.waitForFunction(() => window.newFolder.result === "cancelled");
        expect(await tab.isVisible("dialog[open]")).toBeFalse();
        expect(await tab.evaluate(() => window.newFolder.result)).toBe("cancelled");
        expect(model.requests.slice(beforeCancel).filter((request) => !request.dryRun)).toEqual([]);
      } finally {
        await tab.context().close();
      }
    });

    test(`on ${device} a partial failure stays open without moving the preview or buttons`, async () => {
      const { tab, model } = await open(options);
      try {
        model.failures.add("Projects/2026/Reports/Q2");
        const expected = paths("Reports", "Reports/Q1", "Reports/Q2", "Reports/Q3");
        await fill(tab, "Reports/Q1,Q2,Q3", expected);
        await text(tab, summary, "Creates 3 folders");
        const first = await boxes(tab, [preview, cancel, submit]);
        await tab.keyboard.press("Enter");
        await text(tab, summary, "1 created, 1 failed, 1 not created");
        expect(await tab.getAttribute(summary, "data-tone")).toBe("danger");
        expect(await tab.$$eval(`${folder}__note`, (elements) => elements.map((element) => element.textContent))).toEqual([
          "exists",
          "created",
          "No permission",
          "not created",
        ]);
        expect(await tab.isVisible("dialog[open]")).toBeTrue();
        expect(await tab.evaluate(() => window.newFolder.result)).toBeNull();
        expect(await tab.evaluate(() => window.newFolder.partials)).toBe(1);
        expect(model.requests.filter((request) => !request.dryRun)).toEqual([{ paths: expected }]);
        unchanged(first, await boxes(tab, [preview, cancel, submit]));
      } finally {
        await tab.context().close();
      }
    });

    test(`on ${device} the count, submit label and comma choices follow the German locale`, async () => {
      const { tab } = await open(options, "de");
      try {
        await fill(tab, "Reports/Q1,Q2", paths("Reports", "Reports/Q1", "Reports/Q2"));
        await text(tab, summary, "Erstellt 2 Ordner");
        await text(tab, label, "2 Ordner anlegen");
        expect(
          await tab.$$eval('[role="radiogroup"][aria-label="Komma"] [role="radio"]', (elements) =>
            elements.map((element) => element.textContent),
          ),
        ).toEqual(["Als Trennzeichen", "Als Teil des Namens"]);
      } finally {
        await tab.context().close();
      }
    });
  }

  test("on a 390 px phone the dialog fits and the comma control keeps the preview in place", async () => {
    const { tab } = await open(phone);
    try {
      const first = await boxes(tab, [preview]);
      const fits = async () => {
        const layout = await tab.$eval("dialog[open]", (element) => {
          const box = element.getBoundingClientRect();
          return { left: box.left, right: box.right, overflow: element.scrollWidth - element.clientWidth };
        });
        expect(layout.left).toBeGreaterThanOrEqual(0);
        expect(layout.right).toBeLessThanOrEqual(390);
        expect(layout.overflow).toBeLessThanOrEqual(0);
      };
      await fits();
      await fill(tab, "Reports/Q1", paths("Reports", "Reports/Q1"));
      await text(tab, summary, "Creates 1 folder");
      expect(await tab.isVisible('[role="radiogroup"]')).toBeFalse();
      unchanged(first, await boxes(tab, [preview]));
      await fill(tab, "Reports/Q1,Q2", paths("Reports", "Reports/Q1", "Reports/Q2"));
      await text(tab, summary, "Creates 2 folders");
      expect(await tab.isVisible('[role="radiogroup"]')).toBeTrue();
      unchanged(first, await boxes(tab, [preview]));
      await fits();
    } finally {
      await tab.context().close();
    }
  });
});
