import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeV2Page } from "@k2b/ui/v2/testing";
import tailwind from "bun-plugin-tailwind";
import type { Browser, BrowserContext, Page, Request } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../../../ui/test/browser";

// The deeds of the account and sign-in screens on v2, end to end in a browser: the screens render from frozen fixtures
// and the test answers the API itself, so every request's address and payload is checked. Only presentation changed
// in v2; these tests pin that the requests, the sign-in confirmation and the redirects are still the same.
const ui = resolve(import.meta.dir, "../../../../ui");
const origin = "https://cloud.example.test";

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "AccountScreens.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-account-screens-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Account screens harness build failed");
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
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

type Answer = { status?: number; json: unknown } | "abort";
type Api = Record<string, Answer[]>;
type Seen = { method: string; path: string; body: unknown }[];

const page = (screen: string) =>
  `<!doctype html><html lang="en" class="light" data-screen="${screen}"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style>` +
  `<style>html,body{height:100%;margin:0}#root{position:fixed;inset:0;display:flex}</style></head>` +
  `<body class="k2b-ui k2-ui"><div id="root"></div><script src="/harness.js"></script></body></html>`;

/** Opens a screen at `address`; `api` answers "METHOD /path" in order, everything else is a 404. */
const open = async (screen: string, address: string, api: Api) => {
  const context: BrowserContext = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" });
  // Date starts at a fixed instant, so dates the page computes are the same on every day the test runs.
  await context.addInitScript(pinPageClock, Date.parse(PINNED));
  const tab = await context.newPage();
  tab.setDefaultTimeout(10_000);
  const errors = pageErrors(tab);
  const seen: Seen = [];
  const navigations: string[] = [];
  await tab.route(`${origin}/**`, async (route) => {
    const request: Request = route.request();
    const url = new URL(request.url());
    if (request.isNavigationRequest() && url.pathname !== new URL(address, origin).pathname) {
      navigations.push(`${url.pathname}${url.search}`);
      return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>left</title>" });
    }
    if (request.isNavigationRequest()) return route.fulfill({ contentType: "text/html; charset=utf-8", body: page(screen) });
    if (url.pathname === "/harness.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: harness });
    const key = `${request.method()} ${url.pathname}`;
    // the requests of the API; pictures such as the logo are not
    if (url.pathname.startsWith("/api/"))
      seen.push({ method: request.method(), path: url.pathname, body: request.postData() ? request.postDataJSON() : null });
    const answer = api[key]?.shift();
    if (answer === "abort") return route.abort("connectionreset");
    if (answer) return route.fulfill({ status: answer.status ?? 200, json: answer.json });
    return route.fulfill({ status: 404, json: { message: "Not found" } });
  });
  await tab.goto(`${origin}${address}`);
  await settled(tab);
  return { context, tab, errors, seen, navigations };
};

/** Waits, with a bounded deadline, until the browser did what the test waits for (a request, a navigation). */
const eventually = async (check: () => boolean, timeoutMs = 5_000) => {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("The expected step did not happen in time");
    await Bun.sleep(25);
  }
};

const PINNED = "2026-11-24T10:00:00.000Z";
/** Pins only `Date` in the page to `at`, flowing from there; timers and frames stay real. */
const pinPageClock = (at: number) => {
  const RealDate = Date;
  const offset = at - RealDate.now(); // real clock: the page's distance to the pinned instant
  class PinnedDate extends RealDate {
    constructor(...args: ConstructorParameters<DateConstructor> | []) {
      if (args.length === 0)
        super(RealDate.now() + offset); // real clock: flows from the pinned instant
      else super(...(args as ConstructorParameters<DateConstructor>));
    }
    static override now() {
      return RealDate.now() + offset; // real clock: flows from the pinned instant
    }
  }
  globalThis.Date = PinnedDate as DateConstructor;
};

const dialog = (tab: Page) => tab.locator('[data-k2-part="Dialog"]');

