import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { Browser } from "playwright";
import { createComponent } from "solid-js";
import { Dynamic, renderToString } from "solid-js/web";
import { launchBrowser } from "../../test/browser";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-sidebar-reload-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: AppWorkspace } = await import("./AppWorkspace");
const { Button, IconButton } = await import("../actions/Button");
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");

type TreeComponents = {
  AppWorkspace: typeof AppWorkspace;
  Button: typeof Button;
  IconButton: typeof IconButton;
  createComponent: typeof createComponent;
  Dynamic: typeof Dynamic;
};

// The source components on the server and shipped browser components use one tree.
function tree({ AppWorkspace, Button, IconButton, createComponent, Dynamic }: TreeComponents, { flat }: { flat: boolean }) {
  return createComponent(AppWorkspace, {
    flat,
    resizable: false,
    get children() {
      return [
        createComponent(AppWorkspace.Sidebar, {
          id: "fixture-sidebar",
          label: "Mail navigation",
          get children() {
            return createComponent(AppWorkspace.SidebarDesktop, {
              get children() {
                return [
                  createComponent(AppWorkspace.SidebarSwitcher, {
                    currentId: "team",
                    label: "Team",
                    description: "team@example.com",
                    icon: "ti-mail",
                    switchLabel: "Switch mailbox",
                  }),
                  createComponent(Dynamic, {
                    component: "div",
                    style: "display:flex;gap:0.5rem;padding:0.5rem;flex-shrink:0",
                    get children() {
                      return [
                        createComponent(Button, { children: "Compose", class: "flex-1" }),
                        createComponent(IconButton, { label: "Details", children: "i" }),
                      ];
                    },
                  }),
                  createComponent(AppWorkspace.SidebarBody, {
                    get children() {
                      return Array.from({ length: 3 }, (_, section) =>
                        createComponent(AppWorkspace.SidebarSection, {
                          title: `Section ${section + 1}`,
                          get children() {
                            return Array.from({ length: 20 }, (_, row) => {
                              const index = section * 20 + row + 1;
                              return createComponent(AppWorkspace.SidebarItem, {
                                href: `#row-${index}`,
                                active: index === 30,
                                children: `Row ${index}`,
                              });
                            });
                          },
                        }),
                      );
                    },
                  }),
                  createComponent(AppWorkspace.SidebarFooter, {
                    get children() {
                      return createComponent(AppWorkspace.SidebarItem, { href: "#settings", children: "Settings" });
                    },
                  }),
                ];
              },
            });
          },
        }),
        createComponent(AppWorkspace.Content, {
          get children() {
            return createComponent(AppWorkspace.Main, { children: "Mailbox content" });
          },
        }),
      ];
    },
  });
}

function measure() {
  const desktop = document.querySelector<HTMLElement>(".k2b-app-workspace__sidebar-desktop")!;
  const body = desktop.querySelector<HTMLElement>(".k2b-app-workspace__sidebar-body")!;
  const footer = desktop.querySelector<HTMLElement>(".k2b-app-workspace__sidebar-footer")!;
  const headers = Array.from(desktop.children).slice(0, Array.from(desktop.children).indexOf(body));
  const rect = (element: Element) => {
    const bounds = element.getBoundingClientRect();
    return {
      top: Math.round(bounds.top),
      right: Math.round(bounds.right),
      bottom: Math.round(bounds.bottom),
      left: Math.round(bounds.left),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    };
  };
  return {
    headers: headers.map(rect),
    body: rect(body),
    footer: rect(footer),
    items: Array.from(body.querySelectorAll(".k2b-app-workspace__sidebar-item")).map(rect),
    current: rect(body.querySelector('[aria-current="page"]')!),
    scrollTop: body.scrollTop,
    fade: body.getAttribute("data-scroll-fade"),
    overflowing: body.scrollHeight > body.clientHeight,
    headersHit: headers.map((header) => {
      const bounds = header.getBoundingClientRect();
      return header.contains(document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2));
    }),
  };
}

declare global {
  interface Window {
    measure: typeof measure;
    serverFrame: ReturnType<typeof measure>;
    clientFrame: ReturnType<typeof measure>;
    settledFrame: ReturnType<typeof measure>;
  }
}

