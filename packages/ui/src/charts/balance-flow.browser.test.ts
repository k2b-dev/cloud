import { expect, test } from "bun:test";
import { launchBrowser, pageErrors, settled } from "../../test/browser";
import { balanceFlowPage, balanceFlowSpec as spec } from "../../test/charts/balance-flow-page";
import { renderBalanceFlowSvg } from "./core/balance-flow";

test("BalanceFlow SSR, continuity, inspection, phone rows and real state boxes", async () => {
  const { html, bundle } = await balanceFlowPage();
  const browser = await launchBrowser();
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 }, hasTouch: true });
      try {
        const errors = pageErrors(page);
        await page.setContent(html);
        await settled(page);
        const svg = page.locator("#mount .k2b-chart__svg > svg"),
          frame = page.locator("#mount [data-balance-flow]");
        const before = await svg.evaluate((e) => e.outerHTML);
        const documentBox = (element: Element) => {
          const b = element.getBoundingClientRect();
          return { x: b.x + window.scrollX, y: b.y + window.scrollY, width: b.width, height: b.height };
        };
        const box = await frame.evaluate(documentBox);
        await page.locator("#mount").evaluate((e) => e.replaceChildren());
        await page.addScriptTag({ content: bundle });
        await settled(page);
        expect(await svg.evaluate((e) => e.outerHTML)).toBe(before);
        expect(await frame.evaluate(documentBox)).toEqual(box);
        expect(await frame.locator('[data-balance-step="-1"]').isDisabled()).toBe(true);
        const chart = frame.locator(".k2b-chart");
        if (width === 1440) {
          const band = chart.locator(".k2b-balance-flow-band").first();
          const opacity = await band.evaluate((e) => getComputedStyle(e).fillOpacity);
          await chart.locator('[data-balance-key="in-0"]').hover();
          await settled(page);
          expect(await chart.locator('[role="tooltip"]').textContent()).toContain("Marketplace orders");
          expect(await band.evaluate((e) => getComputedStyle(e).fillOpacity)).toBe(opacity);
          for (const name of ["Refunds", "Shipping labels"]) {
            const caption = chart.locator(".k2b-balance-flow-caption text").filter({ hasText: name }).first();
            expect(await caption.isVisible()).toBe(true);
          }
          expect(await chart.locator(".k2b-balance-flow-caption").count()).toBe(await chart.locator("[data-balance-key]").count());
          expect(await frame.evaluate(documentBox)).toEqual(box);
          await page.mouse.move(1, 1);
          await settled(page);
        }
        await chart.focus();
        await page.keyboard.press("Home");
        await settled(page);
        expect(await chart.locator("[data-inspected]").count()).toBe(1);
        const opacity = await chart
          .locator(".k2b-balance-flow-band")
          .first()
          .evaluate((e) => getComputedStyle(e).fillOpacity);
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Enter");
        await settled(page);
        expect(await chart.locator("[data-selected] > rect").evaluate((e) => getComputedStyle(e).strokeWidth)).toBe("2.5px");
        expect(
          await chart
            .locator(".k2b-balance-flow-band")
            .first()
            .evaluate((e) => getComputedStyle(e).fillOpacity),
        ).toBe(opacity);
        await page.keyboard.press("Escape");
        await settled(page);
        const old = await chart.locator('[data-balance-key="closing"]').evaluate((e) => ({
          fill: getComputedStyle(e).fill,
          value: JSON.parse(e.parentElement!.getAttribute("data-chart-datum")!).values.find((v: { key: string }) => v.key === "value")
            .value,
        }));
        await frame.evaluate((e) => e.style.setProperty("--k2b-motion-base", "0.24s"));
        await settled(page);
        // settled: Observe the running continuity animation in the same frame as the navigation key.
        const continuity = await chart.evaluate((e) => {
          e.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
          const rect = e.querySelector('[data-balance-key="opening"]');
          return {
            running: rect
              ?.getAnimations()
              .some((a) => (a.effect as KeyframeEffect).getKeyframes().some((k) => String(k.transform).includes("translate"))),
            duration: rect?.getAnimations()[0]?.effect?.getTiming().duration,
          };
        });
        expect(continuity.running).toBe(true);
        expect(continuity.duration).toBe(240);
        await settled(page);
        expect(await frame.getAttribute("data-period")).toBe("1");
        const opening = chart.locator('[data-balance-key="opening"]');
        expect(await opening.evaluate((e) => getComputedStyle(e).fill)).toBe(old.fill);
        expect(
          await opening.evaluate(
            (e) =>
              JSON.parse(e.parentElement!.getAttribute("data-chart-datum")!).values.find((v: { key: string }) => v.key === "value").value,
          ),
        ).toBe(old.value);
        await page.evaluate(() =>
          Promise.all(
            document
              .getAnimations()
              .filter((a) => a.timeline === document.timeline)
              .map((a) => a.finished.catch(() => {})),
          ),
        );
        await settled(page);
        expect(await frame.evaluate(documentBox)).toEqual(box);
        await page.emulateMedia({ reducedMotion: "reduce" });
        await frame.locator('[data-balance-step="1"]').click();
        await settled(page);
        expect(await frame.getAttribute("data-period")).toBe("2");
        expect(await frame.locator('[data-balance-step="1"]').isDisabled()).toBe(true);
        expect(await page.evaluate(() => document.getAnimations().filter((a) => a.timeline === document.timeline).length)).toBe(0);
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await page.locator("html").evaluate((e) => (e.dataset.k2bMotion = "reduced"));
        await frame.locator('[data-balance-step="-1"]').click();
        await settled(page);
        expect(await page.evaluate(() => document.getAnimations().filter((a) => a.timeline === document.timeline).length)).toBe(0);
        await page.locator("html").evaluate((e) => delete e.dataset.k2bMotion);
        const mark = chart.locator('[data-balance-key="opening"]');
        await mark.tap();
        await settled(page);
        expect(await chart.locator("[data-inspected]").count()).toBe(1);
        expect(await chart.locator('[role="tooltip"]').textContent()).toContain("€2,000.00");
        if (width === 390) {
          expect(await frame.locator("[data-balance-phone]").innerText()).toContain("Marketplace orders");
          expect(await frame.locator(".k2b-balance-flow-caption").first().isVisible()).toBe(false);
          expect(await frame.evaluate((e) => e.scrollWidth)).toBeLessThanOrEqual(Math.ceil(box!.width));
        } else {
          const caption = frame.locator(".k2b-balance-flow-caption").last();
          const labelBox = await caption.boundingBox();
          expect(labelBox!.x + labelBox!.width).toBeLessThanOrEqual(box!.x + box!.width + 1);
        }
        await frame.locator('[data-balance-view="table"]').click();
        await settled(page);
        expect(await frame.locator("[data-balance-table]").isVisible()).toBe(true);
        expect(await frame.locator("[data-balance-table]").innerText()).toContain("↗ €6,500.00");
        expect(await frame.evaluate(documentBox)).toEqual(box);
        for (const state of ["loading", "empty", "error", "stale", "data"]) {
          await page.locator(`[data-state-button="${state}"]`).click();
          await settled(page);
          expect(await frame.getAttribute("data-state")).toBe(state);
          expect(await frame.evaluate(documentBox)).toEqual(box);
          if (state === "error") {
            await frame.locator("[data-balance-retry]").click();
            await settled(page);
            expect(await frame.getAttribute("data-state")).toBe("data");
          }
        }
        // A redraw remounts navigation after its new HTML is inserted, retaining the current period.
        await frame.locator('[data-balance-step="-1"]').click();
        await settled(page);
        expect(await frame.getAttribute("data-period")).toBe("0");
        await frame.locator('[data-balance-view="chart"]').click();
        await settled(page);
        const text = chart.locator(".k2b-balance-flow-caption").first();
        const light = await text.evaluate((e) => getComputedStyle(e).fill);
        const balanceLight = await chart.locator('[data-balance-key="opening"]').evaluate((e) => getComputedStyle(e).fill);
        await page.locator("body").evaluate((e) => (e.dataset.theme = "dark"));
        await settled(page);
        expect(await text.evaluate((e) => getComputedStyle(e).fill)).not.toBe(light);
        expect(await chart.locator('[data-balance-key="opening"]').evaluate((e) => getComputedStyle(e).fill)).not.toBe(balanceLight);
        expect(await chart.locator('[data-balance-key="opening"]').evaluate((e) => getComputedStyle(e).fill)).toBe(
          await chart.locator('[data-balance-key="closing"]').evaluate((e) => getComputedStyle(e).fill),
        );
        expect(await chart.locator('[data-balance-key="balance"]').evaluate((e) => getComputedStyle(e).fill)).not.toBe("rgb(0, 0, 0)");
        // Truly outside .k2b-ui: literal SVG paint fallbacks must work without theme CSS.
        await page.locator("body").evaluate((e) => e.insertAdjacentHTML("afterend", '<aside id="standalone"></aside>'));
        await page.locator("#standalone").evaluate((e, svg) => (e.innerHTML = svg), renderBalanceFlowSvg({ ...spec, inspect: true }));
        await settled(page);
        expect(await page.locator("#standalone").evaluate((e) => e.closest(".k2b-ui"))).toBeNull();
        expect(await page.locator('#standalone [data-balance-key="in-0"]').evaluate((e) => getComputedStyle(e).fill)).not.toBe(
          "rgb(0, 0, 0)",
        );
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
}, 30000);

test("balance mark adapts to light and dark in base.css-only app frames", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const errors = pageErrors(page);
    const css = await Bun.file(new URL("../base/base.css", import.meta.url)).text();
    await page.setContent(`<style>${css}</style><main class="k2b-ui">${renderBalanceFlowSvg({ ...spec, inspect: true })}</main>`);
    for (const [theme, paint] of [
      ["light", "rgb(59, 130, 246)"],
      ["dark", "rgb(96, 165, 250)"],
    ] as const) {
      await page.locator("html").evaluate((e, theme) => (e.dataset.theme = theme), theme);
      await settled(page);
      expect(await page.locator('[data-balance-key="opening"]').evaluate((e) => getComputedStyle(e).fill)).toBe(paint);
      expect(await page.locator('[data-balance-key="closing"]').evaluate((e) => getComputedStyle(e).fill)).toBe(paint);
    }
    expect(errors).toEqual([]);
    await page.close();
  } finally {
    await browser.close();
  }
});
