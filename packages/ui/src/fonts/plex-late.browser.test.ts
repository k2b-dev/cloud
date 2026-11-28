import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";

// The built Plex preset (dist/plex.css) in a real engine, preloaded as Cloud preloads it (packages/cloud font-preloads):
// a face that arrives after the first frame changes no width, so the head's buttons never move (S2: the dashboard's
// buttons got 11 px narrower once, when Plex replaced the fallback); a face that is there in time is the one the page
// shows.

const dist = resolve(import.meta.dir, "../../dist");
const preset = readFileSync(resolve(dist, "plex.css"), "utf8");
const css = readFileSync(resolve(import.meta.dir, "../v2/v2.css"), "utf8");
const preloads = ["400", "500", "600"]
  .map((weight) => {
    const file = new RegExp(`url\\(\\./fonts/(ibm-plex-sans-latin-${weight}-normal-[0-9a-f]+\\.woff2)\\)`).exec(preset)![1];
    return `<link rel="preload" href="/fonts/${file}" as="font" type="font/woff2" crossorigin>`;
  })
  .join("");
const labels = ["Teilen", "Exportieren", "Bearbeiten", "Neues Widget"];
const html = `<!doctype html><html lang="de"><head><meta charset="utf-8">${preloads}<link rel="stylesheet" href="/plex.css"><style>${css}</style></head><body class="k2-ui"><div style="display: flex; gap: 8px; padding: 16px">${labels.map((label, index) => `<button class="k2-btn"${index === labels.length - 1 ? ' data-variant="primary"' : ""}>${label}</button>`).join("")}</div></body></html>`;
const origin = "http://fonts.test";

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

/** Serves the page; the faces wait for `fonts` (a promise that never settles holds them, `null` refuses them). */
const open = async (fonts: Promise<void> | null, run: (page: Page, served: Promise<void>) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width: 1024, height: 400 } });
  page.setDefaultTimeout(5000);
  const errors = pageErrors(page);
  let served = 0;
  let allServed = () => {};
  // the three preloaded Latin faces of Plex Sans
  const preloaded = new Promise<void>((resolve) => {
    allServed = resolve;
  });
  try {
    await page.route(`${origin}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/") return route.fulfill({ contentType: "text/html", body: html });
      if (path === "/plex.css") return route.fulfill({ contentType: "text/css", body: preset.replaceAll("./fonts/", "/fonts/") });
      if (!path.startsWith("/fonts/") || fonts === null) return route.abort();
      await fonts;
      await route.fulfill({ contentType: "font/woff2", body: readFileSync(resolve(dist, "fonts", basename(path))) });
      if (++served >= 3) allServed();
    });
    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
    // two frames painted (settled would wait for the faces that the first test holds back)
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    await run(page, preloaded);
    if (fonts !== null) expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

const widths = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".k2-btn")].map((button) => button.getBoundingClientRect().width));

test("a Plex face that arrives after the first frame changes no button's width", async () => {
  let release = () => {};
  const late = new Promise<void>((resolve) => {
    release = resolve;
  });
  await open(late, async (page, served) => {
    const first = await widths(page);
    // fixed wait: the faces must arrive well after the first frame, as on a slow first visit
    await page.waitForTimeout(1000);
    release();
    await served;
    await page.evaluate(() => document.fonts.ready);
    await settled(page);
    const after = await widths(page);
    expect(after.map((width, index) => (Math.abs(width - first[index]!) <= 0.5 ? "same" : `${first[index]} -> ${width}`))).toEqual(
      labels.map(() => "same"),
    );
  });
}, 30_000);

test("a Plex face that is there in time is the one the buttons show", async () => {
  let fallback: number[] = [];
  await open(null, async (page) => {
    fallback = await widths(page);
  });
  await open(Promise.resolve(), async (page) => {
    await page.evaluate(() => document.fonts.ready);
    await settled(page);
    const plex = await widths(page);
    // Plex sets these words narrower than the fallback; equal widths would mean the face was not used
    expect(plex.some((width, index) => Math.abs(width - fallback[index]!) > 1)).toBe(true);
  });
}, 30_000);