const entry = resolve(import.meta.dir, "sidebar-reload.fixture.ts");
const fixture = `
import { createComponent, Dynamic, render } from "solid-js/web";
import { AppWorkspace, Button, IconButton } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const tree = ${tree};
const island = document.getElementById("island");
// Mirror packages/ssr/src/mount.ts: islands replace server markup with a client render.
island.innerHTML = "";
render(() => tree({ AppWorkspace, Button, IconButton, createComponent, Dynamic }, { flat: document.body.dataset.flat === "true" }), island);
window.clientFrame = window.measure();
requestAnimationFrame(() => requestAnimationFrame(() => { window.settledFrame = window.measure(); }));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the sidebar reload fixture.");
const client = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const cases = [
  { width: 1366, height: 768, flat: false, hasTouch: false, inset: false },
  { width: 1366, height: 768, flat: true, hasTouch: false, inset: false },
  { width: 1180, height: 820, flat: false, hasTouch: true, inset: false },
  { width: 1180, height: 820, flat: true, hasTouch: true, inset: false },
  { width: 1180, height: 820, flat: false, hasTouch: true, inset: true },
  { width: 820, height: 1180, flat: false, hasTouch: true, inset: false },
  { width: 820, height: 1180, flat: true, hasTouch: true, inset: false },
];

describe("island sidebar reload keeps the server and client frames identical", () => {
  for (const { width, height, flat, hasTouch, inset } of cases) {
    test(`${width}x${height} ${flat ? "flat" : "framed"}${inset ? " installed-app inset" : ""}`, async () => {
      const page = await browser.newPage({ viewport: { width, height }, hasTouch, isMobile: hasTouch });
      try {
        const markup = renderToString(() => tree({ AppWorkspace, Button, IconButton, createComponent, Dynamic }, { flat }));
        const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}${inset ? ".k2b-ui .k2b-app-workspace{--k2b-workspace-inset-bottom:20px}" : ""}</style></head>
<body class="k2b-ui" data-flat="${flat}" style="margin:0">
<div style="height:100dvh;display:flex;flex-direction:column">
<solid-island id="island" style="display:contents">${markup}</solid-island></div>
<script>window.measure = ${measure}; requestAnimationFrame(() => { window.serverFrame = window.measure(); });</script>
</body></html>`;
        await page.route("http://sidebar.test/**", (route) =>
          route.fulfill(
            route.request().url().endsWith("/client.js")
              ? { contentType: "text/javascript", body: client }
              : { contentType: "text/html", body: html },
          ),
        );
        await page.goto("http://sidebar.test/app/fixture");
        await page.addScriptTag({ url: "http://sidebar.test/client.js" });
        await page.waitForFunction(() => !!window.settledFrame);
        const expected = await page.locator('.k2b-app-workspace__sidebar-body [aria-current="page"]').evaluate((current) => {
          current.scrollIntoView({ block: "center" });
          return current.closest(".k2b-app-workspace__sidebar-body")!.scrollTop;
        });
        expect(expected).toBeGreaterThan(0);

        await page.reload();
        await page.waitForFunction(() => !!window.serverFrame);
        await page.addScriptTag({ url: "http://sidebar.test/client.js" });
        await page.waitForFunction(() => !!window.settledFrame);
        const { serverFrame, clientFrame, settledFrame } = await page.evaluate(() => ({
          serverFrame: window.serverFrame,
          clientFrame: window.clientFrame,
          settledFrame: window.settledFrame,
        }));
        expect(serverFrame.scrollTop).toBe(expected);
        expect(clientFrame).toEqual(serverFrame);
        expect(settledFrame).toEqual(clientFrame);
        for (const frame of [serverFrame, clientFrame, settledFrame]) {
          expect(frame.overflowing).toBe(true);
          expect(frame.fade).toBe("both");
          for (const header of frame.headers) expect(frame.body.top).toBeGreaterThanOrEqual(header.bottom);
          expect(frame.footer.top).toBeGreaterThanOrEqual(frame.body.bottom);
          expect(frame.current.top).toBeGreaterThanOrEqual(frame.body.top);
          expect(frame.current.bottom).toBeLessThanOrEqual(frame.body.bottom);
          // Portrait uses a closed compact overlay outside the viewport.
          if (width > 1000) expect(frame.headersHit).toEqual(frame.headers.map(() => true));
        }
      } finally {
        await page.close();
      }
    }, 20_000);
  }
});
