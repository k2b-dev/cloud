import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_ACCOUNT_CATEGORY_POLICY } from "@k2b/cloud/contracts";
import * as services from "@k2b/cloud/services";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import tailwind from "bun-plugin-tailwind";
import { Hono } from "hono";
import type { Browser } from "playwright";
import { serveCoreV2Sheet } from "../../../../../tests/fixtures/core-v2-sheet";
import { launchBrowser, pageErrors, settled, storedCookie } from "../../../../ui/test/browser";
import { registerSsrTestPlugin } from "../../../../ui/test/ssr-test-plugin";
import { authMessages } from "./messages";

// The sign-in page is a v2 visitor page: one centred column on the page background from the tablet up, the whole
// width on a phone. Where it stands and whether a row wraps is decided by v2.css and the fonts at a viewport width,
// which only a real engine resolves.
const root = mkdtempSync(join(tmpdir(), "core-login-page-browser-"));
registerSsrTestPlugin({ dev: true, rootDir: root });

process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: handler } = await import("./page");
// Text and icon widths decide where rows wrap, so the page gets its real fonts.
const { buildFontAssets } = await import("../../../scripts/font-assets");
const { buildTablerIconAssets } = await import("../../../scripts/tabler-assets");
const publicDir = join(root, "public");
const origin = "https://cloud.example.test";

const spies: Array<{ mockRestore(): void }> = [];
beforeEach(() => {
  spies.push(
    spyOn(services.coreSettings, "get").mockImplementation(
      async (key) => (key === "freeipa.enable" ? true : key === "app.contact_email" ? "help@cloud.example.test" : undefined) as never,
    ),
    spyOn(services, "readAccountCategoryPolicy").mockResolvedValue(DEFAULT_ACCOUNT_CATEGORY_POLICY),
    // Core serves v2.css, so the page links it alone.
    serveCoreV2Sheet(),
    spyOn(services.appApproval, "config").mockResolvedValue({
      issuer: "https://cloud.example.test",
      appOrigin: "https://auth.example.test",
      enabled: true,
      adminPairing: false,
    }),
  );
});
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

