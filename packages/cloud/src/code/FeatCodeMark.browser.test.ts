import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwind from "bun-plugin-tailwind";
import type { Browser } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../ui/test/browser";

let browser: Browser;
let harness: string;
let css: string;
/** IBM Plex, which Cloud ships, so the wordmark is measured with the product's widths. */
let plex: string;
beforeAll(async () => {
  const ui = resolve(import.meta.dir, "../../../ui");
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "FeatCodeMark.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-feat-code",
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
  if (!build.success) throw new AggregateError(build.logs, "Mark harness build failed");
  harness = await build.outputs[0]!.text();
  const styles = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  if (!styles.success) throw new AggregateError(styles.logs, "Mark stylesheet build failed");
  css = await styles.outputs[0]!.text();
  const plexPath = fileURLToPath(import.meta.resolve("@k2b/ui/fonts/plex.css"));
  plex = await Bun.file(plexPath).text();
  for (const file of new Set(plex.match(/\.\/fonts\/[^)"']+\.woff2/g) ?? []))
    plex = plex.replaceAll(
      file,
      `data:font/woff2;base64,${Buffer.from(await Bun.file(resolve(dirname(plexPath), file)).arrayBuffer()).toString("base64")}`,
    );
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

test("the mark keeps one line, picks its drawing by size, and colours only the new commit", async () => {
  const page = await browser.newPage({ viewport: { width: 480, height: 900 }, reducedMotion: "reduce" });
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><style>${plex}</style><style>${css}</style></head><body class="k2b-ui"><main id="root"></main></body></html>`,
    );
    await page.addScriptTag({ content: harness });
    await page.evaluate(async () => {
      await document.fonts.load('600 16px "IBM Plex Sans"');
      await document.fonts.ready;
    });
    await settled(page);
    if (process.env.FEAT_CODE_SCREENSHOTS) {
      mkdirSync(process.env.FEAT_CODE_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: resolve(process.env.FEAT_CODE_SCREENSHOTS, "feat-code-mark.png"), fullPage: true });
    }
    const measured = await page.evaluate(() => {
      const mark = (probe: string) => document.querySelector<HTMLElement>(`[data-probe="${probe}"] .cloud-featcode`)!;
      const drawing = (probe: string) => mark(probe).querySelector("svg")!.dataset.drawing;
      const fill = (probe: string, part: string) => getComputedStyle(mark(probe).querySelector(part)!).fill;
      const stroke = (probe: string, part: string) => getComputedStyle(mark(probe).querySelector(part)!).stroke;
      const box = (probe: string) => {
        const rect = mark(probe).getBoundingClientRect();
        return { width: Math.round(rect.width), height: Math.round(rect.height) };
      };
      const narrow = mark("narrow-light");
      const [feat, code] = Array.from(mark("head-light").querySelectorAll<HTMLElement>(".cloud-featcode__word"));
      const sign = mark("head-light").querySelector("svg")!.getBoundingClientRect();
      return {
        name: [mark("head-light").getAttribute("role"), mark("head-light").getAttribute("aria-label")],
        hidden: mark("title-light").getAttribute("aria-hidden"),
        drawings: ["title-light", "head-light", "row-light", "narrow-light", "glyph-32-light", "glyph-16-light"].map(drawing),
        // Narrower than its container, the wordmark overflows on one line instead of breaking at the sign.
        oneLine: narrow.getBoundingClientRect().height <= 16 * 1.25 && narrow.getBoundingClientRect().width > 40,
        glyphs: [box("glyph-32-light"), box("glyph-16-light")],
        // "code" tucks under the new commit; "feat" stays clear of the ring.
        tucked: code!.getBoundingClientRect().left < sign.right && feat!.getBoundingClientRect().right <= sign.left + 1,
        newCommit: [fill("head-light", ".cloud-featcode__head"), fill("head-dark", ".cloud-featcode__head")],
        ring: [stroke("head-light", ".cloud-featcode__base"), getComputedStyle(mark("head-light")).color],
        current: [fill("current-light", ".cloud-featcode__head"), getComputedStyle(mark("current-light")).color],
      };
    });
    expect(measured.name).toEqual(["img", "feat/code"]);
    expect(measured.hidden).toBe("true");
    expect(measured.drawings).toEqual(["large", "large", "small", "small", "large", "small"]);
    expect(measured.oneLine).toBe(true);
    expect(measured.glyphs).toEqual([
      { width: 32, height: 32 },
      { width: 16, height: 16 },
    ]);
    expect(measured.tucked).toBe(true);
    expect(measured.newCommit).toEqual(["rgb(22, 163, 74)", "rgb(74, 222, 128)"]);
    expect(measured.ring[0]).toBe(measured.ring[1]);
    expect(measured.current[0]).toBe(measured.current[1]);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 60_000);
