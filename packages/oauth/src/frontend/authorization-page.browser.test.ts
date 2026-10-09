import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";
import { type AuthorizationState, authorizationStates, renderAuthorizationState } from "./authorization-page.test-fixture";

// Where the card sits, whether it is framed or flat, and whether anything moves when a control is
// hovered or focused is decided by the cascade of Cloud, @k2b/ui and Tailwind styles at a viewport
// width, with the fonts a person gets, which only a real engine resolves.

const viewports = {
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false },
} as const;

const origin = "https://cloud.test";
const uiDist = dirname(fileURLToPath(import.meta.resolve("@k2b/ui/fonts/plex.css")));

let browser: Browser;
/** What the page template links, by path, as Core serves it from the @k2b/ui presets. */
let stylesheets: Record<string, string>;
let iconFont: string;
beforeAll(async () => {
  const entries = [resolve(import.meta.dir, "../styles/app.css"), resolve(import.meta.dir, "../../../../styles.css")];
  const built = await Promise.all(entries.map((entry) => Bun.build({ entrypoints: [entry], plugins: [tailwind] })));
  for (const build of built) if (!build.success) throw new AggregateError(build.logs, "Could not compile the stylesheets.");
  const [appCss, globalCss] = await Promise.all(built.map((build) => build.outputs[0]!.text()));
  const icons = await Bun.file(resolve(uiDist, "tabler.css")).text();
  iconFont = resolve(uiDist, /tabler-icons-[\w-]+\.woff2/.exec(icons)![0]);
  stylesheets = {
    "/public/fonts.css": (await Bun.file(resolve(uiDist, "plex.css")).text()).replaceAll("./fonts/", "/public/fonts/"),
    "/public/tabler-icons.css": icons.replace(/\.\/tabler-icons-[\w-]+\.woff2(\?[^)]*)?/, "/public/tabler-icons.woff2"),
    "/public/oauth/app.css": appCss!,
    "/public/global.css": globalCss!,
  };
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

/**
 * The server-rendered document with the stylesheets and fonts it links, once the fonts are in. The
 * pages need no script to show their state; the platform's MinimalLayout test owns the first frame.
 */
const open = async (
  state: AuthorizationState,
  locale: "en" | "de",
  viewport: keyof typeof viewports,
  theme: "light" | "dark" = "light",
): Promise<Page> => {
  const html = new HTMLRewriter()
    .on("script", { element: (script) => void script.remove() })
    .transform(await renderAuthorizationState(state, locale, theme));
  const page = await browser.newPage({ ...viewports[viewport], deviceScaleFactor: 1 });
  await page.route(`${origin}/**`, (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/authorization-page") return route.fulfill({ contentType: "text/html", body: html });
    const stylesheet = stylesheets[pathname];
    if (stylesheet !== undefined) return route.fulfill({ contentType: "text/css", body: stylesheet });
    if (pathname === "/public/tabler-icons.woff2") return route.fulfill({ path: iconFont });
    if (pathname.startsWith("/public/fonts/"))
      return route.fulfill({ path: resolve(uiDist, "fonts", pathname.slice("/public/fonts/".length)) });
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto(`${origin}/authorization-page`);
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    const loaded: string[] = [];
    document.fonts.forEach((font) => {
      if (font.status === "loaded") loaded.push(font.family);
    });
    return loaded;
  });
  // Measured in a fallback font, a row that wraps for a person would pass.
  expect(fonts, state).toEqual(expect.arrayContaining(["IBM Plex Sans", "tabler-icons"]));
  return page;
};

/**
 * Text and icons in the card whose contrast against the surface behind them is below WCAG AA: 4.5:1
 * for text and 3:1 for icons.
 */
const lowContrast = (page: Page) =>
  page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    /** The sRGB pixel that CSS colors painted over each other, the first at the bottom, leave. */
    const paint = (colors: string[]) => {
      for (const color of ["#fff", ...colors]) {
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
      }
      return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
    };
    const luminance = (rgb: number[]) => {
      const [r, g, b] = rgb.map((value) => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const card = document.querySelector('section[aria-labelledby="oauth-page-title"]')!;
    const found: string[] = [];
    for (const element of [card, ...card.querySelectorAll("*")]) {
      const icon = element.matches("i.ti");
      const text = Array.from(element.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim());
      if (!(icon || text) || !element.checkVisibility()) continue;
      const backgrounds: string[] = [];
      for (let node: Element | null = element; node; node = node.parentElement) backgrounds.unshift(getComputedStyle(node).backgroundColor);
      const [light, dark] = [luminance(paint(backgrounds)), luminance(paint([...backgrounds, getComputedStyle(element).color]))].sort(
        (a, b) => b - a,
      );
      const ratio = (light! + 0.05) / (dark! + 0.05);
      if (ratio < (icon ? 3 : 4.5)) found.push(`${element.tagName.toLowerCase()}.${element.className}: ${ratio.toFixed(2)}`);
    }
    return found;
  });

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

    for (const theme of ["light", "dark"] as const) {
      test(`every state is one centered, readable card without app chrome in ${theme} mode at ${width} px`, async () => {
        for (const state of Object.keys(authorizationStates) as AuthorizationState[]) {
          const page = await open(state, "en", viewport, theme);
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
                // A border, a shadow, and a surface of its own that stands out from the page.
                framed:
                  style.borderTopWidth !== "0px" &&
                  style.boxShadow !== "none" &&
                  style.backgroundColor !== "rgba(0, 0, 0, 0)" &&
                  style.backgroundColor !== getComputedStyle(document.body).backgroundColor,
                scrollWidth: document.documentElement.scrollWidth,
              };
            });
            const context = `${state} ${theme} at ${width} px`;
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
            expect(await lowContrast(page), context).toEqual([]);
          } finally {
            await page.close();
          }
        }
      }, 60_000);
    }

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
