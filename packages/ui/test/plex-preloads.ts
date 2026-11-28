import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page, Route } from "playwright";

const preset = readFileSync(resolve(import.meta.dir, "../dist/plex.css"), "utf8");
const files = ["400", "500", "600", "700"].map((weight) => {
  const file = new RegExp(`url\\(\\./fonts/(ibm-plex-sans-latin-${weight}-normal-[0-9a-f]+\\.woff2)\\)`).exec(preset)?.[1];
  if (!file) throw new Error(`The @k2b/ui Plex preset has no Latin IBM Plex Sans ${weight} face`);
  return file;
});

/**
 * The Plex faces as Cloud's page head preloads them (packages/cloud font-preloads): the Latin IBM Plex Sans faces at
 * 400, 500, 600 and 700, the same files, under `fonts` (the address a fixture serves the font files at, ending in `/`).
 * Core copies the preset's files under their own names, so these are also the files of Core's `fonts.css`.
 *
 * Core's `fonts.css` serves the faces with `font-display: optional` (packages/core/scripts/font-assets.ts): a face that
 * misses the first frame never replaces the fallback on that page. A fixture that builds Core's `fonts.css` and measures
 * Plex text puts `links` in its head before the stylesheet. A preload alone does not hold the first frame on a loaded
 * runner, so the fixture also answers the stylesheet only once the faces are served: `fulfill` answers a routed request
 * that way (or a fixture awaits `ready` before it answers `fonts.css` and reports each answered URL to `served`).
 * The first frame then shows Plex, every time. The page itself arrives by navigation, as a real page does (`show`):
 * after `setContent` the first frame took the fallback in some runs, after `goto` never. One value serves one page.
 */
export const plexPreloads = (fonts: string) => {
  const waiting = new Map(files.map((file) => [`${fonts}${file}`, Promise.withResolvers<void>()]));
  const served = (url: string) => waiting.get(url)?.resolve();
  const ready = Promise.all([...waiting.values()].map((face) => face.promise)).then(() => undefined);
  return {
    links: [...waiting.keys()].map((href) => `<link rel="preload" href="${href}" as="font" type="font/woff2" crossorigin>`).join(""),
    served,
    ready,
    /** Answers a routed request with the file at `path`; `fonts.css` only once the preloaded faces are served. */
    fulfill: async (route: Route, path: string) => {
      const url = route.request().url();
      if (new URL(url).pathname.endsWith("/fonts.css")) await ready;
      await route.fulfill({ path });
      served(url);
    },
    /** Shows `html` as the page at `url`, reached by navigation. */
    show: async (page: Page, url: string, html: string) => {
      await page.route(url, (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: html }));
      await page.goto(url);
    },
  };
};
