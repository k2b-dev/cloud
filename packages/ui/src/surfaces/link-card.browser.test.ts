import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { meterType } from "../../../../scripts/fixtures/type-meter";
import { launchBrowser, settled } from "../../test/browser";

// A stacked LinkCard as on "My apps & automations": head with tile, title, schedule and a run strip, a body line, and
// a footer with state and time; the whole card is one link. The classic card stays as it was.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const assets = "http://k2b-ui.test/";
const fonts = readFileSync(resolve(ui, "dist/plex.css"), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, `url($1${assets}`);
const icons = readFileSync(resolve(ui, "dist/tabler.css"), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, `url($1${assets}`);
const entry = resolve(import.meta.dir, "link-card.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { AppOverview, DotStrip, LinkCard } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const state = (icon, text, tone) => {
  const span = document.createElement("span");
  span.className = "state";
  span.dataset.tone = tone;
  const i = document.createElement("i");
  i.className = icon;
  i.setAttribute("aria-hidden", "true");
  span.append(i, text);
  return span;
};
const card = (id, title, description, body, start, end, dots) =>
  createComponent(LinkCard, {
    href: "#" + id, icon: "ti ti-code", color: "zinc", title, description,
    get aside() { return createComponent(DotStrip, { variant: "bar", dots, label: "Last runs" }); },
    body,
    get footer() { return { start, end }; },
  });
render(() => [
  createComponent(AppOverview.Cards, { get children() { return [
    card("weekly", "Weekly report", "Mondays at 07:00", "Last: created 1 note \\u201eWeekly report 46\\u201c", state("ti ti-circle-check", "On", "ok"), "next run Mon, 16.11.", ["success", "success", "success", "success"]),
    card("prices", "Check fabric prices", "Daily at 06:30", "Last: the price list of fabrics-north.example could not be reached, the run stopped", state("ti ti-alert-circle", "Last run failed", "danger"), "today, 06:30", ["success", "success", "danger"]),
    card("offers", "Follow up offers and ask the suppliers about the open delivery dates", "Every 15 minutes between 7:00 and 19:59", "Last: 3 offers followed up", state("ti ti-player-pause", "Paused", "paused"), "since 29.10.", ["success", "muted"]),
  ]; } }),
  createComponent(LinkCard, { href: "#team", icon: "ti ti-folder", title: "Team logistics", description: "128 files" }),
], document.getElementById("app"));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the link card fixture for the browser.");
const script = await build.outputs[0]!.text();

setDefaultTimeout(30_000);
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (width: number, dark = false) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.route(`${assets}**`, (route) =>
    route.fulfill({
      path: resolve(ui, "dist", new URL(route.request().url()).pathname.slice(1)),
      headers: { "access-control-allow-origin": "*" },
    }),
  );
  await page.setContent(
    `<!doctype html><html lang="en"><head><style>${css}</style><style>${fonts}</style><style>${icons}</style>
      <style>body{margin:0} #app{display:grid;gap:24px;padding:24px;max-width:1100px} .state{font-weight:600} .state[data-tone="ok"]{color:var(--k2b-success-text)} .state[data-tone="danger"]{color:var(--k2b-danger-text)}</style></head>
      <body class="k2b-ui${dark ? " k2b-dark" : ""}"><div id="app"></div></body></html>`,
  );
  await page.addScriptTag({ content: script });
  await page.waitForSelector(".k2b-link-card");
  await page.evaluate(() => document.fonts.ready);
  await settled(page);
  return page;
};
const box = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((node) => {
      const { left, right, top, bottom, width, height } = node.getBoundingClientRect();
      return { left, right, top, bottom, width, height };
    });

