import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { browserName, launchBrowser, settled } from "../../test/browser";

// The chevron's place depends on real flex layout, which happy-dom does not model.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "sidebar-section-chevron.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { AppWorkspace, IconButton } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const item = (label) => createComponent(AppWorkspace.SidebarItem, { href: "#" + label, children: label });
const section = (props) => createComponent(AppWorkspace.SidebarSection, { collapsible: true, ...props, get children() { return item(props.title + " row"); } });
render(
  () => createComponent(AppWorkspace, {
    resizable: false,
    get children() {
      return [
        createComponent(AppWorkspace.Sidebar, {
          id: "navigation", label: "Navigation",
          get children() {
            return createComponent(AppWorkspace.SidebarDesktop, {
              get children() {
                return createComponent(AppWorkspace.SidebarBody, {
                  sidebarMode: "expanded",
                  get children() {
                    return [
                      section({ title: "With actions", actions: createComponent(IconButton, { label: "Section actions", variant: "ghost", size: "sm", children: "+" }) }),
                      section({ title: "Plain" }),
                      section({ title: "With count", count: 12 }),
                      section({ title: "Closed", defaultOpen: false }),
                    ];
                  },
                });
              },
            });
          },
        }),
        createComponent(AppWorkspace.Content, { get children() { return createComponent(AppWorkspace.Main, { children: "Board" }); } }),
      ];
    },
  }),
  document.getElementById("app"),
);
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the sidebar section fixture for the browser.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

describe(`@k2b/ui sidebar section chevrons (${browserName})`, () => {
  test("every collapsible header ends in one chevron column, with or without actions and counts, and it still toggles", async () => {
    const page = await browser.newPage({ viewport: { width: 1366, height: 800 } });
    try {
      await page.setContent(
        `<!doctype html><html lang="en"><head><style>${css}</style></head>` +
          `<body class="k2b-ui" style="margin:0"><div id="app" style="height:40rem"></div></body></html>`,
      );
      await page.addScriptTag({ content: script });
      await page.locator(".k2b-app-workspace__sidebar-section-chevron").nth(3).waitFor();
      await settled(page);
      const edges = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".k2b-app-workspace__sidebar-section-header")).map((header) => {
          const chevron = header.querySelector(".k2b-app-workspace__sidebar-section-chevron i")!.getBoundingClientRect();
          const box = header.getBoundingClientRect();
          return {
            right: Math.round(chevron.right * 2) / 2,
            header: Math.round(box.right * 2) / 2,
            last: header.lastElementChild?.className,
          };
        }),
      );
      expect(edges).toHaveLength(4);
      expect(new Set(edges.map((edge) => edge.right)).size).toBe(1);
      for (const edge of edges) {
        expect(edge.last).toBe("k2b-app-workspace__sidebar-section-chevron");
        expect(edge.header - edge.right).toBeLessThanOrEqual(1);
      }
      // A pointer on the chevron toggles like the heading; the heading stays the keyboard control.
      const closed = page.locator(".k2b-app-workspace__sidebar-section").nth(3);
      await closed.locator(".k2b-app-workspace__sidebar-section-chevron").click();
      expect(await closed.locator(".k2b-app-workspace__sidebar-section-toggle").getAttribute("aria-expanded")).toBe("true");
      await closed.locator(".k2b-app-workspace__sidebar-section-toggle").focus();
      await page.keyboard.press("Enter");
      expect(await closed.locator(".k2b-app-workspace__sidebar-section-toggle").getAttribute("aria-expanded")).toBe("false");
    } finally {
      await page.close();
    }
  }, 30_000);
});