let browser: Browser;
let css: string;
let stylesheets: Record<string, string>;
beforeAll(async () => {
  // As the page template links them on a v2 visitor page: Core's own stylesheet, then Core's v2.css in place of global.css.
  const built = await Promise.all([
    Bun.build({ entrypoints: [resolve(import.meta.dir, "../../styles/app.css")], plugins: [tailwind] }),
    Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../cloud/src/styles/v2-page.css")] }),
  ]);
  for (const build of built) if (!build.success) throw new AggregateError(build.logs, "Could not compile the stylesheets.");
  const [appCss, v2Css] = await Promise.all(built.map((build) => build.outputs[0]!.text()));
  css = [appCss, v2Css].join("\n");
  await buildFontAssets(publicDir);
  await buildTablerIconAssets(publicDir);
  // The stylesheets the page template links, by path.
  stylesheets = {
    "/public/fonts.css": await Bun.file(join(publicDir, "fonts.css")).text(),
    "/public/tabler-icons.css": await Bun.file(join(publicDir, "tabler-icons.css")).text(),
    "/public/core/app.css": appCss!,
    "/public/v2.css": v2Css!,
  };
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

/** The server-rendered sign-in document. */
const serverDocument = async (query: string, locale: string, cookie = "") => {
  // All three legal pages, as the running apps declare them: the longest footer a phone shows.
  const legalLinks = (locale === "de" ? ["Impressum", "Datenschutz", "Nutzungsbedingungen"] : ["Imprint", "Privacy", "Terms"]).map(
    (label, index) => ({ label, href: ["/impressum", "/legal/privacy", "/legal/terms"][index]! }),
  );
  const app = new Hono()
    .use((c, next) => {
      c.set("runtime" as never, { apps: [{ id: "legal-probe", legalLinks }] } as never);
      return next();
    })
    .get("/auth/login", ...handler);
  const response = await app.request(`https://cloud.example.test/auth/login${query}`, {
    headers: { Cookie: `cloud.locale=${locale}; ${cookie}` },
  });
  expect(response.status).toBe(200);
  return await response.text();
};

/** The server-rendered sign-in page body: its attributes (the v2 scope) and its content. */
const body = async (query: string, locale: string, cookie?: string) => {
  const [, attributes, content] = /<body([^>]*)>([\s\S]*)<\/body>/.exec(await serverDocument(query, locale, cookie))!;
  return { attributes: attributes!, content: content! };
};

type View = { width: number; height: number; touch: boolean };
/** `shot` names a full-page image that lands in `CLOUD_VISITOR_SHOTS` when it is set. */
type Options = { locale?: "en" | "de"; cookie?: string; shot?: string };
/**
 * A tab with the server-rendered page as it arrives: its own scripts never run (the content security policy allows
 * none), while the checks still measure it from Playwright; the caller closes it.
 */
const open = async (view: View, query: string, options: Options = {}) => {
  const tab = await browser.newPage({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: 2,
    isMobile: view.touch,
    hasTouch: view.touch,
  });
  await tab.route(`${origin}/public/**`, (route) => route.fulfill({ path: join(root, new URL(route.request().url()).pathname) }));
  await tab.route(`${origin}/branding/logo`, (route) =>
    route.fulfill({ path: resolve(import.meta.dir, "../../../../cloud/public/logo.svg") }),
  );
  const page = await body(query, options.locale ?? "en", options.cookie);
  await tab.setContent(
    `<!doctype html><html lang="${options.locale ?? "en"}" class="light"><head><meta http-equiv="Content-Security-Policy" content="script-src &#39;none&#39;"><base href="${origin}/"><meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<link rel="stylesheet" href="${origin}/public/fonts.css"><link rel="stylesheet" href="${origin}/public/tabler-icons.css"><style>${css}</style><style>solid-client,solid-island{display:contents}</style></head>` +
      `<body${page.attributes}>${page.content}</body></html>`,
  );
  await tab.evaluate(() => document.fonts.ready);
  return tab;
};

/** The v2 outline and measurements, and the boxes the layout checks need, as the server response renders them. */
const measure = async (view: View, query: string, options: Options = {}) => {
  const tab = await open(view, query, options);
  try {
    await settled(tab);
    const outline = await describeV2Page(tab, "main");
    const layout = await measureV2Layout(tab, { root: "[data-k2-workspace]" });
    const shots = process.env.CLOUD_VISITOR_SHOTS;
    if (shots && options.shot) {
      mkdirSync(shots, { recursive: true });
      await tab.screenshot({ path: join(shots, `${options.shot}.png`), fullPage: true });
    }
    const page = await tab.evaluate(() => {
      const box = (element: Element | null) => {
        if (!element) return undefined;
        const { left, right, top, bottom, width, height } = element.getBoundingClientRect();
        return { left, right, top, bottom, width, height };
      };
      const focused = Array.from(document.querySelectorAll("[autofocus]"));
      return {
        column: box(document.querySelector(".minimal-layout-main[data-measure] > :only-child")),
        footer: box(document.querySelector("footer")),
        heading: document.querySelector("main h1")?.textContent?.trim(),
        autofocus: focused.map((element) => `${element.tagName.toLowerCase()} ${element.getAttribute("type") ?? "text"}`),
        autofocusInMain: focused.every((element) => element.closest("main") !== null),
        legal: Array.from(document.querySelectorAll("footer nav a")).map((link) => link.textContent?.trim()),
        // v1 parts and the old sign-in frame; the v2 scope on the body is the only k2b- class left.
        v1: Array.from(document.body.querySelectorAll("[class*='k2b-'], [class*='standalone-'], [class*='auth-']")).map(
          (element) => element.className,
        ),
        // a field or a send button outside any form would send nothing on Enter or press
        unbound: Array.from(
          document.querySelectorAll<HTMLInputElement | HTMLButtonElement>("main input:not([type=checkbox]), main button[type=submit]"),
        )
          .filter((element) => !element.form)
          .map((element) => element.outerHTML.slice(0, 80)),
        // the lines of deeds in the column: an action line (a band with only its bar) and the closing bar
        actionLines: Array.from(
          document.querySelectorAll("[data-k2-part=Pane] :is(.k2-band:has(> .k2-bar:only-child), .k2-scroll > .k2-bar)"),
        ).map((line) => Math.round(line.getBoundingClientRect().height)),
        scrollWidth: document.documentElement.scrollWidth,
        // Controls and words the column cuts off at its edge (it clips, so the page itself never scrolls sideways).
        cut: (() => {
          const column = document.querySelector(".minimal-layout-main[data-measure] > :only-child")!.getBoundingClientRect();
          return Array.from(
            document.querySelectorAll(".minimal-layout-main[data-measure] > :only-child :is(a, button, input, label, h1, [role=tab])"),
          )
            .filter((element) => {
              const box = element.getBoundingClientRect();
              return box.width > 0 && (box.left < column.left - 0.5 || box.right > column.right + 0.5);
            })
            .map((element) => element.textContent?.trim() || element.tagName.toLowerCase());
        })(),
        // Buttons keep the column's 16 px gutter on both sides: a full line wraps instead of squeezing to the edge.
        gutter: (() => {
          const column = document.querySelector(".minimal-layout-main[data-measure] > :only-child")!.getBoundingClientRect();
          return Array.from(document.querySelectorAll(".minimal-layout-main[data-measure] > :only-child [data-k2-part=Button]"))
            .filter((element) => {
              const box = element.getBoundingClientRect();
              return box.width > 0 && (box.left < column.left + 15.5 || box.right > column.right - 15.5);
            })
            .map((element) => element.textContent?.trim() || element.getAttribute("aria-label"));
        })(),
      };
    });
    return { outline, problems: layout.problems, ...page };
  } finally {
    await tab.close();
  }
};

/**
 * Every element's box in the first frame after DOMContentLoaded and once the page and its fonts have loaded,
 * plus Chromium's layout-shift entries. The tab loads the complete server response with the stylesheets and
 * fonts its template links; the islands' scripts are left out, so only the fonts can move anything.
 */
const firstFrameAndLoad = async (view: View, query: string, locale: "en" | "de") => {
  const html = await serverDocument(query, locale);
  // The template preloads the faces that Core's font stylesheet names, under the same URLs.
  const preloads = [...html.matchAll(/<link rel="preload" href="([^"]+)" as="font"/g)].map((match) => match[1]!);
  for (const href of preloads.filter((href) => href.startsWith("/public/fonts/")))
    expect(stylesheets["/public/fonts.css"]).toContain(`url(${href})`);
  // A preload makes the fonts download next to the stylesheets. Answering the stylesheets only once every
  // preloaded font is served makes that order deterministic, however slow the runner; a face without a preload
  // is only requested after the stylesheets and layout, so the first frame shows the fallback font.
  const served = new Map(preloads.map((href) => [href, Promise.withResolvers<void>()]));
  const fontsFirst = Promise.all([...served.values()].map((font) => font.promise));
  const tab = await browser.newPage({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: 2,
    isMobile: view.touch,
    hasTouch: view.touch,
  });
  try {
    await tab.route(`${origin}/**`, async (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === "/auth/login") return route.fulfill({ contentType: "text/html", body: html });
      const stylesheet = stylesheets[pathname];
      if (stylesheet !== undefined) {
        await fontsFirst;
        return route.fulfill({ contentType: "text/css", body: stylesheet });
      }
      if (!pathname.startsWith("/public/")) return route.fulfill({ status: 404, body: "" });
      await route.fulfill({ path: join(root, pathname) });
      served.get(pathname)?.resolve();
    });
    await tab.addInitScript(() => {
      const state = window as unknown as { firstFrame?: string[]; shifts: number[]; boxes: () => string[] };
      state.shifts = [];
      state.boxes = () =>
        Array.from(document.body.querySelectorAll("*")).map((element) => {
          const { left, top, width, height } = element.getBoundingClientRect();
          return `${element.tagName.toLowerCase()}.${element.classList[0] ?? ""} "${element.textContent?.trim().slice(0, 24)}" ${left},${top} ${width}x${height}`;
        });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) state.shifts.push((entry as PerformanceEntry & { value: number }).value);
      }).observe({ type: "layout-shift", buffered: true });
      document.addEventListener("DOMContentLoaded", () => requestAnimationFrame(() => (state.firstFrame = state.boxes())));
    });
    await tab.goto(`${origin}/auth/login${query}`, { waitUntil: "load" });
    await tab.waitForFunction(() => "firstFrame" in window);
    return await tab.evaluate(async () => {
      await document.fonts.ready;
      const state = window as unknown as { firstFrame: string[]; shifts: number[]; boxes: () => string[] };
      const fonts: string[] = [];
      document.fonts.forEach((font) => {
        if (font.status === "loaded") fonts.push(`${font.family} ${font.weight}`);
      });
      return { firstFrame: state.firstFrame, loaded: state.boxes(), shifts: state.shifts, fonts };
    });
  } finally {
    await tab.close();
  }
};

