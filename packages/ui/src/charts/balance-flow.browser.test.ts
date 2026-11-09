import { expect, test } from "bun:test";
import { launchBrowser, pageErrors, settled } from "../../test/browser";
import { balanceFlowPage, balanceFlowSpec as spec } from "../../test/charts/balance-flow-page";
import { renderBalanceFlowSvg } from "./core/balance-flow";
import { renderBalanceFlowHtml } from "./core/balance-flow-frame";

test("continuous BalanceFlow keeps joined bands, SSR newest origin, scroll inspection and real state boxes", async () => {
  const { html, bundle } = await balanceFlowPage();
  const browser = await launchBrowser();
  try {
    for (const width of [1440, 1200, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 1100 }, hasTouch: true });
      try {
        const errors = pageErrors(page);
        await page.setContent(html);
        await page.evaluate(() => document.fonts.ready);
        await settled(page);
        const frame = page.locator("#mount [data-balance-flow]"),
          chart = frame.locator(".k2b-chart"),
          svg = chart.locator(".k2b-chart__svg > svg"),
          viewport = frame.locator("[data-balance-scroll]");
        const documentBox = (element: Element) => {
          const b = element.getBoundingClientRect();
          return { x: b.x + window.scrollX, y: b.y + window.scrollY, width: b.width, height: b.height };
        };
        const serverFrame = await frame.innerHTML();
        const before = await svg.evaluate((e) => e.outerHTML),
          box = await frame.evaluate(documentBox);
        const newestRight = await frame.locator('[data-balance-month="3"]').evaluate((e) => e.getBoundingClientRect().right);
        expect(newestRight).toBeCloseTo((await viewport.evaluate((e) => e.getBoundingClientRect().right)) - (width === 390 ? 24 : 0), 2);
        expect(await frame.evaluate(() => document.fonts.check('12px "IBM Plex Sans"'))).toBe(true);
        expect(await viewport.evaluate((e) => e.scrollLeft)).toBe(0);
        await page.locator("#mount").evaluate((e) => e.replaceChildren());
        await page.addScriptTag({ content: bundle });
        await settled(page);
        expect(await frame.innerHTML()).toBe(serverFrame);
        expect(await svg.evaluate((e) => e.outerHTML)).toBe(before);
        expect(await frame.evaluate(documentBox)).toEqual(box);
        expect(await viewport.evaluate((e) => e.scrollLeft)).toBe(0);
        expect(await frame.getAttribute("data-period")).toBe("3");
        expect(await frame.locator('[data-balance-step="1"]').isDisabled()).toBe(true);
        expect(await chart.locator("[data-balance-period]").count()).toBe(4);
        // Keyboard focus must start inspection even when no pointer has entered the chart yet.
        await page.setViewportSize({ width, height: 450 });
        await settled(page);
        await chart.focus();
        await settled(page);
        expect(await chart.locator('[role="tooltip"]:popover-open').isVisible()).toBe(true);
        const previousScroll = await page.evaluate(() => window.scrollY);
        await page.evaluate((y) => window.scrollTo(0, y === 0 ? 20 : 0), previousScroll);
        await settled(page);
        expect(await page.evaluate(() => window.scrollY)).not.toBe(previousScroll);
        expect(await chart.locator('[role="tooltip"]:popover-open').isVisible()).toBe(true);
        await page.keyboard.press("Escape");
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.setViewportSize({ width, height: 1100 });
        await chart.evaluate((element) => {
          if (element instanceof HTMLElement) element.blur();
        });
        await settled(page);
        for (let period = 0; period < 3; period++) {
          const boundary = chart.locator(`[data-balance-period="${period}"] [data-balance-key="closing"]`);
          const seam = await boundary.evaluate((e) => {
            const period = e.closest("[data-balance-period]")!;
            const index = Number(period.getAttribute("data-balance-period"));
            const next = period.parentElement!.querySelector(`[data-balance-period="${index + 1}"]`)!;
            const node = e.getBoundingClientRect();
            const matrix = (next as SVGGraphicsElement).getScreenCTM()!;
            const edge = new DOMPoint(0, 0).matrixTransform(matrix);
            return { center: node.x + node.width / 2, edge: edge.x, width: Number(e.getAttribute("width")) };
          });
          expect(seam.center).toBeCloseTo(seam.edge, 2);
          expect(seam.width).toBe(8);
          const outgoing = await chart.locator(`[data-balance-period="${period}"] [data-balance-key="out-0"]`).boundingBox();
          const incoming = await chart.locator(`[data-balance-period="${period + 1}"] [data-balance-key="in-0"]`).boundingBox();
          expect(incoming!.x - outgoing!.x - outgoing!.width).toBeGreaterThanOrEqual(width === 390 ? 28 : 64);
          expect(await chart.locator(`[data-balance-period="${period + 1}"] [data-balance-key="opening"]`).count()).toBe(0);
          expect(await boundary.locator("..").getAttribute("aria-label")).toContain(" = Opening ");
        }
        expect(await chart.locator("[data-chart-datum] title").count()).toBe(0);
        for (const period of [0, 3]) {
          const anchor = await chart.locator(`[data-balance-period="${period}"] [data-balance-key="closing"]`).evaluate((e) => {
            const mark = e.closest<SVGGraphicsElement>("[data-chart-datum]")!;
            const datum = JSON.parse(mark.getAttribute("data-chart-datum")!);
            const point = new DOMPoint(datum.anchor[0], datum.anchor[1]).matrixTransform(mark.getScreenCTM()!);
            const b = e.getBoundingClientRect();
            return { x: point.x, y: point.y, cx: b.x + b.width / 2, cy: b.y + b.height / 2 };
          });
          expect(anchor.x).toBeCloseTo(anchor.cx, 2);
          expect(anchor.y).toBeCloseTo(anchor.cy, 2);
        }
        const opacity = await chart
          .locator(".k2b-balance-flow-band")
          .first()
          .evaluate((e) => getComputedStyle(e).fillOpacity);
        await frame.evaluate((e) => e.style.setProperty("--k2b-motion-base", "0.24s"));
        // settled: inspect the running scroll duration in the frame that starts it.
        const timing = await frame.evaluate((e) => {
          e.querySelector<HTMLButtonElement>('[data-balance-step="-1"]')!.click();
          return e.querySelector("[data-balance-scroll]")!.getAnimations()[0]?.effect?.getTiming().duration;
        });
        expect(timing).toBe(240);
        await settled(page);
        expect(await frame.getAttribute("data-period")).toBe("2");
        expect(await viewport.evaluate((e) => e.scrollLeft)).toBeLessThan(0);
        expect(await svg.evaluate((e) => e.outerHTML)).toBe(before);
        expect(await frame.evaluate(documentBox)).toEqual(box);
        // Real trackpad/swipe-equivalent scroll, without replacing any drawing.
        await viewport.evaluate((e) => (e.scrollLeft = -e.scrollWidth));
        await settled(page);
        expect(await frame.getAttribute("data-period")).toBe("0");
        expect(await frame.locator('[data-balance-step="-1"]').isDisabled()).toBe(true);
        const oldScroll = await viewport.evaluate((e) => e.scrollLeft);
        const mark = chart.locator('[data-balance-period="0"] [data-balance-key="in-0"]');
        await mark.tap();
        await settled(page);
        expect(await viewport.evaluate((e) => e.scrollLeft)).toBe(oldScroll);
        expect(await chart.locator('[role="tooltip"]').innerText()).toContain("Marketplace orders");
        expect(await chart.locator("[data-selected] > rect").evaluate((e) => getComputedStyle(e).strokeWidth)).toBe("2.5px");
        expect(
          await chart
            .locator(".k2b-balance-flow-band")
            .first()
            .evaluate((e) => getComputedStyle(e).fillOpacity),
        ).toBe(opacity);
        if (width !== 390) {
          await mark.hover();
          await settled(page);
          expect(
            await chart
              .locator(".k2b-balance-flow-band")
              .first()
              .evaluate((e) => getComputedStyle(e).fillOpacity),
          ).toBe(opacity);
          // Real text boxes in IBM Plex must not collide within or between periods.
          const overlaps = await chart.evaluate((e) => {
            const boxes = Array.from(e.querySelectorAll(".k2b-balance-flow-caption text, .k2b-balance-flow-carry text")).map((text) => ({
              label: text.textContent,
              box: text.getBoundingClientRect(),
            }));
            return boxes.flatMap((a, i) =>
              boxes
                .slice(i + 1)
                .filter(
                  (b) =>
                    Math.min(a.box.right, b.box.right) > Math.max(a.box.left, b.box.left) + 1 &&
                    Math.min(a.box.bottom, b.box.bottom) > Math.max(a.box.top, b.box.top) + 1,
                )
                .map((b) => [a.label, b.label]),
            );
          });
          expect(overlaps).toEqual([]);
          const clipped = await chart.evaluate((e) => {
            const viewport = e.querySelector("[data-balance-scroll]")!.getBoundingClientRect();
            return Array.from(e.querySelectorAll(".k2b-balance-flow-caption text, .k2b-balance-flow-carry text"))
              .filter((text) => {
                const b = text.getBoundingClientRect();
                return b.left < viewport.right && b.right > viewport.left && (b.left < viewport.left || b.right > viewport.right);
              })
              .map((text) => text.textContent);
          });
          expect(clipped).toEqual([]);
          expect(await chart.locator('[data-balance-caption="opening"]').count()).toBe(1);
          expect(await chart.locator('[data-balance-caption="closing"]').count()).toBe(4);
          expect(await chart.locator('[data-balance-key="opening"]').count()).toBe(1);
          for (const name of ["Refunds", "Shipping labels"])
            expect(
              await chart.locator('[data-balance-period="0"] .k2b-balance-flow-caption text').filter({ hasText: name }).isVisible(),
            ).toBe(true);
        } else {
          expect(await frame.locator("[data-balance-phone]").innerText()).toContain("Shipping labels");
          expect(await frame.locator(".k2b-balance-flow-caption").first().isVisible()).toBe(false);
          expect(await page.locator("html").evaluate((e) => e.scrollWidth)).toBe(width);
        }
        await page.keyboard.press("Escape");
        if (width !== 390) {
          await chart.locator('[data-balance-period="0"] [data-balance-key="closing"]').hover();
          await settled(page);
          expect(await chart.locator('[role="tooltip"]').innerText()).toContain("Closing October 2026 = Opening November 2026");
          expect(await chart.locator("[data-chart-datum] title").count()).toBe(0);
        }
        await chart.focus();
        await page.keyboard.press("End");
        await settled(page);
        expect(await frame.getAttribute("data-period")).toBe("3");
        expect(await chart.locator("[data-inspected]").count()).toBe(1);
        await page.keyboard.press("Home");
        await settled(page);
        expect(await frame.getAttribute("data-period")).toBe("0");
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Enter");
        await settled(page);
        expect(await chart.locator("[data-inspected]").count()).toBe(1);
        await page.keyboard.press("Escape");
        await settled(page);
        await page.locator("html").evaluate((e) => (e.dataset.k2bMotion = "reduced"));
        // settled: an immediate read proves host reduced-motion makes navigation synchronous.
        const reduced = await chart.evaluate((e) => {
          e.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
          return {
            moving: e.closest("[data-balance-flow]")!.hasAttribute("data-balance-scrolling"),
            scroll: e.querySelector("[data-balance-scroll]")!.scrollLeft,
          };
        });
        expect(reduced.moving).toBe(false);
        await settled(page);
        expect(await frame.getAttribute("data-period")).toBe("1");
        if (width === 390) {
          const peek = await frame.evaluate((e) => {
            const view = e.querySelector("[data-balance-scroll]")!.getBoundingClientRect();
            const month = e.querySelector('[data-balance-month="1"]')!.getBoundingClientRect();
            return { left: month.left - view.left, right: view.right - month.right };
          });
          expect(peek.left).toBeCloseTo(24, 1);
          expect(peek.right).toBeCloseTo(24, 1);
          const compact = await frame.evaluate((e) => {
            const list = e.querySelector<HTMLElement>('[data-balance-phone-period="1"]')!;
            const bounds = list.getBoundingClientRect();
            const balance = e.querySelector('[data-balance-period="1"] [data-balance-key="closing"]')!.getBoundingClientRect();
            return {
              gap: bounds.top - balance.bottom,
              rows: Array.from(list.children).map((row) => {
                const label = row.querySelector("dt")!.getBoundingClientRect();
                const amount = row.querySelector("dd")!.getBoundingClientRect();
                const style = getComputedStyle(row);
                return { height: row.getBoundingClientRect().height, gap: amount.left - label.right, rule: style.borderTopWidth };
              }),
            };
          });
          expect(compact.gap).toBeGreaterThanOrEqual(0);
          expect(compact.gap).toBeLessThanOrEqual(10.1);
          for (const row of compact.rows) {
            expect(row.height).toBeCloseTo(44, 1);
            expect(row.gap).toBeGreaterThanOrEqual(8);
            expect(row.rule).toBe("1px");
          }
          await frame.locator('[data-balance-step="-1"]').click();
          await settled(page);
          const longer = frame.locator('[data-balance-phone-period="0"]');
          expect(await longer.evaluate((e) => e.scrollHeight)).toBeGreaterThan(await longer.evaluate((e) => e.clientHeight));
          await longer.evaluate((e) => (e.scrollTop = e.scrollHeight));
          await settled(page);
          expect(
            await longer.evaluate((e) => e.lastElementChild!.getBoundingClientRect().bottom <= e.getBoundingClientRect().bottom + 1),
          ).toBe(true);
          expect(await frame.evaluate(documentBox)).toEqual(box);
          await frame.locator('[data-balance-step="1"]').click();
          await settled(page);
        }

        await page.locator("html").evaluate((e) => delete e.dataset.k2bMotion);
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.keyboard.press("ArrowRight");
        await settled(page);
        expect(await frame.getAttribute("data-period")).toBe("2");
        expect(await frame.getAttribute("data-balance-scrolling")).toBeNull();
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await frame.locator('[data-balance-view="table"]').click();
        await settled(page);
        expect(await frame.locator("[data-balance-table] table").count()).toBe(4);
        expect(await frame.locator("[data-balance-table]").innerText()).toContain("January 2027");
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
        await frame.locator('[data-balance-view="chart"]').click();
        await settled(page);
        const balance = chart.locator('[data-balance-period="0"] [data-balance-key="opening"]');
        const light = await balance.evaluate((e) => getComputedStyle(e).fill);
        await page.locator("body").evaluate((e) => (e.dataset.theme = "dark"));
        await settled(page);
        expect(await balance.evaluate((e) => getComputedStyle(e).fill)).not.toBe(light);
        expect(await balance.evaluate((e) => getComputedStyle(e).fill)).toBe(
          await chart.locator('[data-balance-period="3"] [data-balance-key="closing"]').evaluate((e) => getComputedStyle(e).fill),
        );
        expect(
          await chart.locator('[data-balance-period="3"] [data-balance-key="balance"]').evaluate((e) => getComputedStyle(e).fill),
        ).not.toBe("rgb(0, 0, 0)");
        await page.locator("body").evaluate((e) => e.insertAdjacentHTML("afterend", '<aside id="standalone"></aside>'));
        await page.locator("#standalone").evaluate((e, markup) => (e.innerHTML = markup), renderBalanceFlowSvg({ ...spec, inspect: true }));
        await settled(page);
        expect(await page.locator("#standalone").evaluate((e) => e.closest(".k2b-ui"))).toBeNull();
        expect(
          await page
            .locator('#standalone [data-balance-key="in-0"]')
            .first()
            .evaluate((e) => getComputedStyle(e).fill),
        ).not.toBe("rgb(0, 0, 0)");
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
      expect(
        await page
          .locator('[data-balance-key="opening"]')
          .first()
          .evaluate((e) => getComputedStyle(e).fill),
      ).toBe(paint);
      expect(
        await page
          .locator('[data-balance-key="closing"]')
          .first()
          .evaluate((e) => getComputedStyle(e).fill),
      ).toBe(paint);
    }
    await page.setContent(`<style>${css}</style>${renderBalanceFlowHtml(spec)}`);
    await settled(page);
    expect(await page.locator("[data-balance-table]").isVisible()).toBe(false);
    await page.emulateMedia({ media: "print" });
    await settled(page);
    expect(await page.locator("[data-balance-table]").isVisible()).toBe(true);
    expect(await page.locator("[data-balance-table] table").count()).toBe(4);
    expect(await page.locator('.k2b-chart[data-chart-kind="balanceFlow"]').isVisible()).toBe(false);
    expect(errors).toEqual([]);
    await page.close();
  } finally {
    await browser.close();
  }
});
