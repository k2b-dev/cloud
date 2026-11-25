import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../../ui/test/browser";
import type { ApprovalPage } from "../contracts/approvals";
import { approvalsPage, worstCasePage } from "./approvals.v2.fixture";

// The approval list in a v2 page: a person approves, declines, reads everything and remembers, rejects all, and recovers
// from a failed load. The test stands in for Core's approvals API with invented requests.
const ui = resolve(import.meta.dir, "../../../ui");
const origin = "https://cloud.example.test";
const shots = process.env.CLOUD_APPROVALS_V2_SHOTS;

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "Approvals.v2.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-approvals-v2-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Approvals v2 harness build failed");
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
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, "Could not compile the global stylesheet.");
  const v2Css = readFileSync(fileURLToPath(import.meta.resolve("@k2b/ui/v2.css")), "utf8");
  css = ["@layer properties, theme, base, components, utilities;", await build.outputs[0]!.text(), v2Css].join("\n");
  if (shots) mkdirSync(shots, { recursive: true });
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

type View = { width: number; height: number; touch: boolean; name: string };
const views: View[] = [
  { width: 1440, height: 900, touch: false, name: "1440" },
  { width: 1024, height: 768, touch: false, name: "1024" },
  { width: 390, height: 844, touch: true, name: "390" },
];

type Answer = {
  approvals?: ApprovalPage | "fail";
  decision?: (id: string, body: Record<string, unknown>) => { status: number; json: unknown };
};

const open = async (view: View, options: { initial?: ApprovalPage | null; address?: string; locale?: string } & Answer = {}) => {
  const context = await browser.newContext({
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
  const decisions: { id: string; body: Record<string, unknown> }[] = [];
  const time = new Date("2026-10-11T09:00:00.000Z");
  await tab.clock.install({ time });
  const initial = options.initial === undefined ? approvalsPage : options.initial;
  let approvals = options.approvals ?? approvalsPage;
  await tab.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/me/approvals")
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body:
          `<!doctype html><html lang="${options.locale ?? "en"}" class="light"><head><meta charset="utf-8">` +
          `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${origin}/tabler-icons.css">` +
          `<style>${css}</style><style>html,body{height:100%;margin:0}#root{position:fixed;inset:0;display:flex}</style></head>` +
          `<body class="k2b-ui k2-ui"><div id="root"></div><script type="application/json" id="initial">${JSON.stringify(initial)}</script>` +
          `<script src="/harness.js"></script></body></html>`,
      });
    if (url.pathname === "/api/approvals") {
      if (approvals === "fail") {
        approvals = approvalsPage;
        return route.fulfill({ status: 500, json: { message: "down" } });
      }
      return route.fulfill({ json: approvals });
    }
    if (url.pathname === "/api/approvals/counts") return route.fulfill({ json: { total: 0, apps: {} } });
    const decision = /^\/api\/approvals\/([^/]+)\/decision$/.exec(url.pathname)?.[1];
    if (decision) {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      decisions.push({ id: decision, body });
      const answer = options.decision?.(decision, body) ?? { status: 200, json: { status: body.approved ? "approved" : "rejected" } };
      return route.fulfill({ status: answer.status, json: answer.json });
    }
    if (url.pathname === "/harness.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: harness });
    if (url.pathname === "/tabler-icons.css") return route.fulfill({ contentType: "text/css", body: icons.css });
    if (url.pathname === "/tabler-icons.woff2") return route.fulfill({ path: icons.font });
    return route.fulfill({ status: 404, json: { message: "Not found" } });
  });
  await tab.goto(`${origin}${options.address ?? "/me/approvals"}`);
  await tab.evaluate(() => document.fonts.ready);
  await settled(tab);
  return { context, tab, errors, decisions };
};

