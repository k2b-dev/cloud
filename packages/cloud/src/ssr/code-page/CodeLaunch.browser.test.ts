import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwind from "bun-plugin-tailwind";
import type { Browser, BrowserContext, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../../ui/test/browser";
import { HEAD_RUN_ID, HEAD_STATES, type HeadState } from "./head-action.fixture";

let browser: Browser;
let origin: string;
let stop: (() => void) | undefined;
const fonts = new Map<string, string>();
const contexts = new Map<string, BrowserContext>();
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
    format: "iife",
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
  harness = await build.outputs[0]!.text();
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
  // Serve immutable assets once, like the neighboring browser fixtures. Repeated route.fulfill copies
  // of the full bundle and base64 fonts make navigation dominate the unchanged five-second test budget.
  const assets = { "cache-control": "public, max-age=3600" };
  const served = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/__head.js") return new Response(harness, { headers: { ...assets, "content-type": "text/javascript" } });
      if (url.pathname === "/__head.css")
        return new Response(`${plex}\n${css}\n${icons}`, { headers: { ...assets, "content-type": "text/css" } });
      const font = fonts.get(url.pathname);
      if (font) return new Response(Bun.file(font), { headers: { ...assets, "content-type": "font/woff2" } });
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
    for (const context of contexts.values()) await context.close();
    await browser?.close();
  } finally {
    stop?.();
  }
});

const fixedNow = new Date("2026-11-14T12:49:04.000Z").getTime();
const html = (locale: string, theme: string) =>
  `<!doctype html><html lang="${locale}" data-theme="${theme}" class="${theme === "dark" ? "dark" : ""}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/__head.css"><script defer src="/__head.js"></script></head><body class="k2b-ui"><main id="root" style="padding:32px 24px;max-width:1440px;margin:auto"></main></body></html>`;
async function open(state: HeadState, width: number, locale = "de", theme = "light") {
  const key = `${width}-${theme}`;
  let context = contexts.get(key);
  if (!context) {
    context = await browser.newContext({
      viewport: { width, height: width === 390 ? 780 : 900 },
      reducedMotion: "reduce",
      hasTouch: width === 390,
      colorScheme: theme === "dark" ? "dark" : "light",
    });
    contexts.set(key, context);
  }
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
    await page.close();
    throw error;
  }
}
async function shot(page: Page, motif: string, width: number) {
  if (!process.env.CODE_HEAD_SHOTS) return;
  await settled(page);
  mkdirSync(process.env.CODE_HEAD_SHOTS, { recursive: true });
  await page.screenshot({ path: resolve(process.env.CODE_HEAD_SHOTS, `${motif}-light-${width}.png`), fullPage: false });
}
const boxes = (page: Page) =>
  page.evaluate(() =>
    [".cloud-code__head", ".cloud-code__tabs", ".cloud-code__lage", ".cloud-code__grid"].map((selector) => {
      const box = document.querySelector(selector)!.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    }),
  );
