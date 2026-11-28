import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { demoBundle } from "../../test/v2-behavior/harness";
import type {} from "../../test/v2-path.demo";

// The focus ring of every place of a path and of its "…" stands whole: no box around it cuts it (DP2, W1b in #4223:
// the path's own clip cut the rings at its edges). The keyboard walks every path of test/v2-path.demo.tsx at 390, 1024
// and 1440 px; each ring (its outline or its outer shadow) must lie inside the clip of every box up to the page (its
// overflow clip or its clip path), in Chromium and WebKit. The path's measured width stays what path.browser.test.ts pins.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let bundle: string;
beforeAll(async () => {
  [bundle, browser] = await Promise.all([demoBundle("../v2-path"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

/** The focused element inside a path: what it is, and each side its ring is cut on, with the box that cuts it. */
const focusedRing = () => {
  const focused = document.activeElement;
  const path = focused?.closest("nav.k2-path");
  if (!(focused instanceof HTMLElement) || !path) return null;
  const style = getComputedStyle(focused);
  // how far the ring reaches out of the element's border box: its outline, or the spread of a shadow that is not inset
  let reach = 0;
  if (style.outlineStyle !== "none") {
    // an `auto` outline paints its own ring of about 2 px however thin its width says
    const width =
      style.outlineStyle === "auto" ? Math.max(2, Number.parseFloat(style.outlineWidth)) : Number.parseFloat(style.outlineWidth);
    reach = Math.max(reach, width + Number.parseFloat(style.outlineOffset));
  }
  for (const shadow of style.boxShadow === "none" ? [] : style.boxShadow.split(/,(?![^(]*\))/)) {
    if (shadow.includes("inset")) continue;
    const lengths = [...shadow.replace(/\([^)]*\)/g, "").matchAll(/(-?[\d.]+)px/g)].map((match) => Number(match[1]));
    const [x = 0, y = 0, blur = 0, spread = 0] = lengths;
    reach = Math.max(reach, Math.max(Math.abs(x), Math.abs(y)) + blur + spread);
  }
  const box = focused.getBoundingClientRect();
  const ring = { left: box.left - reach, right: box.right + reach, top: box.top - reach, bottom: box.bottom + reach };
  const cuts: string[] = [];
  for (let parent = focused.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
    const clips = getComputedStyle(parent);
    const outer = parent.getBoundingClientRect();
    const name = parent.classList[0] ?? parent.tagName.toLowerCase();
    // a clip path `inset(…)` cuts at the border box moved in by its lengths (out where they are negative)
    const inset = /^inset\(([^)]*)\)/.exec(clips.clipPath)?.[1];
    if (inset) {
      const [top = 0, right = top, bottom = top, left = right] = [...inset.matchAll(/(-?[\d.]+)px/g)].map((match) => Number(match[1]));
      if (ring.left < outer.left + left - 0.5) cuts.push(`left by ${name}`);
      if (ring.right > outer.right - right + 0.5) cuts.push(`right by ${name}`);
      if (ring.top < outer.top + top - 0.5) cuts.push(`top by ${name}`);
      if (ring.bottom > outer.bottom - bottom + 0.5) cuts.push(`bottom by ${name}`);
    }
    if (clips.overflowX === "visible" && clips.overflowY === "visible") continue;
    // the clip edge: the padding box, widened by `overflow-clip-margin` where the box clips with `clip`
    const margin =
      clips.overflowX === "clip" || clips.overflowY === "clip" ? Number.parseFloat(clips.getPropertyValue("overflow-clip-margin")) || 0 : 0;
    const edge = {
      left: outer.left + parent.clientLeft - margin,
      top: outer.top + parent.clientTop - margin,
      right: outer.left + parent.clientLeft + parent.clientWidth + margin,
      bottom: outer.top + parent.clientTop + parent.clientHeight + margin,
    };
    if (clips.overflowX !== "visible" && ring.left < edge.left - 0.5) cuts.push(`left by ${name}`);
    if (clips.overflowX !== "visible" && ring.right > edge.right + 0.5) cuts.push(`right by ${name}`);
    if (clips.overflowY !== "visible" && ring.top < edge.top - 0.5) cuts.push(`top by ${name}`);
    if (clips.overflowY !== "visible" && ring.bottom > edge.bottom + 0.5) cuts.push(`bottom by ${name}`);
  }
  const what = focused.closest(".k2-path-fold") ? "…" : (focused.textContent ?? "").slice(0, 12);
  return { at: `${path.getAttribute("aria-label")} › ${what}`, reach, cuts };
};

for (const width of [390, 1024, 1440])
  test(`${width} px: the focus ring of each place of a path and of its "…" stands whole`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(2000);
    const errors = pageErrors(page);
    try {
      await page.setContent(
        `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
      );
      await page.addScriptTag({ content: bundle });
      await page.waitForFunction(() => window.__mounted === true);
      await settled(page);
      const seen: NonNullable<ReturnType<typeof focusedRing>>[] = [];
      const visited = new Set<string>();
      // the keyboard's way through the whole page, once: it ends where it would start again
      for (;;) {
        await page.keyboard.press("Tab");
        await settled(page);
        const key = await page.evaluate(() => {
          const focused = document.activeElement;
          if (!focused || focused === document.body) return "";
          return [...document.querySelectorAll("a, button, input, [tabindex]")].indexOf(focused).toString();
        });
        if (key === "" || visited.has(key)) break;
        visited.add(key);
        const ring = await page.evaluate(focusedRing);
        if (ring) seen.push(ring);
      }
      // the walk reached the places and a "…" that shows; each ring reaches out of its element and stands whole
      expect(seen.length).toBeGreaterThan(5);
      if (width === 390) expect(seen.some((ring) => ring.at.endsWith("…"))).toBe(true);
      expect(seen.filter((ring) => ring.reach <= 0).map((ring) => ring.at)).toEqual([]);
      expect(seen.filter((ring) => ring.cuts.length > 0).map((ring) => `${ring.at}: ${ring.cuts.join(", ")}`)).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);
