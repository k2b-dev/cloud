import { afterAll, beforeAll, expect, test } from "bun:test";
import { launchBrowser, pageErrors, settled } from "../../../../ui/test/browser";
import { buildHarness } from "./image-intake/browser-harness";

const harness = await buildHarness(new URL("./SpeedTestFlow.browser-harness.tsx", import.meta.url));
const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", new URL("../../../../cloud/", import.meta.url).pathname))).default;
// Match the Cloud HTML template: the app stylesheet precedes the shared shell stylesheet.
const [appCss, globalCss] = await Promise.all(
  ["../../styles/app.css", "../../../../cloud/src/styles/global.css"].map(async (path) => {
    const result = await Bun.build({ entrypoints: [new URL(path, import.meta.url).pathname], plugins: [tailwind] });
    if (!result.success) throw new AggregateError(result.logs, "Tools CSS failed");
    return result.outputs[0]!.text();
  }),
);
const assets: Record<string, [string, string]> = {
  "/harness.js": ["text/javascript", harness],
  "/app.css": ["text/css", appCss!],
  "/styles.css": ["text/css", globalCss!],
};
let browser: Awaited<ReturnType<typeof launchBrowser>>;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});
const open = async (scenario: string, width = 390, lang = "de") => {
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  await page.clock.install({ time: new Date("2026-11-07T12:00:00Z") });
  await page.route("https://speedtest.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/")
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/styles.css"></head><body class="k2b-ui"><div id="root"></div><script src="/harness.js"></script></body></html>`,
      });
    const asset = assets[path];
    return asset ? route.fulfill({ contentType: asset[0], body: asset[1] }) : route.fulfill({ status: 404 });
  });
  await page.goto(`https://speedtest.test/?scenario=${scenario}&lang=${lang}`);
  await page.locator(".tools-speedtest").waitFor();
  return page;
};
const geometry = async (page: Awaited<ReturnType<typeof open>>) => {
  await settled(page);
  return page.evaluate(() =>
    [".tools-speedtest-gauge", ".tools-speedtest-status", ".tools-speedtest-chart", ".tools-speedtest-terminal", ".k2b-stat-grid"].map(
      (selector) => {
        const rect = document.querySelector(selector)!.getBoundingClientRect();
        return { selector, x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height };
      },
    ),
  );
};

type Page = Awaited<ReturnType<typeof open>>;

/** The gauge carries the download; each tile carries one other figure, once, without the phase check row. */
const expectResultHierarchy = async (page: Page) => {
  const view = await page.evaluate(() => ({
    gauge: document.querySelector(".tools-speedtest-gauge .stdlib-chart-gauge-value")?.textContent?.trim(),
    gaugeLabel: document.querySelector(".tools-speedtest-gauge .stdlib-chart-gauge-label")?.textContent?.trim(),
    labels: [...document.querySelectorAll(".tools-speedtest .k2b-stat-cell__label")].map((node) => node.textContent?.trim()),
    values: [...document.querySelectorAll(".tools-speedtest .k2b-stat-cell__value")].map((node) => ({
      text: node.textContent?.trim(),
      clipped: node.scrollWidth > node.clientWidth + 1,
    })),
    phaseRows: document.querySelectorAll(".tools-speedtest-phases").length,
    tileHeights: [
      ...new Set(
        [...document.querySelectorAll(".tools-speedtest .k2b-stat-cell")].map((node) => Math.round(node.getBoundingClientRect().height)),
      ),
    ],
    rows: new Set(
      [...document.querySelectorAll(".tools-speedtest .k2b-stat-cell")].map((node) => Math.round(node.getBoundingClientRect().top)),
    ).size,
  }));
  expect(view.gaugeLabel).toContain("Download");
  expect(view.labels).toEqual(["Upload", "Ping", "Jitter", "Latenz unter Last"]);
  expect(view.phaseRows).toBe(0);
  expect(view.tileHeights).toHaveLength(1);
  // Four tiles fill one row on a wide page and two full rows on a phone: no empty slot.
  expect([1, 2]).toContain(view.rows);
  for (const value of view.values) {
    expect(value.clipped).toBe(false);
    expect(value.text).toMatch(/\d (Mbit\/s|ms)$/);
    expect(value.text?.startsWith(`${view.gauge} `)).toBe(false);
  }
};

