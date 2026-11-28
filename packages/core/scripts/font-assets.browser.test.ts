import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../ui/test/browser";
import { plexPreloads } from "../../ui/test/plex-preloads";
import { buildFontAssets } from "./font-assets";

// The `fonts.css` Core serves, in a real engine, with the Latin Plex Sans faces preloaded as Cloud's page head preloads
// them (packages/cloud font-preloads). A face that arrives after the first frame changes no width, so a head's buttons
// never move (S2: the dashboard's buttons got 11 px narrower once, when Plex replaced the fallback). A face that is
// there in time is the one the page shows.

const v2 = await readFile(resolve(import.meta.dir, "../../ui/src/v2/v2.css"), "utf8");
const labels = ["Teilen", "Exportieren", "Bearbeiten", "Neues Widget"];
const origin = "http://fonts.test";

let output: string | undefined;
let fonts = "";
let html = "";
let browser: Browser;
beforeAll(async () => {
  output = await mkdtemp(join(tmpdir(), "cloud-plex-late-"));
  await buildFontAssets(output);
  fonts = await readFile(join(output, "fonts.css"), "utf8");
  const buttons = labels.map(
    (label, index) => `<button class="k2-btn"${index === labels.length - 1 ? ' data-variant="primary"' : ""}>${label}</button>`,
  );
  html = `<!doctype html><html lang="de"><head><meta charset="utf-8">${plexPreloads("/public/fonts/").links}<link rel="stylesheet" href="/public/fonts.css"><style>${v2}</style></head><body class="k2-ui"><div style="display: flex; gap: 8px; padding: 16px">${buttons.join("")}</div></body></html>`;
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    if (output) await rm(output, { recursive: true, force: true });
  }
});

test("every face Core serves is optional; the @k2b/ui preset keeps swap for apps that do not preload", async () => {
  const faces = fonts.match(/@font-face\s*\{[^}]*\}/g) ?? [];
  expect(faces.length).toBeGreaterThan(40);
  expect(faces.filter((face) => !/font-display:\s*optional/.test(face))).toEqual([]);
  const preset = await readFile(fileURLToPath(import.meta.resolve("@k2b/ui/fonts/plex.css")), "utf8");
  expect(preset).toContain("font-display:swap");
});

/** Serves the page; the faces wait for `held` (a promise that never settles holds them, `null` refuses them). */
const open = async (held: Promise<void> | null, run: (page: Page, served: Promise<void>) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width: 1024, height: 400 } });
  page.setDefaultTimeout(5000);
  const errors = pageErrors(page);
  let count = 0;
  let allServed = () => {};
  // the three preloaded Latin faces of Plex Sans
  const served = new Promise<void>((resolve) => {
    allServed = resolve;
  });
  try {
    await page.route(`${origin}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/") return route.fulfill({ contentType: "text/html", body: html });
      if (path === "/public/fonts.css") return route.fulfill({ contentType: "text/css", body: fonts });
      if (!path.startsWith("/public/fonts/") || held === null) return route.abort();
      await held;
      await route.fulfill({ contentType: "font/woff2", body: await readFile(join(output!, "fonts", basename(path))) });
      if (++count >= 3) allServed();
    });
    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
    // settled: two painted frames are the first frame; settled would wait for the faces the first test holds back
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    await run(page, served);
    if (held !== null) expect(errors).toEqual([]);
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
    // settled: the first frame, painted in the fallback while the faces are held, is the subject
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
    await settled(page);
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
