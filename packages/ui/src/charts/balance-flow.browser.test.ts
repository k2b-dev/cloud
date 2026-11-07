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
        const old = await chart.locator('[data-balance-key="closing"]').evaluate((e) => ({
          fill: getComputedStyle(e).fill,
          value: JSON.parse(e.parentElement!.getAttribute("data-chart-datum")!).values.find((v: { key: string }) => v.key === "value")
            .value,
        }));
        const continuity = await chart.evaluate((e) => {
          e.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
          const rect = e.querySelector('[data-balance-key="opening"]');
          return rect
            ?.getAnimations()
            .some((a) => (a.effect as KeyframeEffect).getKeyframes().some((k) => String(k.transform).includes("translate")));
        });
        expect(continuity).toBe(true);
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
        await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))));
        await settled(page);
        expect(await frame.evaluate(documentBox)).toEqual(box);
        await page.emulateMedia({ reducedMotion: "reduce" });
        await frame.locator('[data-balance-step="1"]').click();
        await settled(page);
        expect(await frame.getAttribute("data-period")).toBe("2");
        expect(await frame.locator('[data-balance-step="1"]').isDisabled()).toBe(true);
        expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
        await frame.locator('[data-balance-step="-1"]').click();
        await settled(page);
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
        await page.locator("body").evaluate((e) => (e.dataset.theme = "dark"));
        await settled(page);
        expect(await text.evaluate((e) => getComputedStyle(e).fill)).not.toBe(light);
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