describe("account deeds on v2", () => {
  test("adding a passkey with an old sign-in asks to confirm the identity and comes back to the dialog with the name", async () => {
    const { context, tab, errors, seen, navigations } = await open("security", "/me/security", {
      "POST /api/me/passkeys/registration/start": [{ status: 403, json: { code: "REAUTHENTICATE", message: "Sign in again." } }],
    });
    try {
      await tab.getByRole("button", { name: "Add passkey" }).first().click();
      await dialog(tab).getByRole("textbox").fill("Laptop");
      await dialog(tab).getByRole("button", { name: "Add passkey" }).click();
      // the v2 question replaces the dialog; agreeing signs in again with the way back
      await tab.getByRole("alertdialog").getByRole("button", { name: "Confirm identity" }).click();
      await eventually(() => navigations.length === 1);
      const target = new URL(navigations[0]!, origin);
      expect(target.pathname).toBe("/auth/login");
      expect(target.searchParams.get("redirectTo")).toBe("/me/security?add=passkey&reauthenticate=1");
      expect(seen.map((entry) => `${entry.method} ${entry.path}`)).toEqual(["POST /api/me/passkeys/registration/start"]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 30_000);

  test("changing the password keeps a retry in the address when the other sign-ins stayed", async () => {
    const { context, tab, errors, seen } = await open("security", "/me/security", {
      "POST /api/me/password": [{ status: 500, json: { code: "SIGN_OUT_OTHERS_FAILED" } }],
    });
    try {
      await tab.getByRole("button", { name: "Change", exact: true }).click();
      const fields = dialog(tab).locator('input[type="password"]');
      await fields.nth(0).fill("old-secret-1");
      await fields.nth(1).fill("A-new-and-long-secret-42");
      await fields.nth(2).fill("A-new-and-long-secret-42");
      await dialog(tab).getByRole("button", { name: "Change" }).click();
      await tab.getByRole("alertdialog").waitFor();
      expect(new URL(tab.url()).searchParams.get("signOutOthers")).toBe("retry");
      expect(seen[0]).toEqual({
        method: "POST",
        path: "/api/me/password",
        body: { currentPassword: "old-secret-1", newPassword: "A-new-and-long-secret-42", confirmPassword: "A-new-and-long-secret-42" },
      });
      // closing the question leaves the password changed and takes the retry out of the address
      await tab.getByRole("alertdialog").getByRole("button", { name: "Close" }).click();
      await tab.waitForURL((url) => !url.searchParams.has("signOutOthers"));
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 30_000);

  test("a new API key shows its token once with a copy button, and the dialog does not close on a stray press", async () => {
    const token = "cld_test_4f7c1e0b9a2d4c6e8f00112233445566";
    const { context, tab, errors, seen } = await open("security", "/me/security", {
      "POST /api/me/api-keys": [
        {
          status: 201,
          json: {
            token,
            credential: {
              id: "00000000-0000-4000-8000-000000000109",
              serviceAccountId: "00000000-0000-4000-8000-000000000102",
              name: "CI",
              kind: "api_token",
              status: "active",
              tokenPrefix: "cld_test",
              scopes: [],
              expiresAt: null,
              lastUsedAt: null,
              createdBy: null,
              createdAt: "2026-11-24T10:00:00.000Z",
              revokedAt: null,
              revokedBy: null,
            },
          },
        },
      ],
    });
    try {
      await tab.getByRole("button", { name: "Create API key" }).first().click();
      await dialog(tab).getByRole("textbox").fill("CI");
      await dialog(tab).getByRole("button", { name: "Create key" }).click();
      await dialog(tab).getByText(token).waitFor();
      const outline = await describeV2Page(tab, "#root");
      expect(outline).not.toContain("Problems (");
      const body = seen.find((entry) => entry.path === "/api/me/api-keys")?.body as { name: string; access: string; expiresAt: string };
      expect([body.name, body.access]).toEqual(["CI", "full"]);
      // 90 days ahead by default, from the page's pinned clock
      expect(Math.round((Date.parse(body.expiresAt) - Date.parse(PINNED)) / 86_400_000)).toBe(90);
      await tab.mouse.click(5, 5);
      expect(await dialog(tab).getByText(token).isVisible()).toBe(true);
      await dialog(tab).getByRole("button", { name: "Done" }).click();
      await dialog(tab).waitFor({ state: "detached" });
      // the token lived only in the dialog
      expect(await tab.getByText(token).count()).toBe(0);
      expect(await tab.getByText("CI", { exact: true }).count()).toBeGreaterThan(0);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 30_000);

  test("a key until a chosen day works through the end of that day in the person's zone; no day sends nothing", async () => {
    const { context, tab, errors, seen } = await open("security", "/me/security", {
      "POST /api/me/api-keys": [{ status: 500, json: { code: "INTERNAL" } }],
    });
    try {
      await tab.getByRole("button", { name: "Create API key" }).first().click();
      await dialog(tab).getByRole("textbox").first().fill("Backup");
      await dialog(tab).locator('[data-k2-part="Select"]').click();
      await tab.getByRole("option", { name: "Custom date…" }).click();
      const day = dialog(tab).getByRole("textbox", { name: "Expires on" });
      await day.waitFor();
      // without a day the key is not created
      await dialog(tab).getByRole("button", { name: "Create key" }).click();
      await dialog(tab).getByText("Choose a day in the future.").waitFor();
      expect(seen.filter((entry) => entry.path === "/api/me/api-keys")).toEqual([]);
      await day.fill("12/15/2026");
      await day.press("Enter");
      await dialog(tab).getByRole("button", { name: "Create key" }).click();
      await eventually(() => seen.some((entry) => entry.path === "/api/me/api-keys"));
      const body = seen.find((entry) => entry.path === "/api/me/api-keys")?.body as { expiresAt: string };
      // 15 December 2026, 23:59:59.999 in Berlin (UTC+1)
      expect(body.expiresAt).toBe("2026-12-15T22:59:59.999Z");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 30_000);

  test("do not disturb pauses until a chosen day and time in the person's zone, and refuses a time in the past", async () => {
    const { context, tab, errors, seen } = await open("quiet", "/me/notifications", {
      "PATCH /api/me/notifications/quiet": [
        {
          json: {
            doNotDisturbUntil: "2026-11-27T13:30:00.000Z",
            quietHours: { timeZone: "Europe/Berlin", periods: [{ days: [1, 2, 3, 4, 5], start: "22:00", end: "07:00" }] },
            state: { active: true, reason: "doNotDisturb", until: "2026-11-27T13:30:00.000Z", nextStart: null },
          },
        },
      ],
    });
    try {
      await tab.getByRole("button", { name: "Pause", exact: true }).click();
      await tab.getByRole("menuitem", { name: "Custom date…" }).click();
      const picker = dialog(tab);
      // the pinned clock is 24 November 2026, 11:00 in Berlin: earlier days cannot be picked
      expect(await picker.locator('[data-value="2026-11-23"]').getAttribute("aria-disabled")).toBe("true");
      await picker.locator('[data-value="2026-11-24"]').click();
      const time = picker.getByRole("textbox", { name: "Time" });
      await time.fill("09:00");
      await time.press("Enter");
      await picker.getByText("Choose a time in the future.").waitFor();
      expect(seen.filter((entry) => entry.method === "PATCH")).toEqual([]);
      await picker.locator('[data-value="2026-11-27"]').click();
      await time.fill("14:30");
      await time.press("Enter");
      await picker.waitFor({ state: "detached" });
      const body = seen.find((entry) => entry.method === "PATCH")?.body as { doNotDisturbUntil: string };
      expect(body.doNotDisturbUntil).toBe("2026-11-27T13:30:00.000Z");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 30_000);
});

describe("sign-in deeds on v2", () => {
  test("FreeIPA sends username and password to the same endpoint and goes on to the page it came for", async () => {
    const { context, tab, errors, seen, navigations } = await open("login", "/auth/login?redirectTo=%2Fapp%2Ffiles", {
      "POST /api/auth/login": [{ json: { ok: true } }],
    });
    try {
      expect(await tab.locator('input[autocomplete="username"]').count()).toBe(1);
      expect(await tab.locator('input[autocomplete="current-password"]').count()).toBe(1);
      await tab.locator('input[autocomplete="username"]').fill("jbeispiel");
      await tab.locator('input[autocomplete="current-password"]').fill("secret-1");
      // Enter in the password field sends, as a form did
      await tab.locator('input[autocomplete="current-password"]').press("Enter");
      await eventually(() => navigations.length === 1);
      expect(seen[0]).toEqual({ method: "POST", path: "/api/auth/login", body: { username: "jbeispiel", password: "secret-1" } });
      // as before v2, a sign-in goes on through the terms check to the page it came for
      expect(navigations[0]).toBe("/auth/continue?redirectTo=%2Fapp%2Ffiles");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 30_000);

  test("an expired FreeIPA password continues on the new-password page with the account and the way on", async () => {
    const { context, tab, navigations } = await open("login", "/auth/login", {
      "POST /api/auth/login": [{ status: 401, json: { passwordExpired: true, ipaUid: "jbeispiel" } }],
    });
    try {
      await tab.locator('input[autocomplete="username"]').fill("jbeispiel");
      await tab.locator('input[autocomplete="current-password"]').fill("old");
      await tab.getByRole("button", { name: "Sign in with FreeIPA" }).click();
      await eventually(() => navigations.length === 1);
      expect(navigations[0]).toBe("/auth/new-password?ipa-uid=jbeispiel&redirectTo=%2Fapp%2Ffiles");
    } finally {
      await context.close();
    }
  }, 30_000);

  test("consent sends the shown version, and continues only once it is accepted", async () => {
    const { context, tab, errors, seen, navigations } = await open("consent", "/auth/continue", {
      "POST /api/auth/legal-consent": [{ json: { ok: true } }],
    });
    try {
      const accept = tab.getByRole("button", { name: "Accept and continue" });
      expect(await accept.isDisabled()).toBe(true);
      await tab.getByRole("checkbox").check();
      await accept.click();
      await eventually(() => navigations.length === 1);
      expect(seen[0]).toEqual({ method: "POST", path: "/api/auth/legal-consent", body: { accepted: true, version: "v-7" } });
      expect(navigations[0]).toBe("/app/files");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 30_000);
});
