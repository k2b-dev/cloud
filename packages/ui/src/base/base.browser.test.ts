import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type axeCore from "axe-core";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser } from "../../test/browser";

declare global {
  interface Window {
    axe?: typeof axeCore;
  }
}

// Spacing, overflow, and contrast depend on layout and paint, so a real
// engine renders the shipped stylesheet on a plain HTML page.
const css = readFileSync(resolve(import.meta.dir, "../../dist/base.css"), "utf8");
const axeSource = readFileSync(Bun.resolveSync("axe-core/axe.min.js", import.meta.dir), "utf8");

/** A small app written without classes beyond the documented helpers. */
const body = `
<main>
  <header class="row">
    <h1>Travel expenses</h1>
    <button type="button" class="primary">Export PDF</button>
  </header>
  <p class="muted">Receipts for October, paid back monthly.</p>
  <form class="row">
    <label>Purpose <input name="purpose" placeholder="Client visit"></label>
    <label>Amount <input name="amount" type="number" step="0.01"></label>
    <button>Add</button>
  </form>
  <p role="status" data-tone="success">Receipt saved.</p>
  <nav aria-label="Filter">
    <button type="button" aria-pressed="true">All</button>
    <button type="button" aria-pressed="false">Open</button>
    <button type="button" aria-pressed="false">Done</button>
  </nav>
  <ul id="checklist">
    <li><label><input type="checkbox" checked> Book the train</label><button type="button" class="danger" aria-label="Delete Book the train">✕</button></li>
    <li><label><input type="checkbox"> Hand in the receipts</label><button type="button" class="danger" aria-label="Delete Hand in the receipts">✕</button></li>
  </ul>
  <section id="summary">
    <h2>Summary</h2>
    <div class="grid">
      <div class="stat"><span>Total</span><strong>€237.40</strong></div>
      <div class="stat"><span>Receipts</span><strong>3</strong></div>
      <div class="stat"><span>Open</span><strong>1</strong></div>
    </div>
    <figure>
      <table>
        <thead>
          <tr><th>Purpose</th><th>Status</th><th class="num">Amount</th><th><span class="sr-only">Actions</span></th></tr>
        </thead>
        <tbody>
          <tr><td>Train Berlin to Hamburg<br><small>Oct 2</small></td><td><span class="tag" data-tone="success">Paid</span></td><td class="num">€89.90</td><td><button type="button" class="danger" aria-label="Delete train receipt">✕</button></td></tr>
          <tr><td>Hotel near the client<br><small>Oct 2</small></td><td><span class="tag" data-tone="warning">Open</span></td><td class="num">€124.00</td><td><button type="button" class="danger" aria-label="Delete hotel receipt">✕</button></td></tr>
          <tr><td>Lunch with the team<br><small>Oct 3</small></td><td><span class="tag">Draft</span></td><td class="num">€23.50</td><td><button type="button" class="danger" aria-label="Delete lunch receipt">✕</button></td></tr>
        </tbody>
      </table>
    </figure>
    <details>
      <summary>Cost center</summary>
      <dl><dt>Number</dt><dd>4711</dd><dt>Approver</dt><dd>Jana Nowak</dd></dl>
    </details>
  </section>
  <section>
    <h2>Approval</h2>
    <p role="alert">The amount must be a number.</p>
    <progress value="2" max="3">2 of 3 approved</progress>
  </section>
</main>`;

const page = (theme: "light" | "dark", extra = "") =>
  `<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Travel expenses</title><style>${css}</style>${extra}</head><body>${body}</body></html>`;

const viewports = {
  desktop: { viewport: { width: 1280, height: 800 } },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
} satisfies Record<string, BrowserContextOptions>;

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (viewport: keyof typeof viewports, theme: "light" | "dark", extra = ""): Promise<Page> => {
  // Without motion the color transitions settle at once, so computed colors are final.
  const context = await browser.newContext({ ...viewports[viewport], reducedMotion: "reduce" });
  const tab = await context.newPage();
  await tab.setContent(page(theme, extra));
  return tab;
};

const style = (tab: Page, selector: string, property: string) =>
  tab.$eval(selector, (element, name) => getComputedStyle(element).getPropertyValue(name), property);

