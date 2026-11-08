import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { Browser } from "playwright";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser } from "../../test/browser";

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

const markup = () =>
  renderToString(() => [
    paper("main-paper", () => paper("nested-paper")),
    resource("main-resource"),
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
            return [paper("panel-paper"), resource("panel-resource")];
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
      `<dialog open><div class="k2b-paper" id="dialog-paper">Dialog</div></dialog>` +
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
  const look = (selector: string) => {
    const style = getComputedStyle(document.querySelector(selector)!);
    return { shadow: style.boxShadow, background: style.backgroundColor };
  };
  return {
    raised: token("--k2b-shadow-raised", "boxShadow"),
    toolbarToken: token("--k2b-shadow-toolbar", "boxShadow"),
    raisedSurface: token("--k2b-surface-raised", "backgroundColor"),
    surface: token("--k2b-surface", "backgroundColor"),
    mainPaper: look("#main-paper"),
    nestedPaper: look("#nested-paper"),
    mainResource: look(".main-resource"),
    frame: look(".k2b-paper:has(> * #frame-paper), .k2b-paper:has(#frame-paper)"),
    framePaper: look("#frame-paper"),
    panelPaper: look("#panel-paper"),
    panelResource: look(".panel-resource"),
    sidebarPaper: look("#sidebar-paper"),
    gridPaper: look("#grid-paper"),
    dialogPaper: look("#dialog-paper"),
    toolbar: getComputedStyle(document.querySelector('.k2b-toolbar[data-variant="floating"]')!).boxShadow,
  };
};

describe("@k2b/ui layers and shadows", () => {
  test("light: islands in the main content carry the island shadow; columns, panels, dialogs, dense collections, and islands inside islands are flat", async () => {
    const page = await open("light");
    try {
      const r = await page.evaluate(read);
      expect(r.raised).not.toBe("none");
      for (const island of [r.mainPaper, r.mainResource, r.frame]) expect(island.shadow).toBe(r.raised);
      for (const flat of [r.nestedPaper, r.framePaper, r.panelPaper, r.panelResource, r.sidebarPaper, r.gridPaper, r.dialogPaper])
        expect(flat.shadow).toBe("none");
      expect(r.mainPaper.background).toBe(r.surface);
      // A floating pill uses the toolbar shadow, softer than a menu's.
      expect(r.toolbar).toBe(r.toolbarToken);
    } finally {
      await page.close();
    }
  });

  test("dark: a lighter surface replaces the island shadow, and flat layers keep the page surface", async () => {
    const page = await open("dark");
    try {
      const r = await page.evaluate(read);
      expect(r.raised).toBe("none");
      expect(r.raisedSurface).not.toBe(r.surface);
      for (const island of [r.mainPaper, r.mainResource]) expect(island).toEqual({ shadow: "none", background: r.raisedSurface });
      for (const flat of [r.panelPaper, r.sidebarPaper, r.gridPaper, r.dialogPaper])
        expect(flat).toEqual({ shadow: "none", background: r.surface });
      // An island inside an island takes the same surface, so it reads as one plane.
      expect(r.nestedPaper.background).toBe(r.raisedSurface);
      expect(r.toolbar).toBe(r.toolbarToken);
      expect(r.toolbar).not.toBe("none");
    } finally {
      await page.close();
    }
  });
});
