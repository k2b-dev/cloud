import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { launchBrowser } from "../../../../ui/test/browser";
import type { StoreCheckResult } from "../../store/check";
import type { StoreConfig, StoreStatus } from "../../store/contracts";

// The data-store page keeps every element in place while Pulse waits for ClickHouse, fits a phone and a
// desktop in light and dark, and shows the failing check with its fix next to the steps.
type Browser = Awaited<ReturnType<typeof launchBrowser>>;
type Page = Awaited<ReturnType<Browser["newPage"]>>;

const ui = new URL("../../../../ui/", import.meta.url).pathname;
const origin = "https://cloud.example.test";
const checkedAt = "2026-10-17T12:31:00.000Z";
const configured: StoreConfig = { configured: true, url: "http://clickhouse:8123", user: "pulse_service", passwordSet: true };
const notConfigured: StoreConfig = { configured: false, url: "", user: "pulse_service", passwordSet: false };
const connected: StoreCheckResult = {
  ok: true,
  version: "26.9.19.9",
  latencyMs: 4,
  checkedAt,
  steps: { reach: "ok", auth: "ok", version: "ok", rights: "skipped", profiles: "skipped" },
};
const unreachable: StoreCheckResult = {
  ok: false,
  code: "UNREACHABLE",
  checkedAt,
  steps: { reach: "failed", auth: "skipped", version: "skipped", rights: "skipped", profiles: "skipped" },
};
const missingRight: StoreCheckResult = {
  ok: false,
  code: "MISSING_RIGHT:CREATE USER",
  version: "26.9.19.9",
  latencyMs: 5,
  checkedAt,
  steps: { reach: "ok", auth: "ok", version: "ok", rights: "failed", profiles: "skipped" },
};

let browser: Browser;
let bundle: string;
let css: string;

beforeAll(async () => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./StoreAdmin.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-pulse-store-admin-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Pulse store admin harness failed");
  bundle = await build.outputs[0]!.text();
  // Pulse builds its styles through the Cloud build; the test borrows the same plugin from the UI package.
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", ui))).default;
  const styles = [resolve(import.meta.dir, "../../styles/app.css"), resolve(import.meta.dir, "../../../../../styles.css")];
  const built = await Promise.all(styles.map((entry) => Bun.build({ entrypoints: [entry], plugins: [tailwind] })));
  for (const result of built) if (!result.success) throw new AggregateError(result.logs, "Could not compile the stylesheets.");
  const [appCss, globalCss] = await Promise.all(built.map((result) => result.outputs[0]!.text()));
  css = ["@layer properties, theme, base, components, utilities;", appCss, globalCss].join("\n");
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

type View = { width: number; height: number; touch: boolean };
const phone: View = { width: 390, height: 844, touch: true };
const desktop: View = { width: 1440, height: 900, touch: false };

/** Opens the page; `status` answers the status read once `release()` is called, so tests can look at the waiting frame. */
const open = async (
  view: View,
  options: { dark?: boolean; locale?: string; initial: StoreConfig; status?: StoreStatus | "error"; put?: StoreStatus },
) => {
  const page = await browser.newPage({ viewport: { width: view.width, height: view.height }, isMobile: view.touch, hasTouch: view.touch });
  let release = () => {};
  const released = new Promise<void>((done) => {
    release = done;
  });
  const calls: string[] = [];
  await page.route(`${origin}/api/pulse/admin/store**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    calls.push(`${route.request().method()} ${path}`);
    if (path.endsWith("/check")) return route.fulfill({ json: missingRight });
    if (route.request().method() === "PUT") return route.fulfill({ json: options.put });
    await released;
    if (options.status === "error") return route.fulfill({ status: 500, json: { code: "STORE_REQUEST_FAILED" } });
    return route.fulfill({ json: options.status });
  });
  await page.route(`${origin}/admin/pulse`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body:
        `<!doctype html><html lang="${options.locale ?? "en"}" class="${options.dark ? "dark" : "light"}"><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
        `<body class="k2b-ui"><div class="cloud-app-canvas relative flex min-h-dvh w-full" data-app-id="pulse">` +
        `<main class="layout-content-main min-h-0 min-w-0 flex-1 p-4"><div id="root"></div></main></div>` +
        `<script>window.__store=${JSON.stringify({ initial: options.initial, locale: options.locale ?? "en" })}</script></body></html>`,
    }),
  );
  await page.goto(`${origin}/admin/pulse`);
  await page.addScriptTag({ content: bundle });
  return { page, release, calls };
};

