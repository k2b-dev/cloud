import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Browser, BrowserContextOptions } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";

// Card layout, touch targets and hover stability need a real layout engine.
const ui = new URL("../../../ui/", import.meta.url).pathname;
const appCss = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8")
  // Tailwind directives; the overview uses app classes and @k2b/ui.
  .replace(/^@(import|source|custom-variant)[^\n]*\n/gm, "");

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./StorageOverview.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-storage-overview-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Storage overview harness build failed");
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
const page = (theme: "light" | "dark", lang: string) =>
  `<!doctype html><html lang="${lang}" class="${theme === "dark" ? "dark" : ""}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<link rel="stylesheet" href="/tabler.css"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/styles.css">` +
  `</head><body class="k2b-ui" data-theme="${theme}"><div id="root"></div><script src="/harness.js"></script></body></html>`;

const desktop: BrowserContextOptions = { viewport: { width: 1366, height: 768 } };
const phone: BrowserContextOptions = { viewport: { width: 390, height: 780 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

// Recent loads itself after the tiles, as the overview does in Cloud; a failure stays inside its section.
const recent = ["Notes.md", "Notes.md", "Plan.txt"].map((name, index) => ({
  base: {
    id: ["valentin", "accounts", "projects"][index]!,
    name: ["valentin", "accounts", "projects"][index]!,
    kind: index ? "groups" : "users",
    area: "cloud",
  },
  entry: { name, path: `Docs/${name}`, directory: false, size: 0, modified: "2026-10-01T00:00:00Z" },
  markedAt: `2026-10-0${index + 1}T00:00:00Z`,
}));
type RecentResponse = () => { status: number; body: unknown };
const recentOk: RecentResponse = () => ({ status: 200, body: recent });

const open = async (options: BrowserContextOptions, theme: "light" | "dark" = "light", lang = "en", recentResponse = recentOk) => {
  const context = await browser.newContext({ ...options, reducedMotion: "reduce" });
  const tab = await context.newPage();
  await tab.route("http://storage-overview.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/") return route.fulfill({ contentType: "text/html", body: page(theme, lang) });
    if (path === "/api/filesv2/recent") {
      const { status, body } = recentResponse();
      return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    }
    const asset = assets[path] ?? (path.endsWith(".woff2") ? ["font/woff2", readFileSync(`${ui}dist${path}`)] : null);
    return asset ? route.fulfill({ contentType: asset[0], body: asset[1] }) : route.fulfill({ status: 404 });
  });
  await tab.goto("http://storage-overview.test/");
  await tab.waitForFunction(() => !!document.querySelector(".k2b-link-card"));
  return tab;
};

