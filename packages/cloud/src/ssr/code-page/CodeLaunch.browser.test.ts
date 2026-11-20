import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../../ui/test/browser";
import { HEAD_RUN_ID, HEAD_STATES, type HeadState } from "./head-action.fixture";

let browser: Browser;
let origin: string;
let stop: (() => void) | undefined;
const fonts = new Map<string, string>();
const scripts = new Map<string, string>();
const fontBodies = new Map<string, ArrayBuffer>();
const harnessErrors = new WeakMap<Page, string[]>();
let harness: string;
let css: string;
let icons: string;
/** IBM Plex, which Cloud ships, so the wrap is measured with the product's widths. */
let plex: string;
beforeAll(async () => {
  const ui = resolve(import.meta.dir, "../../../../ui");
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "CodeLaunch.browser-harness.tsx")],
    target: "browser",
    format: "esm",
    splitting: true,
    minify: true,
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-code-handle",
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
  if (!build.success) throw new AggregateError(build.logs, "Head harness build failed");
  const entry = build.outputs.find((output) => output.kind === "entry-point");
  if (!entry) throw new Error("Missing head harness entry");
  harness = await entry.text();
  for (const output of build.outputs) scripts.set(`/${basename(output.path)}`, await output.text());
  const styles = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../../styles.css")], plugins: [tailwind] });
  if (!styles.success) throw new AggregateError(styles.logs, "Head stylesheet build failed");
  css = await styles.outputs[0]!.text();
  const iconPath = fileURLToPath(import.meta.resolve("@k2b/ui/icons/tabler.css"));
  const source = await Bun.file(iconPath).text();
  const font = source.match(/url\((\.\/[^)"']+\.woff2)[^)]*\)/)?.[1];
  if (!font) throw new Error("Missing Tabler WOFF2 file");
  fonts.set("/__icons.woff2", resolve(dirname(iconPath), font));
  icons = source.replace(/url\([^)]+\)/, 'url("/__icons.woff2")');
  const plexPath = fileURLToPath(import.meta.resolve("@k2b/ui/fonts/plex.css"));
  plex = await Bun.file(plexPath).text();
  const plexFiles = [...new Set(plex.match(/\.\/fonts\/[^)"']+\.woff2/g) ?? [])];
  if (!plexFiles.length) throw new Error("Missing IBM Plex WOFF2 files");
  for (const file of plexFiles) fonts.set(file.slice(1), resolve(dirname(plexPath), file));
  for (const [path, file] of fonts) fontBodies.set(path, await Bun.file(file).arrayBuffer());
  const stylesheet = `${plex}\n${css}\n${icons}`;
  // Serve immutable assets once, like the neighboring browser fixtures. Repeated route.fulfill copies
  // of the full bundle and base64 fonts make navigation dominate the unchanged five-second test budget.
  const assets = { "cache-control": "public, max-age=3600" };
  const served = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/__head.js") return new Response(harness, { headers: { ...assets, "content-type": "text/javascript" } });
      if (url.pathname === "/__head.css") return new Response(stylesheet, { headers: { ...assets, "content-type": "text/css" } });
      const script = scripts.get(url.pathname);
      if (script !== undefined) return new Response(script, { headers: { ...assets, "content-type": "text/javascript" } });
      const font = fontBodies.get(url.pathname);
      if (font) return new Response(font, { headers: { ...assets, "content-type": "font/woff2" } });
      if (request.headers.get("sec-fetch-dest") === "document")
        return new Response(html(url.searchParams.get("locale") ?? "de", url.searchParams.get("theme") ?? "light"), {
          headers: { "content-type": "text/html" },
        });
      return Response.json({ error: { code: "app_unavailable", message: "Unavailable" } }, { status: 503 });
    },
  });
  origin = `http://127.0.0.1:${served.port}`;
  stop = () => void served.stop(true);
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    stop?.();
  }
});

const fixedNow = new Date("2026-11-14T12:49:04.000Z").getTime();
const fontPreloads = () =>
  [...fonts.keys()]
    .filter((path) => path === "/__icons.woff2" || /latin-(400|500|600)-normal/.test(path))
    .map((path) => `<link rel="preload" as="font" type="font/woff2" href="${path}" crossorigin>`)
    .join("");
