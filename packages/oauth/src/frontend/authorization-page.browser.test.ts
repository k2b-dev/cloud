import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";
import { type AuthorizationState, authorizationStates, renderAuthorizationState } from "./authorization-page.test-fixture";

// Where the card sits, whether it is framed or flat, and whether anything moves when a control is
// hovered or focused is decided by the cascade of Cloud, @k2b/ui and Tailwind styles at a viewport
// width, which only a real engine resolves.

const viewports = {
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false },
} as const;

let browser: Browser;
let css: string;
beforeAll(async () => {
  // As the page template links them: the layer order, the app's stylesheet, then the global one.
  const entries = [resolve(import.meta.dir, "../styles/app.css"), resolve(import.meta.dir, "../../../../styles.css")];
  const built = await Promise.all(entries.map((entry) => Bun.build({ entrypoints: [entry], plugins: [tailwind] })));
  for (const build of built) if (!build.success) throw new AggregateError(build.logs, "Could not compile the stylesheets.");
  const [appCss, globalCss] = await Promise.all(built.map((build) => build.outputs[0]!.text()));
  css = ["@layer properties, theme, base, components, utilities;", appCss, globalCss].join("\n");
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

/** The server-rendered document with its stylesheets inlined; the pages need no script to show their state. */
const open = async (state: AuthorizationState, locale: "en" | "de", viewport: keyof typeof viewports): Promise<Page> => {
  const html = (await renderAuthorizationState(state, locale))
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<link [^>]*>/g, "")
    .replace("</head>", () => `<style>${css}</style></head>`);
  const page = await browser.newPage({ ...viewports[viewport], deviceScaleFactor: 1 });
  await page.setContent(html);
  return page;
};

/** Every box in the card and the footer, rounded to hundredths of a pixel. */
const boxes = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll("main, main *, footer, footer *"), (element) => {
      const box = element.getBoundingClientRect();
      return [box.x, box.y, box.width, box.height].map((value) => Math.round(value * 100) / 100).join(",");
    }),
  );

const settle = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

