import type { createComponent } from "solid-js";
import type { Dynamic } from "solid-js/web";
import type { IconButton, PageTrailProvider, ViewTabs } from "../src/index";
import type AppWorkspace from "../src/layout/AppWorkspace";

type Components = {
  AppWorkspace: typeof AppWorkspace;
  IconButton: typeof IconButton;
  PageTrailProvider: typeof PageTrailProvider;
  ViewTabs: typeof ViewTabs;
  createComponent: typeof createComponent;
  Dynamic: typeof Dynamic;
};

export type HeadOverlayOptions = {
  /** A page with a page above it; otherwise the app's root page. */
  up?: boolean;
  /** The sidebar marks the page. */
  marked?: boolean;
  /** The list's toolbar starts with `AppWorkspace.SidebarToggle`. */
  toolbarToggle?: boolean;
  /** An `AppWorkspace.Head` row with views instead of the list's toolbar. */
  headRow?: boolean;
  /** Main renders its own `h1`. */
  mainHeading?: boolean;
};

/**
 * An inbox like the ones that showed a title row beside the overlay sidebar:
 * a sidebar of places, a list column whose first row holds search, a view
 * pill, and "…", and a reader. Self-contained, so the client bundle can embed
 * it with `toString()`.
 */
export function headOverlayTree(
  { AppWorkspace, IconButton, PageTrailProvider, ViewTabs, createComponent, Dynamic }: Components,
  options: HeadOverlayOptions = {},
) {
  const el = (component: string, props: Record<string, unknown>) => createComponent(Dynamic, { component, ...props });
  const icon = (name: string) => el("i", { class: `ti ${name}`, "aria-hidden": "true" });
  const people = ["Kirsten Sanmann", "Jonas Albrecht", "Mira Okafor", "Paul Lindqvist", "Ada Brenner", "Tomás Reyes", "Lea Hoffmann"];
  const toolbar = () =>
    el("div", {
      "data-list-toolbar": "",
      style: "display:flex;align-items:center;gap:8px;padding:12px 12px 4px",
      get children() {
        return [
          options.toolbarToggle ? createComponent(AppWorkspace.SidebarToggle, { size: "sm" }) : null,
          createComponent(IconButton, { label: "Search", size: "sm", class: "fixture-search", children: icon("ti-search") }),
          el("button", {
            type: "button",
            "data-pill": "",
            style:
              "display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:999px;border:1px solid var(--k2b-action);background:var(--k2b-selected);color:var(--k2b-action);font:600 13px/1.4 system-ui",
            children: "Needs action 127",
          }),
          el("span", { style: "flex:1" }),
          createComponent(IconButton, { label: "More", size: "sm", children: icon("ti-dots") }),
        ];
      },
    });
  const rows = () =>
    people.map((name, index) =>
      el("div", {
        style: "display:flex;gap:12px;align-items:center;min-height:44px;padding:0 12px;font:14px/1.4 system-ui",
        get children() {
          return [
            el("strong", { style: "flex:1", children: name }),
            el("span", { style: "color:var(--k2b-text-muted)", children: ["By mail", "Phone", "Visit"][index % 3] }),
          ];
        },
      }),
    );
  const sidebar = () =>
    createComponent(AppWorkspace.Sidebar, {
      id: "places",
      label: "Places",
      get children() {
        return createComponent(AppWorkspace.SidebarDesktop, {
          get children() {
            return createComponent(AppWorkspace.SidebarBody, {
              get children() {
                return ["Inbox", "Calls", "To-dos", "Contracts"].map((label) =>
                  createComponent(AppWorkspace.SidebarItem, {
                    href: `#${label}`,
                    active: options.marked && label === "Inbox",
                    children: label,
                  }),
                );
              },
            });
          },
        });
      },
    });
  const head = () =>
    createComponent(AppWorkspace.Head, {
      get views() {
        return createComponent(ViewTabs, {
          label: "Views",
          current: "action",
          items: [
            { id: "action", label: "Needs action", href: "?view=action", count: 127 },
            { id: "waiting", label: "Waiting", href: "?view=waiting" },
            { id: "done", label: "Done", href: "?view=done" },
          ],
        });
      },
      get actions() {
        return createComponent(IconButton, { label: "Search", size: "sm", children: icon("ti-search") });
      },
    });
  const tree = () =>
    createComponent(AppWorkspace, {
      get children() {
        return [
          sidebar(),
          options.headRow ? head() : null,
          createComponent(AppWorkspace.Content, {
            get children() {
              return createComponent(AppWorkspace.Main, {
                scroll: false,
                get children() {
                  return [
                    createComponent(AppWorkspace.MainPane, {
                      id: "list",
                      label: "Inbox",
                      defaultSize: 360,
                      get children() {
                        return [
                          options.mainHeading ? el("h1", { style: "margin:12px", children: "Inbox" }) : null,
                          options.headRow ? null : toolbar(),
                          ...rows(),
                        ];
                      },
                    }),
                    createComponent(AppWorkspace.MainPane, {
                      id: "reader",
                      label: "Conversation",
                      get children() {
                        return el("p", {
                          style: "padding:16px;font:14px/1.5 system-ui",
                          children: "Kirsten Sanmann asked about the delivery date.",
                        });
                      },
                    }),
                  ];
                },
              });
            },
          }),
        ];
      },
    });
  return createComponent(PageTrailProvider, {
    trail: { title: "Inbox", ancestors: options.up ? [{ title: "Customers", href: "/customers" }] : [] },
    get children() {
      return tree();
    },
  });
}
