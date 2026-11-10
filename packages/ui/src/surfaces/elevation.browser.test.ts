import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { Browser } from "playwright";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, settled } from "../../test/browser";

// The layer model is a cascade of custom properties, so a real engine resolves the shipped stylesheet.
const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-elevation-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: DetailPanel } = await import("../layout/DetailPanel");
const { Toolbar } = await import("../actions/Toolbar");
const { Paper } = await import("./Paper");
const { ResourceCard } = await import("./ResourceCard");
const { DashboardFrame } = await import("../widgets/DashboardFrame");
const { DashboardPanel } = await import("../widgets/Dashboard");
const { StatCell } = await import("./StatCell");

const css = readFileSync(resolve(import.meta.dir, "../../dist/styles.css"), "utf8");

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const paper = (id: string, children?: () => JSX.Element) =>
  createComponent(Paper, {
    id,
    get children(): JSX.Element {
      return children?.() ?? "Content";
    },
  });

const resource = (name: string) =>
  createComponent(ResourceCard, { class: name, state: "ok", title: "Spedition Nord", context: "Task in Team Logistik", href: "#" });

// StatCell takes no id or class, so its label names it.
const stat = (label: string) => createComponent(StatCell, { label, value: 42 });

const markup = () =>
  renderToString(() => [
    paper("main-paper", () => paper("nested-paper")),
    resource("main-resource"),
    stat("main-stat"),
    createComponent(DashboardPanel, {
      id: "main-panel",
      get children() {
        return stat("panel-stat");
      },
    }),
    createComponent(DashboardFrame, {
      title: "Revenue",
      get children() {
        return paper("frame-paper");
      },
    }),
    createComponent(DetailPanel, {
      get children() {
        return createComponent(DetailPanel.Body, {
          get children() {
            return [paper("panel-paper"), resource("panel-resource"), stat("detail-stat")];
          },
        });
      },
    }),
    createComponent(Toolbar, {
      label: "Formatting",
      variant: "floating",
      get children() {
        return createComponent(Toolbar.Action, { label: "Bold", icon: "ti ti-bold" });
      },
    }),
  ]);

const open = async (theme: "light" | "dark") => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await page.setContent(
    `<!doctype html><html><head><style>${css}</style></head><body class="k2b-ui" data-theme="${theme}" style="margin:0;padding:1rem">` +
      `<main>${markup()}</main>` +
      `<aside class="k2b-app-workspace__sidebar"><div class="k2b-paper" id="sidebar-paper">Sidebar</div></aside>` +
      `<section data-k2b-layer="flat"><div class="k2b-paper" id="grid-paper">Grid</div></section>` +
      `<dialog open><div class="k2b-paper" id="dialog-paper">Dialog</div>` +
      // A nested `.k2b-ui` scope inside a flat layer must not bring the main-content default back.
      `<div class="k2b-ui"><div class="k2b-paper" id="scoped-dialog-paper">Scoped</div></div></dialog>` +
      `</body></html>`,
  );
  return page;
};

const read = () => {
  const token = (name: string, property: "boxShadow" | "backgroundColor") => {
    const probe = document.body.appendChild(document.createElement("div"));
    if (property === "boxShadow") probe.style.boxShadow = `var(${name})`;
    else probe.style.backgroundColor = `var(${name})`;
    const value = getComputedStyle(probe)[property];
    probe.remove();
    return value;
  };
  const lookAt = (element: Element) => {
    const style = getComputedStyle(element);
    return { shadow: style.boxShadow, background: style.backgroundColor };
  };
  const look = (selector: string) => lookAt(document.querySelector(selector)!);
  const stat = (label: string) =>
    lookAt([...document.querySelectorAll(".k2b-stat-cell")].find((cell) => cell.textContent?.includes(label))!);
  return {
    raised: token("--k2b-shadow-raised", "boxShadow"),
    toolbarToken: token("--k2b-shadow-toolbar", "boxShadow"),
    raisedSurface: token("--k2b-surface-raised", "backgroundColor"),
    surface: token("--k2b-surface", "backgroundColor"),
    mainPaper: look("#main-paper"),
    nestedPaper: look("#nested-paper"),
    mainResource: look(".main-resource"),
    mainStat: stat("main-stat"),
    mainPanel: look("#main-panel"),
    panelStat: stat("panel-stat"),
    detailStat: stat("detail-stat"),
    frame: look(".k2b-paper:has(> * #frame-paper), .k2b-paper:has(#frame-paper)"),
    framePaper: look("#frame-paper"),
    panelPaper: look("#panel-paper"),
    panelResource: look(".panel-resource"),
    sidebarPaper: look("#sidebar-paper"),
    gridPaper: look("#grid-paper"),
    dialogPaper: look("#dialog-paper"),
    scopedDialogPaper: look("#scoped-dialog-paper"),
    toolbar: getComputedStyle(document.querySelector('.k2b-toolbar[data-variant="floating"]')!).boxShadow,
  };
};

// "No shadow" is a transparent no-op layer, so a ring may list it: `ring, var(--k2b-island-shadow)` stays valid.
const noShadow = "rgba(0, 0, 0, 0) 0px 0px 0px 0px";

