import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { charts } from "@k2b/stdlib";
import type axeCore from "axe-core";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser } from "../../test/browser";
import { responsiveChartSvg } from "../content/chart-svg";

declare global {
  interface Window {
    axe?: typeof axeCore;
  }
}

// Spacing, overflow, and contrast depend on layout and paint, so a real
// engine renders the shipped stylesheet on a plain HTML page.
const css = readFileSync(resolve(import.meta.dir, "../../dist/base.css"), "utf8");
const componentCss = readFileSync(resolve(import.meta.dir, "../../dist/styles.css"), "utf8");
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

type Fixture = { head?: string; body?: string };

const page = (theme: "light" | "dark", fixture: Fixture) =>
  `<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Travel expenses</title><style>${css}</style>${fixture.head ?? ""}</head><body>${fixture.body ?? body}</body></html>`;

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

const open = async (viewport: keyof typeof viewports, theme: "light" | "dark", fixture: Fixture = {}): Promise<Page> => {
  // Without motion the color transitions settle at once, so computed colors are final.
  const context = await browser.newContext({ ...viewports[viewport], reducedMotion: "reduce" });
  const tab = await context.newPage();
  await tab.setContent(page(theme, fixture));
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

  // A wrapper such as <div class="app"> is a flow container like <main>;
  // browser margins never come back inside it.
  test("spaces the children of a div with a class like any other container", async () => {
    const tab = await open("desktop", "light", {
      body: `<div class="app"><h1>Travel expenses</h1><p>Receipts for October.</p><p>Paid back monthly.</p><h2>Summary</h2><p>Three receipts.</p></div>`,
    });
    try {
      const gaps = await tab.$$eval(".app > * + *", (elements) =>
        elements.map((element) => {
          const gap = element.getBoundingClientRect().top - element.previousElementSibling!.getBoundingClientRect().bottom;
          return `${element.previousElementSibling!.tagName} ${element.tagName} ${Math.round(gap)}`;
        }),
      );
      expect(gaps).toEqual(["H1 P 8", "P P 16", "P H2 32", "H2 P 8"]);
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

  // <output> holds a result the reader needs, so only data-tone changes its color.
  test("shows an output in the text color unless a tone colors it", async () => {
    const tab = await open("desktop", "light", {
      body: `<main><p>Total <output id="total">€237.40</output>, <output id="overdue" data-tone="danger">2 overdue</output></p></main>`,
    });
    try {
      expect(await style(tab, "#total", "color")).toBe("rgb(9, 9, 11)");
      expect(await style(tab, "#total", "font-variant-numeric")).toBe("tabular-nums");
      expect(await style(tab, "#overdue", "color")).toBe("rgb(185, 28, 28)");
      expect(await style(tab, "#overdue", "background-color")).toBe("rgba(0, 0, 0, 0)");
    } finally {
      await tab.context().close();
    }
  });

  // K9: a heading row puts the title first and the actions at the end,
  // centered. A title block with a subtitle counts as the title, and an action
  // that wraps below a long title on a phone stays at the end.
  const headers = `<main>
    <header class="row" id="short"><h1>Travel expenses</h1><button type="button" class="primary">Export PDF</button></header>
    <header class="row" id="block"><div><h1>Travel expenses</h1><p class="muted">Paid back monthly.</p></div><button type="button" class="primary">Export PDF</button></header>
    <header class="row" id="long"><h1>Travel expenses for the client visit in Hamburg</h1><button type="button" class="primary">Export PDF</button></header>
  </main>`;
  for (const viewport of ["desktop", "phone"] as const) {
    test(`lays out a header row with the action at the end (${viewport})`, async () => {
      const tab = await open(viewport, "light", { body: headers });
      try {
        const rows = await tab.$$eval("header.row", (elements) =>
          elements.map((header) => {
            const [row, title, action] = [header, header.firstElementChild!, header.lastElementChild!].map((element) =>
              element.getBoundingClientRect(),
            );
            return {
              id: header.id,
              titleStart: Math.round(title!.left - row!.left),
              actionEnd: Math.round(row!.right - action!.right),
              layout:
                action!.top >= title!.bottom
                  ? "wrapped"
                  : Math.abs(title!.top + title!.height / 2 - (action!.top + action!.height / 2)) < 1
                    ? "centered"
                    : "misaligned",
            };
          }),
        );
        expect(rows).toEqual([
          { id: "short", titleStart: 0, actionEnd: 0, layout: "centered" },
          { id: "block", titleStart: 0, actionEnd: 0, layout: "centered" },
          { id: "long", titleStart: 0, actionEnd: 0, layout: viewport === "phone" ? "wrapped" : "centered" },
        ]);
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

  // The checkbox itself stays small; its label is the tap target of the row.
  test("gives buttons, fields, summaries and checklist labels a touch target of at least 44 by 44px on a phone", async () => {
    const tab = await open("phone", "light");
    try {
      const small = await tab.$$eval("button, input:not([type=checkbox]), summary, #checklist label", (elements) =>
        elements
          .filter((element) => {
            const box = element.getBoundingClientRect();
            return box.height < 44 || box.width < 44;
          })
          .map((element) => element.outerHTML.slice(0, 60)),
      );
      expect(small).toEqual([]);
    } finally {
      await tab.context().close();
    }
  });

  // Fields draw the outline inside their box; every other control keeps it
  // outside, so a keyboard user always sees where the focus is.
  test("shows keyboard focus on every kind of control", async () => {
    const tab = await open("desktop", "light", {
      body: `<main><form>
        <ul><li><label><input type="checkbox"> Hand in the receipts</label></li></ul>
        <fieldset><legend>Trip</legend><label><input type="radio" name="trip"> One way</label></fieldset>
        <label>Share <input type="range"></label>
        <label>Receipt <input type="file"></label>
        <label>Purpose <input name="purpose"></label>
        <label>Kind <select><option>Train</option></select></label>
        <label>Note <textarea></textarea></label>
        <input type="submit" value="Save">
      </form></main>`,
    });
    try {
      const focus: string[] = [];
      for (let stop = 0; stop < 8; stop += 1) {
        await tab.keyboard.press("Tab");
        focus.push(
          await tab.evaluate(() => {
            const element = document.activeElement as HTMLInputElement;
            const computed = getComputedStyle(element);
            if (computed.outlineStyle === "none" || computed.outlineWidth === "0px") return `${element.type} without outline`;
            return `${element.type} ${Number.parseFloat(computed.outlineOffset) < 0 ? "inset" : "outside"}`;
          }),
        );
      }
      expect(focus).toEqual([
        "checkbox outside",
        "radio outside",
        "range outside",
        "file outside",
        "text inset",
        "select-one inset",
        "textarea inset",
        "submit outside",
      ]);
    } finally {
      await tab.context().close();
    }
  });

  test("centers a modal dialog", async () => {
    const tab = await open("desktop", "light", {
      body: `<main><h1>Receipts</h1><p>Three receipts.</p><dialog aria-labelledby="confirm-title"><h2 id="confirm-title">Delete the receipt?</h2><p>This cannot be undone.</p><footer><button type="button" value="cancel">Cancel</button><button type="button" class="danger">Delete</button></footer></dialog></main>`,
    });
    try {
      const gaps = await tab.evaluate(() => {
        const dialog = document.querySelector("dialog")!;
        dialog.showModal();
        const box = dialog.getBoundingClientRect();
        return { vertical: box.top - (innerHeight - box.bottom), horizontal: box.left - (innerWidth - box.right) };
      });
      expect(Math.abs(gaps.vertical)).toBeLessThan(1);
      expect(Math.abs(gaps.horizontal)).toBeLessThan(1);
    } finally {
      await tab.context().close();
    }
  });

  test("prints a dark page with the light tokens", async () => {
    const tab = await open("desktop", "dark");
    try {
      await tab.emulateMedia({ media: "print" });
      expect(await style(tab, "html", "color-scheme")).toBe("light");
      expect(await style(tab, "html", "background-color")).toBe("rgb(255, 255, 255)");
      expect(await style(tab, "main > p.muted", "color")).toBe("rgb(82, 82, 91)");
      expect(await style(tab, ".tag[data-tone=success]", "background-color")).toBe("rgb(236, 253, 245)");
      expect(await style(tab, "input[name=purpose]", "background-color")).toBe("rgb(244, 244, 245)");
    } finally {
      await tab.context().close();
    }
  });

  // stdlib embeds an unlayered <style> with fixed light colors that would beat
  // the layer, so the documented chart markup leaves it out.
  const withoutStdlibStyle = (svg: string) => svg.replace(/<style>[\s\S]*?<\/style>/, "");
  const chartMarkup = (kind: string, svg: string, width: number, height: number) =>
    `<div class="k2b-chart" data-chart-kind="${kind}"><div class="k2b-chart__svg" data-stretch style="--k2b-chart-width:${width}px;--k2b-chart-height:${height}px">${responsiveChartSvg(svg)}</div></div>`;
  const cities = ["Revenue Berlin", "Revenue Hamburg", "Revenue Munich", "Revenue Cologne"].map((label, index) => ({
    label,
    data: [
      { x: 0, y: index },
      { x: 1, y: index + 2 },
    ],
  }));

  test("colors a stdlib chart with the tokens in the dark theme", async () => {
    const svg = withoutStdlibStyle(charts.line({ series: cities, width: 640, height: 280, legend: true }));
    const tab = await open("desktop", "dark", { body: `<main>${chartMarkup("line", svg, 640, 280)}</main>` });
    try {
      expect(await style(tab, ".stdlib-chart", "color")).toBe("rgb(250, 250, 250)");
      expect(await style(tab, ".stdlib-chart-line.stdlib-chart-series-3", "stroke")).toBe("rgb(139, 92, 246)");
      expect(await style(tab, ".stdlib-chart-legend-label", "fill")).toBe("rgb(250, 250, 250)");
      expect(await style(tab, ".stdlib-chart-tick-label", "font-family")).toContain("IBM Plex Mono");
    } finally {
      await tab.context().close();
    }
  });

  // The same stretched markup lays out legends, scatter points and sparkline
  // markers exactly as the Chart component does with styles.css.
  test("lays out stretched charts like the Chart component on a phone", async () => {
    const markup = (render: (svg: string) => string) =>
      [
        chartMarkup("line", render(charts.line({ series: cities.slice(0, 3), width: 640, height: 280, legend: true })), 640, 280),
        chartMarkup("scatter", render(charts.scatter({ series: cities.slice(0, 1), width: 640, height: 280 })), 640, 280),
        chartMarkup(
          "sparkline",
          render(charts.sparkline({ data: [3, 5, 2, 8, 6], width: 160, height: 40, showLast: true, showMinMax: true })),
          160,
          40,
        ),
      ].join("");
    const layout = async (stylesheet: string, content: string) => {
      const tab = await (await browser.newContext(viewports.phone)).newPage();
      try {
        // One width and one font for both pages, so only the chart rules differ.
        await tab.setContent(
          `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${stylesheet}</style><style>:root, .k2b-ui { --k2b-font-sans: sans-serif; }</style></head><body><div class="k2b-ui" style="width: 358px">${content}</div></body></html>`,
        );
        // The component takes its height from the caller, as an application sets it.
        await tab.$$eval(".k2b-chart", (elements) => {
          for (const chart of elements as HTMLElement[]) {
            chart.style.height = getComputedStyle(chart.firstElementChild!).getPropertyValue("--k2b-chart-height");
          }
        });
        return await tab.$$eval(".k2b-chart", (elements) =>
          elements.flatMap((chart) => {
            const origin = chart.getBoundingClientRect();
            const parts = [
              chart.querySelector("svg")!,
              ...chart.querySelectorAll(".stdlib-chart-legend-item > *, .stdlib-chart-point, [class*='stdlib-chart-sparkline-']"),
            ];
            return parts.map((part) => {
              const box = part.getBoundingClientRect();
              return {
                part: `${chart.dataset.chartKind} ${part.getAttribute("class")}`,
                box: [box.left - origin.left, box.top - origin.top, box.width, box.height],
              };
            });
          }),
        );
      } finally {
        await tab.context().close();
      }
    };
    const base = await layout(css, markup(withoutStdlibStyle));
    const component = await layout(
      componentCss,
      markup((svg) => svg),
    );
    expect(base.map(({ part }) => part)).toEqual(component.map(({ part }) => part));
    const drift = base.filter(({ box }, index) => box.some((value, side) => Math.abs(value - component[index]!.box[side]!) > 0.5));
    expect(drift).toEqual([]);
    // Each legend label ends before the next swatch starts.
    const legend = base.filter(({ part }) => part.startsWith("line stdlib-chart-legend"));
    expect(legend.length).toBe(6);
    for (let index = 1; index + 1 < legend.length; index += 2) {
      expect(legend[index]!.box[0]! + legend[index]!.box[2]!).toBeLessThan(legend[index + 1]!.box[0]!);
    }
  });

  test("follows the theme attribute live and lets unlayered page rules win", async () => {
    const tab = await open("desktop", "light", { head: "<style>button { background: rgb(1, 2, 3); }</style>" });
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
