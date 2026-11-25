import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import tailwind from "bun-plugin-tailwind";
import type { Browser, BrowserContext, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../../../../ui/test/browser";
import "../../../../../ui/test/solid-ssr-preload";
import { accountsMessages } from "../../messages";
import { userRecordMessages } from "./messages";
import { DEVICE_ID, type FixtureName, GROUP_ID, KEY_ID, PHONE_ID, USER_ID } from "./user-record.fixture";

// An administrator works with a person's record on v2: the areas as tabs, memberships with and without inherited
// groups, removing a membership, revoking keys and devices, the account's deeds with their dialogs, and pairing the
// Cloud app. The test stands in for the server: the page renders from invented records, the API answers here.
const root = mkdtempSync(join(tmpdir(), "accounts-user-screen-browser-"));
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const ui = resolve(import.meta.dir, "../../../../../ui");
const origin = "https://cloud.example.test";
const shots = process.env.CLOUD_ACCOUNTS_V2_SHOTS;
const t = accountsMessages.resolve(["de"]).t;
const r = userRecordMessages.resolve(["de"]).t;
const page = `/app/accounts/users/${USER_ID}`;
const PAIRING = "8f0b3c39-4a7e-4a37-9bdb-1f0f6b0b8f11";

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "UserScreen.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-user-screen-test",
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
  if (!build.success) throw new AggregateError(build.logs, "User screen harness build failed");
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
  const styles = [resolve(import.meta.dir, "../../../styles/app.css"), resolve(import.meta.dir, "../../../../../../styles.css")];
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

const html = (fixture: FixtureName) =>
  `<!doctype html><html lang="de" class="light" data-fixture="${fixture}"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${origin}/tabler-icons.css">` +
  `<style>${css}</style><style>html,body{height:100%;margin:0}#root{position:fixed;inset:0;display:flex}</style></head>` +
  `<body class="k2b-ui k2-ui"><div id="root"></div><script src="/harness.js"></script></body></html>`;

/** What the API answered: each deed's request, and the statuses to answer next (200 when none is queued). */
type Seen = {
  pages: string[];
  requests: { method: string; path: string; body: unknown }[];
  status: number[];
  pairing: string;
  starts: number;
  startError?: string;
};

const open = async (view: View, address: string, fixture: FixtureName = "sample") => {
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
  const seen: Seen = { pages: [], requests: [], status: [], pairing: "pending", starts: 0 };
  await tab.route(`${origin}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === page) {
      seen.pages.push(url.search);
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: html(fixture) });
    }
    if (path === "/app/accounts/users") {
      seen.pages.push(`list${url.search}`);
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: "<!doctype html><title>Benutzer</title><p>Liste</p>" });
    }
    if (path === "/harness.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: harness });
    if (path === "/tabler-icons.css") return route.fulfill({ contentType: "text/css", body: icons.css });
    if (path === "/tabler-icons.woff2") return route.fulfill({ path: icons.font });
    if (path === "/api/accounts/action-notice") return route.fulfill({ json: { failed: false } });
    if (path === "/api/accounts/groups" && request.method() === "GET") {
      const search = (url.searchParams.get("search") ?? "").toLowerCase();
      const groups = [
        { id: GROUP_ID(1), name: "Verkauf", provider: "local" },
        { id: GROUP_ID(7), name: "Lager", provider: "local" },
        { id: GROUP_ID(8), name: "Laden Nord", provider: "local" },
      ].filter((group) => group.name.toLowerCase().includes(search));
      return route.fulfill({ json: { groups } });
    }
    // the Cloud app pairing
    if (path.endsWith(`/users/${USER_ID}/pairings`)) {
      seen.starts++;
      if (seen.startError) return route.fulfill({ status: 403, json: { code: seen.startError } });
      return route.fulfill({
        status: 201,
        json: { id: PAIRING, secret: "A".repeat(43), claimUntil: "2099-01-01T00:05:00.000Z", expiresAt: "2099-01-01T00:10:00.000Z" },
      });
    }
    if (path.endsWith(`/pairings/${PAIRING}/confirm`)) {
      const body = request.postDataJSON() as { code: string };
      seen.requests.push({ method: "POST", path, body });
      if (body.code !== "123456") return route.fulfill({ status: 409, json: { code: "WRONG_CODE", attemptsLeft: 2 } });
      seen.pairing = "awaiting_device";
      return route.fulfill({ status: 204 });
    }
    if (path.endsWith(`/pairings/${PAIRING}/cancel`)) {
      seen.requests.push({ method: "POST", path, body: null });
      return route.fulfill({ status: 204 });
    }
    if (path.endsWith(`/pairings/${PAIRING}`))
      return route.fulfill({
        json: {
          state: seen.pairing,
          claimUntil: "2099-01-01T00:05:00.000Z",
          expiresAt: "2099-01-01T00:10:00.000Z",
          device: seen.pairing === "pending" ? null : { name: "iPad", platform: "ios" },
          attemptsLeft: 2,
        },
      });
    if (path.startsWith("/api/")) {
      const body = request.postData() ? request.postDataJSON() : null;
      seen.requests.push({ method: request.method(), path, body });
      const status = seen.status.shift() ?? 200;
      if (status === 502) return route.fulfill({ status, contentType: "text/plain", body: "Bad gateway" });
      if (status !== 200) return route.fulfill({ status, json: { message: "Zugriff verweigert." } });
      if (path.endsWith("/login-token"))
        return route.fulfill({
          json: { token: "tok_4f7c1e0b9a2d", magicLink: `${origin}/auth/magic#tok_4f7c1e0b9a2d`, expiresInSeconds: 900 },
        });
      if (path.endsWith("/password-reset")) return route.fulfill({ json: { message: "ok", password: "Kiefer-Blau-42" } });
      return route.fulfill({ json: { message: "Erledigt." } });
    }
    return route.fulfill({ status: 404, json: { message: "Not found" } });
  });
  await tab.goto(`${origin}${address}`);
  await tab.evaluate(() => document.fonts.ready);
  await settled(tab);
  return { context, tab, errors, seen };
};
type Opened = Awaited<ReturnType<typeof open>>;