describe("all storage overview in a browser", () => {
  for (const lang of ["en", "de"]) {
    for (const [device, options] of [
      ["desktop", desktop],
      ["phone", phone],
    ] as const) {
      test(`${lang} ${device}: all roots remain links, without counts or create actions`, async () => {
        const tab = await open(options, "light", lang);
        try {
          await tab.evaluate(() => document.fonts.ready);
          const nav = tab.getByRole("navigation", { name: lang === "de" ? "Alle Ablagen" : "All storage" });
          const cards = nav.getByRole("link");
          expect(await cards.count()).toBe(5);
          const names = ["valentin", "accounts", "projects", "archive", "missing"];
          for (let index = 0; index < names.length; index++) {
            expect(await cards.nth(index).getAttribute("href")).toBe(`/app/filesv2?base=${names[index]}`);
            const text = await cards.nth(index).innerText();
            expect(text).not.toMatch(/\d/);
            expect(await cards.nth(index).locator(".k2b-link-card__description").innerText()).toBe(
              index === 0
                ? `${lang === "de" ? "Nur du" : "Only you"} · valentin · Cloud`
                : `${lang === "de" ? "Gruppe" : "Group"} · ${index < 3 ? "Cloud" : "FreeIPA"}`,
            );
          }
          expect(await cards.first().locator(".k2b-link-card__title").innerText()).toBe(lang === "de" ? "Persönlich" : "Personal");
          expect(await cards.last().locator(".k2b-link-card__meta").innerText()).toContain(lang === "de" ? "Fehlt" : "Missing");
          expect(await tab.getByRole("heading", { name: lang === "de" ? "Zuletzt" : "Recent", exact: true }).count()).toBe(1);
          const recent = tab.locator("section").getByRole("button");
          await recent.nth(2).waitFor();
          expect(await recent.count()).toBe(3);
          expect(await recent.first().innerText()).toContain("Plan.txt");
          await recent.first().click();
          expect(await tab.locator("#root").getAttribute("data-opened")).toBe("Docs/Plan.txt");
          expect(
            await tab.getByRole("button", { name: /\b(Add|Create|New folder|Upload|Hinzufügen|Neuer Ordner|Hochladen)\b/i }).count(),
          ).toBe(0);
          expect(
            await tab.getByRole("link", { name: /\b(Add|Create|New folder|Upload|Hinzufügen|Neuer Ordner|Hochladen)\b/i }).count(),
          ).toBe(0);
          const layout = await cards.evaluateAll((links) =>
            links.map((link) => {
              const { x, y, width, height } = link.getBoundingClientRect();
              return { x, y, width, height };
            }),
          );
          if (device === "phone") {
            expect(new Set(layout.map((box) => box.x)).size).toBe(1);
            expect(new Set(layout.map((box) => box.width)).size).toBe(1);
            for (let index = 0; index < layout.length; index++) {
              expect(layout[index]!.height).toBeGreaterThanOrEqual(44);
              if (index) expect(layout[index]!.y).toBeGreaterThanOrEqual(layout[index - 1]!.y + layout[index - 1]!.height);
            }
          }
          expect(await tab.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
          const before = await cards.first().boundingBox();
          await cards.first().hover();
          expect(await cards.first().boundingBox()).toEqual(before);
          await cards.first().click();
          // The navigation runs inside a view transition, one frame after the click.
          await tab.locator("#root[data-navigated]").waitFor({ state: "attached" });
          expect(await tab.locator("#root").getAttribute("data-navigated")).toBe("/app/filesv2?base=valentin");
          expect(new URL(tab.url()).pathname).toBe("/");
        } finally {
          await tab.context().close();
        }
      });
    }
  }
  test("a failing Recent stays inside its section and retries; the tiles never wait for it", async () => {
    let calls = 0;
    const tab = await open(desktop, "light", "en", () =>
      ++calls === 1 ? { status: 503, body: { code: "unavailable", message: "Storage unavailable" } } : { status: 200, body: recent },
    );
    try {
      expect(await tab.getByRole("navigation", { name: "All storage" }).getByRole("link").count()).toBe(5);
      const section = tab.locator("section");
      const retry = section.getByRole("button", { name: "Try again" });
      await retry.waitFor();
      expect(await tab.getByRole("navigation", { name: "All storage" }).getByRole("link").count()).toBe(5);
      await retry.click();
      await section.getByRole("button", { name: /Plan\.txt/ }).waitFor();
      expect(calls).toBe(2);
    } finally {
      await tab.context().close();
    }
  });

  test("a file dropped anywhere on the overview is refused, so the browser never opens it and leaves Cloud", async () => {
    const tab = await open(desktop);
    try {
      const refused = await tab.evaluate(() => {
        const transfer = new DataTransfer();
        transfer.items.add(new File(["hello"], "hello.txt", { type: "text/plain" }));
        const results: Record<string, boolean> = {};
        for (const selector of [".k2b-link-card", "section", ".filesv2-overview"]) {
          const target = document.querySelector(selector)!;
          for (const type of ["dragenter", "dragover"])
            target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
          const drop = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer });
          target.dispatchEvent(drop);
          results[selector] = drop.defaultPrevented;
        }
        return results;
      });
      expect(refused).toEqual({ ".k2b-link-card": true, section: true, ".filesv2-overview": true });
      expect(new URL(tab.url()).pathname).toBe("/");
      expect(await tab.locator("#root").getAttribute("data-navigated")).toBeNull();
    } finally {
      await tab.context().close();
    }
  });
});
