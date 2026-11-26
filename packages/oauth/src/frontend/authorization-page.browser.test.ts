import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { sessionOriginGuard } from "@k2b/cloud/server/middleware/session-origin";
import { measureV2Layout } from "@k2b/ui/v2/testing";
import { Hono } from "hono";
import type { Browser, Page } from "playwright";
import { cloudShellSheets } from "../../../../scripts/fixtures/cloud-shell-sheets";
import { hoverInPlace, launchBrowser, launchHookMs, settled } from "../../../ui/test/browser";
import { loadShellAssets, openShellPage, type ShellAssets } from "../../../ui/test/shell-page";
import { type AuthorizationState, authorizationStates, renderAuthorizationState } from "./authorization-page.test-fixture";

// Every page a person sees during an authorization, as the server sends it, in a real engine with Cloud's stylesheets,
// Plex fonts and icons: the v2 layout rules at phone and desktop width, controls that move nothing, the decision's
// order, and the forms' Origin through the platform guard. `CLOUD_OAUTH_PAGE_SHOTS=<dir>` also saves light pictures.
const shots = process.env.CLOUD_OAUTH_PAGE_SHOTS;
const states = Object.keys(authorizationStates) as AuthorizationState[];

let browser: Browser;
let assets: ShellAssets;
beforeAll(async () => {
  assets = await loadShellAssets(
    await cloudShellSheets({ id: "oauth", css: resolve(import.meta.dir, "../styles/app.css") }, import.meta.dir),
  );
  if (shots) mkdirSync(shots, { recursive: true });
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const open = async (state: AuthorizationState, locale: "en" | "de", width: number) =>
  openShellPage(browser, assets, { path: "/authorization-page", html: await renderAuthorizationState(state, locale), width });

/**
 * Every box in the page and the footer on the document, rounded to hundredths of a pixel: a page taller than the window
 * scrolls a hovered control into view, which moves nothing.
 */
const boxes = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll("main, main *, footer, footer *"), (element) => {
      // an element without a box to see (the fields of a hidden form, an empty toast region) moves nothing
      const box = element.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) return "none";
      return [box.x + window.scrollX, box.y + window.scrollY, box.width, box.height]
        .map((value) => Math.round(value * 100) / 100)
        .join(",");
    }),
  );

/** The decision's controls in document order: the buttons that send its form and the sign-in that takes Allow's place. */
const decision = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('main :is(button[form="oauth-decision"], a[href^="/auth/login"])'), (control) => {
      const box = control.getBoundingClientRect();
      return {
        name: control.tagName === "A" ? "confirm" : (control as HTMLButtonElement).value,
        left: box.left,
        top: box.top,
        fits: control.scrollWidth <= control.clientWidth,
      };
    }),
  );

/** The decision's controls in the order Tab reaches them. */
const focusOrder = async (page: Page) => {
  const order: string[] = [];
  for (let step = 0; step < 16 && order.length < 2; step += 1) {
    await page.keyboard.press("Tab");
    const name = await page.evaluate(() => {
      const active = document.activeElement;
      if (active?.getAttribute("form") === "oauth-decision") return (active as HTMLButtonElement).value;
      return active?.tagName === "A" && active.getAttribute("href")?.startsWith("/auth/login") ? "confirm" : null;
    });
    if (name) order.push(name);
  }
  return order;
};

