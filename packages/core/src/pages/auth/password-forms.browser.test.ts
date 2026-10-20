import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../../../ui/test/browser";
import { authMessages } from "./messages";

// Setting a password on the sign-in page signs this browser in and ends every other sign-in.
// If ending them fails, the form keeps a retry in place instead of continuing silently.
const root = mkdtempSync(join(tmpdir(), "core-password-forms-browser-"));
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const ui = resolve(import.meta.dir, "../../../../ui");
const { buildFontAssets } = await import("../../../scripts/font-assets");
const { buildTablerIconAssets } = await import("../../../scripts/tabler-assets");
const origin = "https://cloud.example.test";
const continueUrl = `${origin}/auth/continue?redirectTo=%2Ffiles%3Ffolder%3D1`;
const query = (form: Form) =>
  form === "reset" ? "?token=fixture-token&redirectTo=%2Ffiles%3Ffolder%3D1" : "?redirectTo=%2Ffiles%3Ffolder%3D1";
const pathOf = (form: Form) =>
  form === "login" ? "/auth/login-form" : form === "new-password" ? "/auth/new-password" : "/auth/password-reset";
/** The form's address at the retry: the used token is gone, the destination stays. */
const retryPath = (form: Form) => `${pathOf(form)}?redirectTo=%2Ffiles%3Ffolder%3D1&signOutOthers=retry`;

/** The real islands, compiled for the browser with Solid's DOM output as Cloud's client build does. */
const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "password-forms.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-password-forms-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Password forms harness build failed");
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

type Form = "new-password" | "reset" | "login";
/** `hold` keeps the answer back until the test releases it. */
type Answer = { status: number; json?: unknown; hold?: Promise<void> };
type Api = { change: Answer[]; signOutOthers: Answer[]; calls: string[] };

const page = (lang: string) =>
  // Playwright's WebKit ignores the charset of a routed response, so the page names it, as a Cloud page does.
  `<!doctype html><html lang="${lang}" class="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<link rel="stylesheet" href="${origin}/public/fonts.css"><link rel="stylesheet" href="${origin}/public/tabler-icons.css"><style>${css}</style></head>` +
  `<body class="k2b-ui"><main class="mx-auto w-full max-w-md p-4"><div id="root"></div></main><script src="/harness.js"></script></body></html>`;

/** Opens one form; the API answers come from `api` in order, and every call is recorded. */
const open = async (form: Form, view: View, lang: "en" | "de", api: Api, path = `${pathOf(form)}${query(form)}`) => {
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
    const method = route.request().method();
    if (method === "GET" && (pathname === "/auth/new-password" || pathname === "/auth/password-reset" || pathname === "/auth/login-form"))
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: page(lang) });
    if (method === "GET" && (pathname === "/auth/continue" || pathname === "/auth/login"))
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: "<!doctype html><title>next</title>" });
    if (pathname === "/harness.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: harness });
    if (pathname.startsWith("/public/")) return route.fulfill({ path: join(root, pathname) });
    const queue =
      method === "POST" &&
      (pathname === "/api/auth/change-expired-password" ||
        pathname === "/api/auth/password-reset/complete" ||
        pathname === "/api/auth/login")
        ? { name: "change", answers: api.change }
        : method === "POST" && pathname === "/api/me/sign-ins/sign-out-others"
          ? { name: "sign-out-others", answers: api.signOutOthers }
          : null;
    if (!queue) return route.fulfill({ status: 404, body: "" });
    api.calls.push(queue.name);
    const answer = queue.answers.shift();
    if (!answer) throw new Error(`Unexpected ${queue.name}`);
    await answer.hold;
    return route.fulfill({ status: answer.status, json: answer.json });
  });
  await tab.goto(`${origin}${path}`);
  await tab.evaluate(() => document.fonts.ready);
  return { context, tab };
};

const submit = async (tab: Page, form: Form) => {
  const fields = tab.locator("input[type='password']");
  if (form === "login") {
    await fields.first().fill("Correct-horse-battery-2026");
    return tab.locator("button[type='submit']").click();
  }
  let index = 0;
  if (form === "new-password") await fields.nth(index++).fill("Temporary-password-1!");
  await fields.nth(index++).fill("Correct-horse-battery-2026");
  await fields.nth(index).fill("Correct-horse-battery-2026");
  await tab.locator("button[type='submit']").click();
};

