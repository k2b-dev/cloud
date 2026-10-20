import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../../../ui/test/browser";
import { accountMessages } from "./messages";

// A password change signs the person out everywhere else. The dialog says so before the change,
// the result names what stays valid, and a failed sign-out keeps a way to retry it.
const root = mkdtempSync(join(tmpdir(), "core-password-change-browser-"));
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const ui = resolve(import.meta.dir, "../../../../ui");
const { buildFontAssets } = await import("../../../scripts/font-assets");
const { buildTablerIconAssets } = await import("../../../scripts/tabler-assets");
const origin = "https://cloud.example.test";

/** The real island, compiled for the browser with Solid's DOM output as Cloud's client build does. */
const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "ProfileSettings.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-password-dialog-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Password dialog harness build failed");
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
  css = ["@layer properties, theme, base, components, utilities;", appCss, globalCss].join("\n");
  await buildFontAssets(join(root, "public"));
  await buildTablerIconAssets(join(root, "public"));
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

type View = { width: number; height: number; touch: boolean };
const desktop: View = { width: 1440, height: 900, touch: false };
const phone: View = { width: 390, height: 844, touch: true };
// The WCAG reflow width.
const narrowPhone: View = { width: 320, height: 640, touch: true };

/** `raw` sends a body as is, for an answer the page cannot read. */
type Answer = { status: number; json?: unknown; raw?: string };
type Api = { password: Answer[]; signOutOthers: Answer[]; calls: string[] };