describe("OAuth authorization pages in a browser", () => {
  test("real consent, device and logout forms send the canonical Origin through the platform guard", async () => {
    const posted = ["consent", "confirm", "logout"] as const;
    const documents = new Map<string, string>(
      await Promise.all(
        posted.map(
          async (state) =>
            [
              `/fixture/${state}`,
              new HTMLRewriter()
                .on("script", { element: (script) => void script.remove() })
                .transform(await renderAuthorizationState(state, "en")),
            ] as const,
        ),
      ),
    );
    let formOrigin = "";
    const posts: Array<{ origin: string | undefined; cookie: string | undefined; body: Record<string, string> }> = [];
    const target = new Hono()
      .use(sessionOriginGuard([], async () => formOrigin))
      .post("*", async (c) => {
        const body = Object.fromEntries(Object.entries(await c.req.parseBody()).map(([key, value]) => [key, String(value)]));
        posts.push({ origin: c.req.header("Origin"), cookie: c.req.header("Cookie"), body });
        return c.text("Confirmed");
      })
      .get("*", (c) => {
        const html = documents.get(c.req.path);
        return html === undefined ? c.notFound() : c.html(html, 200, { "Referrer-Policy": "same-origin" });
      });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: target.fetch });
    formOrigin = `http://localhost:${server.port}`;
    try {
      for (const state of posted) {
        const context = await browser.newContext({
          viewport: { width: 390, height: 844 },
          isMobile: true,
          hasTouch: true,
          reducedMotion: "reduce",
        });
        try {
          await context.addCookies([{ name: "session_token", value: "web-fixture", url: formOrigin, sameSite: "Lax", httpOnly: true }]);
          const page = await context.newPage();
          await page.goto(`${formOrigin}/fixture/${state}`);
          const before = posts.length;
          const [response] = await Promise.all([
            page.waitForResponse((response) => response.request().method() === "POST"),
            page.getByRole("button", { name: state === "logout" ? "Sign out" : "Allow access", exact: true }).click(),
          ]);
          expect(response.status(), state).toBe(200);
          expect(posts.length, state).toBe(before + 1);
          const post = posts.at(-1)!;
          expect({ origin: post.origin, cookie: post.cookie }).toEqual({ origin: formOrigin, cookie: "session_token=web-fixture" });
          // the same fields as before: the hidden request (and code) and the pressed button's decision
          if (state === "logout") expect(post.body, state).toEqual({});
          else
            expect(Object.keys(post.body).sort(), state).toEqual(
              state === "confirm" ? ["decision", "request", "user_code"] : ["decision", "request"],
            );
          if (state !== "logout") expect(post.body.decision, state).toBe("approve");
        } finally {
          await context.close();
        }
      }
    } finally {
      await server.stop(true);
    }
  });

  for (const width of [390, 1024, 1440]) {
    test(`every state keeps the v2 rules in both languages at ${width} px`, async () => {
      for (const state of states) {
        for (const locale of ["de", "en"] as const) {
          const { context, tab, errors } = await open(state, locale, width);
          try {
            const layout = await measureV2Layout(tab, { root: "[data-k2-workspace]" });
            const name = `${state} ${locale} at ${width} px`;
            expect({ name, problems: layout.problems }).toEqual({ name, problems: [] });
            expect(await tab.evaluate(() => document.documentElement.scrollWidth), name).toBeLessThanOrEqual(width);
            if (shots && locale === "de") await tab.screenshot({ path: join(shots, `${state}-${width}.png`) });
            expect(errors, name).toEqual([]);
          } finally {
            await context.close();
          }
        }
      }
    }, 300_000);

    test(`hovering or focusing any control moves nothing at ${width} px`, async () => {
      for (const state of states) {
        const { context, tab } = await open(state, "en", width);
        try {
          await tab.mouse.move(0, 0);
          await settled(tab);
          const resting = await boxes(tab);
          // The closed language menu is rendered but hidden.
          const controls = tab
            .locator("main :is(a[href], button, input:not([type=hidden])), footer :is(a[href], button)")
            .filter({ visible: true });
          const count = await controls.count();
          expect(count, state).toBeGreaterThan(0);
          for (let index = 0; index < count; index += 1) {
            await hoverInPlace(controls.nth(index));
            await settled(tab);
            expect(await boxes(tab), `${state}: hover on control ${index}`).toEqual(resting);
          }
          await tab.mouse.move(0, 0);
          await tab.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          for (let step = 0; step < count; step += 1) {
            await tab.keyboard.press("Tab");
            await settled(tab);
            expect(await boxes(tab), `${state}: Tab ${step + 1}`).toEqual(resting);
          }
        } finally {
          await context.close();
        }
      }
    }, 300_000);

    test(`Deny and Allow share one row in reading and focus order, also in German, at ${width} px`, async () => {
      for (const [state, locale] of [
        ["confirm", "en"],
        ["confirm", "de"],
        ["consent", "de"],
      ] as const) {
        const { context, tab } = await open(state, locale, width);
        try {
          const row = await decision(tab);
          const name = `${state} ${locale} at ${width} px`;
          expect(
            row.map((control) => control.name),
            name,
          ).toEqual(["deny", "approve"]);
          expect(row[0]!.top, name).toBe(row[1]!.top);
          expect(row[0]!.left, name).toBeLessThan(row[1]!.left);
          for (const control of row) expect(control.fits, name).toBe(true);
          // Keyboard order matches what the person sees: Deny, then Allow.
          expect(await focusOrder(tab), name).toEqual(["deny", "approve"]);
        } finally {
          await context.close();
        }
      }
    }, 60_000);

    test(`Confirm identity takes Allow's place in the same row, also in German, at ${width} px`, async () => {
      for (const state of ["confirmReauthenticate", "consentReauthenticate"] as const) {
        for (const locale of ["en", "de"] as const) {
          const { context, tab } = await open(state, locale, width);
          try {
            const row = await decision(tab);
            const name = `${state} ${locale} at ${width} px`;
            expect(
              row.map((control) => control.name),
              name,
            ).toEqual(["deny", "confirm"]);
            expect(row[0]!.top, name).toBe(row[1]!.top);
            expect(row[0]!.left, name).toBeLessThan(row[1]!.left);
            for (const control of row) expect(control.fits, name).toBe(true);
            expect(await focusOrder(tab), name).toEqual(["deny", "confirm"]);
          } finally {
            await context.close();
          }
        }
      }
    }, 60_000);

    test(`a decision stands in a column of 560 px on the page background, on the phone across the whole width (the measure starts at 768 px), at ${width} px`, async () => {
      for (const state of ["consent", "confirm", "entry", "logout"] as const) {
        const { context, tab } = await open(state, "de", width);
        try {
          const page = await tab.evaluate(() => {
            const box = document.querySelector("[data-k2-workspace]")!.getBoundingClientRect();
            const field = document.querySelector('input[name="user_code"]:not([type="hidden"])')?.getBoundingClientRect();
            return {
              left: box.left,
              right: box.right,
              view: document.documentElement.clientWidth,
              field: field?.left ?? null,
              page: getComputedStyle(document.querySelector(".minimal-layout")!).backgroundColor,
              card: getComputedStyle(document.querySelector("[data-k2-workspace]")!).backgroundColor,
              footer: document.querySelector("footer")?.getAttribute("data-ui") ?? null,
            };
          });
          const name = `${state} at ${width} px`;
          if (width >= 768) {
            expect(page.right - page.left, name).toBeLessThanOrEqual(560);
            // centred: as much room on the left as on the right
            expect(Math.abs(page.left - (page.view - page.right)), name).toBeLessThanOrEqual(1);
            // the real v2 frame: a card on the tinted page, the v2 footer below
            expect(page.page, name).not.toBe(page.card);
          } else expect({ left: page.left, right: page.right }, name).toEqual({ left: 0, right: page.view });
          expect(page.footer, name).toBe("v2");
          // the code field stands on the text edge, not at the pane's border
          if (page.field !== null) expect(page.field - page.left, name).toBeGreaterThanOrEqual(16);
        } finally {
          await context.close();
        }
      }
    }, 60_000);

    test(`the device code stands large in the mono face, in a block of its own, at ${width} px`, async () => {
      const { context, tab } = await open("confirm", "de", width);
      try {
        const code = await tab.evaluate(() => {
          const element = document.querySelector('[data-testid="device-user-code"]')!;
          const look = getComputedStyle(element);
          return {
            text: element.textContent,
            size: Number.parseFloat(look.fontSize),
            family: look.fontFamily,
            strip: look.backgroundColor,
          };
        });
        expect(code.text).toBe("WDJB-MJHT");
        expect(code.size).toBeGreaterThanOrEqual(28);
        expect(code.family).toContain("monospace");
        // a strip of its own: tinted, not the page's surface
        expect(code.strip).not.toBe("rgba(0, 0, 0, 0)");
      } finally {
        await context.close();
      }
    }, 60_000);

    test(`the code field has the focus, and Enter in it sends the code at ${width} px`, async () => {
      const { context, tab } = await open("entry", "de", width);
      try {
        expect(await tab.evaluate(() => document.activeElement?.getAttribute("name"))).toBe("user_code");
        await tab.keyboard.type("WDJB-MJHT");
        const [request] = await Promise.all([
          tab.waitForRequest((request) => new URL(request.url()).pathname === "/oauth/device"),
          tab.keyboard.press("Enter"),
        ]);
        expect(request.method()).toBe("GET");
        expect(new URL(request.url()).searchParams.get("user_code")).toBe("WDJB-MJHT");
      } finally {
        await context.close();
      }
    }, 60_000);

    test(`the approved page ends on the first screen with the words that the tab can be closed at ${width} px`, async () => {
      for (const [locale, title, body] of [
        ["en", "Device connected", "You can close this tab now."],
        ["de", "Gerät verbunden", "Du kannst diesen Tab jetzt schließen."],
      ] as const) {
        const { context, tab } = await open("approved", locale, width);
        try {
          expect(await tab.getByRole("heading", { level: 1 }).textContent()).toBe(title);
          const words = tab.getByText(body);
          expect(await words.isVisible()).toBe(true);
          const box = (await words.boundingBox())!;
          const result = await tab.evaluate(() => ({
            forms: document.querySelectorAll("form").length,
            mainControls: document.querySelectorAll("main :is(a[href], button, input)").length,
            height: window.innerHeight,
          }));
          const name = `${locale} at ${width} px`;
          // Nothing left to do on this page, and the whole result is on the first screen.
          expect(result.forms, name).toBe(0);
          expect(result.mainControls, name).toBe(0);
          expect(box.y + box.height, name).toBeLessThanOrEqual(result.height);
        } finally {
          await context.close();
        }
      }
    }, 60_000);
  }
});
