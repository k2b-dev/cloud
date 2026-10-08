import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { Browser } from "playwright";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser } from "../../test/browser";

// Whether every state has the same box is a result of layout in a real engine, with the real type and icons.
const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-resource-card-browser-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { LocaleProvider, MessageRow, ResourceCard } = await import("../index");
type Props = Parameters<typeof ResourceCard>[0];

const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const assets = "http://k2b-ui.test/";
const fonts = ["plex.css", "tabler.css"]
  .map((file) => readFileSync(resolve(ui, "dist", file), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, `url($1${assets}`))
  .join("\n");

const viewports = {
  desktop: { width: 1280, height: 900 },
  phone: { width: 320, height: 700 },
};
const element: Props = {
  title: "Onboarding checklist for everyone who starts in the platform team this autumn",
  icon: "ti ti-notebook",
  source: "Notebooks",
  location: "Team handbook / People / Starting at the company",
  preview: "Laptop, accounts, the first week, and who to ask about what when something is unclear",
  href: "#element",
};
const cards: { name: string; props: Partial<Props> }[] = [
  { name: "ok", props: {} },
  { name: "ok-short", props: { title: "Plan", source: undefined, location: undefined, preview: undefined } },
  { name: "ok-button", props: { href: undefined, onOpen: () => {} } },
  { name: "loading", props: { state: "loading" } },
  { name: "no-access", props: { state: "no_access" } },
  { name: "deleted", props: { state: "deleted" } },
  { name: "unavailable", props: { state: "unavailable" } },
];

const localized = (locale: string, children: () => JSX.Element) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return children();
      },
    }),
  );
const markup = (locale: string) =>
  `<div style="display:flex;flex-direction:column;align-items:flex-start;gap:0.5rem">${localized(locale, () =>
    cards.map(({ name, props }) => createComponent(ResourceCard, { ...element, ...props, class: `card-${name}` })),
  )}</div>` +
  // A message row takes the width of its list, as in a VirtualFeed.
  localized(locale, () =>
    createComponent(MessageRow, {
      author: { name: "Nora Brandt" },
      text: "Here is the checklist.",
      time: "09:31",
      get card() {
        return createComponent(ResourceCard, { ...element, class: "card-in-row" });
      },
    }),
  );

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

// Reduced motion turns the fill transition off, so a hover is measured at its end state without waiting on a timer.
const open = async (viewport: { width: number; height: number }, theme: "light" | "dark", locale: string) => {
  const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
  await page.route(`${assets}**`, async (route) => {
    const file = new URL(route.request().url()).pathname.slice(1);
    await route.fulfill({ body: readFileSync(resolve(ui, "dist", file)) });
  });
  await page.setContent(
    `<!doctype html><html lang="${locale}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${fonts}\n${css}</style></head>` +
      `<body class="k2b-ui" data-theme="${theme}" style="margin:0;padding:0.75rem;background:var(--k2b-surface)">` +
      `${markup(locale)}</body></html>`,
  );
  await page.evaluate(() => document.fonts.ready);
  return page;
};

const boxes = () =>
  Array.from(document.querySelectorAll<HTMLElement>(".k2b-resource-card")).map((card) => {
    const box = card.getBoundingClientRect();
    return {
      name: Array.from(card.classList).find((name) => name.startsWith("card-")),
      width: box.width,
      height: box.height,
      clipped: Array.from(card.querySelectorAll<HTMLElement>(".k2b-resource-card__copy > *")).some(
        (line) => line.getBoundingClientRect().bottom > box.bottom || line.getBoundingClientRect().top < box.top,
      ),
      background: getComputedStyle(card).backgroundColor,
    };
  });