describe("@k2b/ui layers and shadows", () => {
  test("light: islands in the main content carry the island shadow; columns, panels, dialogs, dense collections, and islands inside islands are flat", async () => {
    const page = await open("light");
    await settled(page);
    try {
      const r = await page.evaluate(read);
      expect(r.raised).not.toBe(noShadow);
      for (const island of [r.mainPaper, r.mainResource, r.frame, r.mainStat, r.mainPanel]) expect(island.shadow).toBe(r.raised);
      for (const flat of [
        r.nestedPaper,
        r.panelStat,
        r.detailStat,
        r.framePaper,
        r.panelPaper,
        r.panelResource,
        r.sidebarPaper,
        r.gridPaper,
        r.dialogPaper,
        r.scopedDialogPaper,
      ])
        expect(flat.shadow).toBe(noShadow);
      expect(r.mainPaper.background).toBe(r.surface);
      // A floating pill uses the toolbar shadow, softer than a menu's.
      expect(r.toolbar).toBe(r.toolbarToken);
    } finally {
      await page.close();
    }
  });

  test("dark: a lighter surface replaces the island shadow, and flat layers keep the page surface", async () => {
    const page = await open("dark");
    await settled(page);
    try {
      const r = await page.evaluate(read);
      expect(r.raised).toBe(noShadow);
      expect(r.raisedSurface).not.toBe(r.surface);
      for (const island of [r.mainPaper, r.mainResource, r.mainStat, r.mainPanel])
        expect(island).toEqual({ shadow: noShadow, background: r.raisedSurface });
      expect(r.scopedDialogPaper.shadow).toBe(noShadow);
      for (const flat of [r.panelPaper, r.detailStat, r.sidebarPaper, r.gridPaper, r.dialogPaper])
        expect(flat).toEqual({ shadow: noShadow, background: r.surface });
      // An island inside an island takes the same surface, so it reads as one plane.
      expect(r.nestedPaper.background).toBe(r.raisedSurface);
      expect(r.toolbar).toBe(r.toolbarToken);
      expect(r.toolbar).not.toBe("none");
    } finally {
      await page.close();
    }
  });

  for (const theme of ["light", "dark"] as const)
    test(`${theme}: a quiet area (settings, administration) is flat; only charts, dashboard frames, and key figures lift`, async () => {
      const quiet = renderToString(() => [
        paper("quiet-paper"),
        stat("quiet-stat"),
        createComponent(DashboardFrame, {
          title: "Requests",
          get children() {
            return "Chart";
          },
        }),
        paper("quiet-paper-with-stat", () => stat("stat-in-paper")),
      ]);
      const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
      try {
        await page.setContent(
          `<!doctype html><html><head><style>${css}</style></head><body class="k2b-ui" data-theme="${theme}" style="margin:0;padding:1rem">` +
            `<div class="k2b-app-workspace" data-k2b-layer="quiet">${quiet}` +
            `<div class="k2b-section" data-frame="line" id="quiet-section">Form</div>` +
            `<div class="k2b-chart-explorer" id="quiet-chart"><div class="k2b-paper" id="chart-table">Table view</div></div>` +
            `<section data-k2b-layer="flat">${renderToString(() => stat("flat-stat"))}</section></div>` +
            `</body></html>`,
        );
        await settled(page);
        const r = await page.evaluate(() => {
          const value = (element: Element, name: string) => getComputedStyle(element).getPropertyValue(name).trim();
          const look = (element: Element) => ({
            shadow: getComputedStyle(element).boxShadow,
            background: getComputedStyle(element).backgroundColor,
          });
          const byLabel = (label: string) =>
            [...document.querySelectorAll(".k2b-stat-cell")].find((cell) => cell.textContent?.includes(label))!;
          const probe = document.querySelector(".k2b-app-workspace")!.appendChild(document.createElement("i"));
          probe.style.boxShadow = "var(--k2b-shadow-raised)";
          probe.style.backgroundColor = "var(--k2b-surface-raised)";
          const raised = { shadow: getComputedStyle(probe).boxShadow, background: getComputedStyle(probe).backgroundColor };
          probe.style.backgroundColor = "var(--k2b-surface)";
          const surface = getComputedStyle(probe).backgroundColor;
          probe.remove();
          const chart = document.querySelector("#quiet-chart")!;
          return {
            raised,
            surface,
            paper: look(document.querySelector("#quiet-paper")!),
            section: look(document.querySelector("#quiet-section")!),
            stat: look(byLabel("quiet-stat")),
            frame: look(document.querySelector(".k2b-dashboard-frame")!),
            chartHook: value(chart, "--k2b-island-shadow") === value(chart, "--k2b-shadow-raised"),
            chartTable: look(document.querySelector("#chart-table")!),
            statInPaper: look(byLabel("stat-in-paper")),
            flatStat: look(byLabel("flat-stat")),
          };
        });
        const flat = { shadow: noShadow, background: r.surface };
        // Forms, lists, and sections keep their frame without a shadow.
        expect(r.paper).toEqual(flat);
        expect(r.section).toEqual(flat);
        // Data surfaces lift as in the main content: a key figure and a dashboard frame.
        expect(r.stat).toEqual(r.raised);
        expect(r.frame).toEqual(r.raised);
        // A chart carries the island hook, and what it holds stays flat.
        expect(r.chartHook).toBe(true);
        expect(r.chartTable.shadow).toBe(noShadow);
        // A key figure inside another frame or in a flat layer stays flat.
        expect(r.statInPaper.shadow).toBe(noShadow);
        expect(r.flatStat).toEqual(flat);
      } finally {
        await page.close();
      }
    });
});
