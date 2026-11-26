import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { appHostCss } from "../../../../ui/test/app-host-fixture";
import { launchBrowser, pageErrors, settled } from "../../../../ui/test/browser";
import { buildHarness } from "./image-intake/browser-harness";

// The speed test of Tools on v2 (the shared `@k2b/speedtest/pane` in the Tools frame), driven by the real engine
// against deterministic network fixtures and a test clock.
type Browser = Awaited<ReturnType<typeof launchBrowser>>;
type Page = Awaited<ReturnType<Browser["newPage"]>>;
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  const harness = await buildHarness(new URL("./SpeedTestFlow.browser-harness.tsx", import.meta.url));
  const styles = await appHostCss(resolve(import.meta.dir, "../../styles/app.css"));
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/styles.css") return new Response(styles, { headers: { "Content-Type": "text/css" } });
      if (url.pathname === "/entry.js")
        return new Response(harness, { headers: { "Content-Type": "application/javascript; charset=utf-8" } });
      return new Response(
        `<!doctype html><html lang="de" class="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body class="k2b-ui" style="margin:0;height:100vh"><div id="app" class="k2-ui" style="display:flex;height:100%"></div><script src="/entry.js"></script></body></html>`,
        { headers: { "Content-Type": "text/html" } },
      );
    },
  });
  browser = await launchBrowser();
}, 90_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop(true);
});

const open = async (scenario: string, width = 390, lang = "de") => {
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  await page.clock.install({ time: new Date("2026-11-07T12:00:00Z") });
  await page.goto(`${server.url.href}?scenario=${scenario}&lang=${lang}`);
  await page.locator('[data-k2-part="Pane"]').first().waitFor();
  return page;
};

const lead = (page: Page) => page.locator('[data-k2-part="StatusRow"] .k2-status-lead').textContent();
const history = (page: Page) => page.getByRole("group", { name: "Verlauf", exact: true });
const terminal = (page: Page) => page.getByRole("group", { name: "Messfortschritt", exact: true }).locator("pre");
const start = (page: Page) => page.getByRole("button", { name: /^(Test starten|Erneut testen|Stoppen)$/ });
const cellValues = (page: Page) => page.locator('[data-k2-part="Cells.Cell"] .k2-cell-value').allTextContents();
// k2b-ui gap: a Section head action on the phone hides its words with display:none and so loses its accessible name
// (v2.css `.k2-pane:not([data-side]) .k2-sh .k2-btn-label`); until it keeps them as hidden text, find it by its text.
const sectionAction = (page: Page, text: string) => page.locator('[data-k2-part="Section"] button').filter({ hasText: text });