const boxes = (page: Page) =>
  page.evaluate(() => {
    const box = (element: Element | null) => {
      const rect = element?.getBoundingClientRect();
      return rect ? { top: Math.round(rect.top), left: Math.round(rect.left), width: Math.round(rect.width) } : null;
    };
    return {
      header: [...document.querySelectorAll("header button")].map(box),
      status: box(document.querySelector("section[aria-live]")),
      list: [...document.querySelectorAll("dl > div")].slice(0, 3).map(box),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });

describe("Pulse data store page in a browser", () => {
  test("keeps the header actions, status line and details in place while the status loads or fails", async () => {
    for (const view of [phone, desktop])
      for (const status of [{ ...configured, status: connected }, { ...configured, status: unreachable }, "error" as const]) {
        const { page, release } = await open(view, { initial: configured, status, locale: "de" });
        try {
          await page.getByText("Verbindung wird geprüft …").waitFor();
          const waiting = await boxes(page);
          release();
          const expected = status === "error" ? "Status konnte nicht geladen werden" : status.status.ok ? "Verbunden" : "Nicht erreichbar";
          await page.getByText(expected, { exact: true }).waitFor();
          const done = await boxes(page);
          expect(done.header).toEqual(waiting.header);
          expect(done.status).toEqual(waiting.status);
          expect(done.list).toEqual(waiting.list);
          expect(done.overflow).toBeLessThanOrEqual(0);
        } finally {
          await page.close();
        }
      }
  }, 60_000);

  test("names the failing check with its fix and leaves the saved connection unchanged", async () => {
    const { page, release, calls } = await open(desktop, { initial: configured, status: { ...configured, status: connected } });
    try {
      release();
      await page.getByText("Connected", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Check", exact: true }).click();
      await page.getByText("MISSING_RIGHT:CREATE USER").first().waitFor();
      expect(await page.getByText("The service user lacks CREATE USER.").count()).toBeGreaterThan(0);
      expect(await page.getByRole("button", { name: "Retry" }).count()).toBe(0);
      expect(calls).toEqual(["GET /api/pulse/admin/store", "POST /api/pulse/admin/store/check"]);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("fits a phone and a desktop in light and dark without and with a connection", async () => {
    for (const view of [phone, desktop])
      for (const dark of [false, true])
        for (const initial of [notConfigured, configured]) {
          const { page, release } = await open(view, { dark, initial, status: { ...configured, status: connected } });
          try {
            release();
            await page.getByText(initial.configured ? "Connected" : "Not set up yet", { exact: true }).waitFor();
            expect((await boxes(page)).overflow).toBeLessThanOrEqual(0);
          } finally {
            await page.close();
          }
        }
  }, 60_000);
  test("a slow status read never puts the previous connection back over a save", async () => {
    const moved: StoreStatus = {
      ...configured,
      url: "http://clickhouse-new:8123",
      status: { ...connected, steps: { ...connected.steps, rights: "ok", profiles: "ok" } },
    };
    const { page, release } = await open(desktop, { initial: configured, status: { ...configured, status: connected }, put: moved });
    try {
      await page.getByRole("button", { name: "Change" }).click();
      const address = page.getByRole("dialog").getByRole("textbox", { name: /Address/ });
      await address.fill("http://clickhouse-new:8123");
      await page.getByRole("dialog").locator('input[type="password"]').fill("fixture-password");
      await page.getByRole("button", { name: "Check and save" }).click();
      await page.getByText("http://clickhouse-new:8123").waitFor();
      release();
      await page.waitForTimeout(300);
      expect(await page.getByText("http://clickhouse-new:8123").count()).toBe(1);
      expect(await page.getByText("http://clickhouse:8123").count()).toBe(0);
    } finally {
      await page.close();
    }
  }, 30_000);
});