describe("ResourceCard in a real engine", () => {
  for (const [name, viewport] of Object.entries(viewports)) {
    for (const theme of ["light", "dark"] as const) {
      for (const locale of ["en", "de"]) {
        test(`every state has the same box on a ${name} in ${theme} mode in ${locale}`, async () => {
          const page = await open(viewport, theme, locale);
          try {
            const result = await page.evaluate(boxes);
            const width = name === "phone" ? viewport.width - 24 : 352;

            expect(result.map((card) => card.name)).toEqual([...cards.map((card) => `card-${card.name}`), "card-in-row"]);
            for (const card of result.slice(0, cards.length)) {
              expect({ name: card.name, width: card.width, height: card.height, clipped: card.clipped }).toEqual({
                name: card.name,
                width,
                height: 74,
                clipped: false,
              });
              expect(card.background).not.toBe("rgba(0, 0, 0, 0)");
            }
            // In a message row the card keeps its height and never makes the page scroll sideways.
            expect(result.at(-1)?.height).toBe(74);
            expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
          } finally {
            await page.close();
          }
        });
      }
    }
  }

  test("hover and focus change only the fill of a card that opens", async () => {
    const page = await open(viewports.desktop, "light", "en");
    try {
      const card = page.locator(".card-ok");
      const before = await card.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height, background: getComputedStyle(element).backgroundColor };
      });
      await card.hover();
      const hovered = await card.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height, background: getComputedStyle(element).backgroundColor };
      });
      expect({ ...hovered, background: before.background }).toEqual(before);
      expect(hovered.background).not.toBe(before.background);

      await page.keyboard.press("Tab");
      const focused = await page.evaluate(() => {
        const active = document.activeElement as HTMLElement;
        return { name: active.className, outline: getComputedStyle(active).outlineStyle };
      });
      expect(focused).toEqual({ name: "k2b-resource-card card-ok", outline: "solid" });

      // A card that cannot show its element takes no focus and no hover fill.
      await page.locator(".card-no-access").hover();
      expect(await page.locator(".card-no-access").evaluate((element) => element.matches(":is(a, button)"))).toBe(false);
    } finally {
      await page.close();
    }
  });

  test("keeps the inset beside the icon on the icon's side in right-to-left text", async () => {
    const page = await open(viewports.desktop, "light", "en");
    try {
      const insets = () =>
        page.evaluate(() => {
          const card = document.querySelector<HTMLElement>(".card-ok")!.getBoundingClientRect();
          const icon = document.querySelector<HTMLElement>(".card-ok .k2b-resource-card__icon")!.getBoundingClientRect();
          const copy = document.querySelector<HTMLElement>(".card-ok .k2b-resource-card__copy")!.getBoundingClientRect();
          return document.body.dir === "rtl"
            ? { icon: card.right - icon.right, text: copy.left - card.left }
            : { icon: icon.left - card.left, text: card.right - copy.right };
        });
      expect(await insets()).toEqual({ icon: 10, text: 14 });
      await page.evaluate(() => {
        document.body.dir = "rtl";
      });
      expect(await insets()).toEqual({ icon: 10, text: 14 });
    } finally {
      await page.close();
    }
  });

  test("in forced colours the loading placeholder stays visible in GrayText at the same size", async () => {
    const page = await open(viewports.desktop, "light", "en");
    try {
      const before = await page.locator(".card-loading").evaluate((element) => element.getBoundingClientRect().height);
      await page.emulateMedia({ forcedColors: "active" });
      const measured = await page.evaluate(() => {
        const probe = document.body.appendChild(document.createElement("i"));
        probe.style.color = "GrayText";
        const grayText = getComputedStyle(probe).color;
        probe.remove();
        const card = document.querySelector<HTMLElement>(".card-loading")!;
        return {
          height: card.getBoundingClientRect().height,
          fills: Array.from(card.querySelectorAll<HTMLElement>(".k2b-resource-card__icon, .k2b-resource-card__bar")).map((part) =>
            getComputedStyle(part).backgroundColor === grayText ? "GrayText" : getComputedStyle(part).backgroundColor,
          ),
        };
      });
      expect(measured).toEqual({ height: before, fills: ["GrayText", "GrayText", "GrayText"] });
    } finally {
      await page.close();
    }
  });
});