for (const width of [1440, 390]) {
  for (const state of HEAD_STATES)
    test(`${width}: ${state} follows the head decision table`, async () => {
      const page = await open(state, width);
      const errors = harnessErrors.get(page)!;
      try {
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
        if (state === "reader" || state === "reader-page" || state === "reader-waiting" || state === "paused-reader")
          expect(await head.getByRole("button", { name: "Mit Gustav ändern" }).count()).toBe(0);
        await settled(page);
        if (width === 390 && (await head.locator(".cloud-code__launch").count()) && (await head.locator(".cloud-code__change").count())) {
          expect((await head.locator(".cloud-code__launch").boundingBox())!.width).toBeGreaterThan(
            (await head.locator(".cloud-code__change").boundingBox())!.width,
          );
        }
        if (width === 390 && !["error", "loading"].includes(state)) {
          for (const target of await page
            .locator(
              ".cloud-code__head button:visible, .cloud-code__head a.k2b-button:visible, .cloud-code__run-now:visible, .cloud-code__pages .k2b-button:visible",
            )
            .all())
            expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(44);
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
      } finally {
        await page.close();
      }
    });
  test(`${width}: loading placeholders keep the loaded head and content positions`, async () => {
    const page = await open("loading", width);
    try {
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
    } finally {
      await page.close();
    }
  });
  test(`${width}: split menu, phone sheet, keyboard, opening and copy addresses`, async () => {
    const page = await open("both", width);
    try {
      const trigger = page.getByRole("button", { name: "Weitere Seiten und Läufe" });
      const before = await boxes(page);
      await trigger.focus();
      await page.keyboard.press("ArrowDown");
      await page.getByRole("menuitem", { name: "Vergangene Wochen", exact: true }).waitFor();
      expect(await page.getByRole("menuitem", { name: /wenn eine Nachricht/ }).count()).toBe(0);
      await shot(page, "both-menu", width);
      if (width === 390) expect(await page.locator(".k2b-dialog").count()).toBeGreaterThan(0);
      await page.keyboard.press("Escape");
      await settled(page);
      expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(true);
      expect(await boxes(page)).toEqual(before);
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
      await Promise.all([
        page.waitForURL(`${origin}/code/c_woche1/`, { waitUntil: "commit" }),
        page.locator(".cloud-code__head").getByRole("button", { name: "Öffnen", exact: true }).click(),
      ]);
    } finally {
      await page.close();
    }
  });
  test(`${width}: shared pending, same-key retry, live start, finish and own failure never move the page`, async () => {
    const page = await open("schedule", width);
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
          body: JSON.stringify({
            data: {
              runId: HEAD_RUN_ID,
              title: "Wochenbericht",
              state: "failed",
              status: "Fehlgeschlagen",
              at: "2026-11-14T12:49:04.000Z",
              reason: "Das Tageslimit wurde erreicht.",
              untilThen: { items: [], more: 0, moreText: null },
              complete: true,
            },
          }),
        });
    });
    try {
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
      await page.getByText("Lauf startet.", { exact: true }).waitFor();
      expect(page.url()).toBe(initialUrl);
      expect(await boxes(page)).toEqual(before);
      await shot(page, "queued", width);
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
      expect(await page.locator(".cloud-code__lage-cell").nth(1).textContent()).toContain("Läuft gerade");
      expect(await boxes(page)).toEqual(before);
      await shot(page, "running", width);
      const change = page.locator(".cloud-code__head").getByRole("button", { name: "Mit Gustav ändern" });
      await change.focus();
      await page.evaluate((id) => window.codeHead.run({ id, state: "failed", createdAt: "2026-11-14T12:49:04.000Z" }), HEAD_RUN_ID);
      await page.getByText("Das Tageslimit wurde erreicht.", { exact: true }).waitFor();
      expect(await page.locator(".cloud-code__state").getAttribute("data-tone")).toBe("danger");
      expect(await change.evaluate((element) => element === document.activeElement)).toBe(true);
      expect(await boxes(page)).toEqual(before);
      await shot(page, "own-failed", width);
    } finally {
      await page.close();
    }
  });
  test(`${width}: several schedules keep the menu trigger, selected pending row and terminal geometry`, async () => {
    const page = await open("schedules", width);
    let finish: (() => Promise<void>) | undefined;
    await page.route("**/api/capabilities/v1/actions/**", async (route) => {
      await new Promise<void>((resolve) => {
        finish = async () => {
          await route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({ data: { runId: HEAD_RUN_ID, duplicate: false } }),
          });
          resolve();
        };
      });
    });
    try {
      const before = await boxes(page);
      const trigger = page.locator(".cloud-code__head").getByRole("button", { name: "Jetzt ausführen" });
      await trigger.click();
      const selected = page.getByRole("menuitem", { name: /Erinnert an offene Aufgaben/ });
      await selected.click();
      await trigger.click();
      const pending = page.getByRole("menuitem", { name: /Erinnert an offene Aufgaben/ });
      await pending.waitFor();
      expect(await pending.getAttribute("aria-disabled")).toBe("true");
      expect(await pending.locator(".cloud-code__spin").count()).toBe(1);
      expect(await trigger.getAttribute("aria-busy")).toBeNull();
      await shot(page, "schedules-pending-menu", width);
      await page.keyboard.press("Escape");
      expect(finish).toBeDefined();
      await finish!();
      await page.getByText("Lauf startet.", { exact: true }).waitFor();
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
    } finally {
      await page.close();
    }
  });
  test(`${width}: a start with another running run makes no unconfirmed waiting claim`, async () => {
    const page = await open("schedule", width);
    await page.route("**/api/capabilities/v1/actions/**", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: { runId: HEAD_RUN_ID, duplicate: false } }) }),
    );
    try {
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
      await page.getByText("Lauf startet.", { exact: true }).waitFor();
      expect(await page.getByText("Lauf startet, sobald der laufende Lauf fertig ist.", { exact: true }).count()).toBe(0);
      expect(await boxes(page)).toEqual(before);
      await shot(page, "waiting-for-run", width);
    } finally {
      await page.close();
    }
  });
  test(`${width}: a lost response retries the same intent and remains on the overview`, async () => {
    const page = await open("schedule", width);
    const keys: string[] = [];
    await page.route("**/api/capabilities/v1/actions/**", async (route) => {
      keys.push(route.request().headers()["idempotency-key"]!);
      if (keys.length === 1) await route.abort("failed");
      else
        await route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: { runId: HEAD_RUN_ID, duplicate: true } }) });
    });
    try {
      const url = page.url();
      await page.getByRole("button", { name: "Jetzt ausführen", exact: true }).first().click();
      await page.getByText("„Jetzt ausführen“ hat nicht geklappt: keine Verbindung.", { exact: true }).waitFor();
      await shot(page, "start-error", width);
      await page.getByRole("button", { name: "Erneut versuchen", exact: true }).click();
      await page.getByText("Lauf startet.", { exact: true }).waitFor();
      expect(keys).toHaveLength(2);
      expect(keys[0]).toBeTruthy();
      expect(keys[1]).toBe(keys[0]);
      expect(page.url()).toBe(url);
    } finally {
      await page.close();
    }
  });
  for (const refusal of ["paused", "approval"] as const)
    test(`${width}: ${refusal} start rejection has an explicit recovery`, async () => {
      const page = await open("schedule", width);
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
              data: { code: { ...data.state.code, owner: { kind: "person", userId: "fixture-user" } }, permission: "editor" },
            }),
          });
        }
      });
      try {
        await page.getByRole("button", { name: "Jetzt ausführen", exact: true }).first().click();
        if (refusal === "paused") await page.getByRole("button", { name: "Fortsetzen", exact: true }).waitFor();
        else await page.getByRole("link", { name: "Version ansehen", exact: true }).waitFor();
        await settled(page);
        await shot(page, `rejected-${refusal}`, width);
      } finally {
        await page.close();
      }
    });
  test(`${width}: English, dark and reduced motion preserve the action and semantic colors`, async () => {
    const page = await open("mailbox", width, "en", "dark");
    try {
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
        await page.screenshot({ path: resolve(process.env.CODE_HEAD_SHOTS, `mailbox-dark-${width}.png`), fullPage: false });
    } finally {
      await page.close();
    }
  });
}
