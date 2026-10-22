import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";
import { appAccentStyle } from "./app-appearance";

let browser: Browser;
let css: string;
beforeAll(async () => {
  const styles = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  if (!styles.success) throw new AggregateError(styles.logs, "Could not compile the global stylesheet");
  css = await styles.outputs[0]!.text();
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

// The opaque content surface is white in light mode and the base ink surface in dark mode.
const surfaces = ["--k2b-surface", "--ui-surface-muted", "--ui-app-selected"];
const samples: { markup: string; size?: number }[] = [
  {
    markup:
      '<div class="k2b-placeholder" data-state="empty" data-variant="compact"><span class="k2b-placeholder__icon k2b-icon-tile"><i class="ti ti-notebook"></i></span></div>',
  },
  {
    markup: '<div class="k2b-widget__header"><span class="k2b-widget__icon k2b-icon-tile"><i class="ti ti-notebook"></i></span></div>',
  },
  {
    markup: '<span class="k2b-file-type-icon k2b-icon-tile" data-file-type="folder" data-size="md"><i class="ti ti-folder"></i></span>',
  },
  {
    markup: '<span class="help-topic-icon help-start-tile-icon app-accent-text k2b-icon-tile"><i class="ti ti-notebook"></i></span>',
    size: 36,
  },
  {
    markup: '<span class="help-topic-icon help-start-row-icon app-accent-text k2b-icon-tile"><i class="ti ti-notebook"></i></span>',
    size: 36,
  },
  {
    markup: '<span class="help-topic-icon help-article-related-icon app-accent-text k2b-icon-tile"><i class="ti ti-notebook"></i></span>',
    size: 36,
  },
  {
    markup: '<span class="sidebar-header-icon k2b-icon-tile"><i class="ti ti-notebook"></i></span>',
    size: 23,
  },
  {
    // The mobile icon inherits its box from its owner; it has no size of its own.
    markup: '<span class="sidebar-header-icon-mobile k2b-icon-tile"><i class="ti ti-notebook"></i></span>',
  },
  {
    markup: '<span class="app-overview-icon k2b-icon-tile"><i class="ti ti-notebook"></i></span>',
    size: 40,
  },
  {
    markup: '<span class="k2b-icon-tile size-9 text-[var(--ui-app-accent-text)]"><i class="ti ti-notebook"></i></span>',
    size: 36,
  },
];
const markup = samples.map(({ markup }, index) => `<div data-sample="${index}">${markup}</div>`).join("");

describe("Cloud icon tiles inherit their source app ink", () => {
  for (const [app, accent] of [
    ["Notebooks", "#eab308"],
    ["Mail", "#0f766e"],
  ]) {
    for (const theme of ["light", "dark"]) {
      test(`${app} glyphs match the app ink and keep 3:1 over their chips in ${theme}`, async () => {
        const page = await browser.newPage();
        try {
          const surfaceMarkup = surfaces
            .map((surface) => `<section data-surface="${surface}" style="background:var(${surface})">${markup}</section>`)
            .join("");
          await page.setContent(
            `<!doctype html><html class="${theme === "dark" ? "dark" : ""}"><head><style>${css}</style></head><body class="k2b-ui"><div class="app-accent-scope" style="${appAccentStyle(accent)}"><span data-ink style="color:var(--ui-app-accent-text)"></span>${surfaceMarkup}</div></body></html>`,
          );
          const results = await page.evaluate(() => {
            const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
            const luminance = () => {
              const [r, g, b] = Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3), (value) => {
                const channel = value / 255;
                return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
              });
              return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
            };
            const ink = getComputedStyle(document.querySelector("[data-ink]")!).color;
            return Array.from(document.querySelectorAll(".k2b-icon-tile"), (tile) => {
              const surface = tile.closest<HTMLElement>("[data-surface]")!;
              const glyph = tile.querySelector("i")!;
              const color = getComputedStyle(glyph).color;
              const style = getComputedStyle(tile);
              const box = tile.getBoundingClientRect();
              context.clearRect(0, 0, 1, 1);
              // Light Cloud surfaces are slightly translucent over the opaque page canvas.
              context.fillStyle = getComputedStyle(document.body).getPropertyValue("--k2b-surface-canvas");
              context.fillRect(0, 0, 1, 1);
              context.fillStyle = getComputedStyle(surface).backgroundColor;
              context.fillRect(0, 0, 1, 1);
              context.fillStyle = style.backgroundColor;
              context.fillRect(0, 0, 1, 1);
              const background = luminance();
              const alpha = context.getImageData(0, 0, 1, 1).data[3];
              context.fillStyle = color;
              context.fillRect(0, 0, 1, 1);
              const foreground = luminance();
              return {
                surface: surface.dataset.surface,
                kind: tile.className,
                sample: Number(tile.closest<HTMLElement>("[data-sample]")!.dataset.sample),
                width: box.width,
                height: box.height,
                background: style.backgroundColor,
                shadow: style.boxShadow,
                color,
                ink,
                alpha,
                ratio: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05),
              };
            });
          });
          expect(results).toHaveLength(surfaces.length * samples.length);
          for (const result of results) {
            const label = `${result.surface} ${result.kind}`;
            expect(result.alpha, label).toBe(255);
            expect(result.color, label).toBe(result.ink);
            expect(result.ratio, label).toBeGreaterThanOrEqual(3);
            expect(result.background, label).not.toBe("rgba(0, 0, 0, 0)");
            expect(result.shadow, label).toBe("none");
            const size = samples[result.sample]!.size;
            if (size !== undefined) {
              expect(result.width, label).toBe(size);
              expect(result.height, label).toBe(size);
            }
          }
        } finally {
          await page.close();
        }
      }, 30_000);
    }
  }
});