const html = (locale: string, theme: string) =>
  `<!doctype html><html lang="${locale}" data-theme="${theme}" class="${theme === "dark" ? "dark" : ""}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${fontPreloads()}<link rel="stylesheet" href="/__head.css"><script type="module" src="/__head.js"></script></head><body class="k2b-ui"><main id="root" style="padding:32px 24px;max-width:1440px;margin:auto"></main></body></html>`;
async function open(state: HeadState, width: number, locale = "de", theme = "light") {
  const context = await browser.newContext({
    viewport: { width, height: width === 390 ? 780 : 900 },
    reducedMotion: "reduce",
    hasTouch: width === 390,
    colorScheme: theme === "dark" ? "dark" : "light",
  });
  const page = await context.newPage();
  try {
    harnessErrors.set(page, pageErrors(page));
    await page.addInitScript((at) => {
      const RealDate = Date;
      globalThis.Date = new Proxy(RealDate, {
        construct: (target, args) => Reflect.construct(target, args.length ? args : [at]),
        apply: () => new RealDate(at).toString(),
        get: (target, key, receiver) => (key === "now" ? () => at : Reflect.get(target, key, receiver)),
      });
      let key = 0;
      Object.defineProperty(crypto, "randomUUID", { value: () => `00000000-0000-4000-8000-${String(++key).padStart(12, "0")}` });
    }, fixedNow);
    await page.goto(`${origin}/?state=${state}&locale=${locale}&theme=${theme}`);
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    await settled(page);
    return page;
  } catch (error) {
    await page.context().close();
    throw error;
  }
}
async function shot(page: Page, motif: string, width: number) {
  if (!process.env.CODE_HEAD_SHOTS) return;
  await settled(page);
  mkdirSync(process.env.CODE_HEAD_SHOTS, { recursive: true });
  await page.screenshot({
    path: resolve(process.env.CODE_HEAD_SHOTS, `${motif}-${await page.locator("html").getAttribute("data-theme")}-${width}.png`),
    fullPage: false,
  });
}
const failedRunFixture = {
  runId: HEAD_RUN_ID,
  title: "Wochenbericht",
  state: "failed",
  status: "Fehlgeschlagen",
  at: "2026-11-14T12:49:04.000Z",
  reason: "Das Tageslimit wurde erreicht.",
  untilThen: { items: [], more: 0, moreText: null },
  complete: true,
};
async function holdStarts(page: Page) {
  const finishes: (() => Promise<void>)[] = [];
  let started = Promise.withResolvers<void>();
  await page.route("**/api/capabilities/v1/actions/**", async (route) => {
    await new Promise<void>((resolve) => {
      const id = finishes.length === 0 ? HEAD_RUN_ID : "00000000-0000-4000-8000-999900000003";
      finishes.push(async () => {
        await route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: { runId: id, duplicate: false } }) });
        resolve();
      });
      const received = started;
      started = Promise.withResolvers<void>();
      received.resolve();
    });
  });
  return {
    finishes,
    waitForStarts: async (count: number) => {
      while (finishes.length < count) await started.promise;
    },
  };
}
const timingBoxes = (page: Page) =>
  page.locator(".cloud-code__when .cloud-code__row").evaluateAll((rows) =>
    rows.map((row) => {
      const trail = row.querySelector(".cloud-code__row-trail")!;
      const next = trail.querySelector(".cloud-code__meta")!;
      const main = row.querySelector(".cloud-code__row-main")!;
      const rect = (element: Element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      };
      const rowBox = rect(row);
      const trailBox = rect(trail);
      const nextBox = rect(next);
      const mainBox = rect(main);
      const padding = parseFloat(getComputedStyle(main).paddingRight);
      if (nextBox.x + nextBox.width > mainBox.x + mainBox.width - padding + 0.5) throw new Error("Next start crossed the row padding");
      if (innerWidth === 390 && nextBox.y < trailBox.y + 16) throw new Error("Next start left its reserved second line");
      return { row: rowBox, trail: trailBox, next: nextBox, main: mainBox };
    }),
  );
