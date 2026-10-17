import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "playwright";
import type { createComponent, createSignal } from "solid-js";
import type { Dynamic } from "solid-js/web";
import type AppWorkspace from "../src/layout/AppWorkspace";
import type { AppWorkspaceDetailWidth } from "../src/layout/AppWorkspace";

export const uiDirectory = resolve(import.meta.dir, "..");
export const workspaceDist = process.env.K2B_UI_DIST ?? resolve(uiDirectory, "dist");
export const workspaceCss = () => readFileSync(resolve(workspaceDist, "styles.css"), "utf8");

type Components = {
  AppWorkspace: typeof AppWorkspace;
  createComponent: typeof createComponent;
  createSignal: typeof createSignal;
  Dynamic: typeof Dynamic;
};
export type FixtureOptions = { scenario?: string; detailWidth?: AppWorkspaceDetailWidth };

/** One tree for the baseline, narrowed hosts, and source SSR/dist hydration. */
export function workspaceTree({ AppWorkspace, createComponent, createSignal, Dynamic }: Components, props: FixtureOptions = {}) {
  const [open, setOpen] = createSignal(props.scenario !== "closed");
  const el = (component: string, children: string) => createComponent(Dynamic, { component, children });
  const levels = props.scenario === "levels";
  return createComponent(AppWorkspace, {
    get children() {
      return [
        createComponent(AppWorkspace.Sidebar, {
          id: "folders",
          label: "Mail folders",
          get children() {
            return createComponent(AppWorkspace.SidebarDesktop, {
              get children() {
                return createComponent(AppWorkspace.SidebarBody, {
                  get children() {
                    return ["Inbox", "Sent", "Archive"].map((label) =>
                      createComponent(AppWorkspace.SidebarItem, { href: "#" + label, children: label }),
                    );
                  },
                });
              },
            });
          },
        }),
        createComponent(AppWorkspace.Content, {
          get children() {
            return [
              createComponent(AppWorkspace.Main, {
                level: levels ? "reader" : undefined,
                get children() {
                  return levels
                    ? ["folders", "messages", "reader"].map((id) =>
                        createComponent(AppWorkspace.MainPane, { id, label: id, href: "#" + id, children: el("h2", id) }),
                      )
                    : [
                        createComponent(AppWorkspace.MainPane, {
                          id: "navigation",
                          label: "Navigation",
                          surface: "navigation",
                          children: "Message groups",
                        }),
                        el("button", "Selected message"),
                      ];
                },
              }),
              ...(!levels
                ? [
                    createComponent(AppWorkspace.Detail, {
                      id: "contact",
                      width: props.detailWidth ?? "md",
                      get open() {
                        return open();
                      },
                      onClose: () => {
                        document.body.dataset.closed = String(Number(document.body.dataset.closed ?? 0) + 1);
                        setOpen(false);
                      },
                      get children() {
                        return [el("h2", "Contact"), el("button", "Contact action")];
                      },
                    }),
                  ]
                : []),
            ];
          },
        }),
        ...(!levels
          ? [
              createComponent(AppWorkspace.BottomDrawer, {
                id: "activity",
                open: true,
                children: "Recent activity",
              }),
            ]
          : []),
      ];
    },
  });
}

export const clientFixture = async (includePark = true) => {
  // A saved modular build in /tmp has no node_modules. Copy only its browser
  // modules under this package for dependency resolution; never change the saved build.
  const copy = process.env.K2B_UI_DIST ? mkdtempSync(resolve(uiDirectory, ".workspace-host-dist-")) : null;
  try {
    if (copy) cpSync(resolve(workspaceDist, "browser"), resolve(copy, "browser"), { recursive: true });
    const browserIndex = resolve(copy ?? workspaceDist, "browser/index.js");
    const entry = resolve(uiDirectory, "src/layout/workspace-host.client-fixture.ts");
    const result = await Bun.build({
      entrypoints: [entry],
      files: {
        [entry]: `
        import { createComponent, Dynamic, render } from "solid-js/web";
        import { createSignal } from "solid-js";
        import { AppWorkspace ${includePark ? ", parkWorkspaceDetailDrawers" : ""} } from ${JSON.stringify(browserIndex)};
        const tree = ${workspaceTree.toString()};
        ${includePark ? "window.parkDetails = parkWorkspaceDetailDrawers;" : ""}
        render(() => tree({AppWorkspace, createComponent, createSignal, Dynamic},
          JSON.parse(document.body.dataset.options || "{}")), document.getElementById("app"));
      `,
      },
      target: "browser",
      format: "iife",
    });
    if (!result.success) throw new AggregateError(result.logs, "Could not bundle host fixture");
    return await result.outputs[0]!.text();
  } finally {
    if (copy) rmSync(copy, { recursive: true, force: true });
  }
};

export const workspaceFrames = (page: Page) =>
  page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

/** Coordinates are relative to the host, rounded to 0.01 px for stored baselines. */
export function workspaceGeometry() {
  const origin = document.getElementById("app")!.getBoundingClientRect();
  const rect = (element: Element) => {
    const r = element.getBoundingClientRect();
    const round = (value: number) => Math.round(value * 100) / 100;
    return { x: round(r.x - origin.x), y: round(r.y - origin.y), width: round(r.width), height: round(r.height) };
  };
  const selectors = {
    root: ".k2b-app-workspace",
    head: ".k2b-app-workspace__head",
    sidebar: ".k2b-app-workspace__sidebar",
    main: ".k2b-app-workspace__main",
    regions: "[data-workspace-main-region]",
    detail: ".k2b-app-workspace__detail",
    drawer: ".k2b-app-workspace__drawer",
    toggle: "[data-app-workspace-detail-toggle]",
    handles: "[data-app-workspace-resize]",
  };
  return Object.fromEntries(
    Object.entries(selectors).map(([key, selector]) => [
      key,
      Array.from(document.querySelectorAll<HTMLElement>(selector))
        .filter((element) => key !== "handles" || element.getClientRects().length > 0)
        .map((element) => ({ ...rect(element), display: getComputedStyle(element).display })),
    ]),
  );
}
