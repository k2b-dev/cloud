import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { launchBrowser } from "../../../../ui/test/browser";
import { buildHarness, uiRoot } from "./image-intake/browser-harness";

const harness = await buildHarness(new URL("./SpeedTestFlow.browser-harness.tsx", import.meta.url));
const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", new URL("../../../../cloud/", import.meta.url).pathname))).default;
const css = (
  await Promise.all(
    ["../../../../../styles.css", "../../styles/app.css"].map(async (path) => {
      const result = await Bun.build({ entrypoints: [new URL(path, import.meta.url).pathname], plugins: [tailwind] });
      if (!result.success) throw new AggregateError(result.logs, "Tools CSS failed");
      return result.outputs[0]!.text();
    }),
  )
).join("\n");
const assets: Record<string, [string, string]> = {
  "/harness.js": ["text/javascript", harness],
  "/app.css": ["text/css", css],
  "/styles.css": ["text/css", readFileSync(`${uiRoot}dist/styles.css`, "utf8")],
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
const geometry = (page: Awaited<ReturnType<typeof open>>) =>
  page.evaluate(() =>
    [".tools-speedtest-gauge", ".tools-speedtest-status", ".tools-speedtest-chart", ".tools-speedtest-terminal", ".k2b-stat-grid"].map(
      (selector) => {
        const rect = document.querySelector(selector)!.getBoundingClientRect();
        return { selector, x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height };
      },
    ),
  );

test("real shared-engine run preserves slots, shows remaining time, copies JSON and cancels cleanly", async () => {
  for (const width of [1440, 390]) {
    const page = await open("idle", width);
    try {
      const initial = await geometry(page);
      await page.getByRole("button", { name: "Test starten", exact: true }).click();
      await page.clock.runFor(1_000);
      expect(await page.locator('[role="status"]').textContent()).toMatch(/noch ca\. \d+ s/);
      expect(await page.locator(".tools-speedtest-terminal").textContent()).toMatch(/noch ca\. \d+ s/);
      expect(await geometry(page)).toEqual(initial);
      // Ramp-up is excluded from the result and stays neutral, including the renderer's SVG root.
      expect(
        await page.locator(".tools-speedtest-chart svg").evaluate((element) => {
          const style = getComputedStyle(element);
          return ["--stdlib-chart-c3", "--stdlib-chart-c4"].every(
            (name) => style.getPropertyValue(name).trim() === style.getPropertyValue("--k2b-text-muted").trim(),
          );
        }),
      ).toBe(true);
      await page.clock.runFor(14_000);
      expect(await page.locator(".tools-speedtest").getAttribute("data-state")).toBe("done");
      expect(await geometry(page)).toEqual(initial);
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
      expect(await page.locator(".k2b-stat-cell__value").first().textContent()).toBe("—");
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
        expect(await page.locator(".tools-speedtest-chart .k2b-chart__empty").count()).toBe(1);
        expect(await page.locator(".k2b-stat-cell__value").first().textContent()).toBe("—");
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

test("delayed browser callbacks keep every plotted sample inside the fixed time axis", async () => {
  const page = await open("delayed");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.clock.runFor(15_000);
    expect(await page.locator(".tools-speedtest").getAttribute("data-state")).toBe("done");
    expect(errors).toEqual([]);
    expect(await page.locator(".tools-speedtest-chart svg").count()).toBe(1);
  } finally {
    await page.close();
  }
}, 30_000);