describe("OAuth authorization pages in a browser", () => {
  for (const viewport of Object.keys(viewports) as Array<keyof typeof viewports>) {
    const { width, height } = viewports[viewport].viewport;

    test(`every state is one centered card without app chrome at ${width} px`, async () => {
      for (const state of Object.keys(authorizationStates) as AuthorizationState[]) {
        const page = await open(state, "en", viewport);
        try {
          const layout = await page.evaluate(() => {
            const card = document.querySelector('section[aria-labelledby="oauth-page-title"]')!;
            const box = card.getBoundingClientRect();
            const style = getComputedStyle(card);
            return {
              mains: document.querySelectorAll("main").length,
              mainBackground: getComputedStyle(document.querySelector("main")!).backgroundColor,
              navs: Array.from(document.querySelectorAll("nav"), (nav) => nav.closest("footer") !== null),
              headings: Array.from(document.querySelectorAll("h1"), (heading) => heading.id),
              card: { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
              framed: style.borderTopWidth !== "0px" && style.boxShadow !== "none",
              scrollWidth: document.documentElement.scrollWidth,
            };
          });
          const context = `${state} at ${width} px`;
          expect(layout.mains, context).toBe(1);
          // One page background from top to footer: no band behind the card that ends at the footer.
          expect(layout.mainBackground, context).toBe("rgba(0, 0, 0, 0)");
          // The only navigation is the footer's legal links: no rail, header, or app navigation.
          expect(layout.navs, context).toEqual([true]);
          expect(layout.headings, context).toEqual(["oauth-page-title"]);
          expect(layout.scrollWidth, context).toBeLessThanOrEqual(width);
          expect(layout.card.left, context).toBeGreaterThanOrEqual(0);
          expect(layout.card.right, context).toBeLessThanOrEqual(width);
          // Centered: as much room on the left as on the right.
          expect(Math.abs(layout.card.left - (width - layout.card.right)), context).toBeLessThan(1);
          expect(layout.card.bottom, context).toBeLessThanOrEqual(height);
          // A frame on the desktop, flat on the phone where the page padding is all the room there is.
          expect(layout.framed, context).toBe(viewport === "desktop");
        } finally {
          await page.close();
        }
      }
    }, 60_000);

    test(`hovering or focusing any control moves nothing at ${width} px`, async () => {
      for (const state of Object.keys(authorizationStates) as AuthorizationState[]) {
        const page = await open(state, "en", viewport);
        try {
          await page.mouse.move(0, 0);
          await settle(page);
          const resting = await boxes(page);
          // The closed language menu is rendered but hidden.
          const controls = page
            .locator("main :is(a[href], button, input:not([type=hidden])), footer :is(a[href], button)")
            .filter({ visible: true });
          const count = await controls.count();
          expect(count, state).toBeGreaterThan(0);
          for (let index = 0; index < count; index += 1) {
            await controls.nth(index).hover();
            await settle(page);
            expect(await boxes(page), `${state}: hover on control ${index}`).toEqual(resting);
          }
          await page.mouse.move(0, 0);
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          for (let step = 0; step < count; step += 1) {
            await page.keyboard.press("Tab");
            await settle(page);
            expect(await boxes(page), `${state}: Tab ${step + 1}`).toEqual(resting);
          }
        } finally {
          await page.close();
        }
      }
    }, 120_000);

    test(`Deny and Allow share one row in reading and focus order, also in German, at ${width} px`, async () => {
      for (const [state, locale] of [
        ["confirm", "en"],
        ["confirm", "de"],
        ["consent", "de"],
      ] as const) {
        const page = await open(state, locale, viewport);
        try {
          const buttons = await page.evaluate(() =>
            Array.from(document.querySelectorAll<HTMLButtonElement>("main form button"), (button) => {
              const box = button.getBoundingClientRect();
              return {
                value: button.value,
                left: box.left,
                top: box.top,
                height: box.height,
                fits: button.scrollWidth <= button.clientWidth,
              };
            }),
          );
          const context = `${state} ${locale} at ${width} px`;
          expect(
            buttons.map((button) => button.value),
            context,
          ).toEqual(["deny", "approve"]);
          expect(buttons[0]!.top, context).toBe(buttons[1]!.top);
          expect(buttons[0]!.left, context).toBeLessThan(buttons[1]!.left);
          for (const button of buttons) {
            expect(button.fits, context).toBe(true);
            expect(button.height, context).toBeGreaterThanOrEqual(40);
          }
          // Keyboard order matches what the person sees: Deny, then Allow.
          const order: string[] = [];
          for (let step = 0; step < 12 && order.length < 2; step += 1) {
            await page.keyboard.press("Tab");
            const value = await page.evaluate(() =>
              document.activeElement?.closest("main form") ? (document.activeElement as HTMLButtonElement).value : null,
            );
            if (value) order.push(value);
          }
          expect(order, context).toEqual(["deny", "approve"]);
        } finally {
          await page.close();
        }
      }
    }, 60_000);

    test(`the approved page ends with a visible status that says the tab can be closed at ${width} px`, async () => {
      for (const [locale, title, body] of [
        ["en", "Device connected", "You can close this tab now."],
        ["de", "Gerät verbunden", "Du kannst diesen Tab jetzt schließen."],
      ] as const) {
        const page = await open("approved", locale, viewport);
        try {
          const status = page.getByRole("status");
          expect(await status.getByRole("heading", { level: 1 }).textContent()).toBe(title);
          expect(await status.textContent()).toContain(body);
          const result = await page.evaluate(() => {
            const box = document.querySelector('[role="status"]')!.getBoundingClientRect();
            return {
              box: { top: box.top, bottom: box.bottom },
              forms: document.querySelectorAll("form").length,
              mainControls: document.querySelectorAll("main :is(a[href], button, input)").length,
            };
          });
          const context = `${locale} at ${width} px`;
          // Nothing left to do on this page, and the whole result is on the first screen.
          expect(result.forms, context).toBe(0);
          expect(result.mainControls, context).toBe(0);
          expect(result.box.top, context).toBeGreaterThanOrEqual(0);
          expect(result.box.bottom, context).toBeLessThanOrEqual(height);
        } finally {
          await page.close();
        }
      }
    }, 60_000);
  }
});
