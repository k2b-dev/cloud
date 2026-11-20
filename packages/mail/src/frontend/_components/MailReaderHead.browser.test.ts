import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { launchBrowser } from "../../../../ui/test/browser";
import type { ReaderHeadHarnessOptions } from "./MailReaderHead.browser-harness";

// The chip row under the subject with the shipped CSS and font: chip labels clip their overflow, so their line box
// must hold descenders ("+ Tag" lost the bottom of its "g" in 0.82).
const buildHarness = async (): Promise<string> => {
  const ui = new URL("../../../../ui/", import.meta.url).pathname;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./MailReaderHead.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-reader-head-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Reader head harness build failed");
  return build.outputs[0]!.text();
};

const buildCss = async (entry: string): Promise<string> => {
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", new URL("../../../../cloud/", import.meta.url).pathname))).default;
  const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, `Could not compile ${entry}`);
  return build.outputs[0]!.text();
};

const harness = await buildHarness();
const css =
  "@layer properties, theme, base, components, utilities;" +
  (await buildCss(resolve(import.meta.dir, "../../styles/app.css"))) +
  (await buildCss(resolve(import.meta.dir, "../../../../../styles.css")));
const uiDist = new URL("../../../../ui/dist/", import.meta.url).pathname;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/harness.js") return new Response(harness, { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
    if (url.pathname === "/styles.css") return new Response(css, { headers: { "Content-Type": "text/css; charset=utf-8" } });
    if (url.pathname === "/tabler.css" || url.pathname === "/plex.css" || url.pathname.endsWith(".woff2"))
      return new Response(Bun.file(uiDist + url.pathname.slice(1)));
    return new Response(
      '<!doctype html><html class="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<link rel="stylesheet" href="/plex.css"><link rel="stylesheet" href="/tabler.css"><link rel="stylesheet" href="/styles.css"></head>' +
        '<body class="k2b-ui" style="margin:0"><div id="root" style="width:960px"></div><script src="/harness.js"></script></body></html>',
      { headers: { "Content-Type": "text/html" } },
    );
  },
});

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
  server.stop(true);
});

const tag = (id: string, name: string) => ({
  id,
  mailboxId: "Box001",
  name,
  color: "#0f766e",
  revision: 1,
  createdAt: "2026-11-20T08:00:00.000Z",
  updatedAt: "2026-11-20T08:00:00.000Z",
});

describe("Mail reader head chips", () => {
  for (const locale of ["en", "de"] as const)
    test(`keep descenders inside their clipped labels and their 24px height (${locale})`, async () => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 400 } });
      try {
        await page.goto(server.url.href);
        const options: ReaderHeadHarnessOptions = { locale, tags: [tag("Tag001", "gjpqy"), tag("Tag002", "Rechnung")] };
        await page.evaluate((harnessOptions) => window.mountReaderHead(harnessOptions), options);
        await page.locator('.mail-reader-chip[data-kind="add"]').waitFor();
        await page.evaluate(() => document.fonts.ready);
        const chips = await page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>(".mail-reader-chip")].map((chip) => {
            const label = chip.querySelector<HTMLElement>(".mail-reader-chip-label")!;
            const box = label.getBoundingClientRect();
            // A text range's box is the font's ascent to descent, whatever the line-height: what the label must hold.
            const range = document.createRange();
            range.selectNodeContents(label);
            const glyphs = range.getBoundingClientRect();
            return {
              text: label.textContent,
              family: getComputedStyle(label).fontFamily,
              chipHeight: chip.getBoundingClientRect().height,
              fits: glyphs.top >= box.top && glyphs.bottom <= box.bottom,
              box: [box.top, box.bottom],
              glyphs: [glyphs.top, glyphs.bottom],
            };
          }),
        );
        expect(chips.map((chip) => chip.text)).toEqual(
          locale === "en" ? ["Waiting for reply", "gjpqy", "Rechnung", "Tag"] : ["Wartet auf Antwort", "gjpqy", "Rechnung", "Tag"],
        );
        expect(await page.evaluate(() => document.fonts.check('500 12px "IBM Plex Sans"'))).toBe(true);
        for (const chip of chips) {
          expect(chip.family).toContain("IBM Plex Sans");
          expect(chip).toMatchObject({ fits: true, chipHeight: 24 });
        }
      } finally {
        await page.close();
      }
    });
});
