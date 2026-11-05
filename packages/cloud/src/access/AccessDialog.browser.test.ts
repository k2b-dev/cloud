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

// An app's own sheet repeats common utilities and may load after the shared one, as in app browser fixtures.
const appSheet = "@layer utilities{.contents{display:contents}.inline-flex{display:inline-flex}.flex{display:flex}.hidden{display:none}}";

/** Set ACCESS_DIALOG_SHOTS to a directory to keep screenshots of each state for a visual review. */
const shots = process.env.ACCESS_DIALOG_SHOTS;
const shot = async (page: Page, name: string) => {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: resolve(shots, `${name}.png`) });
};

const open = async (width: number, locale: string) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  // The icon font URL carries a version query (`?v…`); the glob keeps it routed.
  await page.route("https://harness.test/tabler.woff2*", (route) => route.fulfill({ path: icons.font, contentType: "font/woff2" }));
  await page.setContent(
    `<!doctype html><html lang="${locale}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${icons.css}</style><style>${css}</style><style>${appSheet}</style></head>` +
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
        // Each staged row shows its mark once: beside the name on a wide screen, below it on a phone.
        for (const name of ["Lea Schmitt", "Lagerbot"])
          expect(await page.locator("dialog li", { hasText: name }).locator(".k2b-status-badge:visible").count()).toBe(1);
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

  // Mockup v31 `editor · A · aenderungen` at 390 px: full level words, whole marks, names on one line.
  for (const locale of ["de", "en"] as const)
    test(`${locale} 390px: no mark, level or name in a row is cut off`, async () => {
      const page = await open(390, locale);
      const level = async (name: string, de: string, en: string) => {
        await page.locator("dialog li", { hasText: name }).locator("button[aria-haspopup]").first().click();
        await page
          .locator('[role="dialog"] [role="radio"]', { hasText: locale === "de" ? de : en })
          .last()
          .click();
      };
      try {
        await level("Lea Schmitt", "Bearbeiten", "Edit");
        // The longest pairs: "vorher Bearbeiten" beside "Verwalten" and "vorher Verwalten" beside "Bearbeiten".
        await level("Jonas Weber", "Verwalten", "Manage");
        await level("Mia Hoffmann", "Bearbeiten", "Edit");
        await page.locator(`dialog button[aria-label="${locale === "de" ? "Lagerbot entfernen" : "Remove Lagerbot"}"]`).click();
        await page.locator("dialog input[type=checkbox]").first().check();
        await settled(page);
        const cut = await page.evaluate(() => {
          /** Text is cut when it or a part of it overflows its box (an ellipsis) or reaches past an ancestor that clips. */
          const clipped = (element: HTMLElement) => {
            if ([element, ...element.querySelectorAll<HTMLElement>("*")].some((part) => part.scrollWidth > part.clientWidth + 1))
              return true;
            const box = element.getBoundingClientRect();
            for (let parent = element.parentElement; parent && parent.tagName !== "LI"; parent = parent.parentElement) {
              if (getComputedStyle(parent).overflowX === "visible") continue;
              const clip = parent.getBoundingClientRect();
              if (box.right > clip.right + 0.5 || box.left < clip.left - 0.5) return true;
            }
            return false;
          };
          const visible = (element: HTMLElement) => element.getClientRects().length > 0;
          const rows = Array.from(document.querySelectorAll<HTMLElement>("dialog li"));
          const marks = rows.flatMap((row) => Array.from(row.querySelectorAll<HTMLElement>(".k2b-status-badge")).filter(visible));
          const levels = rows.flatMap((row) => Array.from(row.querySelectorAll<HTMLElement>(".k2b-choice-trigger__value")));
          const names = rows
            .map((row) => row.querySelector<HTMLElement>("[data-access-name]"))
            .filter((name): name is HTMLElement => Boolean(name));
          // Level and remove, or Undo in their place, take one width in every people row, so staging leaves a name its room.
          const people = Array.from(
            document.querySelector("dialog ul")!.children,
            (row) => row.lastElementChild!.getBoundingClientRect().width,
          );
          return {
            controls: new Set(people).size,
            marks: marks.length,
            levels: levels.length,
            names: names.length,
            cut: [...marks, ...levels, ...names].filter(clipped).map((element) => element.textContent?.trim()),
            // A name wraps when its text lies on more than one line.
            wrapped: names
              .filter((name) => {
                const range = document.createRange();
                range.selectNodeContents(name);
                return new Set(Array.from(range.getClientRects(), (rect) => Math.round(rect.top))).size > 1;
              })
              .map((name) => name.textContent?.trim()),
          };
        });
        expect(cut).toEqual({ controls: 1, marks: 5, levels: 5, names: 7, cut: [], wrapped: [] });
      } finally {
        await page.close();
      }
    });
});
