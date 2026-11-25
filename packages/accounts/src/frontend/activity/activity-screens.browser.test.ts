import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import tailwind from "bun-plugin-tailwind";
import type { Browser, BrowserContext, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../../../ui/test/browser";
import "../../../../ui/test/solid-ssr-preload";
import { BATCH_ID, RECIPIENTS } from "../notifications/render-fixture";

// An administrator works on the activity page on v2: filters the audit log, switches the kind, starts a notification
// batch beside the list and sends a draft after a second look. The test stands in for the server: every page answers
// with the harness, which renders the screen of the address from invented samples, and the API answers from the test.
const root = mkdtempSync(join(tmpdir(), "accounts-activity-browser-"));
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const ui = resolve(import.meta.dir, "../../../../ui");
const origin = "https://cloud.example.test";
const shots = process.env.CLOUD_ACCOUNTS_V2_SHOTS;

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "ActivityScreens.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-activity-screens-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Activity screens harness build failed");
  return build.outputs[0]!.text();
};

let browser: Browser;
let css: string;
let harness: string;
let icons: { css: string; font: string };
beforeAll(async () => {
  harness = await buildHarness();
  const iconCssUrl = import.meta.resolve("@k2b/ui/icons/tabler.css");
  const iconCss = await Bun.file(fileURLToPath(iconCssUrl)).text();
  const fontAsset = iconCss.match(/url\((\.\/[^)"']+\.woff2(?:[?#][^)"']*)?)\)/)?.[1];
  if (!fontAsset) throw new Error("@k2b/ui Tabler preset does not reference a WOFF2 asset");
  icons = { css: iconCss.replace(fontAsset, "/tabler-icons.woff2"), font: fileURLToPath(new URL(fontAsset, iconCssUrl)) };
  const styles = [resolve(import.meta.dir, "../../styles/app.css"), resolve(import.meta.dir, "../../../../../styles.css")];
  const built = await Promise.all(styles.map((entry) => Bun.build({ entrypoints: [entry], plugins: [tailwind] })));
  for (const build of built) if (!build.success) throw new AggregateError(build.logs, "Could not compile the stylesheets.");
  const [appCss, globalCss] = await Promise.all(built.map((build) => build.outputs[0]!.text()));
  const v2Css = readFileSync(fileURLToPath(import.meta.resolve("@k2b/ui/v2.css")), "utf8");
  css = ["@layer properties, theme, base, components, utilities;", appCss, globalCss, v2Css].join("\n");
  if (shots) mkdirSync(shots, { recursive: true });
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

type View = { width: number; height: number; touch: boolean; name: string };
const wide: View = { width: 1440, height: 900, touch: false, name: "1440" };
const narrow: View = { width: 1024, height: 768, touch: false, name: "1024" };
const phone: View = { width: 390, height: 844, touch: true, name: "390" };
type State = { worst?: boolean; huge?: boolean; status?: "draft" | "running" | "completed_with_errors" };

const page = (state: State) =>
  `<!doctype html><html lang="de" class="light" data-state='${JSON.stringify(state)}'><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${origin}/tabler-icons.css">` +
  `<style>${css}</style><style>html,body{height:100%;margin:0}#root{position:fixed;inset:0;display:flex}</style></head>` +
  `<body class="k2b-ui k2-ui"><div id="root"></div><script src="/harness.js"></script></body></html>`;

type Seen = { pages: string[]; previews: unknown[]; created: unknown[]; finalized: unknown[]; retried: string[]; entities: string[] };

const open = async (view: View, address: string, state: State = {}) => {
  const context: BrowserContext = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: 1,
    isMobile: view.touch,
    hasTouch: view.touch,
    reducedMotion: "reduce",
    colorScheme: "light",
  });
  const tab = await context.newPage();
  tab.setDefaultTimeout(10_000);
  const errors = pageErrors(tab);
  const seen: Seen = { pages: [], previews: [], created: [], finalized: [], retried: [], entities: [] };
  await tab.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname.startsWith("/app/accounts/activity")) {
      seen.pages.push(`${url.pathname}${url.search}`);
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: page(state) });
    }
    if (url.pathname === "/api/accounts/entities") {
      seen.entities.push(url.search);
      const kinds = url.searchParams.get("kinds") ?? "";
      const items = kinds.includes("group")
        ? [{ kind: "group", group: { id: "33333333-3333-4333-8333-000000000001", name: "Verkauf", provider: "local" } }]
        : [
            {
              kind: "user",
              user: { id: RECIPIENTS[0]!.userId, uid: "milan.horvat", displayName: "Milan Horvat", mail: "milan@solberg-kramer.example" },
            },
          ];
      return route.fulfill({ json: { items } });
    }
    if (url.pathname === "/api/accounts/notifications/batches/preview" && method === "POST") {
      seen.previews.push(route.request().postDataJSON());
      return route.fulfill({
        json: { targetCount: 12, deliverableCount: 11, skippedNoEmailCount: 1, duplicateCount: 0, recipientHash: "r-1" },
      });
    }
    if (url.pathname === "/api/accounts/notifications/batches" && method === "POST") {
      seen.created.push(route.request().postDataJSON());
      return route.fulfill({ status: 201, json: { id: BATCH_ID } });
    }
    if (url.pathname === `/api/accounts/notifications/batches/${BATCH_ID}/finalize`) {
      seen.finalized.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true } });
    }
    if (url.pathname.includes("/retry")) {
      seen.retried.push(url.pathname);
      return route.fulfill({ json: { ok: true } });
    }
    if (url.pathname === "/harness.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: harness });
    if (url.pathname === "/tabler-icons.css") return route.fulfill({ contentType: "text/css", body: icons.css });
    if (url.pathname === "/tabler-icons.woff2") return route.fulfill({ path: icons.font });
    return route.fulfill({ status: 404, json: { message: "Not found" } });
  });
  await tab.goto(`${origin}${address}`);
  await tab.evaluate(() => document.fonts.ready);
  await settled(tab);
  return { context, tab, errors, seen };
};

