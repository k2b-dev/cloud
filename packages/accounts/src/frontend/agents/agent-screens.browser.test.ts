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
import type { AgentKeyOpen, AgentKeySort } from "./agent-keys";
import { AGENT_ID, KEY_IDS } from "./agent-screens.fixture";
import { agentMessages } from "./messages";

// An administrator sees an agent's API keys on v2, creates one and sees its token once, and revokes one after a second
// question. The test answers the administration API itself; the screens render from frozen fixtures.
const root = mkdtempSync(join(tmpdir(), "accounts-agent-screens-browser-"));
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const ui = resolve(import.meta.dir, "../../../../ui");
const origin = "https://cloud.example.test";
const shots = process.env.CLOUD_AGENT_SCREENS_SHOTS;
const t = agentMessages.resolve(["de"]).t;
const TOKEN = "k2b_sa_test_4f7c1e0b9a2d4c6e8f00112233445566";
const keysPath = `/api/admin/identity/service-accounts/${AGENT_ID}/api-keys`;

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
type State =
  | { screen: "agents"; empty?: boolean }
  | { screen: "agent"; keys?: "sample" | "empty" | "failed"; open?: AgentKeyOpen; sort?: AgentKeySort; active?: boolean };
/** What the API answers next: a create answers with a token, a status, or a lost connection; a revoke with a status. */
type Api = { create: "token" | 400 | 500 | "lost"; revoke: number[]; posts: unknown[]; deletes: string[]; pages: string[] };
const api = (create: Api["create"] = "token", revoke: number[] = [200]): Api => ({ create, revoke, posts: [], deletes: [], pages: [] });

const page = (state: State, dark: boolean) =>
  `<!doctype html><html lang="de" class="${dark ? "dark" : "light"}" data-state='${JSON.stringify(state)}'><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${origin}/tabler-icons.css">` +
  `<style>${css}</style><style>html,body{height:100%;margin:0}#root{position:fixed;inset:0;display:flex}</style></head>` +
  `<body class="k2b-ui k2-ui"><div id="root"></div><script src="/harness.js"></script></body></html>`;

/** The agent page's state from its address, as the server reads it. */
const stateOf = (url: URL, extra: Partial<Extract<State, { screen: "agent" }>>): State => {
  const key = url.searchParams.get("key");
  const sort = url.searchParams.get("sort");
  return {
    screen: "agent",
    ...extra,
    sort: sort === "name" || sort === "used" ? sort : "created",
    open: key === "new" ? { kind: "new" } : key ? { kind: "key", id: key } : { kind: "none" },
  };
};

