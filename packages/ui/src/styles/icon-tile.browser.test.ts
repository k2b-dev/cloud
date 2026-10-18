import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../test/browser";

const css = readFileSync(resolve(import.meta.dir, "../../dist/styles.css"), "utf8");
const surfaces = ["--k2b-surface", "--k2b-surface-muted", "--k2b-hover", "--k2b-selected"];
const glyph = '<i class="ti ti-file" aria-hidden="true"></i>';
const tile = (className: string, attributes = "") => `<span class="${className} k2b-icon-tile" ${attributes}>${glyph}</span>`;
// Component markup without hydration: the parent selectors, not a test override, own layout and interaction.
const fixtures = [
  {
    kind: "placeholder-compact",
    size: 32,
    markup: `<div class="k2b-placeholder" data-variant="compact" data-state="empty" data-parent tabindex="0">${tile("k2b-placeholder__icon")}</div>`,
  },
  {
    kind: "placeholder-panel",
    size: 40,
    markup: `<div class="k2b-placeholder" data-variant="panel" data-state="empty" data-parent tabindex="0">${tile("k2b-placeholder__icon")}</div>`,
  },
  {
    kind: "overview",
    size: 40,
    markup: `<header class="k2b-app-overview__header" data-parent tabindex="0">${tile("k2b-app-overview__icon")}</header>`,
  },
  {
    kind: "object",
    size: 32,
    markup: `<a class="k2b-app-workspace__sidebar-item" data-variant="object" href="#" data-parent>${tile("k2b-app-workspace__sidebar-item-icon")}<span class="k2b-app-workspace__sidebar-item-label">Notes</span></a>`,
  },
  {
    kind: "panel-dialog",
    size: 32,
    markup: `<header class="k2b-panel-dialog__header" data-surface="contained" data-parent tabindex="0">${tile("k2b-panel-dialog__icon")}<div class="k2b-panel-dialog__heading"><h2>Notes</h2></div></header>`,
  },
  {
    kind: "widget",
    size: 24,
    markup: `<div class="k2b-paper k2b-widget" data-size="content"><a href="#" class="k2b-widget__header" data-parent>${tile("k2b-widget__icon")}<span class="k2b-widget__heading"><span class="k2b-widget__title">Notes</span></span></a><div class="k2b-widget__body"></div></div>`,
  },
  {
    kind: "link-card",
    size: 40,
    markup: `<a href="#" class="k2b-paper k2b-link-card" data-interactive="true" data-parent><div class="k2b-link-card__icon k2b-icon-tile"><i class="ti ti-file k2b-link-card__glyph"></i></div><div class="k2b-link-card__copy">Notes</div></a>`,
  },
  // Every card colour keeps its glyph readable on its own chip.
  ...(["blue", "emerald", "violet", "orange", "red", "amber", "zinc", "cyan", "rose"] as const).map((color) => ({
    kind: `link-card-${color}`,
    size: 40,
    markup: `<a href="#" class="k2b-paper k2b-link-card" data-color="${color}" data-interactive="true" data-parent><div class="k2b-link-card__icon k2b-icon-tile"><i class="ti ti-file k2b-link-card__glyph"></i></div><div class="k2b-link-card__copy">Notes</div></a>`,
  })),
  {
    kind: "file-tree",
    size: 20,
    markup: `<ul class="k2b-content-file-tree"><li class="k2b-content-file-tree__item" role="treeitem" tabindex="0" data-parent><div class="k2b-content-file-tree__row" data-state="idle"><button class="k2b-content-file-tree__select" tabindex="-1">${tile("k2b-file-type-icon k2b-content-file-tree__icon", 'data-size="sm" data-file-type="pdf"')}<span class="k2b-content-file-tree__name">report.pdf</span></button></div></li></ul>`,
  },
  ...(["folder", "pdf", "sheet", "image", "document", "slides", "video", "audio", "archive", "other"] as const).flatMap((type) =>
    (["sm", "md", "lg"] as const).map((size) => ({
      kind: `file-${type}-${size}`,
      size: { sm: 20, md: 32, lg: 72 }[size],
      markup: `<a href="#" data-parent>${tile("k2b-file-type-icon", `data-file-type="${type}" data-size="${size}"`)}</a>`,
    })),
  ),
];

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const mount = async (page: Page, theme: string) => {
  // Give paper-framed fixtures the surface under test too; otherwise their own paper would hide hover/selection fills.
  const samples = surfaces
    .flatMap((surface) =>
      fixtures.map(
        (fixture) =>
          `<section data-sample="${surface}/${fixture.kind}" data-size="${fixture.size}" style="background:var(${surface})">${fixture.markup.replaceAll('class="k2b-paper ', `style="background:var(${surface})" class="k2b-paper `)}</section>`,
      ),
    )
    .join("");
  await page.setContent(
    `<!doctype html><html><head><style>${css}</style></head><body class="k2b-ui" data-theme="${theme}">${samples}</body></html>`,
  );
};