/** The names keyboard focus reaches after the "use the app instead" link, which stands before the form's action. */
const tabOrder = async (view: View, query: string, steps: number) => {
  const tab = await open(view, query);
  try {
    await tab.focus("main a[href*='credential=']");
    const names: string[] = [];
    for (let step = 0; step < steps; step++) {
      await tab.keyboard.press("Tab");
      names.push(await tab.evaluate(() => document.activeElement?.textContent?.trim() ?? ""));
    }
    return names;
  } finally {
    await tab.close();
  }
};

// An iPhone 14 with Safari's toolbars showing.
const phone = { width: 390, height: 664, touch: true };
const desktop = { width: 1440, height: 900, touch: false };
const forms = {
  password: "?method=ipa",
  app: "?method=ipa&credential=app",
  guest: "?method=guest",
  login: "?method=login&credential=legacy",
  admin: "?method=admin",
};

describe("sign-in page in a browser", () => {
  test("is one centred column on the page at 1440 and the whole width on a phone, clean in v2, for every form and language", async () => {
    // Where the column starts at 1440, by form: switching the account type never moves the head.
    const tops = new Set<number>();
    for (const locale of ["en", "de"] as const) {
      const t = authMessages.resolve([locale]).t;
      for (const [name, query] of Object.entries(forms)) {
        for (const view of [phone, desktop]) {
          const context = `${name} ${locale} ${view.width}`;
          const page = await measure(view, query, { locale, shot: `sign-in-${name}-${locale}-${view.width}` });
          expect(page.outline.includes("Problems (") ? page.outline : "", context).toBe("");
          expect(page.problems, context).toEqual([]);
          expect(page.v1, context).toEqual([]);
          expect(page.scrollWidth, context).toBeLessThanOrEqual(view.width);
          expect(page.cut, context).toEqual([]);
          expect(page.unbound, context).toEqual([]);
          expect(page.gutter, context).toEqual([]);
          const column = page.column!;
          if (view === desktop) {
            // A measure on the page background, in the middle of the window.
            expect(column.width, context).toBeLessThanOrEqual(560);
            expect(column.width, context).toBeGreaterThan(480);
            expect(Math.abs(column.left - (view.width - column.right)), context).toBeLessThanOrEqual(1);
            expect(column.top, context).toBeGreaterThanOrEqual(24);
            tops.add(column.top);
            // every line of deeds stands as high as a bar, one after the other alike (a band draws its line below the bar)
            expect(Math.max(...page.actionLines) - Math.min(...page.actionLines), `${context} ${page.actionLines}`).toBeLessThanOrEqual(1);
          } else {
            expect([column.left, column.width], context).toEqual([0, view.width]);
          }
          expect(page.heading, context).toBe(name === "admin" ? t.adminToken : t.signIn);
          // The first field takes the focus, as before: one, in the form.
          expect(page.autofocus, context).toHaveLength(1);
          expect(page.autofocus[0], context).toStartWith("input ");
          expect(page.autofocusInMain, context).toBe(true);
          // The legal links stay in the footer, below the column.
          expect(page.legal, context).toEqual(
            locale === "de" ? ["Impressum", "Datenschutz", "Nutzungsbedingungen"] : ["Imprint", "Privacy", "Terms"],
          );
          expect(page.footer!.top, context).toBeGreaterThanOrEqual(column.bottom);
        }
      }
    }
    expect([...tops]).toHaveLength(1);
  }, 120_000);

  test("names a remembered account and focuses its password instead", async () => {
    const page = await measure(desktop, `${forms.password}&ipa-uid=mira`);
    expect(page.autofocus).toEqual(["input password"]);
  }, 30_000);

  test("shows its final layout in the first frame instead of moving when the fonts arrive", async () => {
    for (const view of [...[360, 375, 390, 430].map((width) => ({ ...phone, width })), desktop]) {
      for (const locale of ["en", "de"] as const) {
        const context = `${view.width} ${locale}`;
        const page = await firstFrameAndLoad(view, forms.password, locale);
        expect(page.fonts, context).toEqual(expect.arrayContaining(["IBM Plex Sans 400", "IBM Plex Sans 500", "IBM Plex Sans 600"]));
        expect(page.loaded, context).toEqual(page.firstFrame);
        expect(page.shifts, context).toEqual([]);
      }
    }
  }, 120_000);

  test("moves focus through the secondary actions in the order they are shown", async () => {
    for (const view of [phone, { ...phone, width: 320 }, desktop]) {
      expect(await tabOrder(view, forms.password, 4), `${view.width}`).toEqual([
        "Sign in with FreeIPA",
        "Use passkey",
        "Contact support",
        "Admin token",
      ]);
    }
  }, 30_000);
});

