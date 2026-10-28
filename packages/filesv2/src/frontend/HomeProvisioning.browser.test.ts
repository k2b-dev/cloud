import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Browser, BrowserContextOptions } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";

// Row layout, wrapping on phones and the pager's recovery need a real layout engine.
const ui = new URL("../../../ui/", import.meta.url).pathname;
// The section's layout lives in Tailwind utilities: compile the workspace sheet with the shared theme as Cloud serves it.
const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", ui))).default;
const styles = await Bun.build({ entrypoints: [new URL("../../../../styles.css", import.meta.url).pathname], plugins: [tailwind] });
if (!styles.success) throw new AggregateError(styles.logs, "Could not compile the Files stylesheet");
const appCss = await styles.outputs[0]!.text();

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./HomeProvisioning.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-home-provisioning-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Home provisioning harness build failed");
  return build.outputs[0]!.text();
};

const harness = await buildHarness();
const assets: Record<string, [string, string | Buffer]> = {
  "/harness.js": ["text/javascript; charset=utf-8", harness],
  // As in Cloud: the app sheet first, @k2b/ui after it.
  "/app.css": ["text/css", appCss],
  "/tabler.css": ["text/css", readFileSync(`${ui}dist/tabler.css`, "utf8")],
};
const page = (theme: "light" | "dark", lang: string) =>
  `<!doctype html><html lang="${lang}" class="${theme === "dark" ? "dark" : ""}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<link rel="stylesheet" href="/tabler.css"><link rel="stylesheet" href="/app.css">` +
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

const more = {
  items: [
    {
      userId: "00000000-0000-4000-8000-000000000009",
      username: "barbara",
      area: "freeipa",
      state: "posix_incomplete",
      operationId: null,
      eventId: null,
      errorCode: null,
      updatedAt: "2026-10-27T09:40:00Z",
    },
  ],
  nextCursor: null,
  counts: { cloud: {}, freeipa: {} },
  reconcile: { lastRunAt: null, lastResult: null, running: false },
};
type PageResponse = () => { status: number; body: unknown };

const open = async (options: BrowserContextOptions, scenario: string, lang = "en", pageResponse?: PageResponse) => {
  const context = await browser.newContext({ ...options, reducedMotion: "reduce" });
  const tab = await context.newPage();
  const requests: string[] = [];
  await tab.route("http://home-provisioning.test/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: page("light", lang) });
    if (url.pathname === "/api/filesv2/admin/provisioning" && pageResponse) {
      requests.push(url.search);
      const { status, body } = pageResponse();
      return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    }
    const path = url.pathname;
    const asset = assets[path] ?? (path.endsWith(".woff2") ? ["font/woff2", readFileSync(`${ui}dist${path}`)] : null);
    return asset ? route.fulfill({ contentType: asset[0], body: asset[1] }) : route.fulfill({ status: 404 });
  });
  await tab.goto(`http://home-provisioning.test/#${scenario}`);
  await tab.waitForFunction(() => !!document.querySelector(".k2b-stat-grid"));
  await tab.evaluate(() => document.fonts.ready);
  return { tab, requests };
};
const shots = process.env.FILES_HOME_PROVISIONING_SHOTS;

describe("home provisioning status in a browser", () => {
  for (const lang of ["en", "de"]) {
    for (const [device, options] of [
      ["desktop", desktop],
      ["phone", phone],
    ] as const) {
      test(`${lang} ${device}: waiting accounts name their reason and the way out, without horizontal overflow`, async () => {
        const { tab } = await open(options, "waiting", lang);
        try {
          const de = lang === "de";
          expect(await tab.getByRole("heading", { name: de ? "Persönliche Verzeichnisse" : "Personal directories" }).count()).toBe(1);
          const text = await tab.locator("#root").innerText();
          expect(text).toContain("37");
          expect(text).toContain(de ? "POSIX-Identität unvollständig" : "POSIX identity incomplete");
          expect(text).toContain(de ? "Automatische Anlage aus" : "Automatic creation off");
          expect(text).toContain(de ? "Letzter Abgleich" : "Last reconciliation");
          // A failed account names its own reason, not a generic connection hint.
          expect(text).toContain(de ? "Pfad, Identität und Unix-Eigentümer prüfen" : "Review the path, identity and Unix ownership");
          const rows = tab.getByRole("list").getByRole("listitem");
          expect(await rows.count()).toBe(3);
          const settings = tab.getByRole("link", { name: de ? "Einstellungen öffnen" : "Open settings" });
          expect(await settings.count()).toBe(1);
          expect(await settings.getAttribute("href")).toBe("/admin/filesv2?view=settings");
          expect(await tab.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
          if (shots) await tab.screenshot({ path: `${shots}/waiting-${lang}-${device}.png`, fullPage: true });
        } finally {
          await tab.context().close();
        }
      });
    }
  }

  test("every area state has its own text: done while reconciling, nothing processed, not configured", async () => {
    for (const [scenario, expected, absent] of [
      ["done", ["Every account has its personal directory.", "Reconciliation running"], "Open settings"],
      ["empty", ["No accounts processed yet.", "No reconciliation yet"], "Open settings"],
      ["unconfigured", ["Waiting until this storage area is enabled and Filegate is configured.", "Not configured"], "Show more"],
    ] as const) {
      const { tab } = await open(desktop, scenario);
      try {
        const text = await tab.locator("#root").innerText();
        for (const line of expected) expect(text).toContain(line);
        expect(text).not.toContain(absent);
        if (shots) await tab.screenshot({ path: `${shots}/${scenario}-en-desktop.png`, fullPage: true });
      } finally {
        await tab.context().close();
      }
    }
  });

  test("a failed further page stays inside the section and the same button retries from the same cursor", async () => {
    let calls = 0;
    const { tab, requests } = await open(desktop, "waiting", "en", () =>
      ++calls === 1 ? { status: 503, body: { code: "unavailable", message: "unavailable" } } : { status: 200, body: more },
    );
    try {
      const button = tab.getByRole("button", { name: "Show more" });
      await button.click();
      await tab.getByRole("alert").filter({ hasText: "More accounts could not be loaded." }).waitFor();
      expect(await tab.getByRole("list").getByRole("listitem").count()).toBe(3);
      await button.click();
      await tab.getByText("barbara").waitFor();
      expect(await tab.getByRole("list").getByRole("listitem").count()).toBe(4);
      expect(await tab.getByRole("button", { name: "Show more" }).count()).toBe(0);
      expect(await tab.getByRole("alert").count()).toBe(0);
      expect(requests).toEqual([
        "?area=freeipa&after=00000000-0000-4000-8000-000000000002",
        "?area=freeipa&after=00000000-0000-4000-8000-000000000002",
      ]);
    } finally {
      await tab.context().close();
    }
  });
});