/** Opens the sign-in actions; the API answers come from `api` in order, and every call is recorded. */
const open = async (view: View, lang: "en" | "de", api: Api, path = "/me/security") => {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: 1,
    isMobile: view.touch,
    hasTouch: view.touch,
    reducedMotion: "reduce",
  });
  const tab = await context.newPage();
  await tab.route(`${origin}/**`, async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/me/security")
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body:
          // Playwright's WebKit ignores the charset of a routed response, so the page names it, as a Cloud page does.
          `<!doctype html><html lang="${lang}" class="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
          `<link rel="stylesheet" href="${origin}/public/fonts.css"><link rel="stylesheet" href="${origin}/public/tabler-icons.css"><style>${css}</style></head>` +
          `<body class="k2b-ui"><div id="root"></div><script src="/harness.js"></script></body></html>`,
      });
    if (pathname === "/harness.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: harness });
    if (pathname.startsWith("/public/")) return route.fulfill({ path: join(root, pathname) });
    if (route.request().method() === "POST" && pathname === "/api/me/password") {
      api.calls.push("password");
      const answer = api.password.shift();
      if (!answer) throw new Error("Unexpected password change");
      return route.fulfill({ status: answer.status, json: answer.json });
    }
    if (route.request().method() === "POST" && pathname === "/api/me/sign-ins/sign-out-others") {
      api.calls.push("sign-out-others");
      const answer = api.signOutOthers.shift();
      if (!answer) throw new Error("Unexpected sign-out");
      if (answer.raw !== undefined) return route.fulfill({ status: answer.status, contentType: "application/json", body: answer.raw });
      return route.fulfill({ status: answer.status, json: answer.json });
    }
    return route.fulfill({ status: 404, body: "" });
  });
  await tab.goto(`${origin}${path}`);
  await tab.evaluate(() => document.fonts.ready);
  return { context, tab };
};

const openDialog = async (tab: Page, lang: "en" | "de") => {
  const t = accountMessages.resolve([lang]).t;
  await tab.getByRole("button", { name: new RegExp(t.changePassword) }).click();
  const dialog = tab.locator("dialog[open]");
  await dialog.getByText(t.changePasswordSignsOutHint).waitFor();
  return dialog;
};

const submit = async (tab: Page, lang: "en" | "de") => {
  const dialog = await openDialog(tab, lang);
  const fields = dialog.locator("input[type='password']");
  await fields.nth(0).fill("Current-password-1!");
  await fields.nth(1).fill("Correct-horse-battery-2026");
  await fields.nth(2).fill("Correct-horse-battery-2026");
  await dialog.locator("button[type='submit']").click();
};

const ok: Answer = { status: 200, json: { message: "Password changed successfully.", signInAgain: false } };
const signedOutHere: Answer = {
  status: 200,
  json: { message: "Password changed. You are signed out everywhere, including this browser. Sign in again.", signInAgain: true },
};
const signOutFailed: Answer = {
  status: 500,
  json: { code: "SIGN_OUT_OTHERS_FAILED", message: "Password changed. Signing out your other sign-ins did not work." },
};

describe("changing the password in a browser", () => {
  test("says before the change that every other sign-in ends, inside the dialog on computers and phones", async () => {
    for (const view of [desktop, phone, narrowPhone])
      for (const lang of ["en", "de"] as const) {
        const { context, tab } = await open(view, lang, { password: [], signOutOthers: [], calls: [] });
        try {
          const dialog = await openDialog(tab, lang);
          const t = accountMessages.resolve([lang]).t;
          const layout = await dialog.evaluate((element, hint) => {
            const box = element.getBoundingClientRect();
            const text = Array.from(element.querySelectorAll("p")).find((paragraph) => paragraph.textContent === hint)!;
            const line = text.getBoundingClientRect();
            const buttons = Array.from(element.querySelectorAll("button[type='submit']")).map((button) => button.getBoundingClientRect());
            return {
              inside: line.left >= box.left && line.right <= box.right,
              aboveActions: buttons.every((button) => line.bottom <= button.top),
              overflow: document.documentElement.scrollWidth - window.innerWidth,
            };
          }, t.changePasswordSignsOutHint);
          expect({ width: view.width, lang, inside: layout.inside, aboveActions: layout.aboveActions }).toEqual({
            width: view.width,
            lang,
            inside: true,
            aboveActions: true,
          });
          expect(layout.overflow).toBeLessThanOrEqual(0);
        } finally {
          await context.close();
        }
      }
  }, 120_000);

  test("confirms the change and names what stays valid", async () => {
    const api: Api = { password: [ok], signOutOthers: [], calls: [] };
    const { context, tab } = await open(phone, "de", api);
    try {
      await submit(tab, "de");
      await tab
        .locator("dialog[open]")
        .getByText(accountMessages.resolve(["de"]).t.passwordChangedSignedOut)
        .waitFor();
      expect(api.calls).toEqual(["password"]);
    } finally {
      await context.close();
    }
  }, 30_000);

  test("keeps a retry when the password changed but the other sign-ins stayed", async () => {
    const t = accountMessages.resolve(["en"]).t;
    const api: Api = {
      password: [signOutFailed],
      signOutOthers: [signOutFailed, ok],
      calls: [],
    };
    const { context, tab } = await open(phone, "en", api);
    try {
      await submit(tab, "en");
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const failed = tab.locator("dialog[open]").filter({ hasText: t.passwordChangedSignOutFailed });
        await failed.waitFor();
        await failed.locator(".k2b-dialog__actions button", { hasText: t.tryAgain }).click();
      }
      await tab.locator("dialog[open]").getByText(t.passwordChangedSignedOut).waitFor();
      expect(api.calls).toEqual(["password", "sign-out-others", "sign-out-others"]);
    } finally {
      await context.close();
    }
  }, 30_000);

  test("asks to sign in again when this browser could not stay signed in, and comes back here afterwards", async () => {
    const t = accountMessages.resolve(["de"]).t;
    const api: Api = { password: [signedOutHere], signOutOthers: [], calls: [] };
    const { context, tab } = await open(phone, "de", api);
    try {
      await submit(tab, "de");
      const notice = tab.locator("dialog[open]").filter({ hasText: t.passwordChangedSignInAgain });
      await notice.locator(".k2b-dialog__actions button", { hasText: t.signInAgain }).click();
      await tab.waitForURL(`${origin}/auth/login?redirectTo=%2Fme%2Fsecurity`);
      expect(api.calls).toEqual(["password"]);
    } finally {
      await context.close();
    }
  }, 30_000);

  test("asks to sign in when a retry finds no browser sign-in here, and retries after coming back", async () => {
    const t = accountMessages.resolve(["en"]).t;
    // 401: this browser's sign-in ended. 403: the request fell back to a mobile app session.
    for (const status of [401, 403]) {
      const api: Api = {
        password: [signOutFailed],
        signOutOthers: [{ status, json: { code: "FIXTURE", message: "Fixture" } }],
        calls: [],
      };
      const { context, tab } = await open(phone, "en", api);
      try {
        await submit(tab, "en");
        const failed = tab.locator("dialog[open]").filter({ hasText: t.passwordChangedSignOutFailed });
        await failed.locator(".k2b-dialog__actions button", { hasText: t.tryAgain }).click();
        // It does not claim that the other sign-ins ended.
        const notice = tab.locator("dialog[open]").filter({ hasText: t.signInToFinishSignOut });
        await notice.locator(".k2b-dialog__actions button", { hasText: t.signInAgain }).click();
        await tab.waitForURL(`${origin}/auth/login?redirectTo=%2Fme%2Fsecurity%3FsignOutOthers%3Dretry`);
        expect({ status, calls: api.calls }).toEqual({ status, calls: ["password", "sign-out-others"] });
      } finally {
        await context.close();
      }
    }
  }, 60_000);

  test("keeps the retry in the address until it succeeds, so a reload or a new sign-in asks again", async () => {
    const t = accountMessages.resolve(["de"]).t;
    const api: Api = { password: [signOutFailed], signOutOthers: [ok], calls: [] };
    const { context, tab } = await open(phone, "de", api);
    try {
      await submit(tab, "de");
      const failed = tab.locator("dialog[open]").filter({ hasText: t.passwordChangedSignOutFailed });
      await failed.waitFor();
      expect(tab.url()).toBe(`${origin}/me/security?signOutOthers=retry`);
      await tab.reload();
      await failed.waitFor();
      expect(tab.url()).toBe(`${origin}/me/security?signOutOthers=retry`);
      await failed.locator(".k2b-dialog__actions button", { hasText: t.tryAgain }).click();
      await tab.locator("dialog[open]").getByText(t.passwordChangedSignedOut).waitFor();
      expect(tab.url()).toBe(`${origin}/me/security`);
      expect(api.calls).toEqual(["password", "sign-out-others"]);
    } finally {
      await context.close();
    }
  }, 30_000);

  test("asks again when a retry answer cannot be read", async () => {
    const t = accountMessages.resolve(["en"]).t;
    const api: Api = { password: [signOutFailed], signOutOthers: [{ status: 200, raw: "{" }, ok], calls: [] };
    const { context, tab } = await open(phone, "en", api);
    try {
      await submit(tab, "en");
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const failed = tab.locator("dialog[open]").filter({ hasText: t.passwordChangedSignOutFailed });
        await failed.waitFor();
        await failed.locator(".k2b-dialog__actions button", { hasText: t.tryAgain }).click();
      }
      await tab.locator("dialog[open]").getByText(t.passwordChangedSignedOut).waitFor();
      expect(api.calls).toEqual(["password", "sign-out-others", "sign-out-others"]);
    } finally {
      await context.close();
    }
  }, 30_000);

  test("closing the retry leaves the password changed and asks nothing else", async () => {
    const t = accountMessages.resolve(["en"]).t;
    const api: Api = { password: [signOutFailed], signOutOthers: [], calls: [] };
    const { context, tab } = await open(desktop, "en", api);
    try {
      await submit(tab, "en");
      const failed = tab.locator("dialog[open]").filter({ hasText: t.passwordChangedSignOutFailed });
      await failed.locator(".k2b-dialog__actions button", { hasText: t.close }).click();
      await tab.locator("dialog[open]").waitFor({ state: "detached" });
      expect(tab.url()).toBe(`${origin}/me/security`);
      expect(api.calls).toEqual(["password"]);
    } finally {
      await context.close();
    }
  }, 30_000);

  test("a wrong current password still says so and signs nobody out", async () => {
    const t = accountMessages.resolve(["en"]).t;
    const api: Api = {
      password: [{ status: 401, json: { code: "UNAUTHENTICATED", message: "Current password is incorrect." } }],
      signOutOthers: [],
      calls: [],
    };
    const { context, tab } = await open(desktop, "en", api);
    try {
      await submit(tab, "en");
      await tab.locator("dialog[open]").getByText(t.currentPasswordIncorrect).waitFor();
      expect(api.calls).toEqual(["password"]);
    } finally {
      await context.close();
    }
  }, 30_000);
});