const changed = (signOutOthersFailed: boolean): Answer => ({
  status: 200,
  json: { session_token: "fixture", user: { id: "fixture" }, signOutOthersFailed },
});
const keptHere: Answer = { status: 200, json: { message: "Other sign-ins ended.", signInAgain: false } };
const failedAgain: Answer = {
  status: 500,
  json: { code: "SIGN_OUT_OTHERS_FAILED", message: "Signing out your other sign-ins did not work. Try again." },
};

const recovery = (tab: Page, lang: "en" | "de") =>
  tab.locator(".k2b-notice-card").filter({ hasText: authMessages.resolve([lang]).t.passwordChangedSignOutFailed });

describe("setting a password on the sign-in page", () => {
  test("continues straight away when the other sign-ins ended", async () => {
    for (const form of ["new-password", "reset"] as const) {
      const api: Api = { change: [changed(false)], signOutOthers: [], calls: [] };
      const { context, tab } = await open(form, phone, "en", api);
      try {
        await submit(tab, form);
        await tab.waitForURL(continueUrl);
        expect({ form, calls: api.calls }).toEqual({ form, calls: ["change"] });
      } finally {
        await context.close();
      }
    }
  }, 60_000);

  test("keeps a retry in place on computers and phones, and continues once the other sign-ins ended", async () => {
    for (const form of ["new-password", "reset"] as const)
      for (const view of [desktop, phone, narrowPhone])
        for (const lang of ["en", "de"] as const) {
          const t = authMessages.resolve([lang]).t;
          let release!: () => void;
          const hold = new Promise<void>((resolve) => {
            release = resolve;
          });
          const api: Api = { change: [changed(true)], signOutOthers: [{ ...failedAgain, hold }, keptHere], calls: [] };
          const { context, tab } = await open(form, view, lang, api);
          try {
            await submit(tab, form);
            const notice = recovery(tab, lang);
            await notice.waitFor();
            expect(await tab.locator("input[type='password']").count()).toBe(0);
            expect(tab.url()).toBe(`${origin}${retryPath(form)}`);
            await notice.getByText(t.signOutOthersRetryHint).waitFor();
            const retry = notice.getByRole("button", { name: t.tryAgain });
            const before = await notice.boundingBox();
            await retry.click();
            await notice.getByRole("button", { name: t.signingOutOthers }).waitFor();
            const busy = await notice.boundingBox();
            release();
            await retry.waitFor();
            const after = await notice.boundingBox();
            // Retrying neither moves nor resizes the notice.
            expect({ form, width: view.width, lang, busy, after }).toEqual({ form, width: view.width, lang, busy: before, after: before });
            const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
            expect(overflow).toBeLessThanOrEqual(0);
            await retry.click();
            await tab.waitForURL(continueUrl);
            expect(api.calls).toEqual(["change", "sign-out-others", "sign-out-others"]);
          } finally {
            await context.close();
          }
        }
  }, 240_000);

  test("comes back to the retry after signing in or accepting the terms when a retry finds no browser sign-in", async () => {
    const t = authMessages.resolve(["de"]).t;
    // 401: this browser's sign-in ended or still waits for the terms. 403: the request fell back to a mobile app session.
    for (const [form, status] of [
      ["reset", 401],
      ["new-password", 403],
    ] as const) {
      const api: Api = { change: [changed(true)], signOutOthers: [{ status, json: { code: "FIXTURE", message: "Fixture" } }], calls: [] };
      const { context, tab } = await open(form, phone, "de", api);
      try {
        await submit(tab, form);
        await recovery(tab, "de").getByRole("button", { name: t.tryAgain }).click();
        await tab.waitForURL(`${origin}/auth/continue?${new URLSearchParams({ redirectTo: retryPath(form) })}`);
        expect({ form, calls: api.calls }).toEqual({ form, calls: ["change", "sign-out-others"] });
      } finally {
        await context.close();
      }
    }
  }, 60_000);

  test("opens at the retry from its address, after a reload or a sign-in", async () => {
    const t = authMessages.resolve(["en"]).t;
    for (const form of ["new-password", "reset"] as const) {
      const api: Api = { change: [], signOutOthers: [keptHere], calls: [] };
      const { context, tab } = await open(form, phone, "en", api, retryPath(form));
      try {
        await recovery(tab, "en").getByRole("button", { name: t.tryAgain }).click();
        await tab.waitForURL(continueUrl);
        expect({ form, calls: api.calls }).toEqual({ form, calls: ["sign-out-others"] });
      } finally {
        await context.close();
      }
    }
  }, 60_000);

  test("offers a new reset link where a failed reset is reported", async () => {
    // The first attempt uses up the link, so the way on is a new one, not another try.
    const message = "Your password was changed, but signing you out everywhere did not work. Request a new reset link to finish.";
    for (const view of [phone, narrowPhone])
      for (const lang of ["en", "de"] as const) {
        const t = authMessages.resolve([lang]).t;
        const api: Api = { change: [{ status: 500, json: { message } }], signOutOthers: [], calls: [] };
        const { context, tab } = await open("reset", view, lang, api);
        try {
          await submit(tab, "reset");
          const notice = tab.locator(".k2b-notice-card").filter({ hasText: message });
          await notice.waitFor();
          const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          expect({ width: view.width, lang, overflow: overflow <= 0 }).toEqual({ width: view.width, lang, overflow: true });
          await notice.getByRole("link", { name: t.requestNewResetLink }).click();
          await tab.waitForURL(`${origin}/auth/password-reset?redirectTo=%2Ffiles%3Ffolder%3D1`);
          expect(api.calls).toEqual(["change"]);
        } finally {
          await context.close();
        }
      }
  }, 60_000);

  test("asks for a sign-in with the new password when a sign-out everywhere ended the new sign-in", async () => {
    // The password is changed, so the form is done: the way on is the sign-in page, which keeps the destination.
    for (const form of ["new-password", "reset"] as const)
      for (const view of [phone, narrowPhone])
        for (const lang of ["en", "de"] as const) {
          const t = authMessages.resolve([lang]).t;
          const message = "Your password was changed, but you were signed out everywhere while signing in. Sign in again.";
          const api: Api = { change: [{ status: 409, json: { message } }], signOutOthers: [], calls: [] };
          const { context, tab } = await open(form, view, lang, api);
          try {
            await submit(tab, form);
            const notice = tab.locator(".k2b-notice-card").filter({ hasText: t.passwordChangedSignInAgain });
            await notice.waitFor();
            expect(await tab.locator("input[type='password']").count()).toBe(0);
            const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
            expect({ form, width: view.width, lang, overflow: overflow <= 0 }).toEqual({ form, width: view.width, lang, overflow: true });
            await notice.getByRole("link", { name: t.signIn }).click();
            await tab.waitForURL(`${origin}/auth/login?redirectTo=%2Ffiles%3Ffolder%3D1`);
            expect(api.calls).toEqual(["change"]);
          } finally {
            await context.close();
          }
        }
  }, 120_000);

  test("signing in says in the person's language that a sign-out everywhere ended the sign-in, and the next try signs in", async () => {
    for (const lang of ["en", "de"] as const) {
      const t = authMessages.resolve([lang]).t;
      const message = "You were signed out everywhere while signing in. Sign in again.";
      const api: Api = { change: [{ status: 409, json: { message } }, changed(false)], signOutOthers: [], calls: [] };
      const { context, tab } = await open("login", phone, lang, api);
      try {
        await submit(tab, "login");
        await tab.locator(".k2b-notice-card").filter({ hasText: t.signedOutWhileSigningIn }).waitFor();
        await tab.locator("button[type='submit']").click();
        await tab.waitForURL(continueUrl);
        expect({ lang, calls: api.calls }).toEqual({ lang, calls: ["change", "change"] });
      } finally {
        await context.close();
      }
    }
  }, 60_000);

  test("lets the person continue without the retry", async () => {
    const t = authMessages.resolve(["en"]).t;
    const api: Api = { change: [changed(true)], signOutOthers: [], calls: [] };
    const { context, tab } = await open("new-password", desktop, "en", api);
    try {
      await submit(tab, "new-password");
      await recovery(tab, "en").getByRole("link", { name: t.continueWithoutSignOut }).click();
      await tab.waitForURL(continueUrl);
      expect(api.calls).toEqual(["change"]);
    } finally {
      await context.close();
    }
  }, 30_000);
});