describe("@k2b/ui base stylesheet in a browser", () => {
  for (const viewport of ["desktop", "phone"] as const) {
    for (const theme of ["light", "dark"] as const) {
      test(`passes axe and never scrolls sideways (${viewport}, ${theme})`, async () => {
        const tab = await open(viewport, theme);
        try {
          await tab.addScriptTag({ content: axeSource });
          const violations = await tab.evaluate(async () => {
            const result = await window.axe!.run(document, { resultTypes: ["violations"] });
            return result.violations.map(
              (violation) => `${violation.impact} ${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`,
            );
          });
          expect(violations).toEqual([]);
          const page = await tab.evaluate(() => ({
            scroll: document.documentElement.scrollWidth,
            width: document.documentElement.clientWidth,
          }));
          expect(page.scroll).toBeLessThanOrEqual(page.width);
        } finally {
          await tab.context().close();
        }
      }, 30_000);
    }
  }

  // K7: the flow rules alone space siblings, so no element rule can glue a
  // filter bar to the form above it, and helper layouts use only their gap.
  test("spaces siblings only through the flow rules", async () => {
    const tab = await open("desktop", "light");
    try {
      const gaps = await tab.evaluate(() => {
        const gap = (selector: string) => {
          const element = document.querySelector(selector)!;
          const previous = element.previousElementSibling!;
          return Math.round(element.getBoundingClientRect().top - previous.getBoundingClientRect().bottom);
        };
        return {
          headerToText: gap("main > p.muted"),
          textToForm: gap("main > form"),
          formToStatus: gap("main > [role=status]"),
          statusToNav: gap("main > nav"),
          navToList: gap("main > ul"),
          listToSection: gap("#summary"),
          sectionToSection: gap("#summary + section"),
          headingToGrid: gap("#summary > .grid"),
          gridToTable: gap("#summary > figure"),
          checklistRows: gap("#checklist > li + li"),
        };
      });
      expect(gaps).toEqual({
        headerToText: 16,
        textToForm: 16,
        formToStatus: 16,
        statusToNav: 16,
        navToList: 16,
        listToSection: 16,
        sectionToSection: 40,
        headingToGrid: 8,
        gridToTable: 16,
        checklistRows: 0,
      });
      const helperChildMargins = await tab.$$eval(".row > *, .grid > *, .stat > *, nav > *", (elements) =>
        elements.map((element) => getComputedStyle(element).marginTop).filter((margin) => margin !== "0px"),
      );
      expect(helperChildMargins).toEqual([]);
    } finally {
      await tab.context().close();
    }
  });

  // K8 and K11: a status message and a key figure are text, not surfaces.
  test("keeps status messages and key figures flat", async () => {
    const tab = await open("desktop", "light");
    try {
      expect(await style(tab, "[role=status]", "background-color")).toBe("rgba(0, 0, 0, 0)");
      expect(await style(tab, "[role=status]", "padding-left")).toBe("0px");
      expect(await style(tab, "[role=status]", "color")).toBe("rgb(4, 120, 87)");
      expect(await style(tab, ".stat", "background-color")).toBe("rgba(0, 0, 0, 0)");
      expect(await style(tab, ".stat", "padding-left")).toBe("0px");
      expect(await style(tab, "[role=alert]", "background-color")).toBe("rgb(254, 242, 242)");
    } finally {
      await tab.context().close();
    }
  });

  // K9: a heading row puts the title first and the actions at the end, centered.
  for (const viewport of ["desktop", "phone"] as const) {
    test(`lays out a header row with the action at the end (${viewport})`, async () => {
      const tab = await open(viewport, "light");
      try {
        const box = await tab.evaluate(() => {
          const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
          const [header, title, action] = [rect("header.row"), rect("header.row > h1"), rect("header.row > button")];
          return {
            titleStart: Math.round(title.left - header.left),
            actionEnd: Math.round(header.right - action.right),
            centers: Math.abs(title.top + title.height / 2 - (action.top + action.height / 2)) < 1,
          };
        });
        expect(box).toEqual({ titleStart: 0, actionEnd: 0, centers: true });
      } finally {
        await tab.context().close();
      }
    });
  }

  // K10: a delete action in every row stays quiet until its row is hovered or focused.
  test("keeps row actions quiet until their row is hovered or focused", async () => {
    const tab = await open("desktop", "light");
    try {
      const muted = "rgb(82, 82, 91)";
      const danger = "rgb(185, 28, 28)";
      const rowAction = "tbody tr:first-child .danger";
      await tab.mouse.move(0, 0);
      expect(await style(tab, rowAction, "color")).toBe(muted);
      expect(await style(tab, "#checklist li:first-child .danger", "color")).toBe(muted);
      await tab.hover("tbody tr:first-child td:nth-child(2)");
      expect(await style(tab, rowAction, "color")).toBe(danger);
      await tab.mouse.move(0, 0);
      await tab.focus(rowAction);
      expect(await style(tab, rowAction, "color")).toBe(danger);
    } finally {
      await tab.context().close();
    }
  });

  test("gives every control a touch target of at least 44px on a phone", async () => {
    const tab = await open("phone", "light");
    try {
      const small = await tab.$$eval("button, input:not([type=checkbox]), summary", (elements) =>
        elements.filter((element) => element.getBoundingClientRect().height < 44).map((element) => element.outerHTML.slice(0, 60)),
      );
      expect(small).toEqual([]);
    } finally {
      await tab.context().close();
    }
  });

  test("follows the theme attribute live and lets unlayered page rules win", async () => {
    const tab = await open("desktop", "light", "<style>button { background: rgb(1, 2, 3); }</style>");
    try {
      expect(await style(tab, "html", "background-color")).toBe("rgb(255, 255, 255)");
      await tab.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
      expect(await style(tab, "html", "background-color")).toBe("rgb(17, 21, 27)");
      expect(await style(tab, "html", "color")).toBe("rgb(250, 250, 250)");
      // `.primary` is more specific than `button`, but it sits in the layer.
      expect(await style(tab, "header .primary", "background-color")).toBe("rgb(1, 2, 3)");
    } finally {
      await tab.context().close();
    }
  });
});
