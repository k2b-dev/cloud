import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page, Route } from "playwright";
import { launchBrowser, settled } from "../../../../ui/test/browser";
import { appApprovalMessages } from "./messages";

// Revoking a device and pairing a further one wait for approval on a paired device, in v2 dialogs that a stray press
// outside does not close: on a phone and an iPad. The requests and their order are those before v2.
// CLOUD_APPROVAL_SHOTS=<dir> also saves each state.
const root = await mkdtemp(join(tmpdir(), "core-approval-dialogs-"));
const publicDir = join(root, "public");
const ui = resolve(import.meta.dir, "../../../../ui");
const origin = "https://cloud.example.test";
const api = `${origin}/api/auth/app-approval/v1`;
const shots = process.env.CLOUD_APPROVAL_SHOTS;
const t = appApprovalMessages.resolve(["en"]).t;

/** The real islands, compiled for the browser with Solid's DOM output as Cloud's client build does. */
const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "ApprovalDialogs.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-approval-dialogs-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Approval dialogs harness build failed");
  return build.outputs[0]!.text();
};

let browser: Browser;
let css: string;
let harness: string;
beforeAll(async () => {
  harness = await buildHarness();
  const styles = [resolve(import.meta.dir, "../../styles/app.css"), resolve(import.meta.dir, "../../../../../styles.css")];
  const built = await Promise.all(styles.map((entry) => Bun.build({ entrypoints: [entry], plugins: [tailwind] })));
  for (const build of built) if (!build.success) throw new AggregateError(build.logs, "Could not compile the stylesheets.");
  const [appCss, globalCss] = await Promise.all(built.map((build) => build.outputs[0]!.text()));
  const v2Css = readFileSync(fileURLToPath(import.meta.resolve("@k2b/ui/v2.css")), "utf8");
  css = ["@layer properties, theme, base, components, utilities;", appCss, globalCss, v2Css].join("\n");
  const { buildFontAssets } = await import("../../../scripts/font-assets");
  const { buildTablerIconAssets } = await import("../../../scripts/tabler-assets");
  await buildFontAssets(publicDir);
  await buildTablerIconAssets(publicDir);
  if (shots) await mkdir(shots, { recursive: true });
  browser = await launchBrowser();
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await rm(root, { recursive: true, force: true });
});

const views = [
  { name: "iphone-390", width: 390, height: 844, touch: true },
  { name: "ipad-1194", width: 1194, height: 834, touch: true },
] as const;
const head = (dark: boolean) =>
  `<!doctype html><html lang="en" class="${dark ? "dark" : "light"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<link rel="stylesheet" href="${origin}/public/fonts.css"><link rel="stylesheet" href="${origin}/public/tabler-icons.css"><style>${css}</style></head>`;

/** Whether the open dialog's content has to scroll, once the layout settled. */
const overflow = async (page: Page) => {
  await settled(page);
  return page.evaluate(() => {
    const body = document.querySelector<HTMLElement>('[data-k2-part="Dialog"] .k2-dialog-body')!;
    return body.scrollHeight - body.clientHeight;
  });
};

type Api = (route: Route, path: string) => Promise<void> | void;
const open = async (view: (typeof views)[number], dark: boolean, mode: string, answer: Api, clock?: Date) => {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: 2,
    isMobile: view.touch,
    hasTouch: view.touch,
    colorScheme: dark ? "dark" : "light",
  });
  const page = await context.newPage();
  if (clock) await page.clock.install({ time: clock });
  await page.route(`${origin}/**`, async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/me/security")
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `${head(dark)}<body class="k2b-ui k2-ui"><div id="root"></div><script src="/harness.js"></script></body></html>`,
      });
    if (pathname === "/harness.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: harness });
    if (pathname.startsWith("/public/")) return route.fulfill({ path: join(root, pathname) });
    if (route.request().url().startsWith(api)) return answer(route, route.request().url().slice(api.length).split("?")[0]!);
    return route.fulfill({ status: 404 });
  });
  await page.goto(`${origin}/me/security?mode=${mode}`);
  await page.evaluate(() => document.fonts.ready);
  return { page, close: () => context.close() };
};

// real clock: the page counts this expiry down on its real clock.
const later = () => new Date(Date.now() + 300_000).toISOString();

