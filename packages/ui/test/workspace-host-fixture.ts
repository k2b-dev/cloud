import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "playwright";
import type { createComponent, createSignal } from "solid-js";
import type { Dynamic } from "solid-js/web";
import type { FilterChip, IconButton, PageTrailProvider, ViewTabs } from "../src/index";
import type AppWorkspace from "../src/layout/AppWorkspace";
import type { AppWorkspaceDetailWidth, AppWorkspaceWidthShare } from "../src/layout/AppWorkspace";
import type { AppWorkspaceLayoutState } from "../src/layout/app-workspace-state";

export const uiDirectory = resolve(import.meta.dir, "..");
export const workspaceDist = process.env.K2B_UI_DIST ?? resolve(uiDirectory, "dist");
export const workspaceCss = () => readFileSync(resolve(workspaceDist, "styles.css"), "utf8");

type Components = {
  AppWorkspace: typeof AppWorkspace;
  createComponent: typeof createComponent;
  createSignal: typeof createSignal;
  Dynamic: typeof Dynamic;
  ViewTabs?: typeof ViewTabs;
  FilterChip?: typeof FilterChip;
  IconButton?: typeof IconButton;
  PageTrailProvider?: typeof PageTrailProvider;
};
export type FixtureOptions = {
  scenario?: string;
  selectionDelay?: boolean;
  detailWidth?: AppWorkspaceDetailWidth;
  mainMin?: number | AppWorkspaceWidthShare;
  paneSize?: number | AppWorkspaceWidthShare;
  sidebar?: boolean;
  sidebarActive?: boolean;
  head?: {
    items?: number;
    current?: string;
    filtered?: boolean;
    reset?: "link" | "callback";
    mainHeading?: boolean;
    /** A page at the app's root: the trail has no page above it. */
    root?: boolean;
    actions?: boolean;
    longLabels?: boolean;
    /** Also render a detail of this width beside the head row. */
    detail?: AppWorkspaceDetailWidth;
  };
  layoutState?: AppWorkspaceLayoutState;
};

