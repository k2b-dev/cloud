import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../../ui/test/browser";

// The dialog's layout and its marks depend on the real layout engine: rows must not move when a change is staged.
let browser: Browser;
let css: string;
let harness: string;
let icons: { css: string; font: string };

const buildHarness = async () => {
  const ui = resolve(import.meta.dir, "../../../ui");
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "AccessDialog.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-access-dialog-test",
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
  if (!build.success) throw new AggregateError(build.logs, "AccessDialog harness build failed");
  return build.outputs[0]!.text();
};
beforeAll(async () => {
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, "Could not compile the global stylesheet.");
  css = await build.outputs[0]!.text();
  harness = await buildHarness();
  const iconCss = fileURLToPath(import.meta.resolve("@k2b/ui/icons/tabler.css"));
  const source = await Bun.file(iconCss).text();
  const font = source.match(/url\((\.\/[^)"']+\.woff2)[^)]*\)/)?.[1];
  if (!font) throw new Error("Missing Tabler WOFF2 file");
  icons = { css: source.replace(font, "https://harness.test/tabler.woff2"), font: resolve(dirname(iconCss), font) };
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

/** Set ACCESS_DIALOG_SHOTS to a directory to keep screenshots of each state for a visual review. */
const shots = process.env.ACCESS_DIALOG_SHOTS;
const shot = async (page: Page, name: string) => {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: resolve(shots, `${name}.png`) });
};

const open = async (width: number, locale: string) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.route("https://harness.test/tabler.woff2", (route) => route.fulfill({ path: icons.font, contentType: "font/woff2" }));
  await page.setContent(
    `<!doctype html><html lang="${locale}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${icons.css}</style><style>${css}</style></head>` +
      `<body class="k2b-ui"><script>${harness}</script></body></html>`,
  );
  await page.waitForSelector("dialog[open]");
  await settled(page);
  return page;
};

const rowTop = (page: Page, name: string) =>
  page.evaluate((text) => {
    const row = Array.from(document.querySelectorAll("dialog li")).find((item) => item.textContent?.includes(text));
    return row ? Math.round(row.getBoundingClientRect().top) : -1;
  }, name);

describe("AccessDialog in a browser", () => {
  for (const [width, locale] of [
    [1440, "de"],
    [390, "de"],
    [390, "en"],
  ] as const)
    test(`${locale} ${width}px: staging changes moves no row and nothing overflows`, async () => {
      const page = await open(width, locale);
      try {
        await shot(page, `${locale}-${width}-normal`);
        const before = await Promise.all(["Jonas Weber", "Logistik", "Lagerbot", "Lea Schmitt"].map((name) => rowTop(page, name)));
        const lea = page.locator("dialog li", { hasText: "Lea Schmitt" });
        await lea.locator("button[aria-haspopup]").first().click();
        // The level menu offers each level with what it means, as in the approved mockup.
        await page
          .locator('[role="dialog"] [role="radio"]', { hasText: locale === "de" ? "Bearbeiten" : "Edit" })
          .last()
          .click();
        await page.locator(`dialog button[aria-label="${locale === "de" ? "Lagerbot entfernen" : "Remove Lagerbot"}"]`).click();
        await settled(page);
        const after = await Promise.all(["Jonas Weber", "Logistik", "Lagerbot", "Lea Schmitt"].map((name) => rowTop(page, name)));
        expect(after).toEqual(before);
        await page.locator("dialog input[type=checkbox]").first().check();
        await settled(page);
        await shot(page, `${locale}-${width}-changes`);
        const overflow = await page.evaluate(() => {
          const dialog = document.querySelector("dialog")!;
          return (
            Array.from(dialog.querySelectorAll<HTMLElement>("*"))
              // Inputs scroll their own text, and a switch hides its checkbox; neither pushes the layout.
              .filter((element) => element.tagName !== "INPUT")
              .filter((element) => element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX === "visible")
              .map((element) => `${element.tagName.toLowerCase()}.${element.className}`)
          );
        });
        expect(overflow).toEqual([]);
        expect(await page.locator("dialog").textContent()).toContain(locale === "de" ? "3 Änderungen" : "3 changes");
      } finally {
        await page.close();
      }
    });
});
