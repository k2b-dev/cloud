import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, pageErrors, settled } from "../../../ui/test/browser";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import { approvalModel, approvalNow, approvalSnapshot, approvalStates, approvalVersionId } from "./code-version-card.test-fixture";

// Real Assistant CSS, typeface, icons, timeline and continuation. Fictional data, one browser at a time.
const ui = resolve(import.meta.dir, "../../../ui");
const cloud = resolve(import.meta.dir, "../../../cloud");
const shots = process.env.APPROVAL_CARD_SCREENSHOTS?.trim();
const appColors =
  "--app-accent:#8e1b6f;--app-ink-light:#8e1b6f;--app-ink-dark:#bf7dad;--app-selected-light:#f7eff5;--app-selected-dark:#231627;--app-selected-nav-light:#f4e8f1;--app-selected-nav-dark:#261629";
registerSsrTestPlugin({ dev: true, rootDir: mkdtempSync(resolve(tmpdir(), "assistant-approval-browser-")) });
let browser: Browser;
let assets: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  setSystemTime(new Date(approvalNow));
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "code-version-card.browser-harness.tsx")],
    target: "browser",
    format: "esm",
    minify: true,
    conditions: ["browser"],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [
      {
        name: "assistant-approval-card",
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
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the approval harness.");
  const script = await build.outputs[0]!.text();
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", cloud))).default;
  const outputs: string[] = [];
  for (const path of [resolve(import.meta.dir, "../styles/app.css"), resolve(import.meta.dir, "../../../../styles.css")]) {
    const output = await Bun.build({ entrypoints: [path], plugins: [tailwind] });
    if (!output.success) throw new AggregateError(output.logs, `Could not compile ${path}.`);
    outputs.push(await output.outputs[0]!.text());
  }
  const fonts = ["plex.css", "tabler.css"]
    .map((file) => readFileSync(resolve(ui, "dist", file), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, "url($1/ui/"))
    .join("\n");
  const css = [fonts, "@layer properties, theme, base, components, utilities;", ...outputs].join("\n");
  const preloads = [...fonts.matchAll(/url\(["']?([^"')]+\.woff2)/g)]
    .map((match) => match[1]!)
    .filter((path) => /\/(?:ibm-plex-sans-latin-(?:400|600)-normal-|tabler-icons-)/.test(path))
    .map((path) => `<link rel="preload" href="${path}" as="font" type="font/woff2" crossorigin>`)
    .join("");
  const { ApprovalSnapshotView } = await import("./code-version-card-ssr.test-fixture");
  const snapshot = approvalSnapshot("on");
  const serverHtml = renderToString(() =>
    createComponent(ApprovalSnapshotView, {
      initial: [{ codeId: "c_info01", versionId: approvalVersionId, state: "available", snapshot }],
    }),
  );
  const cache = { "cache-control": "public, max-age=3600" };
  assets = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/harness.js") return new Response(script, { headers: { "content-type": "text/javascript", ...cache } });
      if (url.pathname === "/harness.css") return new Response(css, { headers: { "content-type": "text/css", ...cache } });
      if (url.pathname.startsWith("/ui/")) return new Response(Bun.file(resolve(ui, "dist", url.pathname.slice(4))), { headers: cache });
      if (url.pathname === "/")
        return new Response(
          `<!doctype html><html lang="${url.searchParams.get("lang")}" class="${url.searchParams.get("theme")}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${preloads}<link rel="stylesheet" href="/harness.css"></head><body class="k2b-ui" style="margin:0"><div class="app-accent-scope" data-k2b-primary="ai" style="${appColors}">${url.searchParams.get("mode") === "snapshot" ? `<main id="snapshot-root" style="max-width:48rem;margin:0 auto;padding:24px 16px">${serverHtml}</main>` : ""}<script type="module" src="/harness.js"></script></div></body></html>`,
          { headers: { "content-type": "text/html" } },
        );
      return new Response("Not found", { status: 404 });
    },
  });
  browser = await launchBrowser();
}, 180_000);
afterAll(async () => {
  await browser?.close();
  assets?.stop(true);
  setSystemTime();
});

const open = async (width: number, theme: string, lang = "de", mode = "states") => {
  const context = await browser.newContext({
    viewport: { width, height: width < 600 ? 780 : 900 },
    locale: lang,
    reducedMotion: "reduce",
    isMobile: width < 600,
    hasTouch: width < 600,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = pageErrors(page);
  await page.addInitScript((at) => {
    const RealDate = Date;
    globalThis.Date = new Proxy(RealDate, {
      construct: (target, args, newTarget) => Reflect.construct(target, args.length ? args : [at], newTarget),
      apply: () => new RealDate(at).toString(),
      get: (target, property) => (property === "now" ? () => at : Reflect.get(target, property)),
    });
  }, Date.parse(approvalNow));
  await page.goto(`${assets.url.origin}/?${new URLSearchParams({ lang, theme, mode })}`);
  await page.waitForFunction(() => "setApprovalState" in window);
  await settled(page);
  return { page, errors, close: () => context.close() };
};
const setState = async (page: Page, state: string) => {
  await page.evaluate((state) => (window as unknown as { setApprovalState(state: string): void }).setApprovalState(state), state);
  await settled(page);
};
const boxes = (page: Page) =>
  page.evaluate(() => {
    const box = (selector: string) => {
      const rect = document.querySelector(selector)!.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    return {
      card: box(".assistant-code-version-host .cloud-approval-frame"),
      main: box(".k2b-notice-card__title"),
      quiet: box(".k2b-notice-card__description"),
      next: box("#following"),
    };
  });
const stableBoxes = async (page: Page) => {
  const { card, next } = await boxes(page);
  return { card, next };
};
const screenshot = async (page: Page, name: string, theme: string, width: number) => {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: resolve(shots, `approval-${name}-${theme}-${width}.png`) });
};

describe("v10 approval card in Chromium", () => {
  test("all twelve states stay in place in light/dark on desktop/phone; phone actions share width", async () => {
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"]) {
        const h = await open(width, theme);
        try {
          const first = await boxes(h.page);
          for (const state of [
            ...approvalStates,
            "on-single-page",
            "loading",
            "failed",
            "denied",
            "unknown",
            "checking",
            "pages-unavailable",
            "refresh-failed",
          ]) {
            await setState(h.page, state);
            const measured = await boxes(h.page);
            const noActions = width === 390 && state === "denied";
            if (noActions) expect(measured.card.height).toBeLessThan(first.card.height);
            else expect({ state, card: measured.card, next: measured.next }).toEqual({ state, card: first.card, next: first.next });
            expect(measured.quiet.y - measured.main.y - measured.main.height).toBeLessThanOrEqual(4);
            expect(measured.quiet.y - measured.main.y - measured.main.height).toBeGreaterThanOrEqual(0);
            if (width === 1440) expect(measured.card.height).toBe(64);
            expect(await h.page.locator(".assistant-code-version-host .k2b-notice-card__detail-text").getAttribute("title")).toBe(
              await h.page.locator(".assistant-code-version-host .k2b-notice-card__detail-text").textContent(),
            );
            const card = h.page.locator(".assistant-code-version-host .cloud-approval-frame");
            expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
            expect(await card.locator(".k2b-notice-card__icon").count()).toBe(1);
            expect(await card.locator(".k2b-chat-decision__details").count()).toBe(0);
            const actions = card.locator(".k2b-notice-card__actions > *");
            const count = await actions.count();
            expect(count).toBeLessThanOrEqual(2);
            if (width === 390 && count) {
              const row = (await card.locator(".k2b-notice-card__actions").boundingBox())!;
              const a = (await actions.first().boundingBox())!;
              if (count === 1) expect(Math.abs(a.width - row.width)).toBeLessThan(0.5);
              else {
                const b = (await actions.nth(1).boundingBox())!;
                expect(Math.abs(a.width - b.width)).toBeLessThan(0.5);
                expect(a.x).toBeLessThan(b.x);
                expect(await actions.first().locator(".k2b-button").getAttribute("data-variant")).toBe("secondary");
              }
              expect(a.y).toBeGreaterThanOrEqual(measured.quiet.y + measured.quiet.height);
              expect(
                a.y - measured.quiet.y - measured.quiet.height,
                `${state}: a buffer separates the text and decisions`,
              ).toBeGreaterThanOrEqual(12);
              expect(measured.card.y + measured.card.height - a.y - a.height).toBeCloseTo(11, 0);
              const quietStyle = await card.locator(".k2b-notice-card__detail-text").evaluate((element) => {
                const style = getComputedStyle(element);
                return {
                  whiteSpace: style.whiteSpace,
                  clamp: style.webkitLineClamp,
                  lineHeight: Number.parseFloat(style.lineHeight),
                  height: element.getBoundingClientRect().height,
                };
              });
              expect(quietStyle.whiteSpace).toBe("normal");
              expect(quietStyle.clamp).toBe("2");
              expect(quietStyle.height).toBeLessThanOrEqual(quietStyle.lineHeight * 2);
              for (const control of await actions.locator(".k2b-button").all()) {
                const bounds = (await control.boundingBox())!;
                expect(bounds.y + bounds.height).toBeLessThanOrEqual(measured.card.y + measured.card.height);
              }
              const filled =
                state === "on-single-page" ||
                state === "failed" ||
                state === "checking" ||
                state === "pages-unavailable" ||
                state === "refresh-failed" ||
                (approvalStates.includes(state as (typeof approvalStates)[number]) &&
                  approvalModel(state as (typeof approvalStates)[number]).primary?.filled);
              expect(await card.locator("[data-code-version-primary]").getAttribute("data-variant")).toBe(filled ? "ai" : "secondary");
            }
            if (state === "on-single-page")
              expect(await card.getByRole("link", { name: "Öffnen", exact: true }).getAttribute("href")).toBe("/code/c_info01/home");
            if (state === "on") expect(await card.locator(".k2b-split-button").count()).toBe(1);
            else expect(await card.getByRole("button", { name: "Öffnen", exact: true }).count()).toBe(0);
            await screenshot(h.page, state, theme, width);
          }
          expect(h.errors).toEqual([]);
        } finally {
          await h.close();
        }
      }
  }, 120_000);

  test("phone loading and a real failed-read retry keep the card and following message in place", async () => {
    for (const theme of ["light", "dark"]) {
      const h = await open(390, theme, "de", "load-retry");
      try {
        await h.page.waitForFunction(() => (window as unknown as { cardReadCount(): number }).cardReadCount() === 1);
        await h.page.locator(".assistant-code-version-host[data-state=loading] .cloud-approval-frame").waitFor();
        const first = await stableBoxes(h.page);
        expect(first.card.height).toBe(156);
        await screenshot(h.page, "loading", theme, 390);
        await h.page.evaluate(() => (window as unknown as { finishCardRead(state: string): void }).finishCardRead("failed"));
        await h.page.locator(".assistant-code-version-host[data-state=load-failed] .cloud-approval-frame").waitFor();
        expect(await stableBoxes(h.page)).toEqual(first);
        await h.page.getByRole("button", { name: "Erneut versuchen", exact: true }).click();
        await h.page.waitForFunction(() => (window as unknown as { cardReadCount(): number }).cardReadCount() === 2);
        // The real store retains the failed snapshot while its retry is pending; it never clears it to loading.
        expect(await h.page.locator(".assistant-code-version-host").getAttribute("data-state")).toBe("load-failed");
        expect(await stableBoxes(h.page)).toEqual(first);
        await h.page.evaluate(() => (window as unknown as { finishCardRead(state: string): void }).finishCardRead("ready"));
        await h.page.locator(".assistant-code-version-host[data-state=ready] .cloud-approval-frame").waitFor();
        expect(await stableBoxes(h.page)).toEqual(first);
        expect(h.errors).toEqual([]);
      } finally {
        await h.close();
      }
    }
  }, 60_000);

  test("event jump focuses the main control on both widths; SplitButton offers only the other projected pages", async () => {
    for (const width of [1440, 390]) {
      const h = await open(width, "light");
      try {
        await setState(h.page, "ready");
        await h.page.getByRole("button", { name: "Zur Karte", exact: true }).click();
        expect(await h.page.locator("[data-code-version-primary]").evaluate((element) => element === document.activeElement)).toBe(true);
        await screenshot(h.page, "focus-jump", "light", width);
        await setState(h.page, "on");
        const menu = h.page.getByRole("button", { name: "Weitere Seiten", exact: true });
        await menu.focus();
        await h.page.keyboard.press("Enter");
        await h.page.getByRole("menuitem", { name: "Monatsübersicht", exact: true }).waitFor();
        expect(await h.page.getByRole("menuitem", { name: "Einstellungen", exact: true }).getAttribute("href")).toBe(
          "/code/c_info01/settings",
        );
        expect(await h.page.getByRole("menuitem", { name: "Lieferscheine", exact: true }).count()).toBe(0);
        if (width === 390) expect(await h.page.locator(".k2b-gesture-menu__sheet-menu").count()).toBeGreaterThan(0);
        else {
          const bounds = await h.page.getByRole("menu").boundingBox();
          const cardBounds = await h.page.locator(".assistant-code-version-host .cloud-approval-frame").boundingBox();
          expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(cardBounds!.x + cardBounds!.width);
          expect(await h.page.getByRole("menu").getByText("Weitere Seiten", { exact: true }).count()).toBe(0);
        }
        await screenshot(h.page, "pages", "light", width);
        await h.page.keyboard.press("Escape");
        await h.page.locator("[data-code-version-primary]").click();
        await h.page.waitForURL("**/code/c_info01/home");
        expect(h.errors).toEqual([]);
      } finally {
        await h.close();
      }
    }
  }, 60_000);

  test("keyboard activation retains focus after failure and the phone leaves no room change", async () => {
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"]) {
        const h = await open(width, theme, "de", "interactive");
        try {
          await h.page.locator(".assistant-code-version-host[data-state=ready] .cloud-approval-frame").waitFor();
          const first = await boxes(h.page);
          const primary = h.page.locator("[data-code-version-primary]");
          await primary.focus();
          await h.page.keyboard.press("Enter");
          await h.page.locator(".assistant-code-version-host[data-state=switching] .cloud-approval-frame").waitFor();
          expect(await stableBoxes(h.page)).toEqual({ card: first.card, next: first.next });
          await h.page.evaluate(() => (window as unknown as { finishActivation(ok: boolean): void }).finishActivation(false));
          await h.page.getByRole("alert").filter({ hasText: "Einschalten hat nicht geklappt." }).waitFor();
          // No focus() after answering the failure: the component must restore it.
          expect(await h.page.locator("[data-code-version-primary]").evaluate((element) => element === document.activeElement)).toBe(true);
          expect(await stableBoxes(h.page)).toEqual({ card: first.card, next: first.next });
          await screenshot(h.page, "failure-focus", theme, width);
          expect(h.errors).toEqual([]);
        } finally {
          await h.close();
        }
      }
  }, 60_000);

  test("English remains readable at phone width", async () => {
    const h = await open(390, "light", "en");
    try {
      for (const state of approvalStates) {
        await setState(h.page, state);
        expect(
          await h.page
            .locator(".assistant-code-version-host .cloud-approval-frame")
            .evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
      }
      expect(h.errors).toEqual([]);
    } finally {
      await h.close();
    }
  }, 60_000);
  test("server output and first browser card agree, including openable pages, without a mount read", async () => {
    for (const width of [1440, 390]) {
      const h = await open(width, "light", "de", "snapshot");
      try {
        const agreement = await h.page.evaluate(() => {
          const w = window as unknown as { snapshotBefore: { text: string; rect: DOMRect }; cardReadCount(): number };
          return {
            before: w.snapshotBefore,
            after: {
              text: (document.querySelector("#snapshot-root") as HTMLElement).innerText,
              rect: document.querySelector(".assistant-code-version-host .cloud-approval-frame")!.getBoundingClientRect().toJSON(),
            },
            reads: w.cardReadCount(),
          };
        });
        expect(agreement.after).toEqual(agreement.before);
        expect(agreement.reads).toBe(0);
        await h.page.getByRole("button", { name: "Weitere Seiten", exact: true }).click();
        await h.page.getByRole("menuitem", { name: "Monatsübersicht", exact: true }).waitFor();
        expect(h.errors).toEqual([]);
      } finally {
        await h.close();
      }
    }
  }, 60_000);

  test("successful keyboard activation focuses Open unless deliberately moved; the real transition never moves the next message", async () => {
    for (const width of [1440, 390])
      for (const move of [false, true]) {
        const h = await open(width, "light", "de", "interactive");
        try {
          await h.page.locator(".assistant-code-version-host[data-state=ready] .cloud-approval-frame").waitFor();
          const first = await stableBoxes(h.page);
          const primary = h.page.locator("[data-code-version-primary]");
          await primary.focus();
          const before = await h.page.screenshot();
          await h.page.keyboard.press("Enter");
          await h.page.locator(".assistant-code-version-host[data-state=switching] .cloud-approval-frame").waitFor();
          if (move) await h.page.getByRole("button", { name: "Zur Karte", exact: true }).focus();
          await h.page.evaluate(() => (window as unknown as { finishActivation(ok: boolean): void }).finishActivation(true));
          await h.page.locator(".assistant-code-version-host[data-state=on] .cloud-approval-frame").waitFor();
          await settled(h.page);
          expect(await h.page.evaluate(() => document.activeElement?.textContent)).toBe(move ? "Zur Karte" : "Öffnen");
          expect(await stableBoxes(h.page)).toEqual(first);
          if (!move) {
            await screenshot(h.page, "success-focus", "light", width);
            if (shots) {
              const after = await h.page.screenshot();
              await h.page.evaluate(
                async ({ before, after }) => {
                  const images = await Promise.all(
                    [before, after].map(
                      (data) =>
                        new Promise<HTMLImageElement>((resolve) => {
                          const img = new Image();
                          img.onload = () => resolve(img);
                          img.src = `data:image/png;base64,${data}`;
                        }),
                    ),
                  );
                  const canvas = document.createElement("canvas");
                  canvas.width = images[0]!.width;
                  canvas.height = images[0]!.height * 2;
                  const ctx = canvas.getContext("2d")!;
                  images.forEach((img, i) => ctx.drawImage(img, 0, i * img.height));
                  (window as unknown as { transitionImage: string }).transitionImage = canvas.toDataURL("image/png");
                },
                { before: before.toString("base64"), after: after.toString("base64") },
              );
              const data = await h.page.evaluate(() => (window as unknown as { transitionImage: string }).transitionImage);
              await Bun.write(resolve(shots, `approval-transition-light-${width}.png`), Buffer.from(data.split(",")[1]!, "base64"));
            }
          }
          expect(h.errors).toEqual([]);
        } finally {
          await h.close();
        }
      }
  }, 60_000);

  test("pause and approval share the row form and public sizes; an overtaken phone receipt frees the action space", async () => {
    for (const width of [1440, 390]) {
      const h = await open(width, "light", "de", "comparison");
      try {
        const pause = h.page.locator(".assistant-authoring-stop");
        const card = h.page.locator(".assistant-code-version-host .cloud-approval-frame");
        const before = await pause.boundingBox();
        const approval = (await card.boundingBox())!;
        expect(before!.height).toBe(approval.height);
        expect(before!.x).toBe(approval.x);
        expect(before!.width).toBe(approval.width);
        const edges = await h.page.evaluate(() =>
          [".assistant-authoring-stop", ".assistant-code-version-host .cloud-approval-frame"].map((selector) => {
            const card = document.querySelector(selector)!;
            const content = card.querySelector(".k2b-notice-card__title")!;
            const icon = card.querySelector(".k2b-notice-card__icon")!;
            return {
              contentX: content.getBoundingClientRect().x,
              iconX: icon.getBoundingClientRect().x,
              iconFont: getComputedStyle(icon).fontSize,
              iconWidth: icon.getBoundingClientRect().width,
              columns: getComputedStyle(card).gridTemplateColumns.split(" ")[0],
              gap: getComputedStyle(card).columnGap,
              padding: getComputedStyle(card).paddingInlineStart,
            };
          }),
        );
        expect(edges[0]).toEqual(edges[1]);
        if (width === 390) {
          for (const selector of [
            ".assistant-authoring-stop .k2b-notice-card__detail-text",
            ".assistant-code-version-host .k2b-notice-card__detail-text",
          ]) {
            expect(await h.page.locator(selector).evaluate((element) => getComputedStyle(element).webkitLineClamp)).toBe("2");
          }
        }
        expect(await pause.getByRole("button", { name: "Weiterarbeiten", exact: true }).getAttribute("data-size")).toBe(
          width === 390 ? "md" : "sm",
        );
        expect(await pause.getByRole("button").getAttribute("data-variant")).toBe("secondary");
        await screenshot(h.page, "pause-and-approval", "light", width);
        await h.page.evaluate(() => (window as unknown as { setRetired(value: boolean): void }).setRetired(true));
        await settled(h.page);
        expect(await pause.getByRole("button").count()).toBe(0);
        if (width === 390) expect((await pause.boundingBox())!.height).toBeLessThan(before!.height - 40);
        expect(h.errors).toEqual([]);
      } finally {
        await h.close();
      }
    }
  }, 60_000);
  test("real chat insets leave every phone action inside the card, including long labels", async () => {
    const h = await open(390, "light", "de", "comparison");
    try {
      const card = h.page.locator(".assistant-code-version-host .cloud-approval-frame");
      const first = (await card.boundingBox())!;
      for (const state of approvalStates) {
        await setState(h.page, state);
        const bounds = (await card.boundingBox())!;
        expect(bounds).toEqual(first);
        for (const action of await card.locator(".k2b-notice-card__actions > * .k2b-button").all()) {
          const control = (await action.boundingBox())!;
          expect(control.y + control.height).toBeLessThanOrEqual(bounds.y + bounds.height);
        }
        if (state === "changes") await screenshot(h.page, "pause-and-approval-changes", "light", 390);
      }
      expect(h.errors).toEqual([]);
    } finally {
      await h.close();
    }
  }, 60_000);
});