/** One tree for the baseline, narrowed hosts, and source SSR/dist hydration. */
export function workspaceTree(
  { AppWorkspace, createComponent, createSignal, Dynamic, ViewTabs, FilterChip, IconButton, PageTrailProvider }: Components,
  props: FixtureOptions = {},
) {
  const [open, setOpen] = createSignal(props.scenario !== "closed");
  const [contact, setContact] = createSignal("Contact");
  if (props.scenario === "selection" && typeof window !== "undefined")
    (window as Window & { updateWorkspaceContact?: (title: string) => void }).updateWorkspaceContact = setContact;
  const el = (component: string, children: string) => createComponent(Dynamic, { component, children });
  const levels = props.scenario === "levels";
  const [filtered, setFiltered] = createSignal(props.head?.filtered !== false);
  const [tags, setTags] = createSignal(props.head?.filtered === false ? [] : ["customer"]);
  const head = () => {
    if (!ViewTabs || !FilterChip || !IconButton) throw new Error("Head fixture needs the public head components");
    return createComponent(AppWorkspace.Head, {
      get views() {
        return createComponent(ViewTabs, {
          label: "Views",
          current: props.head?.current ?? "1",
          items: Array.from({ length: props.head?.items ?? 4 }, (_, index) => ({
            id: String(index + 1),
            label:
              (props.head?.longLabels
                ? ["Needs action", "Assigned to me", "Waiting for a reply", "Not assigned", "Snoozed", "Done", "Recent activity", "Kept"]
                : ["List", "Board", "Calendar", "Timeline", "Files", "Activity", "Overview", "Archive"])[index] ?? `View ${index + 1}`,
            href: `?view=${index + 1}`,
            count: index === 0 ? 12 : index === 7 ? 3 : undefined,
          })),
        });
      },
      get filters() {
        return [
          createComponent(FilterChip, {
            showValue: true,
            label: "Tags",
            icon: "ti ti-tag",
            get value() {
              return tags();
            },
            onValueChange: (value) => {
              setTags(value);
              setFiltered(value.length > 0);
            },
            options: [{ multiple: true, options: [{ value: "customer", label: "Customer", color: "#16a34a" }] }],
          }),
          createComponent(FilterChip, {
            showValue: true,
            label: "Status",
            icon: "ti ti-filter",
            value: [],
            onValueChange: () => {},
            options: [{ options: [{ value: "open", label: "Open" }] }],
          }),
        ];
      },
      get filtered() {
        return filtered();
      },
      resetHref: props.head?.reset === "callback" ? undefined : "?view=1",
      onReset:
        props.head?.reset === "callback"
          ? () => {
              setTags([]);
              setFiltered(false);
              document.body.dataset.resetCalls = String(Number(document.body.dataset.resetCalls ?? 0) + 1);
            }
          : undefined,
      count: "12 results",
      get actions() {
        if (props.head?.actions === false) return undefined;
        return createComponent(IconButton, {
          label: "Search",
          size: "sm",
          variant: "ghost",
          get children() {
            return createComponent(Dynamic, { component: "i", class: "ti ti-search", "aria-hidden": "true" });
          },
        });
      },
      primary: props.head?.actions === false ? undefined : { label: "New task", icon: "ti ti-plus", href: "?new=task" },
    });
  };
  const tree = () =>
    createComponent(AppWorkspace, {
      layoutState: () => props.layoutState,
      get children() {
        return [
          props.head ? head() : null,
          props.sidebar === false
            ? null
            : createComponent(AppWorkspace.Sidebar, {
                id: "folders",
                label: "Mail folders",
                get children() {
                  return createComponent(AppWorkspace.SidebarDesktop, {
                    get children() {
                      return createComponent(AppWorkspace.SidebarBody, {
                        get children() {
                          return ["Inbox", "Sent", "Archive"].map((label) =>
                            createComponent(AppWorkspace.SidebarItem, {
                              href: "#" + label,
                              active: props.sidebarActive && label === "Inbox",
                              children: label,
                            }),
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
                  minWidth: props.mainMin,
                  get children() {
                    if (props.head)
                      return [
                        props.head.mainHeading ? el("h1", "Inbox") : null,
                        ...Array.from({ length: 80 }, (_, index) =>
                          createComponent(Dynamic, { component: "p", style: "min-height:44px", children: `Task ${index + 1}` }),
                        ),
                        createComponent(Dynamic, { component: "button", children: "Last control" }),
                      ];
                    return levels
                      ? ["folders", "messages", "reader"].map((id) =>
                          createComponent(AppWorkspace.MainPane, { id, label: id, href: "#" + id, children: el("h2", id) }),
                        )
                      : [
                          createComponent(AppWorkspace.MainPane, {
                            id: "navigation",
                            label: "Navigation",
                            surface: "navigation",
                            defaultSize: props.paneSize,
                            children: "Message groups",
                          }),
                          createComponent(Dynamic, { component: "button", children: "Selected message", onClick: () => setOpen(true) }),
                          ...(props.scenario === "selection"
                            ? [
                                createComponent(Dynamic, {
                                  component: "button",
                                  children: "Another message",
                                  onClick: (event: MouseEvent) => {
                                    const item = event.currentTarget;
                                    if (item instanceof HTMLElement) {
                                      const mark = () => item.setAttribute("aria-current", "true");
                                      if (props.selectionDelay)
                                        (window as Window & { markWorkspaceSelection?: () => void }).markWorkspaceSelection = mark;
                                      else mark();
                                    }
                                    setContact("Another contact");
                                  },
                                }),
                              ]
                            : []),
                        ];
                  },
                }),
                ...(!levels && (!props.head || props.head.detail)
                  ? [
                      createComponent(AppWorkspace.Detail, {
                        id: "contact",
                        width: props.head?.detail ?? props.detailWidth ?? "md",
                        get open() {
                          return open();
                        },
                        onClose: () => {
                          document.body.dataset.closed = String(Number(document.body.dataset.closed ?? 0) + 1);
                          setOpen(false);
                        },
                        get children() {
                          return [
                            props.scenario === "selection"
                              ? createComponent(Dynamic, {
                                  component: "h2",
                                  get children() {
                                    return contact();
                                  },
                                })
                              : el("h2", "Contact"),
                            el("button", "Contact action"),
                          ];
                        },
                      }),
                    ]
                  : []),
              ];
            },
          }),
          ...(!levels && !props.head
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
  if (props.head) {
    if (!PageTrailProvider) throw new Error("Head fixture needs PageTrailProvider");
    return createComponent(PageTrailProvider, {
      trail: { title: "Inbox", ancestors: props.head?.root ? [] : [{ title: "Mailboxes", href: "/mail" }] },
      get children() {
        return tree();
      },
    });
  }
  return tree();
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
        import { AppWorkspace, ViewTabs, FilterChip, IconButton, PageTrailProvider ${includePark ? ", parkWorkspaceDetailDrawers" : ""} } from ${JSON.stringify(browserIndex)};
        const tree = ${workspaceTree.toString()};
        ${includePark ? "window.parkDetails = parkWorkspaceDetailDrawers;" : ""}
        render(() => tree({AppWorkspace, ViewTabs, FilterChip, IconButton, PageTrailProvider, createComponent, createSignal, Dynamic},
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