const shoot = async (tab: Page, name: string) => {
  if (shots) await tab.screenshot({ path: join(shots, `e-${name}.png`) });
};

const expectClean = async (tab: Page) => {
  await tab.mouse.move(0, 0);
  const outline = await describeV2Page(tab, "#root");
  expect(outline.includes("Problems (") ? outline : "").toBe("");
  const layout = await measureV2Layout(tab, { root: "[data-k2-workspace]" });
  expect(layout.problems).toEqual([]);
  return outline;
};

/** Answers the open question; `agree` presses its confirming button, else Escape answers no. */
const answer = async (tab: Page, title: string, agree: boolean, confirm?: string) => {
  const question = tab.getByRole("alertdialog", { name: title });
  await question.waitFor();
  if (agree) await question.getByRole("button", { name: confirm }).click();
  else await tab.keyboard.press("Escape");
  await question.waitFor({ state: "detached" });
};

/** The next request to this path, such as the page itself after a change (it shows again in place). */
const next = (tab: Page, path: string, method = "GET") =>
  tab.waitForRequest((request) => new URL(request.url()).pathname === path && request.method() === method);

const visible = (tab: Page, role: "button" | "link" | "tab", name: string | RegExp) =>
  tab.getByRole(role, { name }).filter({ visible: true }).first();