const expectClean = async (tab: Page) => {
  await tab.mouse.move(0, 0);
  const outline = await describeV2Page(tab, "#root");
  expect(outline.includes("Problems (") ? outline : "").toBe("");
  const layout = await measureV2Layout(tab, { root: "[data-k2-workspace]" });
  expect(layout.problems).toEqual([]);
  expect(await tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
};

const rows = (tab: Page) => tab.locator('[data-k2-part="Row"]');
const arm = (tab: Page) => tab.clock.runFor(600);

describe("approvals on v2", () => {
  for (const view of views)
    test(`${view.name} px: one section per app, each request one row, clean and without a loading sign`, async () => {
      const { context, tab, errors } = await open(view);
      try {
        expect(await tab.locator('[data-k2-part="Section"]').count()).toBe(2);
        expect(await rows(tab).count()).toBe(3);
        expect(await tab.locator('[data-k2-part="Loading"]').count()).toBe(0);
        expect(await rows(tab).first().textContent()).toContain("Send the offer?");
        expect(await rows(tab).first().textContent()).toContain("from chat “Offer Q4 for the customer”");
        await tab.getByText("3 open").waitFor();
        await expectClean(tab);
        if (shots) await tab.screenshot({ path: join(shots, `01-approvals-v2-${view.name}.png`) });
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    });

  test("an answer before the row armed does nothing; after it, the row keeps its place as the receipt", async () => {
    const { context, tab, decisions } = await open(views[0]!);
    try {
      const first = rows(tab).first();
      const before = await first.boundingBox();
      const next = await rows(tab).nth(1).boundingBox();
      await first.getByRole("button", { name: "Send offer", exact: true }).click();
      expect(decisions).toEqual([]);
      await arm(tab);
      await first.getByRole("button", { name: "Send offer", exact: true }).click();
      await first.getByText("Approved.", { exact: true }).waitFor();
      expect(decisions).toEqual([{ id: approvalsPage.items[0]!.id, body: { approved: true } }]);
      expect(await first.getByText("The chat it came from carries it out and shows how it ends.").count()).toBe(1);
      expect(await first.boundingBox()).toEqual(before);
      expect(await rows(tab).nth(1).boundingBox()).toEqual(next);
      await tab.getByText("2 open").waitFor();
      // The focus stays in the row whose answer left, not on the page.
      expect(await tab.evaluate(() => document.activeElement?.closest('[data-k2-part="Row"]') !== null)).toBe(true);
    } finally {
      await context.close();
    }
  });

  test("declining in the row records the rejection as its receipt", async () => {
    const { context, tab, decisions } = await open(views[2]!);
    try {
      await arm(tab);
      const first = rows(tab).first();
      await first.getByRole("button", { name: "Don't run", exact: true }).click();
      await first.getByText("You declined.").waitFor();
      expect(decisions[0]?.body).toEqual({ approved: false });
    } finally {
      await context.close();
    }
  });

  test("the row opens everything in a dialog, where the person can remember the answer for the chat", async () => {
    const { context, tab, decisions } = await open(views[0]!);
    try {
      await arm(tab);
      const second = rows(tab).nth(1);
      await second.getByRole("button", { name: /Send the offer\?/ }).click();
      const dialog = tab.getByRole("dialog");
      await dialog.getByText("customer@example.com").waitFor();
      await expectClean(tab);
      if (shots) await tab.screenshot({ path: join(shots, "02-approvals-v2-details-1440.png") });
      await dialog.getByRole("checkbox").check();
      await dialog.getByRole("button", { name: "Send offer", exact: true }).click();
      await second.getByText("Approved.", { exact: true }).waitFor();
      expect(decisions).toEqual([{ id: approvalsPage.items[1]!.id, body: { approved: true, remember: "chat" } }]);
      expect(await tab.getByRole("dialog").count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  test("rejecting all asks first and then rejects each open request", async () => {
    const { context, tab, decisions } = await open(views[1]!);
    try {
      await arm(tab);
      await tab.getByRole("button", { name: "Reject all", exact: true }).click();
      const question = tab.getByRole("alertdialog");
      await question.getByText("Reject all open approvals?").waitFor();
      await question.getByRole("button", { name: "Reject all", exact: true }).click();
      await tab.getByText("0 open").waitFor();
      expect(decisions.map((entry) => entry.body)).toEqual([{ approved: false }, { approved: false }, { approved: false }]);
    } finally {
      await context.close();
    }
  });

  test("a failed answer says so in the row and offers to answer again", async () => {
    const { context, tab } = await open(views[0]!, { decision: () => ({ status: 500, json: { message: "down" } }) });
    try {
      await arm(tab);
      const first = rows(tab).first();
      await first.getByRole("button", { name: "Send offer", exact: true }).click();
      await first.getByText("Your decision was not applied.").waitFor();
      await first.getByRole("button", { name: "Answer again", exact: true }).click();
      await first.getByRole("button", { name: "Send offer", exact: true }).waitFor();
    } finally {
      await context.close();
    }
  });

  test("a list that failed to load shows Failed in its place and loads again", async () => {
    const { context, tab } = await open(views[0]!, { initial: null, approvals: "fail" });
    try {
      await tab.locator('[data-k2-part="Failed"]').waitFor();
      await tab.getByRole("button", { name: "Try again" }).click();
      await rows(tab).first().waitFor();
      expect(await rows(tab).count()).toBe(3);
    } finally {
      await context.close();
    }
  });

  test("an empty list says you are all set", async () => {
    const empty: ApprovalPage = { items: [], nextCursor: null, count: 0, elsewhere: 0 };
    const { context, tab } = await open(views[0]!, { initial: empty });
    try {
      await tab
        .locator('[data-k2-part="Empty"]')
        .getByText(/You're all set\./)
        .waitFor();
      await expectClean(tab);
    } finally {
      await context.close();
    }
  });

  test("a list beside one resource shows nothing while no request waits", async () => {
    const empty: ApprovalPage = { items: [], nextCursor: null, count: 0, elsewhere: 0 };
    const { context, tab } = await open(views[0]!, { initial: empty, address: "/me/approvals?app=mail&link=/app/mail/draft" });
    try {
      expect(await tab.locator('[data-k2-part="Empty"]').count()).toBe(0);
      expect(await rows(tab).count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  for (const view of [views[0]!, views[2]!])
    test(`${view.name} px: the worst case stays readable and nothing overflows`, async () => {
      const { context, tab, errors } = await open(view, { initial: worstCasePage, locale: "de" });
      try {
        expect(await rows(tab).count()).toBe(4);
        await tab.getByText("12.345 offen").waitFor();
        await tab.getByRole("button", { name: "Mehr anzeigen" }).waitFor();
        await expectClean(tab);
        if (shots) await tab.screenshot({ path: join(shots, `03-approvals-v2-worst-${view.name}.png`), fullPage: true });
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
});