for (const width of [1440, 390]) {
  describe(`LinkCard at ${width}`, () => {
    test("a stacked card puts the strip top right, the body below, and the footer on the bottom edge, as one link", async () => {
      const page = await open(width);
      try {
        const card = '.k2b-link-card[href="#weekly"]';
        const frame = await box(page, card);
        const aside = await box(page, `${card} .k2b-link-card__aside`);
        const title = await box(page, `${card} .k2b-link-card__title`);
        const tile = await box(page, `${card} .k2b-link-card__icon`);
        const body = await box(page, `${card} .k2b-link-card__body`);
        const footer = await box(page, `${card} .k2b-link-card__footer`);
        // The 1 px edge and a 16 px inset on every side; the strip on the right of the title row.
        expect(frame.right - aside.right).toBe(17);
        expect(aside.top).toBeLessThan(title.bottom);
        expect(body.top).toBeGreaterThan(tile.bottom);
        expect(body.left).toBe(tile.left);
        expect(footer.left).toBe(tile.left);
        expect(frame.bottom - footer.bottom).toBe(17);
        const style = await page.locator(card).evaluate((node) => ({
          radius: getComputedStyle(node).borderRadius,
          shadow: getComputedStyle(node).boxShadow !== "none",
          links: node.querySelectorAll("a, button").length,
          chevron: node.querySelector(".k2b-link-card__chevron") !== null,
        }));
        expect(style).toEqual({ radius: "10px", shadow: true, links: 0, chevron: false });
        // Footer start and end never overlap, also on a phone.
        const start = await box(page, `${card} .k2b-link-card__footer-start`);
        const end = await box(page, `${card} .k2b-link-card__footer-end`);
        expect(start.right).toBeLessThanOrEqual(end.left);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      } finally {
        await page.close();
      }
    });

    test("cards in one row end level, however long their body is", async () => {
      const page = await open(width);
      try {
        const cards = await page.locator(".k2b-app-overview__cards > .k2b-link-card").evaluateAll((nodes) =>
          nodes.map((node) => {
            const card = node.getBoundingClientRect();
            const footer = node.querySelector(".k2b-link-card__footer")!.getBoundingClientRect();
            return { top: card.top, bottom: card.bottom, footer: footer.bottom };
          }),
        );
        const rows = new Map<number, typeof cards>();
        for (const card of cards) rows.set(card.top, [...(rows.get(card.top) ?? []), card]);
        for (const row of rows.values()) {
          expect(new Set(row.map((card) => card.bottom)).size).toBe(1);
          expect(new Set(row.map((card) => card.footer)).size).toBe(1);
        }
        if (width === 1440) {
          expect(rows.size).toBe(1);
          const lefts = await page
            .locator(".k2b-app-overview__cards > .k2b-link-card")
            .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect()));
          expect(lefts[1]!.left - lefts[0]!.right).toBe(14);
        }
      } finally {
        await page.close();
      }
    });

    test("a long title and schedule wrap instead of ending in an ellipsis, so the end time stays visible", async () => {
      const page = await open(width);
      try {
        for (const part of ["title", "description"]) {
          const shown = await page.locator(`.k2b-link-card[href="#offers"] .k2b-link-card__${part}`).evaluate((node) => {
            const style = getComputedStyle(node);
            const own = node.getBoundingClientRect();
            const card = node.closest(".k2b-link-card")!.getBoundingClientRect();
            return {
              ellipsis: style.textOverflow === "ellipsis",
              cut: node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1,
              inside: own.right <= card.right,
              lines: Math.round(own.height / Number.parseFloat(style.lineHeight)),
            };
          });
          expect(shown.ellipsis).toBe(false);
          expect(shown.cut).toBe(false);
          expect(shown.inside).toBe(true);
          // At this length the title needs more than one line at both widths.
          if (part === "title") expect(shown.lines).toBeGreaterThan(1);
        }
        expect(await page.locator('.k2b-link-card[href="#offers"] .k2b-link-card__description').textContent()).toBe(
          "Every 15 minutes between 7:00 and 19:59",
        );
      } finally {
        await page.close();
      }
    });

    test("the keyboard reaches the whole card and shows its ring", async () => {
      const page = await open(width);
      try {
        await page.keyboard.press("Tab");
        await settled(page);
        const focused = await page.evaluate(() => ({
          href: document.activeElement?.getAttribute("href"),
          outline: getComputedStyle(document.activeElement!).outlineStyle,
        }));
        expect(focused).toEqual({ href: "#weekly", outline: "solid" });
      } finally {
        await page.close();
      }
    });

    test("type holds the steps: title 14/600, entries 13/400, the footer's end 12/400", async () => {
      const page = await open(width);
      try {
        const type = await meterType(page, '.k2b-link-card[href="#weekly"]', { ignore: ".state" });
        expect(type.styles).toEqual(["12/400", "13/400", "14/600"]);
        expect(type.offSizes).toEqual([]);
      } finally {
        await page.close();
      }
    });
  });
}

test("a classic card keeps its row, chevron, 12 px radius, and 16 px inset", async () => {
  const page = await open(1440);
  try {
    const classic = await page.locator('.k2b-link-card[href="#team"]').evaluate((node) => ({
      layout: node.getAttribute("data-layout"),
      direction: getComputedStyle(node).flexDirection,
      radius: getComputedStyle(node).borderRadius,
      padding: getComputedStyle(node).padding,
      chevron: node.querySelector(".k2b-link-card__chevron") !== null,
    }));
    expect(classic).toEqual({ layout: null, direction: "row", radius: "12px", padding: "16px", chevron: true });
  } finally {
    await page.close();
  }
});

test("dark: the stacked card is an island with the lighter surface and its own text colours", async () => {
  const page = await open(1440, true);
  try {
    const colours = await page.locator('.k2b-link-card[href="#weekly"]').evaluate((node) => {
      const probe = document.createElement("span");
      node.append(probe);
      probe.style.background = "var(--k2b-island-surface)";
      const island = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return {
        card: getComputedStyle(node).backgroundColor,
        island,
        title: getComputedStyle(node.querySelector(".k2b-link-card__title")!).color,
      };
    });
    expect(colours.card).toBe(colours.island);
    expect(colours.title).not.toBe("rgb(9, 9, 11)");
  } finally {
    await page.close();
  }
});

// Evidence for reviews: K2B_LINK_CARD_SCREENSHOTS=<dir> writes the cards at both widths.
const shots = process.env.K2B_LINK_CARD_SCREENSHOTS;
test.if(Boolean(shots))("screenshots of the cards", async () => {
  mkdirSync(shots!, { recursive: true });
  for (const width of [1440, 390]) {
    const page = await open(width);
    try {
      await page.screenshot({ path: `${shots}/link-card-${width}.png`, fullPage: true });
    } finally {
      await page.close();
    }
  }
});