const measurements = (page: Page) =>
  page.locator("[data-sample]").evaluateAll((samples) =>
    samples.map((sample) => {
      const icon = sample.querySelector<HTMLElement>(".k2b-icon-tile")!;
      const box = icon.getBoundingClientRect();
      return {
        sample: sample.getAttribute("data-sample"),
        expected: Number(sample.getAttribute("data-size")),
        width: box.width,
        height: box.height,
        background: getComputedStyle(icon).backgroundColor,
      };
    }),
  );

describe("standalone icon tiles", () => {
  for (const theme of ["light", "dark"]) {
    test(`glyph contrast is at least 3:1 over every surface in ${theme}`, async () => {
      const page = await browser.newPage();
      try {
        await mount(page, theme);
        const results = await page.locator("[data-sample]").evaluateAll((samples) => {
          const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
          const luminance = () => {
            const [r, g, b] = Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3), (value) => {
              const channel = value / 255;
              return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
            });
            return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
          };
          return samples.map((sample) => {
            const icon = sample.querySelector(".k2b-icon-tile")!;
            // Paper surfaces can override the outer sample's fill. Composite the actual ancestors from the sample in.
            const ancestors: Element[] = [];
            for (let element = icon.parentElement; element; element = element.parentElement) {
              ancestors.unshift(element);
              if (element === sample) break;
            }
            context.clearRect(0, 0, 1, 1);
            for (const element of [...ancestors, icon]) {
              context.fillStyle = getComputedStyle(element).backgroundColor;
              context.fillRect(0, 0, 1, 1);
            }
            const background = luminance();
            const alpha = context.getImageData(0, 0, 1, 1).data[3];
            context.fillStyle = getComputedStyle(icon.querySelector("i")!).color;
            context.fillRect(0, 0, 1, 1);
            const foreground = luminance();
            return {
              sample: sample.getAttribute("data-sample"),
              alpha,
              ratio: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05),
            };
          });
        });
        expect(results).toHaveLength(surfaces.length * fixtures.length);
        for (const result of results) {
          expect(result.alpha, result.sample!).toBe(255);
          expect(result.ratio, result.sample!).toBeGreaterThanOrEqual(3);
        }
      } finally {
        await page.close();
      }
    }, 30_000);

    test(`boxes and fills stay fixed on parent hover and focus in ${theme}`, async () => {
      const page = await browser.newPage();
      try {
        await mount(page, theme);
        const before = await measurements(page);
        for (const result of before) {
          expect(result.width, result.sample!).toBe(result.expected);
          expect(result.height, result.sample!).toBe(result.expected);
          expect(result.background, result.sample!).not.toBe("rgba(0, 0, 0, 0)");
        }
        const parents = page.locator("[data-parent]");
        for (let index = 0; index < before.length; index++) {
          const parent = parents.nth(index);
          const snapshot = () =>
            parent.locator(".k2b-icon-tile").evaluate((icon) => {
              const box = icon.getBoundingClientRect();
              return { width: box.width, height: box.height, background: getComputedStyle(icon).backgroundColor };
            });
          const expected = { width: before[index]!.width, height: before[index]!.height, background: before[index]!.background };
          await parent.hover();
          expect(await parent.evaluate((element) => element.matches(":hover"))).toBe(true);
          expect(await snapshot(), `${before[index]!.sample} hover`).toEqual(expected);
          await page.mouse.move(0, 0);
          await parent.focus();
          expect(await parent.evaluate((element) => element === document.activeElement)).toBe(true);
          expect(await snapshot(), `${before[index]!.sample} focus`).toEqual(expected);
          await parent.evaluate((element) => (element as HTMLElement).blur());
        }
      } finally {
        await page.close();
      }
    }, 60_000);
  }
});
