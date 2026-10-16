import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { AppWorkspaceMainPaneProps, AppWorkspaceMainProps } from "./AppWorkspace";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-levels-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: AppWorkspace } = await import("./AppWorkspace");
const { LocaleProvider } = await import("../intl/locale");
const panes = (count = 3): AppWorkspaceMainPaneProps[] =>
  ["sections", "items", "item"].slice(0, count).map((id) => ({ id, label: id, href: `/?level=${id}`, children: `Body ${id}` }));
const main = (props: Omit<AppWorkspaceMainProps, "children">, levels = panes()) =>
  createComponent(AppWorkspace.Main, {
    ...props,
    get children() {
      return levels.map((pane) => createComponent(AppWorkspace.MainPane, pane));
    },
  });
const attributes = (html: string, tag: string, name: string) =>
  [...html.matchAll(new RegExp(`<${tag}[^>]*>`, "g"))]
    .filter(([element]) => element.includes(`${name}=`))
    .map(([element]) => Object.fromEntries([...element.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value])));
const cases = [
  {
    level: "sections",
    expected: [
      ["1 2 3", "", "1"],
      ["2 3", "", "2"],
      ["3", "", "3"],
    ],
    handles: ["2 3", "3"],
  },
  {
    level: "items",
    expected: [
      ["2 3", "", ""],
      ["1 2 3", "1", "1 2"],
      ["3", "", "3"],
    ],
    handles: ["2 3", "3"],
  },
  {
    level: "item",
    expected: [
      ["3", "", ""],
      ["2 3", "2", ""],
      ["1 2 3", "1", "1 2 3"],
    ],
    handles: ["3", "2 3"],
  },
];
describe("AppWorkspace ordered levels SSR", () => {
  for (const { level, expected, handles } of cases)
    test(`three levels selected at ${level}`, () => {
      const html = renderToString(() => main({ level, mobilePane: "ignored" }));
      expect(html).toContain('data-workspace-levels=""');
      expect(html).toContain('data-workspace-level-count="3"');
      expect(html).not.toContain("data-mobile-pane");
      const sections = attributes(html, "section", "data-workspace-level");
      expect(
        sections.map((attrs) => [
          attrs["data-workspace-level-shown"],
          attrs["data-workspace-level-first"],
          attrs["data-workspace-level-last"],
        ]),
      ).toEqual(expected);
      expect(sections.map((attrs) => attrs["data-workspace-level"])).toEqual(["1", "2", "3"]);
      expect(sections.map((attrs) => attrs["data-workspace-mobile-active"])).toEqual(
        expected.map(([shown]) => (shown!.split(" ").includes("1") ? "true" : "false")),
      );
      const separators = attributes(html, "button", "data-app-workspace-resize");
      expect(separators.map((attrs) => attrs["data-workspace-level-shown"])).toEqual(handles);
      expect(separators.map((attrs) => attrs["data-workspace-resize-edge"])).toEqual(["end", "end"]);
    });
  for (const level of ["sections", "items"])
    test(`two levels selected at ${level}`, () => {
      const html = renderToString(() => main({ level }, panes(2)));
      expect(html).toContain('data-workspace-level-count="2"');
      expect(
        attributes(html, "section", "data-workspace-level").map((attrs) => [
          attrs["data-workspace-level-shown"],
          attrs["data-workspace-level-first"],
          attrs["data-workspace-level-last"],
        ]),
      ).toEqual(
        level === "sections"
          ? [
              ["1 2 3", "", "1"],
              ["2 3", "", "2 3"],
            ]
          : [
              ["2 3", "", ""],
              ["1 2 3", "1", "1 2 3"],
            ],
      );
      expect(attributes(html, "button", "data-app-workspace-resize").map((attrs) => attrs["data-workspace-level-shown"])).toEqual(["2 3"]);
    });
  test("an unknown id selects the first open level", () => {
    expect(renderToString(() => main({ level: "unknown" }))).toBe(renderToString(() => main({ level: "sections" })));
  });
  test("closed panes do not count as levels or require href", () => {
    const html = renderToString(() => main({ level: "item" }, [{ ...panes()[0]!, open: false, href: undefined }, ...panes().slice(1)]));
    expect(html).toContain('data-workspace-level-count="2"');
    expect(attributes(html, "section", "data-workspace-level").map((attrs) => attrs["data-workspace-main-region"])).toEqual([
      "items",
      "item",
    ]);
  });
  for (const [locale, prefix] of [
    ["en", "Back to"],
    ["de", "Zurück zu"],
  ])
    test(`back links have names and the selected parent's URL in ${locale}`, () => {
      const html = renderToString(() =>
        createComponent(LocaleProvider, {
          locale: locale!,
          get children() {
            return main({ level: "item" });
          },
        }),
      );
      expect(attributes(html, "a", "href").map((attrs) => [attrs.href, attrs["aria-label"]])).toEqual([
        ["/?level=items", `${prefix} sections`],
        ["/?level=items", `${prefix} items`],
      ]);
      expect(html).toContain('aria-hidden="true"');
    });
  test("the first selection has no back step", () => {
    expect(renderToString(() => main({ level: "sections" }))).not.toContain("k2b-app-workspace__level-back");
  });
  test("renders a head, description, actions and a separate scroll body", () => {
    const html = renderToString(() =>
      main({ level: "one" }, [
        { id: "one", label: "Title", description: "Quiet description", actions: "Controls", scroll: false, children: "Content" },
      ]),
    );
    expect(html).toContain('<h2 tabindex="-1">Title</h2>');
    expect(html).toContain("<p>Quiet description</p>");
    expect(html).toContain('class="k2b-app-workspace__level-actions">Controls');
    expect(html).toContain('class="k2b-app-workspace__level-body" data-scroll="false"');
    expect(attributes(html, "section", "aria-label")[0]?.["aria-label"]).toBe("Title");
  });
  // A second read of a JSX prop builds it again, so the client cannot hydrate
  // the server markup. Each slot renders exactly once.
  test("builds the description and actions once, and not for a closed level", () => {
    let built = 0;
    const counted = (text: string) => () => {
      built += 1;
      return text;
    };
    const html = renderToString(() =>
      main({ level: "one" }, [
        {
          id: "one",
          label: "Title",
          get description() {
            return createComponent(counted("Quiet description"), {});
          },
          get actions() {
            return createComponent(counted("Controls"), {});
          },
          children: "Content",
        },
        {
          id: "closed",
          label: "Closed",
          open: false,
          get actions() {
            return createComponent(counted("Closed controls"), {});
          },
          children: "Closed content",
        },
      ]),
    );
    expect(html).not.toContain("Closed controls");
    expect(html).toContain("<p>Quiet description</p>");
    expect(html).toContain('class="k2b-app-workspace__level-actions">Controls');
    expect(built).toBe(2);
  });
  for (const accessor of [false, true])
    test(`restores clamped separator values from ${accessor ? "layoutState" : "LayoutStateProvider"}`, () => {
      const state = {
        version: 2 as const,
        paneWidths: { sections: 208, items: 999 },
        sidebarWidth: 260,
        detailWidths: { detail: 500 },
        drawerHeights: { drawer: 280 },
      };
      const html = renderToString(() =>
        createComponent(AppWorkspace.LayoutStateProvider, {
          state: accessor ? null : state,
          get children() {
            return createComponent(AppWorkspace, {
              layoutState: accessor ? () => state : undefined,
              get children() {
                return [
                  createComponent(AppWorkspace.Sidebar, { children: "Navigation" }),
                  main({ level: "item" }),
                  createComponent(AppWorkspace.Detail, { id: "detail", open: true, children: "Detail" }),
                  createComponent(AppWorkspace.BottomDrawer, { id: "drawer", open: true, children: "Drawer" }),
                ];
              },
            });
          },
        }),
      );
      expect(attributes(html, "button", "data-app-workspace-resize").map((attrs) => attrs["aria-valuenow"])).toEqual([
        "260",
        "240",
        "640",
        "500",
        "280",
      ]);
    });
  test("requires href on every open level except the last", () => {
    expect(() =>
      renderToString(() =>
        main(
          { level: "item" },
          panes().map((pane, index) => ({ ...pane, href: index === 0 ? undefined : pane.href })),
        ),
      ),
    ).toThrow('AppWorkspace.MainPane "sections" requires href');
    expect(() =>
      renderToString(() =>
        main(
          { level: "item" },
          panes().map((pane, index) => ({ ...pane, href: index === 2 ? undefined : pane.href })),
        ),
      ),
    ).not.toThrow();
  });
  test("rejects children other than MainPane", () => {
    expect(() => renderToString(() => createComponent(AppWorkspace.Main, { level: "one", children: "Not a pane" }))).toThrow(
      "requires only AppWorkspace.MainPane children",
    );
  });
  test("ordinary Main keeps the existing markup", () => {
    const html = renderToString(() => main({ mobilePane: "items" }));
    expect(html).not.toContain("data-workspace-level");
    expect(html).not.toContain("k2b-app-workspace__level-head");
    expect(html).not.toContain("k2b-app-workspace__level-body");
    expect(html).toContain('data-mobile-pane="items"');
  });
  test("ordinary Main clamps a stored pane width to its own limits before hydration", () => {
    const html = renderToString(() =>
      createComponent(AppWorkspace.LayoutStateProvider, {
        state: { version: 2, paneWidths: { sections: 720 } },
        get children() {
          return createComponent(AppWorkspace, {
            get children() {
              return createComponent(AppWorkspace.Main, {
                get children() {
                  return [createComponent(AppWorkspace.MainPane, { ...panes()[0]!, maxSize: 640 }), "Primary content"];
                },
              });
            },
          });
        },
      }),
    );
    const pane = attributes(html, "section", "data-workspace-main-region").find(
      (attrs) => attrs["data-workspace-main-region"] === "sections",
    );
    expect(html).not.toContain("data-workspace-levels");
    expect(pane?.style).toContain("--k2b-workspace-panel-size:clamp(240px, var(--k2b-workspace-pane-sections-width, 320px), 640px)");
    expect(attributes(html, "button", "data-app-workspace-resize")[0]?.["aria-valuenow"]).toBe("640");
  });
});