const open = async (
  view: View,
  address: string,
  answers: Api,
  options: { dark?: boolean; state?: Partial<Extract<State, { screen: "agent" }>>; list?: { empty?: boolean } } = {},
) => {
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
  const logged: string[] = [];
  tab.on("console", (message) => logged.push(message.text()));
  await tab.route(`${origin}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/app/accounts/agents")
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: page({ screen: "agents", ...options.list }, Boolean(options.dark)),
      });
    if (url.pathname === `/app/accounts/agents/${AGENT_ID}`) {
      answers.pages.push(`${url.pathname}${url.search}`);
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: page(stateOf(url, options.state ?? {}), Boolean(options.dark)),
      });
    }
    if (url.pathname === "/harness.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: harness });
    if (url.pathname === "/tabler-icons.css") return route.fulfill({ contentType: "text/css", body: icons.css });
    if (url.pathname === "/tabler-icons.woff2") return route.fulfill({ path: icons.font });
    if (url.pathname === keysPath && request.method() === "POST") {
      answers.posts.push(request.postDataJSON());
      if (answers.create === "lost") return route.abort("connectionreset");
      if (answers.create === 400) return route.fulfill({ status: 400, json: { message: "Name ist zu lang." } });
      if (answers.create === 500) return route.fulfill({ status: 500, json: { message: "Internal server error" } });
      return route.fulfill({ status: 201, json: { credential: { id: KEY_IDS[0] }, token: TOKEN } });
    }
    if (url.pathname.startsWith(`${keysPath}/`) && request.method() === "DELETE") {
      answers.deletes.push(url.pathname);
      const status = answers.revoke.shift() ?? 200;
      return route.fulfill(status === 200 ? { json: { revoked: true } } : { status, json: { message: "Internal server error" } });
    }
    return route.fulfill({ status: 404, json: { message: "Not found" } });
  });
  await tab.goto(`${origin}${address}`);
  await tab.evaluate(() => document.fonts.ready);
  await settled(tab);
  return { context, tab, errors, logged };
};

const shoot = async (tab: Page, name: string) => {
  if (shots) await tab.screenshot({ path: join(shots, `agents-v2-${name}.png`) });
};

// k2b-ui gap: on the phone the side column stacks under the table, and its seam doubles the last row's line; the
// primitives own both lines, so this one finding is named here until Pane.Split or Table drops one of them.
const knownPhoneSeam = (problem: string) => /^double line: div\.k2-row border-bottom and div\.k2-seam/.test(problem);

const expectClean = async (tab: Page, view: View) => {
  const outline = await describeV2Page(tab, "#root");
  expect(outline).not.toContain("Problems (");
  const layout = await measureV2Layout(tab, { root: "[data-k2-workspace]" });
  expect(layout.problems.filter((problem) => !(view === phone && knownPhoneSeam(problem)))).toEqual([]);
  return outline;
};

describe("an agent's API keys on v2", () => {
  test("the list, an agent's keys, the order and the states keep the v2 rules at 1280 and 390 px", async () => {
    for (const view of [desktop, phone]) {
      for (const [name, address, options] of [
        ["list", "/app/accounts/agents", {}],
        ["list-empty", "/app/accounts/agents", { list: { empty: true } }],
        ["detail", `/app/accounts/agents/${AGENT_ID}`, {}],
        ["detail-sorted", `/app/accounts/agents/${AGENT_ID}?sort=name`, {}],
        ["detail-empty", `/app/accounts/agents/${AGENT_ID}`, { state: { keys: "empty" } }],
        ["detail-failed", `/app/accounts/agents/${AGENT_ID}`, { state: { keys: "failed" } }],
        ["detail-disabled", `/app/accounts/agents/${AGENT_ID}`, { state: { active: false } }],
        ["detail-key", `/app/accounts/agents/${AGENT_ID}?key=${KEY_IDS[0]}`, {}],
      ] as const) {
        const { context, tab, errors } = await open(view, address, api(), options);
        try {
          const outline = await expectClean(tab, view);
          if (name === "list-empty") expect(outline).toContain(t.noAgents.slice(0, 30));
          if (name === "detail-empty") expect(outline).toContain(t.noKeys.slice(0, 30));
          if (name === "detail-failed") expect(outline).toContain(t.retry);
          if (name === "detail-disabled") expect(outline).toContain(t.agentDisabledNotice.slice(0, 30));
          if (name === "detail-sorted" && view === desktop) {
            // the server sorts (unit test); the page names the order with the pressed chip and the column's arrow
            expect(await tab.locator("[data-k2-part='StatusRow'] [data-pressed]").textContent()).toBe(t.sortName);
            expect(await tab.locator("[aria-sort='ascending']").textContent()).toContain(t.name);
          }
          await shoot(tab, `${name}-${view.name}`);
          expect(errors).toEqual([]);
        } finally {
          await context.close();
        }
      }
    }
  }, 240_000);

  test("creating a key shows its token once, with a copy button, and closing drops it from the page", async () => {
    for (const view of [desktop, phone]) {
      const answers = api();
      const { context, tab, errors, logged } = await open(view, `/app/accounts/agents/${AGENT_ID}?key=new`, answers);
      try {
        const dialog = tab.locator("[data-k2-part='Dialog']");
        await dialog.getByRole("heading", { name: t.createKeyFor({ name: "Wochenbericht" }) }).waitFor();
        await settled(tab);
        await shoot(tab, `create-${view.name}`);
        // without a name nothing is sent
        await dialog.getByRole("button", { name: t.create }).click();
        await dialog.getByText(t.keyNameRequired).waitFor();
        expect(answers.posts).toEqual([]);
        await dialog.getByRole("textbox", { name: t.keyName }).fill("Laptop Jana");
        await dialog.getByRole("radio", { name: t.modelsOnly }).check();
        await dialog.getByRole("button", { name: t.create }).click();
        await dialog.getByText(TOKEN).waitFor();
        expect(answers.posts).toEqual([{ name: "Laptop Jana", access: "models", expiresAt: null }]);
        await dialog.getByText(t.oneTime).waitFor();
        expect(await dialog.getByRole("button", { name: /kopieren|copy/i }).count()).toBe(1);
        await settled(tab);
        await shoot(tab, `created-${view.name}`);
        await dialog.getByRole("button", { name: t.done }).click();
        // the address no longer names the dialog, and the token is nowhere on the page
        await tab.waitForURL(`${origin}/app/accounts/agents/${AGENT_ID}`);
        await tab.getByText(t.keysCount({ count: 3 })).waitFor();
        expect(await tab.content()).not.toContain(TOKEN);
        expect(logged.filter((line) => line.includes(TOKEN))).toEqual([]);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  }, 120_000);

  test("a refused key says why; a lost answer forbids a second creation", async () => {
    for (const create of [400, 500, "lost"] as const) {
      const answers = api(create);
      const { context, tab, errors } = await open(desktop, `/app/accounts/agents/${AGENT_ID}?key=new`, answers);
      try {
        const dialog = tab.locator("[data-k2-part='Dialog']");
        await dialog.getByRole("textbox", { name: t.keyName }).fill("Laptop Jana");
        await dialog.getByRole("button", { name: t.create }).click();
        if (create === 400) {
          await dialog.getByText("Name ist zu lang.").waitFor();
          expect(await dialog.getByRole("button", { name: t.create }).isDisabled()).toBe(false);
        } else {
          await dialog.getByText(t.createUncertain).waitFor();
          expect(await dialog.getByRole("button", { name: t.create }).isDisabled()).toBe(true);
        }
        expect(answers.posts).toHaveLength(1);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  }, 60_000);

  test("revoking asks first, says when it failed, and shows the list after it worked", async () => {
    for (const view of [desktop, phone]) {
      const answers = api("token", [500, 200]);
      const { context, tab, errors } = await open(view, `/app/accounts/agents/${AGENT_ID}?key=${KEY_IDS[0]}`, answers);
      try {
        const pane = tab.locator("[data-k2-part='Pane'][aria-label='Laptop Jana']");
        const ask = async () => {
          await pane.getByRole("button", { name: t.revoke }).click();
          const question = tab.getByRole("alertdialog", { name: t.revokeTitle({ name: "Laptop Jana" }) });
          await question.waitFor();
          await settled(tab);
          return question;
        };
        // the question starts on "Abbrechen"; Escape answers no and sends nothing
        let question = await ask();
        await question.getByText(t.revokeConsequence).waitFor();
        expect(await tab.evaluate(() => document.activeElement?.textContent?.trim())).toBe(t.cancel);
        await shoot(tab, `revoke-${view.name}`);
        await tab.keyboard.press("Escape");
        await question.waitFor({ state: "detached" });
        expect(answers.deletes).toEqual([]);
        // a failed revoke says so beside the key, which stays
        question = await ask();
        await question.getByRole("button", { name: t.revoke }).click();
        await pane.getByText(t.revokeFailed).waitFor();
        await shoot(tab, `revoke-failed-${view.name}`);
        question = await ask();
        await question.getByRole("button", { name: t.revoke }).click();
        await tab.waitForURL(`${origin}/app/accounts/agents/${AGENT_ID}`);
        expect(answers.deletes).toEqual([`${keysPath}/${KEY_IDS[0]}`, `${keysPath}/${KEY_IDS[0]}`]);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  }, 120_000);

  test("the page and the dialog keep the rules in the dark", async () => {
    for (const address of [`/app/accounts/agents/${AGENT_ID}`, `/app/accounts/agents/${AGENT_ID}?key=new`]) {
      const { context, tab, errors } = await open(desktop, address, api(), { dark: true });
      try {
        await expectClean(tab, desktop);
        await shoot(tab, address.endsWith("new") ? "create-dark-1280" : "detail-dark-1280");
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  }, 60_000);
});