test("re-authentication opens the same remembered credential as normal sign-in", async () => {
  const redirectTo = "/me/security?reauthenticate=1&pairDevice=example-user";
  const query = `?${new URLSearchParams({ redirectTo })}`;
  for (const [name, cookie, button] of [
    ["app", "login_method=ipa; login_freeipa_app=1", "Sign in with app"],
    ["email", "login_method=guest", "Send sign-in link"],
    ["login-email", "login_method=login; login_email=1", "Send sign-in link"],
    ["login-app", "login_method=login", "Sign in with app"],
  ]) {
    for (const view of [phone, desktop]) {
      for (const [state, search] of [
        ["normal", ""],
        ["reauth", query],
      ]) {
        const tab = await open(view, search!, { cookie });
        try {
          expect(await tab.locator("main button[type=submit]").textContent(), `${name} ${state}`).toContain(button!);
          expect(await tab.getByRole("button", { name: "Use passkey", exact: true }).count()).toBe(1);
          const alternative = tab.locator("main a[href*='credential=']");
          expect(await alternative.count()).toBe(1);
          const href = new URL((await alternative.getAttribute("href"))!, origin);
          expect(href.searchParams.get("credential")).toBe(button === "Sign in with app" ? "legacy" : "app");
          expect(href.searchParams.get("redirectTo")).toBe(state === "reauth" ? redirectTo : null);
          if (state === "reauth") expect(await tab.getByRole("heading", { name: "Confirm identity" }).count()).toBe(1);
          const shots = process.env.CLOUD_REAUTH_SHOTS;
          if (shots && state === "reauth" && (name === "login-app" || name === "email")) {
            const file = `${name === "login-app" ? "app" : name}-reauth-light-${view.width}.png`;
            mkdirSync(join(shots, "after"), { recursive: true });
            mkdirSync(join(shots, "before"), { recursive: true });
            await tab.screenshot({ path: join(shots, "after", file), fullPage: true });
            // The old confirmation URL forced the still-supported legacy alternative.
            const previous = await open(view, `${query}&credential=legacy`, { cookie });
            try {
              await previous.screenshot({ path: join(shots, "before", file), fullPage: true });
            } finally {
              await previous.close();
            }
          }
        } finally {
          await tab.close();
        }
      }
    }
  }
}, 60_000);

