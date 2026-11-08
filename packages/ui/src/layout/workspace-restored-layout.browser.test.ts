import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { launchBrowser } from "../../test/browser";

// The restored layout is the workspace's first frame. Afterwards the controller owns the sizes, so an
// unrelated rerender of the root, such as a class that follows the current view, must not restore the
// widths of the first frame again: Files' sidebar fell back to them for two frames on every folder change.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "workspace-restored-layout.fixture.ts");
const fixture = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { AppWorkspace, LocaleProvider } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const [view, setView] = createSignal("list");
window.setView = setView;
render(
  () =>
    createComponent(LocaleProvider, {
      locale: "en",
      get children() {
        // As in Cloud: the host restores the saved layout through the provider.
        return createComponent(AppWorkspace.LayoutStateProvider, {
          state: { version: 2, sidebarWidth: 248 },
          get children() {
            return createComponent(AppWorkspace, {
              get class() {
                return "view-" + view();
              },
              get children() {
                return [
                  createComponent(AppWorkspace.Sidebar, {
                    id: "navigation",
                    label: "Navigation",
                    defaultSize: 248,
                    get children() {
                      return createComponent(AppWorkspace.SidebarDesktop, {
                        get children() {
                          return createComponent(AppWorkspace.SidebarBody, {
                            get children() {
                              return createComponent(AppWorkspace.SidebarItem, { href: "#files", icon: "ti ti-folder", children: "Files" });
                            },
                          });
                        },
                      });
                    },
                  }),
                  createComponent(AppWorkspace.Content, {
                    get children() {
                      return createComponent(AppWorkspace.Main, { children: "Files" });
                    },
                  }),
                ];
              },
            });
          },
        });
      },
    }),
  document.getElementById("app"),
);
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the restored layout fixture for the browser.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

test("a resized sidebar keeps its width on every frame while the workspace root rerenders", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  try {
    await page.setContent(
      `<!doctype html><html lang="en"><head><style>${css}</style><style>*,*::before,*::after{transition:none!important;animation:none!important}</style></head>` +
        `<body class="k2b-ui" style="margin:0"><div id="app" style="height:40rem"></div></body></html>`,
    );
    await page.addScriptTag({ content: script });
    const handle = page.getByRole("separator", { name: "Resize navigation" });
    await handle.waitFor();
    expect(Math.round((await page.locator("#navigation").boundingBox())!.width)).toBe(248);
    // The person widens the sidebar: the controller now owns 280 px.
    await handle.focus();
    for (let step = 0; step < 4; step++) await page.keyboard.press("ArrowRight");
    const resized = await page.evaluate(() => ({
      sidebar: document.querySelector("#navigation")!.getBoundingClientRect().width,
      content: document.querySelector(".k2b-app-workspace__content")!.getBoundingClientRect().left,
    }));
    expect(resized.sidebar).toBe(280);
    const frames = await page.evaluate(async () => {
      const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const host = window as unknown as { setView: (view: string) => void };
      const seen: { sidebar: number; content: number }[] = [];
      for (const view of ["detail", "list", "activity", "list"]) {
        host.setView(view);
        for (let frame = 0; frame < 3; frame++) {
          seen.push({ sidebar: box("#navigation").width, content: box(".k2b-app-workspace__content").left });
          await new Promise(requestAnimationFrame);
        }
      }
      return seen;
    });
    expect(frames.length).toBe(12);
    expect(frames.filter((frame) => frame.sidebar !== resized.sidebar || frame.content !== resized.content)).toEqual([]);
  } finally {
    await page.close();
  }
}, 30_000);