/** Every region keeps its place and size while the measurement runs, stops or ends. */
const geometry = async (page: Page) => {
  await settled(page);
  return page.evaluate(() =>
    [
      '[data-k2-part="StatusRow"]',
      '[data-k2-part="Canvas"]',
      '[data-k2-part="Cells"]',
      '[data-k2-part="Progress"] .k2-progress-track',
    ].flatMap((selector) =>
      [...document.querySelectorAll(selector)].map((node) => {
        const rect = node.getBoundingClientRect();
        return { selector, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }),
    ),
  );
};

/** Four cells, each with one figure and its unit, none cut; the gauge carries the phase being measured. */
const expectResultHierarchy = async (page: Page) => {
  const view = await page.evaluate(() => ({
    labels: [...document.querySelectorAll('[data-k2-part="Cells.Cell"] .k2-cell-label')].map((node) => node.textContent?.trim()),
    values: [...document.querySelectorAll('[data-k2-part="Cells.Cell"] .k2-cell-value')].map((node) => ({
      text: node.textContent?.trim(),
      clipped: node.scrollWidth > node.clientWidth + 1,
    })),
  }));
  expect(view.labels).toEqual(["Download", "Upload", "Ping", "Latenz unter Last"]);
  for (const value of view.values) {
    expect(value.clipped).toBe(false);
    expect(value.text).toMatch(/\d (Mbit\/s|ms)$/);
  }
};

/** Measured windows end where they were measured: no aggregate cliff, no zero, warmup thin. */
const expectCleanHistory = async (page: Page) => {
  const result = await history(page).evaluate((chart) => {
    const points = [...chart.querySelectorAll<SVGElement>("[data-chart-datum]")]
      .map(
        (node) =>
          JSON.parse(node.getAttribute("data-chart-datum")!) as {
            role: string;
            seriesIndex?: number;
            values: { key: string; value: unknown }[];
          },
      )
      .filter((datum) => datum.role === "point")
      .map((datum) => ({
        series: datum.seriesIndex ?? 0,
        x: Number(datum.values.find((field) => field.key === "x")!.value),
        y: Number(datum.values.find((field) => field.key === "y")!.value),
      }));
    const stroke = (index: number) =>
      parseFloat(getComputedStyle(chart.querySelector(`.stdlib-chart-line.stdlib-chart-series-${index}`)!).strokeWidth);
    return { points, measured: stroke(0), ramp: stroke(2) };
  });
  for (const series of [0, 1]) {
    const points = result.points.filter((point) => point.series === series);
    expect(points.length).toBeGreaterThan(2);
    expect(points.every((point) => point.y > 0)).toBe(true);
    for (let index = 1; index < points.length; index++) expect(points[index]!.x).toBeGreaterThan(points[index - 1]!.x);
  }
  const download = result.points.filter((point) => point.series === 0);
  const ramp = result.points.filter((point) => point.series === 2);
  expect(ramp.length).toBeGreaterThan(0);
  expect(Math.min(...download.map((point) => point.x))).toBeGreaterThan(Math.min(...ramp.map((point) => point.x)));
  expect(result.ramp).toBeLessThanOrEqual(result.measured);
};

const axisEnd = (page: Page) =>
  history(page)
    .locator(".stdlib-chart-tick-label")
    .evaluateAll((ticks) =>
      Math.max(
        ...ticks
          .map((tick) => tick.textContent ?? "")
          .filter((text) => text.endsWith(" s"))
          .map((text) => Number(text.replace(" s", "").replace(",", "."))),
      ),
    );

test("the durations read in full in German and English, on a phone and a wide page", async () => {
  for (const [lang, width] of [
    ["de", 390],
    ["en", 390],
    ["de", 1440],
    ["en", 1440],
  ] as const) {
    const page = await open("idle", width, lang);
    try {
      const options = await page
        .locator('[role="radiogroup"]')
        .first()
        .locator('input[type="radio"]')
        .evaluateAll((nodes) =>
          nodes.map((node) => {
            const text = node.closest("label")!.querySelector<HTMLElement>(".k2-choice-text")!;
            return { text: text.textContent?.trim(), clipped: text.scrollWidth > text.clientWidth + 1 };
          }),
        );
      expect(options).toEqual(
        (lang === "de" ? ["Schnell · 14 s", "Genau · 29 s"] : ["Quick · 14 s", "Accurate · 29 s"]).map((text) => ({
          text,
          clipped: false,
        })),
      );
    } finally {
      await page.close();
    }
  }
}, 45_000);

test("a run keeps every region in place, counts down, copies JSON and stops cleanly", async () => {
  for (const width of [1440, 390]) {
    const page = await open("idle", width);
    const errors = pageErrors(page);
    try {
      const initial = await geometry(page);
      expect(await lead(page)).toBe("Bereit zur Messung");
      await page.getByRole("button", { name: "Test starten", exact: true }).click();
      await page.clock.runFor(1_000);
      await settled(page);
      expect(await lead(page)).toMatch(/noch ca\. \d+ s/);
      expect(await terminal(page).textContent()).toMatch(/noch ca\. \d+ s/);
      expect(await geometry(page)).toEqual(initial);
      await page.clock.runFor(14_000);
      await settled(page);
      expect(await lead(page)).toMatch(/^Fertig nach/);
      expect(await geometry(page)).toEqual(initial);
      await expectResultHierarchy(page);
      await expectCleanHistory(page);
      await sectionAction(page, "--json").click();
      expect(await terminal(page).textContent()).toContain('"loaded_latency_ms"');
      expect(await sectionAction(page, "Ergebnis kopieren").isEnabled()).toBe(true);
      await sectionAction(page, "Fortschritt").click();
      await page.getByRole("button", { name: "Erneut testen", exact: true }).click();
      await page.clock.runFor(250);
      await page.getByRole("button", { name: "Stoppen", exact: true }).click();
      await page.clock.runFor(250);
      await settled(page);
      expect(await lead(page)).toBe("Messung gestoppt. Du kannst sie erneut starten.");
      expect(await geometry(page)).toEqual(initial);
      expect((await cellValues(page))[0]).toBe("— Mbit/s");
      expect(await terminal(page).textContent()).toContain("Download: — Mbit/s");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }
}, 60_000);

test("offline, disabled, network failure, retry and the test limit say why and the start recovers", async () => {
  for (const scenario of ["offline", "disabled", "error", "retry", "429"]) {
    const page = await open(scenario);
    try {
      await page.clock.runFor(1_000);
      await settled(page);
      const text = (await lead(page))!;
      expect(text.length).toBeGreaterThan(15);
      if (scenario === "offline") expect(text).toBe("Du bist offline. Verbinde dich und versuche es erneut.");
      if (scenario === "disabled") expect(text).toBe("Der Betreiber hat Speedtests für diese Cloud-Installation deaktiviert.");
      // a failed measurement names its reason in a notice; the test limit is a wait, not a failure
      expect(await page.locator('[data-k2-part="Notice"]').count()).toBe(scenario === "error" || scenario === "retry" ? 1 : 0);
      const button = start(page);
      if (["offline", "disabled", "429"].includes(scenario)) expect(await button.isDisabled()).toBe(true);
      else expect(await button.isEnabled()).toBe(true);
      if (scenario === "429") {
        expect(text).toContain("Testlimit erreicht");
        expect(await history(page).locator('[data-k2-part="Empty"]').count()).toBe(1);
        expect((await cellValues(page))[0]).toBe("— Mbit/s");
        await page.clock.runFor(3_000);
        expect(await button.isEnabled()).toBe(true);
      }
      if (scenario === "disabled" || scenario === "offline") expect(await terminal(page).textContent()).not.toContain("Bereit zur Messung");
      if (scenario === "retry") {
        await button.click();
        await page.clock.runFor(1_000);
        expect(await lead(page)).toContain("Download wird gemessen");
      }
    } finally {
      await page.close();
    }
  }
}, 45_000);

test("a finished test fits its actual time span and leaves the whole result in the terminal", async () => {
  for (const width of [1440, 390]) {
    const page = await open("idle", width);
    try {
      const initial = await geometry(page);
      await page.getByRole("button", { name: "Test starten", exact: true }).click();
      await page.clock.runFor(2_000);
      await settled(page);
      expect(await axisEnd(page)).toBe(14);
      await page.clock.runFor(13_000);
      await settled(page);
      expect(await lead(page)).toMatch(/^Fertig nach/);
      expect(await geometry(page)).toEqual(initial);
      const end = await axisEnd(page);
      expect(end).toBeLessThan(14);
      const labels = await history(page)
        .locator(".stdlib-chart-tick-label")
        .evaluateAll((ticks) => {
          const times = ticks.filter((tick) => tick.textContent?.endsWith(" s"));
          const svg = times[0]!.closest("svg")!.getBoundingClientRect();
          return times.map((label, index) => {
            const rect = label.getBoundingClientRect();
            return {
              inside: rect.left >= svg.left && rect.right <= svg.right,
              separate: index === 0 || rect.left >= times[index - 1]!.getBoundingClientRect().right,
            };
          });
        });
      expect(labels.length).toBeGreaterThan(1);
      expect(labels.every((label) => label.inside && label.separate)).toBe(true);
      const output = await terminal(page).evaluate((node) => ({
        horizontalOverflow: node.scrollWidth > node.clientWidth,
        text: node.textContent,
      }));
      expect(output.horizontalOverflow).toBe(false);
      expect(output.text).toContain("Fertig nach");
      await sectionAction(page, "--json").click();
      const duration = await terminal(page).evaluate((node) => {
        const text = node.textContent!;
        return JSON.parse(text.slice(text.indexOf("{\n"))).duration_ms / 1_000;
      });
      expect(Math.abs(end - duration)).toBeLessThanOrEqual(0.05);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally {
      await page.close();
    }
  }
}, 45_000);

test("delayed browser callbacks end in a named failure without a page error", async () => {
  const page = await open("delayed");
  const errors = pageErrors(page);
  try {
    await page.clock.runFor(15_000);
    expect(await lead(page)).toBe("Der Server antwortet zu langsam. Versuche es erneut.");
    expect(await page.locator('[data-k2-part="Notice"]').count()).toBe(1);
    expect(await sectionAction(page, "Ergebnis kopieren").isDisabled()).toBe(true);
    expect(errors).toEqual([]);
    expect(await history(page).locator(".k2b-chart__svg > svg").count()).toBe(1);
  } finally {
    await page.close();
  }
}, 30_000);

test("the check of the result keeps the countdown and the regions; the terminal starts with the Cloud CLI", async () => {
  const page = await open("verify");
  try {
    const initial = await geometry(page);
    expect(await terminal(page).textContent()).toContain("cld tools speedtest --server 'https://speedtest.k2b.dev' --mode quick");
    await page.clock.runFor(7_750);
    await settled(page);
    expect(await lead(page)).toContain("Ergebnis wird geprüft");
    expect(await lead(page)).toMatch(/noch ca\. [1-9]\d* s/);
    expect(await geometry(page)).toEqual(initial);
    await page.clock.runFor(2_000);
    await settled(page);
    expect(await lead(page)).toMatch(/^Fertig nach/);
    expect(await sectionAction(page, "Ergebnis kopieren").isEnabled()).toBe(true);
  } finally {
    await page.close();
  }
}, 30_000);