describe("a user's record on v2", () => {
  test("every area keeps the v2 rules at 1440, 1024 and 390 px, also with the worst real data and when empty", async () => {
    const screens: [string, string, FixtureName, View[]][] = [
      ["overview", page, "sample", [wide, narrow, phone]],
      ["groups", `${page}?tab=groups&recursive=true`, "sample", [wide, narrow, phone]],
      ["keys", `${page}?tab=keys`, "sample", [wide, narrow, phone]],
      ["devices", `${page}?tab=devices`, "sample", [wide, narrow, phone]],
      ["worst-overview", page, "worst", [wide, narrow, phone]],
      ["worst-groups", `${page}?tab=groups&recursive=true`, "worst", [wide, phone]],
      ["worst-keys", `${page}?tab=keys`, "worst", [wide, phone]],
      ["worst-devices", `${page}?tab=devices`, "worst", [wide, phone]],
      ["empty-overview", page, "empty", [wide, phone]],
      ["empty-devices", `${page}?tab=devices`, "empty", [wide]],
    ];
    for (const [name, address, fixture, views] of screens)
      for (const view of views) {
        const { context, tab, errors } = await open(view, address, fixture);
        try {
          const outline = await expectClean(tab);
          if (name === "worst-overview") expect(outline).toContain(r.expiredNotice({ date: "31.10.2026" }).slice(0, 30));
          if (name === "worst-devices") {
            expect(outline).toContain(t.devicesUnavailable.slice(0, 30));
            expect(outline).toContain(t.cloudAppBlocked({ name: "Aleksandra" }).slice(0, 10));
          }
          if (name === "empty-overview") expect(outline).toContain(t.noGroupMemberships.slice(0, 30));
          await shoot(tab, `${name}-light-${view.name}`);
          expect(errors).toEqual([]);
        } finally {
          await context.close();
        }
      }
  }, 300_000);

  test("tabs and the inherited switch live in the address with the list it came from; reload and Back keep them", async () => {
    const list = "status=active&page=2";
    const { context, tab, errors, seen } = await open(wide, `${page}?list=${encodeURIComponent(list)}`);
    try {
      await visible(tab, "link", new RegExp(`^${t.groups}`)).click();
      await tab.waitForURL(`${origin}${page}?list=${encodeURIComponent(list)}&tab=groups`);
      await tab.getByText("Verkauf").first().waitFor();
      expect(await tab.getByText("Alle Mitarbeitenden").count()).toBe(0);
      await visible(tab, "link", r.includeInherited).click();
      await tab.waitForURL(/recursive=true/);
      await tab.getByText("Alle Mitarbeitenden").first().waitFor();
      // an inherited membership cannot be removed here
      expect(await tab.getByRole("button", { name: r.removeFromGroup({ group: "Alle Mitarbeitenden" }) }).count()).toBe(0);
      await tab.reload();
      await settled(tab);
      await tab.getByText("Alle Mitarbeitenden").first().waitFor();
      await tab.goBack();
      await tab.waitForURL((url) => !url.searchParams.has("recursive"));
      // every page of the record carried the list it came from
      expect(seen.pages.every((search) => new URLSearchParams(search).get("list") === list)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("removing a membership asks first, says why it failed, and shows the page again after it worked", async () => {
    const { context, tab, errors, seen } = await open(wide, `${page}?tab=groups`);
    try {
      const remove = tab.getByRole("button", { name: r.removeFromGroup({ group: "Verkauf" }) });
      const question = r.removeFromGroupQuestion({ name: "milan.horvat", group: "Verkauf" });
      await remove.click();
      await shoot(tab, "remove-membership-light-1440");
      await answer(tab, question, false);
      expect(seen.requests).toEqual([]);
      seen.status.push(403);
      await remove.click();
      await answer(tab, question, true, r.remove);
      await tab.getByText("Zugriff verweigert.").waitFor();
      const reloaded = next(tab, page);
      await remove.click();
      await answer(tab, question, true, r.remove);
      await reloaded;
      expect(seen.requests.filter((entry) => entry.method === "DELETE")).toEqual([
        { method: "DELETE", path: `/api/accounts/groups/${GROUP_ID(1)}/members`, body: { type: "user", id: USER_ID } },
        { method: "DELETE", path: `/api/accounts/groups/${GROUP_ID(1)}/members`, body: { type: "user", id: USER_ID } },
      ]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("keys, sign-in devices and app devices are revoked or removed after a question; a failure keeps them and says so", async () => {
    for (const [address, label, title, confirm, path, fallback] of [
      [
        `${page}?tab=keys`,
        t.revokeApiKeyLabel({ name: "Backup-Skript" }),
        r.revokeKeyQuestion({ name: "Backup-Skript" }),
        t.revoke,
        `/api/accounts/service-accounts/credentials/${KEY_ID(1)}`,
        t.revokeApiKeyFailed,
      ],
      [
        `${page}?tab=devices`,
        t.revokeDeviceLabel({ name: "Pixel 8" }),
        r.revokeDeviceQuestion({ name: "Pixel 8" }),
        t.revokeDevice,
        `/api/accounts/users/${USER_ID}/devices/${DEVICE_ID(1)}`,
        t.revokeDeviceFailed,
      ],
      [
        `${page}?tab=devices`,
        t.removeAppDeviceLabel({ name: "iPhone im Laden" }),
        r.removeAppDeviceQuestion({ name: "iPhone im Laden" }),
        t.removeAppDevice,
        `/api/accounts/users/${USER_ID}/app-devices/${PHONE_ID(1)}`,
        t.removeAppDeviceFailed,
      ],
    ] as const) {
      for (const view of [wide, phone]) {
        const { context, tab, errors, seen } = await open(view, address);
        try {
          const button = visible(tab, "button", label);
          await button.click();
          await answer(tab, title, false);
          expect(seen.requests).toEqual([]);
          // a proxy page carries no message: the deed's own sentence
          seen.status.push(502);
          await button.click();
          await answer(tab, title, true, confirm);
          await tab.getByText(fallback).waitFor();
          const reloaded = next(tab, page);
          await button.click();
          await answer(tab, title, true, confirm);
          await reloaded;
          expect(seen.requests.map((entry) => `${entry.method} ${entry.path}`)).toEqual([`DELETE ${path}`, `DELETE ${path}`]);
          expect(errors).toEqual([]);
        } finally {
          await context.close();
        }
      }
    }
  }, 180_000);

  test("the actions menu offers the account's deeds; editing saves, a login token shows once, deleting returns to the list", async () => {
    const { context, tab, errors, seen } = await open(wide, `${page}?list=${encodeURIComponent("status=active")}`);
    try {
      const menu = async () => {
        await tab.getByRole("button", { name: t.userActions }).click();
        return tab.getByRole("menu");
      };
      let opened = await menu();
      for (const entry of [
        t.actionsByUser,
        t.changeAvatar,
        t.edit,
        t.notify,
        t.setExpiry,
        t.loginToken,
        t.demote,
        t.grantAdmin,
        t.createFreeIpa,
        t.delete,
      ])
        await opened.getByRole("menuitem", { name: entry }).waitFor();
      await shoot(tab, "actions-light-1440");
      // edit: a required field left empty says so and sends nothing; a saved name is sent with the address unchanged
      await opened.getByRole("menuitem", { name: t.edit }).click();
      const dialog = tab.locator("[data-k2-part=Dialog]");
      await dialog.waitFor();
      await dialog.getByRole("textbox", { name: t.email }).fill("");
      await dialog.getByRole("button", { name: t.save }).click();
      await dialog.getByText(r.required).waitFor();
      expect(seen.requests).toEqual([]);
      await dialog.getByRole("textbox", { name: t.email }).fill("milan.horvat@solberg-kramer.example");
      await dialog.getByRole("textbox", { name: t.displayName }).fill("Milan H.");
      await shoot(tab, "edit-light-1440");
      await dialog.getByRole("button", { name: t.save }).click();
      await dialog.waitFor({ state: "detached" });
      expect(seen.requests.at(-1)).toEqual({
        method: "PATCH",
        path: `/api/accounts/users/${USER_ID}`,
        body: { givenname: "Milan", sn: "Horvat", displayName: "Milan H.", mail: "milan.horvat@solberg-kramer.example" },
      });
      // the expiry takes a day
      opened = await menu();
      await opened.getByRole("menuitem", { name: t.setExpiry }).click();
      await dialog.getByRole("textbox", { name: t.expiryDate }).fill("31.12.2026");
      await dialog.getByRole("button", { name: t.setExpiry }).click();
      await dialog.waitFor({ state: "detached" });
      expect(seen.requests.at(-1)).toEqual({
        method: "PUT",
        path: `/api/accounts/users/${USER_ID}/expiry`,
        body: { expiryDate: "2026-12-31" },
      });
      // a login token: asks, then shows token and link once; a press outside keeps them
      opened = await menu();
      await opened.getByRole("menuitem", { name: t.loginToken }).click();
      await answer(tab, t.createLoginToken, true, t.createToken);
      await dialog.getByText("tok_4f7c1e0b9a2d").first().waitFor();
      await shoot(tab, "login-token-light-1440");
      await tab.mouse.click(4, 4);
      await settled(tab);
      expect(await dialog.getByText("tok_4f7c1e0b9a2d").first().isVisible()).toBe(true);
      await dialog.getByRole("button", { name: t.done }).click();
      await dialog.waitFor({ state: "detached" });
      expect(await tab.content()).not.toContain("tok_4f7c1e0b9a2d");
      // demote to guest asks and sends the profile
      opened = await menu();
      await opened.getByRole("menuitem", { name: t.demote }).click();
      const profiled = next(tab, `/api/accounts/users/${USER_ID}/profile`, "PUT");
      await answer(tab, t.setGuestQuestion({ uid: "milan.horvat" }), true, t.setGuestAccount);
      expect((await profiled).postDataJSON()).toEqual({ profile: "guest" });
      // delete: asks, then opens the list it came from
      opened = await menu();
      await opened.getByRole("menuitem", { name: t.delete }).click();
      const listed = next(tab, "/app/accounts/users");
      await answer(tab, t.deleteUserQuestion({ uid: "milan.horvat" }), true, t.delete);
      expect(new URL((await listed).url()).search).toBe("?status=active");
      expect(seen.requests.some((entry) => entry.method === "DELETE" && entry.path === `/api/accounts/users/${USER_ID}`)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 120_000);

  test("adding to groups searches groups the person is not in and adds each chosen one", async () => {
    const { context, tab, errors, seen } = await open(wide, `${page}?tab=groups`);
    try {
      await visible(tab, "button", r.addToGroups).click();
      const dialog = tab.locator("[data-k2-part=Dialog]");
      await dialog.getByRole("button", { name: t.add }).click();
      await dialog.getByText(r.chooseGroup).waitFor();
      await dialog.getByRole("searchbox").fill("la");
      await dialog.getByRole("option", { name: /Lager/ }).click();
      // a group the person is already in is not offered
      expect(await dialog.getByRole("option", { name: /Verkauf/ }).count()).toBe(0);
      await shoot(tab, "add-groups-light-1440");
      const reloaded = next(tab, page);
      await dialog.getByRole("button", { name: t.add }).click();
      await reloaded;
      expect(seen.requests).toEqual([
        { method: "POST", path: `/api/accounts/groups/${GROUP_ID(7)}/members`, body: { type: "user", id: USER_ID } },
      ]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("pairing the Cloud app shows the code, keeps a wrong code's message, waits for the person and ends on close", async () => {
    const { context, tab, errors, seen } = await open(wide, `${page}?tab=devices`);
    try {
      await visible(tab, "button", t.cloudAppPair).click();
      const dialog = tab.locator("[data-k2-part=Dialog]");
      await dialog.locator("img").waitFor();
      expect(await dialog.locator("ol li").count()).toBe(3);
      await dialog.getByText(t.cloudAppPairWarning({ name: "Milan Horvat" })).waitFor();
      await shoot(tab, "pair-light-1440");
      seen.pairing = "claimed";
      const code = dialog.getByRole("textbox", { name: t.cloudAppCode });
      await code.waitFor({ timeout: 15_000 });
      await code.fill("111111");
      await dialog.getByRole("button", { name: t.cloudAppConfirm }).click();
      await dialog.getByText(t.cloudAppWrongCode({ count: 2 })).waitFor();
      await code.fill("123456");
      await dialog.getByRole("button", { name: t.cloudAppConfirm }).click();
      await dialog.getByText(t.cloudAppWaiting({ name: "Milan Horvat" })).waitFor();
      await dialog.getByText(t.cloudAppDeviceHint({ administrator: "Ada Admin" })).waitFor();
      await shoot(tab, "pair-waiting-light-1440");
      await dialog.getByRole("button", { name: t.cloudAppCancel }).click();
      await dialog.waitFor({ state: "detached" });
      expect(seen.requests.map((entry) => entry.path.split("/").at(-1))).toEqual(["confirm", "confirm", "cancel"]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 90_000);

  test("emptying an address that may go asks first; agreeing removes it, no keeps it", async () => {
    const { context, tab, errors, seen } = await open(wide, page, "optional-email");
    try {
      const dialog = tab.locator("[data-k2-part=Dialog]");
      await tab.getByRole("button", { name: t.userActions }).click();
      await tab.getByRole("menuitem", { name: t.edit }).click();
      await dialog.getByRole("textbox", { name: t.email }).fill("");
      const question = t.removeEmailQuestion({ email: "milan.horvat@solberg-kramer.example" });
      await dialog.getByRole("button", { name: t.save }).click();
      await answer(tab, question, false);
      expect(seen.requests).toEqual([]);
      await dialog.getByRole("button", { name: t.save }).click();
      const patched = next(tab, `/api/accounts/users/${USER_ID}`, "PATCH");
      await answer(tab, question, true, t.removeEmail);
      expect((await patched).postDataJSON()).toEqual({ givenname: "Milan", sn: "Horvat", displayName: "Milan Horvat", mail: null });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("a finished pairing names the device and shows the list again after closing; a reload resumes a running one", async () => {
    let opened: Opened = await open(wide, `${page}?tab=devices`);
    try {
      const { tab, seen } = opened;
      seen.pairing = "completed";
      await visible(tab, "button", t.cloudAppPair).click();
      const dialog = tab.locator("[data-k2-part=Dialog]");
      await dialog.getByText(t.cloudAppSuccess({ name: "iPad" })).waitFor();
      await dialog.getByText(t.cloudAppSuccessHint({ name: "Milan Horvat" })).waitFor();
      const reloaded = next(tab, page);
      await dialog.getByRole("button", { name: t.close }).click();
      await reloaded;
      expect(opened.errors).toEqual([]);
    } finally {
      await opened.context.close();
    }
    opened = await open(wide, `${page}?tab=devices`);
    try {
      const { tab, seen } = opened;
      await visible(tab, "button", t.cloudAppPair).click();
      await tab.locator("[data-k2-part=Dialog] img").waitFor();
      // the tab keeps the pairing's id, never its secret
      const saved = await tab.evaluate((key) => sessionStorage.getItem(key), `cloud.admin-pwa-pairing:${USER_ID}`);
      expect(saved).toContain(PAIRING);
      expect(saved).not.toContain("A".repeat(43));
      seen.pairing = "claimed";
      await tab.reload();
      await tab.locator("[data-k2-part=Dialog]").getByRole("textbox", { name: t.cloudAppCode }).waitFor({ timeout: 15_000 });
      expect(seen.starts).toBe(1);
      seen.pairing = "rejected";
      await tab.getByText(t.cloudAppRejected({ name: "Milan Horvat" })).waitFor({ timeout: 15_000 });
      expect(opened.errors).toEqual([]);
    } finally {
      await opened.context.close();
    }
  }, 90_000);

  test("a pairing that needs a fresh sign-in leads back to the same record, which opens it again", async () => {
    const { context, tab, errors, seen } = await open(wide, `${page}?tab=devices`);
    try {
      seen.startError = "REAUTHENTICATE";
      await visible(tab, "button", t.cloudAppPair).click();
      const link = tab.locator("[data-k2-part=Dialog]").getByRole("link", { name: t.cloudAppSignIn });
      await link.waitFor();
      const redirect = new URL((await link.getAttribute("href")) ?? "", origin).searchParams.get("redirectTo");
      expect(redirect).toBe(`${page}?tab=devices&pairCloudApp=1`);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);
});