const shoot = async (tab: Page, name: string) => {
  if (shots) await tab.screenshot({ path: join(shots, `b-${name}.png`) });
};

const expectClean = async (tab: Page) => {
  // a row under the pointer shows its hover frame; the rules judge the resting page
  await tab.mouse.move(0, 0);
  const outline = await describeV2Page(tab, "#root");
  // the whole outline names each problem when one is found
  expect(outline.includes("Problems (") ? outline : "").toBe("");
  const layout = await measureV2Layout(tab, { root: "[data-k2-workspace]" });
  expect(layout.problems).toEqual([]);
};

const rows = (tab: Page) => tab.locator("[data-k2-part=Table] tbody tr").count();

describe("the activity page on v2", () => {
  test("every screen keeps the v2 rules at 1440, 1024 and 390 px, also with worst-case data", async () => {
    const screens: [string, string, State][] = [
      ["audit", "/app/accounts/activity", {}],
      ["audit-worst", "/app/accounts/activity", { worst: true }],
      ["notifications", "/app/accounts/activity?kind=notifications", {}],
      ["notifications-worst", "/app/accounts/activity?kind=notifications", { worst: true }],
      ["new-batch", "/app/accounts/activity?kind=notifications&new=1", {}],
      ["batch", `/app/accounts/activity/notifications/${BATCH_ID}`, {}],
      ["batch-worst", `/app/accounts/activity/notifications/${BATCH_ID}`, { worst: true }],
      ["batch-draft", `/app/accounts/activity/notifications/${BATCH_ID}`, { status: "draft" }],
      ["reminders", "/app/accounts/activity?kind=reminders", {}],
      ["deleted", "/app/accounts/activity?kind=deleted&entry=77777777-7777-4777-8777-000000000002", {}],
    ];
    for (const [name, address, state] of screens) {
      for (const view of [wide, narrow, phone]) {
        const { context, tab, errors } = await open(view, address, state);
        try {
          await expectClean(tab);
          await shoot(tab, `${name}-light-${view.name}`);
          expect(errors).toEqual([]);
        } finally {
          await context.close();
        }
      }
    }
  }, 300_000);

  test("a list of thousands of entries shows one page of rows: bounded DOM, ready within 1.5 s", async () => {
    for (const [address, most] of [
      ["/app/accounts/activity", 100],
      ["/app/accounts/activity?kind=notifications", 50],
      [`/app/accounts/activity/notifications/${BATCH_ID}`, 100],
    ] as const) {
      const { context, tab, errors } = await open(wide, address, { huge: true });
      try {
        await tab.locator("[data-k2-part=Table] tbody tr").first().waitFor({ state: "attached" }).catch(async () => {
          throw new Error(`no rows: ${JSON.stringify(errors)} ${(await tab.locator("#root").textContent())?.slice(0, 400)}`);
        });
        // the page was ready (its rows rendered) within 1.5 s of the navigation
        const ready = await tab.evaluate(() => performance.getEntriesByType("navigation")[0]?.duration ?? performance.now());
        expect(ready).toBeLessThan(1_500);
        expect(await rows(tab)).toBeLessThanOrEqual(most);
        const elements = await tab.evaluate(() => document.querySelectorAll("*").length);
        expect(elements).toBeLessThan(8_000);
        // the way to the other pages stands under the rows
        await tab.getByRole("link", { name: "Weiter" }).first().waitFor();
        await shoot(tab, `huge-${address.includes("kind=") ? "notifications" : address.includes("/notifications/") ? "batch" : "audit"}-light-1440`);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  }, 120_000);

  test("a filter of the audit log writes the address and the log shows its events", async () => {
    const { context, tab, errors, seen } = await open(wide, "/app/accounts/activity");
    try {
      const all = await rows(tab);
      await tab.getByRole("button", { name: "Filter", exact: true }).click();
      await tab.getByRole("menuitem", { name: /Ergebnis/ }).click();
      await tab.getByRole("option", { name: /Abgelehnt/ }).click();
      await tab.waitForFunction(() => new URL(location.href).searchParams.get("outcome") === "denied");
      await tab.waitForFunction((count) => document.querySelectorAll("[data-k2-part=Table] tbody tr").length < count, all);
      expect(seen.pages.at(-1)).toContain("outcome=denied");
      expect(await tab.locator("[data-k2-part=Table] tbody").textContent()).toContain("Abgelehnt");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("another kind opens with its own filters and none of the audit log's", async () => {
    const { context, tab, errors } = await open(wide, "/app/accounts/activity?outcome=denied");
    try {
      await tab.locator(".k2-stmt-b").filter({ hasText: "Protokoll" }).first().click();
      await tab.getByRole("option", { name: /Benachrichtigungen/ }).click();
      await tab.waitForFunction(() => location.search === "?kind=notifications");
      await tab.getByRole("link", { name: "Neue Benachrichtigung" }).first().waitFor();
      expect(await tab.locator("[data-k2-part=Table]").textContent()).toContain("Wartungsfenster heute Nacht");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("“New notification” opens the form beside the list; a draft is created after a fresh preview and opens", async () => {
    const { context, tab, errors, seen } = await open(wide, "/app/accounts/activity?kind=notifications");
    try {
      await tab.getByRole("link", { name: "Neue Benachrichtigung" }).first().click();
      await tab.waitForFunction(() => new URL(location.href).searchParams.get("new") === "1");
      const form = tab.locator("[data-k2-part=Pane]").filter({ hasText: "Neuer Benachrichtigungslauf" }).last();
      await form.getByRole("textbox", { name: /Betreff/ }).fill("Inventur am Samstag");
      await form.getByRole("textbox", { name: /Inhalt/ }).fill("Bitte bis 10 Uhr da sein.");
      await form.getByRole("searchbox").first().fill("mi");
      await form.getByRole("option", { name: /Milan Horvat/ }).click();
      await tab.waitForFunction(() => document.body.textContent?.includes("11"));
      expect(seen.previews.at(-1)).toEqual({ selection: { userIds: [RECIPIENTS[0]!.userId], groupIds: [] } });
      await shoot(tab, "new-batch-filled-light-1440");
      await form.getByRole("button", { name: "Entwurf erstellen" }).click();
      await tab.waitForFunction((id) => location.pathname.endsWith(id), BATCH_ID);
      expect(seen.created).toEqual([
        {
          subject: "Inventur am Samstag",
          bodyMarkdown: "Bitte bis 10 Uhr da sein.",
          selection: { userIds: [RECIPIENTS[0]!.userId], groupIds: [] },
        },
      ]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("a draft is sent after a second look, and a failed recipient is sent again", async () => {
    const draft = await open(wide, `/app/accounts/activity/notifications/${BATCH_ID}`, { status: "draft" });
    try {
      await draft.tab.getByRole("button", { name: "Versand prüfen" }).first().click();
      const dialog = draft.tab.locator("[data-k2-part=Dialog]");
      await dialog.waitFor();
      const send = dialog.getByRole("button", { name: "Versand starten" });
      expect(await send.isDisabled()).toBe(true);
      await dialog.getByRole("checkbox").check();
      await shoot(draft.tab, "batch-finalize-light-1440");
      await send.click();
      await draft.tab.waitForFunction(() => !document.querySelector("[data-k2-part=Dialog]"));
      expect(draft.seen.finalized).toEqual([
        { expectedSelectionHash: "hash-0", expectedDeliverableCount: 11, expectedRecipientHash: "r-1" },
      ]);
      expect(draft.errors).toEqual([]);
    } finally {
      await draft.context.close();
    }
    const sent = await open(wide, `/app/accounts/activity/notifications/${BATCH_ID}`);
    try {
      // a sent-again recipient shows the batch again from the server (here: the same page)
      const retry = sent.tab.waitForRequest((request) => request.url().includes("/retry"));
      await sent.tab.getByRole("button", { name: "Erneut senden" }).first().click();
      await retry;
      expect(sent.seen.retried).toEqual([`/api/accounts/notifications/batches/${BATCH_ID}/recipients/${RECIPIENTS[3]!.userId}/retry`]);
      expect(sent.errors).toEqual([]);
    } finally {
      await sent.context.close();
    }
  }, 60_000);
});
