import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderAvatarSvg } from "@k2b/cloud/shared";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import tailwind from "bun-plugin-tailwind";
import type { Browser, BrowserContext, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../../../ui/test/browser";
import "../../../../ui/test/solid-ssr-preload";
import { accountsMessages } from "../messages";
import type { KeysState } from "./agent-screens.fixture";
import { AGENT_ID } from "./agent-screens.fixture-ids";
import { agentMessages } from "./messages";

// An administrator opens an agent in the account record on v2: its state, key figures, API keys and directory access.
// The screens render from frozen fixtures; the test answers the routes itself.
const root = mkdtempSync(join(tmpdir(), "accounts-agent-screens-browser-"));
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const ui = resolve(import.meta.dir, "../../../../ui");
const origin = "https://cloud.example.test";
const shots = process.env.CLOUD_AGENT_SCREENS_SHOTS;
const t = agentMessages.resolve(["de"]).t;
const accounts = accountsMessages.resolve(["de"]).t;
// the agent's robot, as the avatar route serves it
const robot = renderAvatarSvg({
  v: 1,
  kind: "robot",
  head: "square",
  antenna: "ball",
  eyes: "round",
  mouth: "grill",
  body: "light",
  color: "teal",
  bg: "sand",
});

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "AgentScreens.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-agent-screens-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Agent screens harness build failed");
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
const desktop: View = { width: 1280, height: 860, touch: false, name: "1280" };
const phone: View = { width: 390, height: 844, touch: true, name: "390" };
type State = { screen: "agents"; empty?: boolean } | { screen: "agent"; keys?: KeysState; active?: boolean };

const page = (state: State, dark: boolean) =>
  `<!doctype html><html lang="de" class="${dark ? "dark" : "light"}" data-state='${JSON.stringify(state)}'><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${origin}/tabler-icons.css">` +
  `<style>${css}</style><style>html,body{height:100%;margin:0}#root{position:fixed;inset:0;display:flex}</style></head>` +
  `<body class="k2b-ui k2-ui"><div id="root"></div><script src="/harness.js"></script></body></html>`;

/** Opens a screen; the record's state comes from the test, as the server would read it for the agent. */
const open = async (view: View, state: State, options: { dark?: boolean } = {}) => {
  const context: BrowserContext = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: 1,
    isMobile: view.touch,
    hasTouch: view.touch,
    reducedMotion: "reduce",
    colorScheme: options.dark ? "dark" : "light",
  });
  const tab = await context.newPage();
  tab.setDefaultTimeout(10_000);
  const errors = pageErrors(tab);
  const posts: string[] = [];
  await tab.route(`${origin}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/app/accounts/agents" || url.pathname === `/app/accounts/users/${AGENT_ID}`)
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: page(state, Boolean(options.dark)) });
    if (url.pathname === `/api/accounts/users/${AGENT_ID}/avatar`) return route.fulfill({ contentType: "image/svg+xml", body: robot });
    if (url.pathname === "/harness.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: harness });
    if (url.pathname === "/tabler-icons.css") return route.fulfill({ contentType: "text/css", body: icons.css });
    if (url.pathname === "/tabler-icons.woff2") return route.fulfill({ path: icons.font });
    if (request.method() !== "GET") posts.push(url.pathname);
    return route.fulfill({ status: 404, json: { message: "Not found" } });
  });
  await tab.goto(`${origin}${state.screen === "agents" ? "/app/accounts/agents" : `/app/accounts/users/${AGENT_ID}`}`);
  await tab.evaluate(() => document.fonts.ready);
  await settled(tab);
  return { context, tab, errors, posts };
};

const shoot = async (tab: Page, name: string) => {
  if (shots) await tab.screenshot({ path: join(shots, `agents-v2-${name}.png`) });
};

const expectClean = async (tab: Page) => {
  await tab.mouse.move(0, 0);
  const outline = await describeV2Page(tab, "#root");
  expect(outline.includes("Problems (") ? outline : "").toBe("");
  const layout = await measureV2Layout(tab, { root: "[data-k2-workspace]" });
  expect(layout.problems).toEqual([]);
  return outline;
};

// The keys and the directory access are the record's sections from service-accounts/; their deeds (a new key with
// its token once, refusals, a lost answer, revoke, replacing a legacy key, paging through 1,284 keys, sharing and
// removing directory entries) are tested in service-accounts/keys-and-new-user.browser.test.ts. Here: the agent kind
// of the record around them, in every state, and the list while it has its route.
describe("an agent in the account record on v2", () => {
  test("the list and the agent's record keep the v2 rules at 1280 and 390 px in every state", async () => {
    const states: [string, State][] = [
      ["list", { screen: "agents" }],
      ["list-empty", { screen: "agents", empty: true }],
      ["detail", { screen: "agent" }],
      ["detail-empty", { screen: "agent", keys: "empty" }],
      ["detail-failed", { screen: "agent", keys: "failed" }],
      ["detail-disabled", { screen: "agent", active: false }],
      ["detail-worst", { screen: "agent", keys: "worst" }],
    ];
    for (const view of [desktop, phone])
      for (const [name, state] of states) {
        const { context, tab, errors } = await open(view, state);
        try {
          const outline = await expectClean(tab);
          if (name === "list-empty") expect(outline).toContain(t.noAgents.slice(0, 30));
          if (name === "detail-failed") expect(outline).toContain(t.retry);
          if (name === "detail-disabled") expect(outline).toContain(t.agentDisabledNotice.slice(0, 30));
          // the side column says what a key reaches and that it lives only while its agent is active
          if (name === "detail") {
            expect(outline).toContain(t.reachTitle);
            expect(outline).toContain("Jana Berger");
          }
          await shoot(tab, `${name}-${view.name}`);
          expect(errors).toEqual([]);
        } finally {
          await context.close();
        }
      }
  }, 240_000);

  test("an agent with 1,284 keys shows the true count and one bounded page, ready quickly", async () => {
    const { context, tab, errors } = await open(desktop, { screen: "agent", keys: "huge" });
    try {
      await tab.locator("[data-k2-part='Section'] [data-k2-part='Row']").first().waitFor();
      // the screen stood within 1.5 s of the page's answer, as the harness measured it in the page
      expect(Number(await tab.evaluate(() => document.documentElement.dataset.ready))).toBeLessThan(1500);
      expect(await tab.locator("[data-k2-part='Cells.Cell']", { hasText: "1.284" }).count()).toBe(1);
      expect(await tab.locator("[data-k2-part='Row']").count()).toBeLessThanOrEqual(60);
      expect(await tab.evaluate(() => document.querySelectorAll("*").length)).toBeLessThan(4000);
      await expectClean(tab);
      await shoot(tab, "detail-huge-1280");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("a new key starts from the record's key section, in its dialog", async () => {
    const { context, tab, errors, posts } = await open(desktop, { screen: "agent" });
    try {
      await tab.getByRole("button", { name: accounts.createMachineKey }).first().click();
      await tab.locator("[data-k2-part='Dialog']").waitFor();
      await shoot(tab, "create-1280");
      expect(posts).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("the record keeps the rules in the dark", async () => {
    const { context, tab, errors } = await open(desktop, { screen: "agent" }, { dark: true });
    try {
      await expectClean(tab);
      await shoot(tab, "detail-dark-1280");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);
});