/** Measured windows end where they were measured: no aggregate cliff, no zero, warmup thin and neutral. */
const expectCleanHistory = async (page: Page) => {
  const history = await page.locator(".tools-speedtest-chart").evaluate((chart) => {
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
    const points = history.points.filter((point) => point.series === series);
    expect(points.length).toBeGreaterThan(2);
    expect(points.every((point) => point.y > 0)).toBe(true);
    // Actual window rates can vary under load. Preserve those readings and their order;
    // a smoothness threshold would reject honest measurements or encourage invented data.
    for (let index = 1; index < points.length; index++) expect(points[index]!.x).toBeGreaterThan(points[index - 1]!.x);
  }
  const download = history.points.filter((point) => point.series === 0);
  const ramp = history.points.filter((point) => point.series === 2);
  expect(ramp.length).toBeGreaterThan(0);
  // Warmup windows come before the first measured window of their phase and never mix into it.
  expect(Math.min(...download.map((point) => point.x))).toBeGreaterThan(Math.min(...ramp.map((point) => point.x)));
  expect(history.ramp).toBeLessThan(history.measured);
};

test("modes stay on one line in German and English, on a phone and a wide page", async () => {
  for (const [lang, width] of [
    ["de", 390],
    ["en", 390],
    ["de", 1440],
    ["en", 1440],
  ] as const) {
    const page = await open("idle", width, lang);
    try {
      const options = await page.locator(".tools-speedtest-mode [role=radio]").evaluateAll((nodes) =>
        nodes.map((node) => ({
          text: node.textContent?.trim(),
          clipped: node.scrollWidth > node.clientWidth + 1,
        })),
      );
      expect(options.map((option) => option.text)).toEqual(
        lang === "de" ? ["Schnell · 14 s", "Genau · 29 s"] : ["Quick · 14 s", "Accurate · 29 s"],
      );
      for (const option of options) expect(option.clipped).toBe(false);
      const tops = await page
        .locator(".tools-speedtest-mode")
        .evaluate(
          (node) =>
            new Set([...node.querySelectorAll("[role=radio]")].map((option) => Math.round(option.getBoundingClientRect().top))).size,
        );
      expect(tops).toBe(1);
      const heights = await page.locator(".tools-speedtest-mode").evaluate((node) => node.getBoundingClientRect().height);
      expect(heights).toBeLessThan(48);
    } finally {
      await page.close();
    }
  }
}, 45_000);

test("real shared-engine run preserves slots, shows remaining time, copies JSON and cancels cleanly", async () => {
  for (const width of [1440, 390]) {
    const page = await open("idle", width);
    try {
      const initial = await geometry(page);
      await page.getByRole("button", { name: "Test starten", exact: true }).click();
      await page.clock.runFor(1_000);
      await settled(page);
      expect(await page.locator('[role="status"]').textContent()).toMatch(/noch ca\. \d+ s/);
      expect(await page.locator(".tools-speedtest-terminal").textContent()).toMatch(/noch ca\. \d+ s/);
      expect(await geometry(page)).toEqual(initial);
      // Ramp-up is excluded from the result and stays neutral, in the plot and in the legend swatch.
      expect(
        await page.locator(".tools-speedtest-chart").evaluate((element) =>
          [
            element,
            element.querySelector(".k2b-chart__svg > svg")!,
            element.querySelector(".k2b-chart__legend .stdlib-chart-series-2")!,
          ].every((node) => {
            const style = getComputedStyle(node);
            return style.getPropertyValue("--stdlib-chart-c3").trim() === style.getPropertyValue("--k2b-text-muted").trim();
          }),
        ),
      ).toBe(true);
      await page.clock.runFor(14_000);
      await settled(page);
      expect(await page.locator(".tools-speedtest").getAttribute("data-state")).toBe("done");
      expect(await geometry(page)).toEqual(initial);
      await expectResultHierarchy(page);
      await expectCleanHistory(page);
      const gaugeFonts = await page.locator(".tools-speedtest-gauge").evaluate((element) =>
        [...element.querySelectorAll<SVGTextElement>("text")].map((text) => ({
          value: text.classList.contains("stdlib-chart-gauge-value"),
          pixels: parseFloat(getComputedStyle(text).fontSize) * (text.getScreenCTM()?.a ?? 0),
        })),
      );
      expect(gaugeFonts.every((font) => font.pixels >= (font.value ? 48 : 12))).toBe(true);
      expect(await page.locator(".stdlib-chart-gauge-unit").first().textContent()).toBe("0");
      await page.getByRole("button", { name: "--json", exact: true }).click();
      expect(await page.locator(".tools-speedtest-terminal").textContent()).toContain('"loaded_latency_ms"');
      expect(await page.getByRole("button", { name: "Ergebnis kopieren", exact: true }).isEnabled()).toBe(true);
      await page.getByRole("button", { name: "Fortschritt", exact: true }).click();
      await page.getByRole("button", { name: "Erneut testen", exact: true }).click();
      await page.clock.runFor(250);
      await page.getByRole("button", { name: "Stoppen", exact: true }).click();
      await page.clock.runFor(250);
      expect(await page.locator(".tools-speedtest").getAttribute("data-state")).toBe("cancelled");
      expect(await geometry(page)).toEqual(initial);
      expect(await page.locator(".k2b-stat-cell__value").first().textContent()).toBe("–");
      expect(await page.locator(".tools-speedtest-terminal").textContent()).toContain("Download: — Mbit/s");
      expect(await page.locator(".tools-speedtest-gauge").getAttribute("data-empty")).toBe("true");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally {
      await page.close();
    }
  }
}, 60_000);

test("offline, disabled, network retry and 429 keep feedback visible and controls recover", async () => {
  for (const scenario of ["offline", "disabled", "error", "retry", "429"]) {
    const page = await open(scenario);
    try {
      await page.clock.runFor(1_000);
      const state = await page.locator(".tools-speedtest").getAttribute("data-state");
      expect(state).toBe(scenario === "offline" || scenario === "disabled" ? scenario : "error");
      expect((await page.locator('[role="status"]').textContent())!.length).toBeGreaterThan(15);
      const button = page.locator(".tools-speedtest-start");
      if (["offline", "disabled", "429"].includes(scenario)) expect(await button.isDisabled()).toBe(true);
      else expect(await button.isEnabled()).toBe(true);
      if (scenario === "429") {
        expect(await page.locator('[role="status"]').textContent()).toContain("Testlimit erreicht");
        expect(await page.locator('[role="status"]').getAttribute("class")).not.toContain("speedtest-danger");
        expect(await page.locator(".tools-speedtest-chart .k2b-chart__empty").count()).toBe(1);
        expect(await page.locator(".k2b-stat-cell__value").first().textContent()).toBe("–");
        await page.clock.runFor(3_000);
        expect(await button.isEnabled()).toBe(true);
      }
      if (scenario === "disabled" || scenario === "offline") {
        expect(await page.locator(".tools-speedtest-terminal").textContent()).not.toContain("Bereit zur Messung");
      }
      if (scenario === "retry") {
        await button.click();
        await page.clock.runFor(1_000);
        expect(await page.locator(".tools-speedtest").getAttribute("data-state")).toBe("download");
      }
    } finally {
      await page.close();
    }
  }
}, 45_000);

test("finished tests fit their actual time span and leave an unwrapped complete terminal in fixed slots", async () => {
  for (const width of [1440, 390]) {
    const page = await open("public", width);
    try {
      const initial = await geometry(page);
      const expectTimeLabelsInside = async () => {
        await settled(page);
        const bounds = await page.locator(".tools-speedtest-chart .stdlib-chart-tick-label").evaluateAll((ticks) => {
          const labels = ticks.filter((tick) => tick.textContent?.endsWith(" s"));
          const svg = labels[0]!.closest("svg")!.getBoundingClientRect();
          return labels.map((label, index) => {
            const rect = label.getBoundingClientRect();
            return {
              inside: rect.left >= svg.left && rect.right <= svg.right,
              separate: index === 0 || rect.left >= labels[index - 1]!.getBoundingClientRect().right,
            };
          });
        });
        expect(bounds.length).toBeGreaterThan(1);
        expect(bounds.every((label) => label.inside && label.separate)).toBe(true);
      };
      const axisEnd = async () =>
        page.locator(".tools-speedtest-chart .stdlib-chart-tick-label").evaluateAll((ticks) =>
          Math.max(
            ...ticks
              .map((tick) => tick.textContent ?? "")
              .filter((text) => text.endsWith(" s"))
              .map((text) => Number(text.replace(" s", "").replace(",", "."))),
          ),
        );
      await page.getByRole("button", { name: "Test starten", exact: true }).click();
      await page.clock.runFor(2_000);
      await settled(page);
      expect(await axisEnd()).toBe(14);
      expect(await page.locator(".tools-speedtest-eta").evaluate((node) => getComputedStyle(node).visibility)).toBe("visible");
      await page.clock.runFor(13_000);
      await settled(page);
      expect(await page.locator(".tools-speedtest").getAttribute("data-state")).toBe("done");
      expect(await geometry(page)).toEqual(initial);
      const end = await axisEnd();
      expect(end).toBeLessThan(14);
      await expectTimeLabelsInside();
      expect(await page.locator(".tools-speedtest-eta").evaluate((node) => getComputedStyle(node).visibility)).toBe("hidden");
      expect(await page.getByRole("progressbar").count()).toBe(0);
      const terminal = await page.locator(".tools-speedtest-terminal").evaluate((node) => ({
        whiteSpace: getComputedStyle(node).whiteSpace,
        verticalOverflow: node.scrollHeight > node.clientHeight,
        horizontalOverflow: node.scrollWidth > node.clientWidth,
        text: node.textContent,
      }));
      expect(terminal.whiteSpace).toBe("pre");
      expect(terminal.verticalOverflow).toBe(false);
      if (width === 390) expect(terminal.horizontalOverflow).toBe(true);
      expect(terminal.text).toContain("Fertig nach");
      await page.getByRole("button", { name: "--json", exact: true }).click();
      const duration = await page.locator(".tools-speedtest-terminal").evaluate((node) => {
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

test("delayed browser callbacks keep every plotted sample inside the fixed time axis", async () => {
  const page = await open("delayed");
  const errors = pageErrors(page);
  try {
    await page.clock.runFor(15_000);
    expect(await page.locator(".tools-speedtest").getAttribute("data-state")).toBe("error");
    expect(await page.getByRole("button", { name: "Ergebnis kopieren", exact: true }).isDisabled()).toBe(true);
    expect(errors).toEqual([]);
    expect(await page.locator(".tools-speedtest-chart .k2b-chart__svg > svg").count()).toBe(1);
  } finally {
    await page.close();
  }
}, 30_000);

test("verification keeps the countdown and slots while the public terminal starts with Node", async () => {
  const publicPage = await open("public");
  try {
    expect(await publicPage.locator(".tools-speedtest-terminal").textContent()).toContain("node speedtest.mjs");
  } finally {
    await publicPage.close();
  }
  const page = await open("verify");
  try {
    const initial = await geometry(page);
    await page.clock.runFor(7_750);
    expect(await page.locator(".tools-speedtest").getAttribute("data-state")).toBe("verify");
    expect(await page.locator('[role="status"]').textContent()).toContain("Ergebnis wird geprüft");
    expect(await page.locator('[role="status"]').textContent()).toMatch(/noch ca\. [1-9]\d* s/);
    expect(await geometry(page)).toEqual(initial);
    await page.clock.runFor(2_000);
    expect(await page.locator(".tools-speedtest").getAttribute("data-state")).toBe("done");
    expect(await page.getByRole("button", { name: "Ergebnis kopieren", exact: true }).isEnabled()).toBe(true);
  } finally {
    await page.close();
  }
}, 30_000);
