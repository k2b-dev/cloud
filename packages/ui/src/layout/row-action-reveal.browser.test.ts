import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../test/browser";

const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const environments = [
  { name: "desktop mouse", hover: "hover", "any-hover": "hover", pointer: "fine", "any-pointer": ["fine"] },
  { name: "tablet with mouse", hover: "none", "any-hover": "hover", pointer: "coarse", "any-pointer": ["coarse", "fine"] },
  { name: "touch-only phone", hover: "none", "any-hover": "none", pointer: "coarse", "any-pointer": ["coarse"] },
] as const;
type Environment = (typeof environments)[number];

// Neither engine emulates a touch primary pointer with a hovering secondary one.
const pointerCss = (source: string, environment: Environment) =>
  source.replace(/\((hover|any-hover|pointer|any-pointer)\s*:\s*(hover|none|fine|coarse)\)/g, (_, feature: string, value: string) => {
    const matches =
      feature === "any-pointer"
        ? environment["any-pointer"].some((pointer) => pointer === value)
        : feature === "hover"
          ? environment.hover === value
          : feature === "any-hover"
            ? environment["any-hover"] === value
            : environment.pointer === value;
    return matches ? "(min-width:0)" : "(max-width:0)";
  });

const entry = resolve(import.meta.dir, "row-action-reveal.fixture.ts");
const fixture = `
import { createComponent as c, render } from "solid-js/web";
import { AppWorkspace, DetailPanel, Discussion, DescriptionList, Dropdown } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const items = [{ label: "Rename", action() {} }, { label: "Duplicate", action() {} }];
const menu = (title) => c(Dropdown.Root, {
  position: "bottom-right", width: "12rem", items,
  get children() { return c(Dropdown.Trigger, { iconOnly: true, size: "xs", label: "Actions for " + title, children: "…" }); },
});
const actions = (title) => c(AppWorkspace.SidebarItemActions, { visibility: "hover", get children() { return menu(title); } });
const treeItem = (id, title, children) => c(AppWorkspace.NavTree.Item, {
  id, label: title, href: "#" + id,
  get actions() { return actions(title); },
  get children() { return children?.(); },
});
const tree = () => c(AppWorkspace.NavTree, {
  ariaLabel: "Notes", selectedId: "notes", defaultExpandedIds: ["archive"],
  get children() {
    return [treeItem("archive", "Archive", () => treeItem("draft", "Draft")), treeItem("notes", "Notes")];
  },
});
const flat = () => ["Inbox", "Projects", "Shared"].map((title) => c(AppWorkspace.SidebarItem, {
  href: "#" + title, active: title === "Projects",
  get actions() { return actions(title); },
  get children() { return c(AppWorkspace.SidebarItemLabel, { children: title }); },
}));
const details = () => [
  c(DetailPanel, { get children() { return c(DetailPanel.Action, {
    title: "Attachment", href: "#attachment", menuItems: items, menuLabel: "Actions for Attachment",
    secondaryAction: { icon: "ti ti-trash", label: "Delete Attachment", onClick() {} },
  }); } }),
  c(Discussion, { label: "Comments", get children() { return c(Discussion.List, {
    get children() { return c(Discussion.Item, {
      author: "Valentin", children: "Ready for review.", actionVisibility: "progressive",
      get actions() { return menu("Comment"); },
    }); },
  }); } }),
  c(DescriptionList, {
    layout: "rows", actionVisibility: "progressive",
    get items() { return [{ term: "Owner", description: "Valentin", get action() { return menu("Owner"); } }]; },
  }),
];
render(() => c(AppWorkspace, {
  resizable: false,
  get children() { return [
    c(AppWorkspace.Sidebar, { get children() { return c(AppWorkspace.SidebarDesktop, {
      get children() { return c(AppWorkspace.SidebarBody, {
        get children() { return [
          c(AppWorkspace.SidebarSection, { title: "Notes", get children() { return tree(); } }),
          c(AppWorkspace.SidebarSection, { title: "Spaces", get children() { return flat(); } }),
        ]; },
      }); },
    }); } }),
    c(AppWorkspace.Content, { get children() { return c(AppWorkspace.Main, { get children() { return details(); } }); } }),
  ]; },
}), document.getElementById("app"));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the row action fixture.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const rowSelector = [
  ".k2b-app-workspace__sidebar-item",
  ".k2b-detail-panel__action-row",
  ".k2b-discussion__item",
  ".k2b-description-list__item",
].join(", ");
const titles = ["Archive", "Draft", "Notes", "Inbox", "Projects", "Shared", "Attachment", "Comment", "Owner"];
const names = [...titles.map((title) => `Actions for ${title}`), "Delete Attachment"];
const current = ["Actions for Notes", "Actions for Projects"];
const inspect = (page: Page) =>
  page.evaluate(
    ({ names, rowSelector }) => {
      const box = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return [rect.x, rect.y, rect.width, rect.height];
      };
      return names.map((name) => {
        const trigger = document.querySelector<HTMLElement>(`button[aria-label="${name}"]`)!;
        const row = trigger.closest(rowSelector)!;
        let opacity = 1;
        for (let node: Element | null = trigger; node; node = node === row ? null : node.parentElement) {
          opacity *= Number(getComputedStyle(node).opacity);
        }
        const visibility = getComputedStyle(trigger).visibility;
        return {
          name: trigger.getAttribute("aria-label"),
          shown: visibility === "visible" && opacity === 1,
          hidden: visibility === "hidden" || opacity === 0,
          expanded: trigger.getAttribute("aria-expanded"),
          focused: trigger === document.activeElement,
          rowBox: box(row),
          triggerBox: box(trigger),
        };
      });
    },
    { names, rowSelector },
  );
type Snapshot = Awaited<ReturnType<typeof inspect>>;

const expectGeometry = (state: Snapshot, rest: Snapshot) => {
  for (const [index, action] of state.entries()) {
    expect(action.name).toBe(names[index]!);
    for (const key of ["rowBox", "triggerBox"] as const) {
      action[key].forEach((coordinate, axis) => {
        expect(Math.abs(coordinate - rest[index]![key][axis]!), `${action.name} ${key} axis ${axis}`).toBeLessThanOrEqual(0.01);
      });
    }
  }
};
const expectVisibility = (state: Snapshot, visible: string[]) => {
  for (const action of state) {
    const shown = visible.includes(action.name!);
    expect(action.shown, `${action.name} shown`).toBe(shown);
    expect(action.hidden, `${action.name} hidden`).toBe(!shown);
  }
};

const targets = [
  { title: "Draft", focus: '[data-k2b-nav-tree-id="draft"]', tabs: 1 },
  { title: "Inbox", focus: 'a[href="#Inbox"]', tabs: 1 },
  { title: "Attachment", focus: 'a[href="#attachment"]', tabs: 2 },
  { title: "Comment", focus: 'button[aria-label="Actions for Comment"]', tabs: 0 },
  { title: "Owner", focus: 'button[aria-label="Actions for Owner"]', tabs: 0 },
];

describe("@k2b/ui row action reveal", () => {
  for (const environment of environments) {
    test(`${environment.name}: row actions reveal without layout shifts`, async () => {
      const stylesheet = pointerCss(css, environment);
      expect(stylesheet).not.toMatch(/\((?:any-)?(?:hover|pointer)\s*:/);
      expect(stylesheet).not.toBe(css);
      // Desktop rows disappear below 1024px; media rewriting isolates input from viewport size.
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      try {
        await page.setContent(`<!doctype html><html lang="en"><head><style>${stylesheet}</style>
          <style>*,*::before,*::after{transition:none!important;animation:none!important}</style></head>
          <body class="k2b-ui" style="margin:0"><div id="app" style="height:40rem"></div></body></html>`);
        await page.addScriptTag({ content: script });
        await page.getByRole("tree", { name: "Notes" }).waitFor();
        const park = async () => {
          await page.mouse.move(1400, 850);
          await page.evaluate(() => {
            if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
          });
        };
        await park();
        const rest = await inspect(page);
        const idle = environment["any-hover"] === "hover" ? current : names;
        expectVisibility(rest, idle);

        for (const target of targets) {
          const name = `Actions for ${target.title}`;
          const trigger = page.locator(`button[aria-label="${name}"]`);
          const index = names.indexOf(name);
          const box = rest[index]!.rowBox;
          await page.mouse.move(box[0]! + box[2]! / 2, box[1]! + box[3]! / 2);
          const hovered = await inspect(page);
          expectGeometry(hovered, rest);
          expectVisibility(hovered, [...idle, name, ...(target.title === "Attachment" ? ["Delete Attachment"] : [])]);

          await park();
          await page.locator(target.focus).focus();
          for (let tab = 0; tab < target.tabs; tab += 1) await page.keyboard.press("Tab");
          const focused = await inspect(page);
          expectGeometry(focused, rest);
          expect(focused[index]!.focused, name).toBe(true);
          expect(focused[index]!.shown, name).toBe(true);

          await trigger.click();
          await page.mouse.move(1400, 850);
          const opened = await inspect(page);
          expectGeometry(opened, rest);
          expect(opened[index]!.expanded, name).toBe("true");
          expect(opened[index]!.shown, name).toBe(true);
          expectVisibility(
            opened.filter((action) => action.name !== "Delete Attachment"),
            [...idle, name],
          );

          await page.keyboard.press("Escape");
          // Escape restores trigger focus; move focus away to test the resting state.
          await park();
          const closed = await inspect(page);
          expectGeometry(closed, rest);
          expect(closed[index]!.expanded, name).toBe("false");
          expectVisibility(closed, idle);
        }
      } finally {
        await page.close();
      }
    });
  }
});