const boxes = (page: Page) =>
  page.evaluate(() =>
    [".cloud-code__head", ".cloud-code__tabs", ".cloud-code__lage", ".cloud-code__grid"].map((selector) => {
      const box = document.querySelector(selector)!.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    }),
  );
/** Fresh page per scenario; the test lifecycle also closes it after an assertion failure. */
function scene(name: string, state: HeadState, width: number, locale: string, theme: string, check: (page: Page) => Promise<void>) {
  describe(name, () => {
    let page: Page | undefined;
    beforeEach(async () => {
      page = await open(state, width, locale, theme);
    });
    afterEach(async () => {
      await page?.context().close();
    });
    test("interactions and layout", async () => {
      await check(page!);
    });
  });
}
for (const theme of ["light", "dark"])
  for (const width of [1440, 390]) {
    for (const state of HEAD_STATES)
      scene(`${theme} ${width}: ${state} follows the head decision table`, state, width, "de", theme, async (page) => {
        const errors = harnessErrors.get(page)!;
        const head = page.locator(".cloud-code__head");
        const primary = head.locator('[data-variant="primary"]');
        if (["page", "pages", "both", "mailbox", "reader-page", "reader-waiting"].includes(state))
          expect(await head.getByText("Öffnen", { exact: true }).count()).toBe(1);
        if (["schedule", "manual", "schedules"].includes(state))
          expect(await head.getByText("Jetzt ausführen", { exact: true }).count()).toBe(1);
        if (["reader", "partial", "error", "loading", "events"].includes(state))
          expect(await head.locator(".cloud-code__launch").count()).toBe(0);
        if (state === "events" || state === "needs-you")
          expect(await head.getByRole("button", { name: "Mit Gustav ändern" }).getAttribute("data-variant")).toBe("primary");
        if (state === "waiting" || state === "reader-waiting") expect(await primary.count()).toBe(0);
        if (state === "paused") expect(await head.getByRole("button", { name: "Fortsetzen" }).count()).toBe(1);
        if (state === "paused-reader") {
          const button = head.getByRole("button", { name: "Öffnen" });
          expect(await button.getAttribute("aria-disabled")).toBe("true");
          expect(await button.getAttribute("disabled")).toBeNull();
          await button.focus();
          expect(await button.evaluate((element) => element === document.activeElement)).toBe(true);
        }
        if (state.startsWith("reader") || state === "paused-reader") {
          expect(await page.locator(".cloud-code").textContent()).not.toContain("Dein Code");
          expect(await page.locator(".cloud-code").textContent()).not.toContain("Läuft als du");
          expect(await page.locator(".cloud-code").textContent()).not.toMatch(/deine Postfächer|dein Kontingent|Deine Seiten/);
        }
        if (state === "pages" || state === "both") {
          await settled(page);
          const list = page.locator(".cloud-code__pages .cloud-code__row");
          expect((await list.first().locator(".cloud-code__row-title").textContent())?.trim()).toBe("Startseite");
          if (width === 1440)
            for (const row of await list.all()) {
              const title = (await row.locator(".cloud-code__row-title").boundingBox())!;
              const actions = row.locator(".cloud-code__row-trail .k2b-button");
              const positions = await actions.evaluateAll((items) =>
                items.map((item) => {
                  const { x, y, height } = item.getBoundingClientRect();
                  return { x, y, height };
                }),
              );
              expect(new Set(positions.map((box) => box.y)).size).toBe(1);
              expect(Math.abs(positions[0]!.y - title.y)).toBeLessThanOrEqual(4);
              const open = row.getByRole("link", { name: "Öffnen", exact: true });
              if (await open.count()) expect(await open.locator("i").count()).toBe(1);
            }
        }
        if (state === "reader" || state === "reader-page" || state === "reader-waiting" || state === "paused-reader")
          expect(await head.getByRole("button", { name: "Mit Gustav ändern" }).count()).toBe(0);
        await settled(page);
        if (width === 390 && (await head.locator(".cloud-code__launch").count()) && (await head.locator(".cloud-code__change").count())) {
          expect((await head.locator(".cloud-code__launch").boundingBox())!.width).toBeGreaterThan(
            (await head.locator(".cloud-code__change").boundingBox())!.width,
          );
        }
        if (width === 390 && !["error", "loading"].includes(state)) {
          const heights = await page
            .locator(
              ".cloud-code__head button:visible, .cloud-code__head a.k2b-button:visible, .cloud-code__run-now:visible, .cloud-code__pages .k2b-button:visible",
            )
            .evaluateAll((targets) => targets.map((target) => target.getBoundingClientRect().height));
          for (const height of heights) expect(height).toBeGreaterThanOrEqual(44);
        }
        expect(
          await page.evaluate(() =>
            [...document.querySelectorAll<HTMLElement>("body *")]
              .filter((element) => {
                const box = element.getBoundingClientRect();
                return box.width > 0 && box.right > innerWidth;
              })
              .map((element) => ({
                cls: element.className,
                width: element.getBoundingClientRect().width,
                right: element.getBoundingClientRect().right,
              })),
          ),
        ).toEqual([]);
        await shot(page, state, width);
        if (state === "both" && width === 390) {
          await page.locator(".cloud-code__pages").scrollIntoViewIfNeeded();
          await shot(page, "pages-and-addresses", width);
        }
        expect(errors).toEqual([]);
      });
    scene(
      `${theme} ${width}: loading placeholders keep the loaded head and content positions`,
      "loading",
      width,
      "de",
      theme,
      async (page) => {
        const before = await boxes(page);
        const islands = () =>
          page.locator(".cloud-code__o1, .cloud-code__o2").evaluateAll((elements) =>
            elements.map((element) => {
              const { x, y, width, height } = element.getBoundingClientRect();
              return { x, y, width, height };
            }),
          );
        const islandsBefore = await islands();
        await page.evaluate(() => window.codeHead.show("schedule"));
        await settled(page);
        const after = await boxes(page);
        expect(after.map(({ x, y, width }) => ({ x, y, width }))).toEqual(before.map(({ x, y, width }) => ({ x, y, width })));
        expect(after.slice(0, 3)).toEqual(before.slice(0, 3));
        expect(await islands()).toEqual(islandsBefore);
      },
    );
    scene(`${theme} ${width}: split menu, phone sheet and keyboard keep focus and geometry`, "both", width, "de", theme, async (page) => {
      const trigger = page.getByRole("button", { name: "Weitere Seiten und Automationen" });
      const before = await boxes(page);
      await trigger.focus();
      await page.keyboard.press("ArrowDown");
      await page.getByRole("menuitem", { name: "Vergangene Wochen", exact: true }).waitFor();
      expect(await page.getByRole("menuitem", { name: /wenn eine Nachricht/ }).count()).toBe(0);
      await shot(page, "both-menu", width);
      if (width === 390) {
        expect(await page.locator(".k2b-dialog").count()).toBeGreaterThan(0);
        expect(await page.getByRole("dialog", { name: "Weitere Seiten und Automationen", exact: true }).count()).toBe(1);
      }
      await page.keyboard.press("Escape");
      await settled(page);
      expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(true);
      expect(await boxes(page)).toEqual(before);
    });
    scene(`${theme} ${width}: page addresses copy and report clipboard failures`, "both", width, "de", theme, async (page) => {
      const pages = page.locator(".cloud-code__pages");
      expect(await pages.getByRole("link", { name: "Öffnen", exact: true }).count()).toBe(2);
      expect(await pages.getByText("Startseite", { exact: true }).count()).toBe(1);
      await page.evaluate(() =>
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            writeText: async (text: string) => {
              document.body.dataset.copied = text;
            },
          },
        }),
      );
      await pages.getByRole("button", { name: "Adresse kopieren" }).last().click();
      expect(await page.locator("body").getAttribute("data-copied")).toBe(`${origin}/code/c_woche1/inbox`);
      await page.evaluate(() =>
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            writeText: async () => {
              throw new Error("Fixture clipboard refusal");
            },
          },
        }),
      );
      await pages.getByRole("button", { name: "Adresse kopieren" }).last().click();
      await page.getByText("Die Adresse konnte nicht kopiert werden.", { exact: true }).waitFor();
      await shot(page, "copy-error", width);
    });
    scene(`${theme} ${width}: the primary Open action navigates to the home page`, "both", width, "de", theme, async (page) => {
      await Promise.all([
        page.waitForURL(`${origin}/code/c_woche1/`, { waitUntil: "commit" }),
        page.locator(".cloud-code__head").getByRole("button", { name: "Öffnen", exact: true }).click(),
      ]);
    });
    scene(
      `${theme} ${width}: head and overview share pending and keep their place after the start`,
      "schedule",
      width,
      "de",
      theme,
      async (page) => {
        let finish: (() => Promise<void>) | undefined;
        const keys: string[] = [];
        await page.route("**/api/capabilities/v1/**", async (route) => {
          if (route.request().url().includes("/actions/")) {
            keys.push(route.request().headers()["idempotency-key"]!);
            await new Promise<void>((resolve) => {
              finish = async () => {
                await route.fulfill({
                  contentType: "application/json",
                  body: JSON.stringify({ data: { runId: HEAD_RUN_ID, duplicate: keys.length > 1 } }),
                });
                resolve();
              };
            });
          } else
            await route.fulfill({
              contentType: "application/json",
              body: JSON.stringify({ data: failedRunFixture }),
            });
        });
        const start = page.getByRole("button", { name: "Jetzt ausführen", exact: true });
        const initialUrl = page.url();
        const before = await boxes(page);
        await start.first().click();
        await page.waitForFunction(() => document.querySelectorAll('[aria-busy="true"]').length >= 2);
        expect(await start.first().isDisabled()).toBe(true);
        expect(await start.last().isDisabled()).toBe(true);
        expect(await boxes(page)).toEqual(before);
        await shot(page, "starting", width);
        expect(finish).toBeDefined();
        await finish!();
        await page
          .getByRole("region", { name: "Benachrichtigungen, Alt+T", exact: true })
          .getByText("Lauf startet.", { exact: true })
          .waitFor();
        expect(page.url()).toBe(initialUrl);
        expect(await boxes(page)).toEqual(before);
        await shot(page, "queued", width);
      },
    );
    scene(
      `${theme} ${width}: an own running and failed run preserves timing, focus and geometry`,
      "schedule",
      width,
      "de",
      theme,
      async (page) => {
        await page.route("**/api/capabilities/v1/**", (route) =>
          route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({
              data: route.request().url().includes("/actions/") ? { runId: HEAD_RUN_ID, duplicate: false } : failedRunFixture,
            }),
          }),
        );
        const before = await boxes(page);
        const timingBefore = await timingBoxes(page);
        await page.getByRole("button", { name: "Jetzt ausführen", exact: true }).first().click();
        await page
          .getByRole("region", { name: "Benachrichtigungen, Alt+T", exact: true })
          .getByText("Lauf startet.", { exact: true })
          .waitFor();
        await page.evaluate(
          (id) =>
            window.codeHead.run({
              id,
              state: "running",
              createdAt: "2026-11-14T12:49:00.000Z",
              startedAt: "2026-11-14T12:49:00.000Z",
              entrypoint: "wochenbericht",
            }),
          HEAD_RUN_ID,
        );
        expect(await page.locator(".cloud-code__lage-cell").nth(1).textContent()).toContain("Läuft gerade · von dir gestartet");
        expect(await boxes(page)).toEqual(before);
        expect(await timingBoxes(page)).toEqual(timingBefore);
        await shot(page, "running", width);
        const change = page.locator(".cloud-code__head").getByRole("button", { name: "Mit Gustav ändern" });
        await change.focus();
        await page.evaluate((id) => window.codeHead.run({ id, state: "failed", createdAt: "2026-11-14T12:49:04.000Z" }), HEAD_RUN_ID);
        await page.getByText("Der Lauf ist fehlgeschlagen: Das Tageslimit wurde erreicht.", { exact: true }).waitFor();
        const [tone, focused, afterFailure] = await Promise.all([
          page.locator(".cloud-code__state").getAttribute("data-tone"),
          change.evaluate((element) => element === document.activeElement),
          boxes(page),
        ]);
        expect(tone).toBe("danger");
        expect(focused).toBe(true);
        expect(afterFailure).toEqual(before);
        await shot(page, "own-failed", width);
      },
    );
    scene(`${theme} ${width}: only the selected pending schedule is disabled`, "schedules", width, "de", theme, async (page) => {
      const { finishes, waitForStarts } = await holdStarts(page);
      const trigger = page.locator(".cloud-code__head").getByRole("button", { name: "Jetzt ausführen" });
      await trigger.click();
      await page.getByRole("menuitem", { name: /Erinnert an offene Aufgaben/ }).click();
      await waitForStarts(1);
      await trigger.and(page.locator('[aria-expanded="false"]')).waitFor();
      await trigger.click();
      const pending = page.getByRole("menuitem", { name: /Erinnert an offene Aufgaben/ });
      expect(await pending.getAttribute("aria-disabled")).toBe("true");
      expect(await pending.locator(".cloud-code__spin").count()).toBe(1);
      expect(await pending.textContent()).toContain("Wird gestartet …");
      expect(await page.getByRole("menuitem", { name: /Erstellt den Wochenbericht/ }).getAttribute("aria-disabled")).not.toBe("true");
      expect(await trigger.getAttribute("aria-busy")).toBeNull();
      await shot(page, "schedules-pending-menu", width);
      await finishes[0]!();
    });
    scene(`${theme} ${width}: concurrent menu starts retain both receipts`, "schedules", width, "de", theme, async (page) => {
      const { finishes, waitForStarts } = await holdStarts(page);
      const trigger = page.locator(".cloud-code__head").getByRole("button", { name: "Jetzt ausführen" });
      await trigger.click();
      await page.getByRole("menuitem", { name: /Erinnert an offene Aufgaben/ }).click();
      await waitForStarts(1);
      await trigger.and(page.locator('[aria-expanded="false"]')).waitFor();
      await trigger.click();
      const first = page.getByRole("menuitem", { name: /Erinnert an offene Aufgaben/ });
      await first.locator(".cloud-code__spin").waitFor();
      expect(await first.getAttribute("aria-disabled")).toBe("true");
      const second = page.getByRole("menuitem", { name: /Erstellt den Wochenbericht/ });
      expect(await second.getAttribute("aria-disabled")).not.toBe("true");
      await second.click();
      // A phone sheet runs the selection only after leaving history. A completed click is not a started request.
      await waitForStarts(2);
      await trigger.and(page.locator('[aria-expanded="false"]')).waitFor();
      await trigger.click();
      await second.locator(".cloud-code__spin").waitFor();
      expect(await second.getAttribute("aria-disabled")).toBe("true");
      expect(await first.getAttribute("aria-disabled")).toBe("true");
      expect(await trigger.getAttribute("aria-busy")).toBeNull();
      expect(finishes).toHaveLength(2);
      // Out-of-order receipts must preserve the first start; pending-state interleavings are checked in the DOM behavior test.
      await finishes[1]!();
      await finishes[0]!();
      await page.waitForFunction(
        () => [...document.querySelectorAll(".k2b-toast__description")].filter((item) => item.textContent === "Lauf startet.").length === 2,
      );
      expect(harnessErrors.get(page)).toEqual([]);
    });
    scene(
      `${theme} ${width}: own run attribution distinguishes a queued start from a running one`,
      "schedules",
      width,
      "de",
      theme,
      async (page) => {
        const labels = await page.evaluate((id) => {
          const second = "00000000-0000-4000-8000-999900000003";
          const createdAt = "2026-11-14T12:49:04.000Z";
          // The command receipts identify ownership; live hints then update those same records.
          window.codeHead.run({ id, state: "running", entrypoint: "reminder", createdAt, startedHere: true });
          window.codeHead.run({ id: second, state: "queued", entrypoint: "wochenbericht", createdAt, startedHere: true });
          const label = () => document.querySelectorAll(".cloud-code__lage-cell")[1]!.textContent;
          const waiting = label();
          window.codeHead.run({ id: second, state: "succeeded", entrypoint: "wochenbericht", createdAt });
          return { waiting, running: label() };
        }, HEAD_RUN_ID);
        expect(labels.waiting).toContain("dein Lauf wartet");
        expect(labels.running).toContain("von dir gestartet");
        expect(harnessErrors.get(page)).toEqual([]);
      },
    );
    scene(
      `${theme} ${width}: several schedules update only the running row without moving terminal geometry`,
      "schedules",
      width,
      "de",
      theme,
      async (page) => {
        const before = await boxes(page);
        await page.evaluate(
          (id) => window.codeHead.run({ id, state: "running", entrypoint: "reminder", createdAt: "2026-11-14T12:49:04.000Z" }),
          HEAD_RUN_ID,
        );
        const rows = page.locator(".cloud-code__when .cloud-code__row");
        expect(await rows.nth(0).textContent()).not.toContain("Läuft gerade");
        expect(await rows.nth(1).textContent()).toContain("Läuft gerade");
        expect(await rows.nth(2).textContent()).not.toContain("Läuft gerade");
        expect(await boxes(page)).toEqual(before);
        await shot(page, "schedules-running", width);
        await page.evaluate(
          (id) => window.codeHead.run({ id, state: "succeeded", entrypoint: "reminder", createdAt: "2026-11-14T12:49:04.000Z" }),
          HEAD_RUN_ID,
        );
        expect(await boxes(page)).toEqual(before);
        await shot(page, "schedules-finished", width);
        expect(harnessErrors.get(page)).toEqual([]);
      },
    );
    scene(
      `${theme} ${width}: a start with another running run makes no unconfirmed waiting claim`,
      "schedule",
      width,
      "de",
      theme,
      async (page) => {
        await page.route("**/api/capabilities/v1/actions/**", (route) =>
          route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: { runId: HEAD_RUN_ID, duplicate: false } }) }),
        );
        await page.evaluate(() =>
          window.codeHead.run({
            id: "00000000-0000-4000-8000-999900000002",
            state: "running",
            entrypoint: "wochenbericht",
            createdAt: "2026-11-14T12:49:00.000Z",
          }),
        );
        const before = await boxes(page);
        await page.getByRole("button", { name: "Jetzt ausführen", exact: true }).first().click();
        await page
          .getByRole("region", { name: "Benachrichtigungen, Alt+T", exact: true })
          .getByText("Lauf startet.", { exact: true })
          .waitFor();
        expect(await page.getByText("Lauf startet, sobald der laufende Lauf fertig ist.", { exact: true }).count()).toBe(0);
        expect(await boxes(page)).toEqual(before);
        expect(await page.locator(".cloud-code__lage-cell").nth(1).textContent()).toContain("Läuft gerade · dein Lauf wartet");
        await shot(page, "waiting-for-run", width);
      },
    );
    scene(
      `${theme} ${width}: a lost response retries the same intent and remains on the overview`,
      "schedule",
      width,
      "de",
      theme,
      async (page) => {
        const keys: string[] = [];
        await page.route("**/api/capabilities/v1/actions/**", async (route) => {
          keys.push(route.request().headers()["idempotency-key"]!);
          if (keys.length === 1) await route.abort("failed");
          else
            await route.fulfill({
              contentType: "application/json",
              body: JSON.stringify({ data: { runId: HEAD_RUN_ID, duplicate: true } }),
            });
        });
        const url = page.url();
        await page.getByRole("button", { name: "Jetzt ausführen", exact: true }).first().click();
        await page.getByText("„Jetzt ausführen“ hat nicht geklappt: keine Verbindung.", { exact: true }).waitFor();
        await shot(page, "start-error", width);
        await page.getByRole("button", { name: "Erneut versuchen", exact: true }).click();
        // A toast also writes to its visually hidden live region. Keep both present to catch an unscoped locator.
        await page.locator("[data-k2b-live]").getByText("Lauf startet.", { exact: true }).waitFor({ state: "attached" });
        await page
          .getByRole("region", { name: "Benachrichtigungen, Alt+T", exact: true })
          .getByText("Lauf startet.", { exact: true })
          .waitFor();
        expect(keys).toHaveLength(2);
        expect(keys[0]).toBeTruthy();
        expect(keys[1]).toBe(keys[0]);
        expect(page.url()).toBe(url);
      },
    );
    for (const refusal of ["paused", "approval"] as const)
      scene(`${theme} ${width}: ${refusal} start rejection has an explicit recovery`, "schedule", width, "de", theme, async (page) => {
        await page.route("**/api/capabilities/v1/**", async (route) => {
          if (route.request().url().includes("/actions/"))
            await route.fulfill({
              status: refusal === "paused" ? 409 : 403,
              contentType: "application/json",
              body: JSON.stringify({ code: refusal === "paused" ? "CONFLICT" : "code_approval_required", message: "Fixture refusal" }),
            });
          else {
            const { headActionFixture } = await import("./head-action.fixture");
            const data = headActionFixture("paused");
            if (data.state.kind !== "ready") throw new Error("Expected ready fixture");
            await route.fulfill({
              contentType: "application/json",
              body: JSON.stringify({
                data: {
                  code: {
                    ...data.state.code,
                    pausedBy: { name: "Lena" },
                    pauseReason: "manual",
                    pausedAt: "2026-11-14T12:49:04.000Z",
                    owner: { kind: "person", userId: "fixture-user" },
                  },
                  permission: "editor",
                },
              }),
            });
          }
        });
        await page.getByRole("button", { name: "Jetzt ausführen", exact: true }).first().click();
        if (refusal === "paused") {
          await page.getByRole("button", { name: "Fortsetzen", exact: true }).waitFor();
          await page.getByText("Nicht gestartet: Lena hat die Automation inzwischen pausiert.", { exact: true }).waitFor();
          expect(await page.locator(".cloud-code__head-text > .cloud-code__meta").textContent()).toContain("seit eben von Lena");
        } else {
          await page.getByRole("link", { name: "Version ansehen", exact: true }).waitFor();
          expect(await page.locator(".cloud-code__head").getByRole("button", { name: "Jetzt ausführen", exact: true }).count()).toBe(1);
          await page.getByText("Diese Version braucht erst eine neue Freigabe.", { exact: true }).waitFor();
        }
        await settled(page);
        await shot(page, `rejected-${refusal}`, width);
      });
    scene(
      `${theme} ${width}: English, dark and reduced motion preserve the action and semantic colors`,
      "mailbox",
      width,
      "en",
      "dark",
      async (page) => {
        expect(await page.locator(".cloud-code__head").getByRole("button", { name: "Open", exact: true }).count()).toBe(1);
        await settled(page);
        const colors = await page.evaluate(() => {
          const open = document.querySelector<HTMLElement>(".cloud-code__launch .k2b-button")!;
          const change = document.querySelector<HTMLElement>(".cloud-code__change")!;
          const icon = change.querySelector("i")!;
          const probe = document.createElement("span");
          open.append(probe);
          probe.style.color = "var(--k2b-action-solid)";
          const action = getComputedStyle(probe).color;
          probe.style.color = "var(--k2b-ai-accent)";
          const ai = getComputedStyle(probe).color;
          const result = {
            fill: getComputedStyle(open).backgroundColor,
            action,
            icon: getComputedStyle(icon).color,
            ai,
            transition: getComputedStyle(open).transitionDuration,
          };
          probe.remove();
          return result;
        });
        expect(colors.fill).toBe(colors.action);
        expect(colors.icon).toBe(colors.ai);
        expect(colors.transition.split(",").every((duration) => duration.trim() === "0s")).toBe(true);
        expect(harnessErrors.get(page)).toEqual([]);
        if (process.env.CODE_HEAD_SHOTS)
          await page.screenshot({ path: resolve(process.env.CODE_HEAD_SHOTS, `mailbox-en-dark-${width}.png`), fullPage: false });
      },
    );
  }