test("email-link completion remembers email and a later app approval remembers the app", async () => {
  const ui = resolve(import.meta.dir, "../../../../ui");
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const built = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "remembered-credential.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "remembered-credential",
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
  if (!built.success) throw new AggregateError(built.logs, "Could not build sign-in fixture");
  const script = await built.outputs[0]!.text();
  const context = await browser.newContext();
  const tab = await context.newPage();
  const browserErrors = pageErrors(tab);
  await tab.clock.install({ time: new Date("2026-10-23T12:00:00Z") });
  const redirectTo = "/me/security?reauthenticate=1";
  const query = new URLSearchParams({ redirectTo });
  const verified: string[] = [];
  let rejectAppCompletion = true;
  let rejectEmail = true;
  let started = 0;
  const consumedProofs = new Set<string>();
  try {
    await tab.route(`${origin}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/auth/login")
        return route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: await serverDocument(new URL(route.request().url()).search, "en", route.request().headers().cookie),
        });
      if (path === "/fixture")
        return route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
        });
      if (path === "/fixture.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: script });
      if (path.endsWith("/verify-token") || path.endsWith("/login/complete")) {
        verified.push(path);
        const submitted: unknown = route.request().postDataJSON();
        const proof =
          submitted && typeof submitted === "object"
            ? "token" in submitted
              ? submitted.token
              : "requestId" in submitted
                ? submitted.requestId
                : undefined
            : undefined;
        if (typeof proof !== "string") throw new Error("Missing fixture proof");
        expect(consumedProofs.has(proof)).toBe(false);
        consumedProofs.add(proof);
        expect(route.request().headers()["x-cloud-reauthenticate"]).toBe("1");
        if (path.endsWith("/verify-token") && rejectEmail)
          return route.fulfill({ status: 403, json: { code: "ACCOUNT_MISMATCH", message: "Use the original account." } });
        if (path.endsWith("/login/complete") && rejectAppCompletion)
          return route.fulfill({ status: 403, json: { code: "ACCOUNT_MISMATCH" } });
        return path.endsWith("/verify-token")
          ? route.fulfill({ json: { user: { id: "fixture-user", provider: "local", profile: "user" } } })
          : route.fulfill({ status: 204 });
      }
      if (path.endsWith("/login/start"))
        return route.fulfill({
          json: {
            requestId: `00000000-0000-4000-8000-${String(++started).padStart(12, "0")}`,
            browserSecret: "a".repeat(42) + "A",
            comparison: "123456",
            expiresAt: "2026-10-23T12:05:00Z",
            pollAfterSeconds: 5,
          },
        });
      if (path.endsWith("/login/status")) return route.fulfill({ json: { state: "approved", pollAfterSeconds: 5 } });
      return route.fulfill({ contentType: "text/html", body: "Continued" });
    });
    // A clicked email link has no category prop: the verified user supplies it.
    await tab.goto(`${origin}/fixture?${query}`);
    await tab.getByRole("link", { name: "Back to sign in", exact: true }).click();
    await tab.waitForURL("**/auth/login?**");
    const restarted = new URL(tab.url());
    expect(restarted.searchParams.get("redirectTo")).toBe(redirectTo);
    expect(restarted.searchParams.has("token")).toBe(false);
    expect(await tab.getByRole("button", { name: "Use passkey", exact: true }).count()).toBe(1);
    rejectEmail = false;
    // A newly requested proof for the original account, never reuse the rejected link.
    await tab.goto(`${origin}/fixture?${query}&token=fixture-new-mail-token`);
    await tab.waitForURL("**/auth/continue?**").catch(async (error) => {
      throw new Error(
        `${error}\nBrowser errors: ${browserErrors.join("; ")}\nPage: ${await tab.locator("body").innerText()}\nCalls: ${verified}`,
      );
    });
    const cookies = async () => {
      const stored = await Promise.all([storedCookie(tab, "login_email"), storedCookie(tab, "login_method")]);
      return stored.flatMap((cookie) => (cookie ? [`${cookie.name}=${cookie.value}`] : [])).join("; ");
    };
    expect(await cookies()).toContain("login_email=1");
    expect(await cookies()).toContain("login_method=login");
    const emailPage = await open(phone, `?${query}`, { cookie: await cookies() });
    try {
      expect(await emailPage.locator("main button[type=submit]").textContent()).toContain("Send sign-in link");
    } finally {
      await emailPage.close();
    }

    await tab.goto(`${origin}/fixture?${query}&credential=app`);
    await tab.getByRole("textbox").fill("mira");
    await tab.getByRole("button", { name: "Sign in with app", exact: true }).click();
    await tab.getByText("Sign in with the account already open in this browser.", { exact: false }).waitFor();
    expect(new URL(tab.url()).pathname).toBe("/fixture");
    expect(await cookies()).toContain("login_email=1");
    rejectAppCompletion = false;
    await tab.getByRole("button", { name: "Sign in with app", exact: true }).click();
    await tab.waitForURL("**/auth/continue?**");
    expect(await cookies()).not.toContain("login_email=1");
    const appPage = await open(phone, `?${query}`, { cookie: await cookies() });
    try {
      expect(await appPage.getByRole("button", { name: "Sign in with app", exact: true }).count()).toBe(1);
    } finally {
      await appPage.close();
    }
    expect(verified).toEqual([
      "/api/auth/verify-token",
      "/api/auth/verify-token",
      "/api/auth/app-approval/v1/login/complete",
      "/api/auth/app-approval/v1/login/complete",
    ]);
  } finally {
    await context.close();
  }
}, 60_000);