describe("approval on a paired device in a browser", () => {
  for (const view of views) {
    const dark = false;
    const theme = "light";
    test(`revoking asks, retries after an error, waits and reports the result, ${view.name}`, async () => {
      let sends = 0;
      let decided = false;
      const { page, close } = await open(view, dark, "revoke", (route, path) => {
        if (path === "/manage/devices/update") {
          sends += 1;
          // The first request fails, so the error and its retry are measured too.
          return sends === 1
            ? route.fulfill({ status: 503, json: { code: "UNAVAILABLE" } })
            : route.fulfill({ json: { state: "pending", changeId: "00000000-0000-4000-8000-000000000801", expiresAt: later() } });
        }
        if (path === "/manage/device-changes/status")
          return route.fulfill({
            json: {
              changeId: "00000000-0000-4000-8000-000000000801",
              endSessions: true,
              state: decided ? "approved" : "pending",
              expiresAt: later(),
            },
          });
        if (path === "/manage/devices") return route.fulfill({ json: { items: [], nextCursor: null } });
        return route.fulfill({ status: 204 });
      });
      try {
        const shot = async (state: string) => {
          if (shots) await page.screenshot({ path: join(shots, `revoke-${state}-${view.name}-${theme}.png`) });
        };
        const steps: Record<string, number> = {};
        await page.getByRole("button", { name: t.deviceActions({ name: "Jonas' iPhone 15 Pro" }) }).click();
        await page.getByRole("menuitem", { name: t.revoke }).click();
        const dialog = page.locator('[data-k2-part="Dialog"]');
        await dialog.getByText(t.endSessions).waitFor();
        // a stray press outside keeps the question open
        await page.mouse.click(2, 2);
        expect(await dialog.count()).toBe(1);
        steps.ask = await overflow(page);
        await shot("ask");
        const footer = dialog.locator('[data-slot="foot"]');
        await footer.getByRole("button", { name: t.revoke }).click();
        await dialog.getByText(t.unavailable).waitFor();
        steps.error = await overflow(page);
        await shot("error");
        await footer.getByRole("button", { name: t.tryAgain }).click();
        await footer.getByRole("button", { name: t.revoke }).click();
        await dialog.getByText(t.approvalTitle).waitFor();
        steps.waiting = await overflow(page);
        await shot("waiting");
        decided = true;
        await dialog.getByText(t.revokeDone({ name: "Jonas' iPhone 15 Pro" })).waitFor({ timeout: 12_000 });
        steps.approved = await overflow(page);
        await shot("approved");
        expect(Object.entries(steps).filter(([, step]) => step > 0)).toEqual([]);
        expect(sends).toBe(2);
      } finally {
        await close();
      }
    }, 60_000);

    test(`a further pairing shows the code, then waits for the paired device, ${view.name}`, async () => {
      let confirmed = false;
      const { page, close } = await open(view, dark, "pair", (route, path) => {
        if (path === "/manage/pairings/status")
          return route.fulfill({
            json: {
              state: "claimed",
              name: "Jonas' iPad Pro",
              deviceId: "00000000-0000-4000-8000-000000000702",
              comparison: "482913",
              userId: "00000000-0000-4000-8000-000000000042",
              approval: confirmed ? { state: "pending", expiresAt: later() } : null,
            },
          });
        if (path === "/manage/pairings/confirm") {
          confirmed = true;
          return route.fulfill({
            json: { deviceId: "00000000-0000-4000-8000-000000000702", approval: { state: "pending", expiresAt: later() } },
          });
        }
        return route.fulfill({ status: 204 });
      });
      try {
        const dialog = page.locator('[data-k2-part="Dialog"]');
        await dialog.getByText("482913").waitFor({ timeout: 12_000 });
        const code = await overflow(page);
        if (shots) await page.screenshot({ path: join(shots, `pair-code-${view.name}-${theme}.png`) });
        // a stray press outside keeps the pairing open
        await page.mouse.click(2, 2);
        expect(await dialog.count()).toBe(1);
        await dialog.getByRole("button", { name: t.confirm }).click();
        await dialog.getByText(t.approvalTitle).waitFor();
        const waiting = await overflow(page);
        if (shots) await page.screenshot({ path: join(shots, `pair-waiting-${view.name}-${theme}.png`) });
        expect([code, waiting].filter((value) => value > 0)).toEqual([]);
        expect(confirmed).toBe(true);
      } finally {
        await close();
      }
    }, 60_000);
  }
});

test("identity confirmation keeps normal login method selection", async () => {
  const { page, close } = await open(
    views[0],
    false,
    "pair",
    (route) => route.fulfill({ status: 403, json: { code: "REAUTHENTICATE" } }),
    new Date("2026-10-23T12:00:00Z"),
  );
  try {
    await page.locator('[data-k2-part="Dialog"]').waitFor();
    await page.clock.fastForward(5000);
    await page.getByRole("button", { name: t.reauthenticate, exact: true }).click();
    await page.waitForURL("**/auth/login?**");
    const url = new URL(page.url());
    expect(url.searchParams.has("credential")).toBe(false);
    const target = new URL(url.searchParams.get("redirectTo")!, origin);
    expect(target.searchParams.get("reauthenticate")).toBe("1");
    expect(target.searchParams.get("pairDevice")).toBe("00000000-0000-4000-8000-000000000042");
  } finally {
    await close();
  }
});
