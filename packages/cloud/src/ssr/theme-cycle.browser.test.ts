import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";

let browser: Browser;
let script: string;
let css: string;
beforeAll(async () => {
  const ui = resolve(import.meta.dir, "../../../ui");
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const entry = resolve(import.meta.dir, "theme-cycle.fixture.tsx");
  const fixture = `
import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import ProfilePreferences from "./ProfilePreferences";
import MinimalLayoutPreferences from "./MinimalLayoutPreferences.island";
import { MobileProfileActions } from "./MobileProfileActions";
const params = new URLSearchParams(location.search);
render(() => <LocaleProvider locale={params.get("locale") ?? "en"}>
  {params.get("surface") === "profile" || params.get("surface") === "panel" ? <ProfilePreferences name="Test user" initialTheme="system" /> :
   params.get("surface") === "minimal" ? <footer class="minimal-layout-footer"><MinimalLayoutPreferences initialTheme="system" /></footer> :
   <MobileProfileActions profile={{ name: "Test user", theme: "system" }} beforeSelect={async () => true} />}
</LocaleProvider>, document.getElementById("app"));
`;
  const build = await Bun.build({
    entrypoints: [entry],
    files: { [entry]: fixture },
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "theme-cycle-test",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(path === entry ? fixture : await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            if (!result?.code) throw new Error(`Could not compile ${path}`);
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the theme cycle fixture");
  script = await build.outputs[0]!.text();
  const styles = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  if (!styles.success) throw new AggregateError(styles.logs, "Could not compile the global stylesheet");
  css = await styles.outputs[0]!.text();
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

const settle = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
// Standalone profile at both widths: expose its hydrated trigger even on a fine pointer, without the rail.
const dropdownOnly = `.layout-profile-preferences > .layout-profile-preferences__dropdown { display: inline-flex; }
.layout-profile-preferences__link, .layout-profile-preferences__panel { display: none; }`;
const surfaces = {
  profile: {
    control: '.k2b-dropdown__menu [role="menuitem"]',
    neighbor: '.k2b-dropdown__menu [role="menuitem"]:nth-child(2)',
    container: ".k2b-dropdown__menu",
    css: dropdownOnly,
  },
  // The server-rendered panel a fine pointer opens beside the rail, kept open below room for it to grow upward.
  panel: {
    control: ".layout-profile-preferences__panel .menu-item",
    neighbor: ".layout-profile-preferences__panel .menu-item:nth-child(2)",
    container: ".layout-profile-preferences__panel",
    css: `#app { padding-top: 320px; }
.layout-profile-preferences__panel { display: flex; opacity: 1; visibility: visible; pointer-events: auto; }
.layout-profile-preferences > .layout-profile-preferences__dropdown { display: none; }`,
  },
  // The footer keeps language first, so its adjacent control is the preceding sibling.
  minimal: {
    control: ".cloud-theme-cycle",
    neighbor: ".minimal-layout-footer__preferences > .k2b-dropdown",
    container: ".minimal-layout-footer",
    css: dropdownOnly,
  },
  mobile: {
    control: ".cloud-theme-cycle",
    neighbor: '.cloud-mobile-profile > a[href="/me"]',
    container: ".cloud-mobile-profile",
    css: dropdownOnly,
  },
};

for (const viewport of [
  { width: 1366, height: 900 },
  { width: 390, height: 844 },
]) {
  for (const [locale, labels] of [
    ["en", ["Light", "Dark", "Automatic"]],
    ["de", ["Hell", "Dunkel", "Automatisch"]],
  ] as const) {
    test(`cycling appearance keeps controls, neighbors and containers in place (${locale}, ${viewport.width}px)`, async () => {
      for (const [surface, selectors] of Object.entries(surfaces)) {
        const page = await browser.newPage({ viewport });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        try {
          const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}
*, *::before, *::after { animation: none !important; transition: none !important; }
#app { padding: 16px; }
${selectors.css}
</style></head><body class="k2b-ui"><main id="app"></main></body></html>`;
          await page.route("http://localhost/theme-cycle**", (route) => route.fulfill({ contentType: "text/html", body: html }));
          await page.goto(`http://localhost/theme-cycle?locale=${locale}&surface=${surface}`);
          await page.addScriptTag({ content: script });
          if (surface === "profile") await page.locator(".k2b-dropdown__trigger").click();
          const control = page.locator(selectors.control).first();
          await control.waitFor({ state: "visible" });
          await settle(page);
          const rects = () =>
            page.evaluate(
              (selectors) =>
                [selectors.control, selectors.neighbor, selectors.container].map((selector) => {
                  const rect = document.querySelector(selector)!.getBoundingClientRect();
                  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
                }),
              selectors,
            );
          const before = await rects();
          expect(before.every((rect) => rect.width > 0 && rect.height > 0)).toBe(true);
          if (surface === "minimal") expect(await control.locator(".cloud-theme-cycle__label").isVisible()).toBe(viewport.width >= 768);
          if (surface === "mobile") {
            const grid = await page.locator(".cloud-mobile-profile").evaluate((element) => ({
              width: element.getBoundingClientRect().width,
              announcementPosition: getComputedStyle(element.querySelector('[aria-live="polite"]')!).position,
            }));
            expect(before[0]!.width).toBeLessThan(grid.width / 2);
            expect(grid.announcementPosition).toBe("absolute");
          }
          const node = await control.elementHandle();
          expect(await control.textContent()).toBe(locale === "de" ? "Automatisch" : "Automatic");
          for (const label of labels) {
            await control.click();
            await settle(page);
            expect(await rects()).toEqual(before);
            expect(await control.textContent()).toBe(label);
            expect(await control.evaluate((element, original) => element === original, node)).toBe(true);
            if (surface === "profile") {
              expect(await page.locator(".k2b-dropdown__trigger").getAttribute("aria-expanded")).toBe("true");
              expect(await control.evaluate((element) => document.activeElement === element)).toBe(true);
            }
          }
          expect(errors).toEqual([]);
        } finally {
          await page.close();
        }
      }
    }, 30_000);
  }
}
