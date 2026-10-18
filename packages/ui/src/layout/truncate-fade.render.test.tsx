import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { Window } from "happy-dom";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-truncate-fade-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { AppWorkspace, SettingsModal, SpotlightButton, TabBar, Tabs } = await import("../index");
const message = "navigation labels fade with `k2b-truncate-fade`, they never end in an ellipsis";

describe("navigation label markup", () => {
  test(message, () => {
    const html = renderToString(() => [
      createComponent(AppWorkspace.SidebarItem, { href: "/item", context: "Project", description: "Description", children: "Item" }),
      createComponent(AppWorkspace.NavTree, {
        ariaLabel: "Pages",
        get children() {
          return [
            createComponent(AppWorkspace.NavTree.Item, { id: "plain", label: "Plain", href: "/plain" }),
            createComponent(AppWorkspace.NavTree.Item, { id: "detail", label: "Detail", description: "Tree description", href: "/detail" }),
          ];
        },
      }),
      createComponent(AppWorkspace.Main, {
        level: "items",
        get children() {
          return createComponent(AppWorkspace.MainPane, {
            id: "items",
            label: "Items",
            description: "Level description",
            children: "Items",
          });
        },
      }),
      createComponent(AppWorkspace.SidebarSwitcher, {
        currentId: "work",
        label: "Work",
        description: "Switcher description",
        icon: "ti ti-book",
        switchLabel: "Switch",
        options: [],
      }),
      createComponent(SettingsModal, {
        title: "Settings",
        activeTab: "general",
        get children() {
          return createComponent(SettingsModal.Group, {
            title: "Personal",
            get children() {
              return createComponent(SettingsModal.Tab, { id: "general", title: "General", children: "Settings content" });
            },
          });
        },
      }),
      createComponent(TabBar, { label: "Apps", items: [{ id: "home", label: "Home", href: "/", icon: "ti ti-home" }] }),
      createComponent(SpotlightButton, { variant: "sidebar", onClick: () => {} }),
      createComponent(SpotlightButton, { variant: "default", onClick: () => {} }),
      createComponent(Tabs, {
        variant: "pill",
        ariaLabel: "Views",
        value: "all",
        onValueChange: () => {},
        options: [{ value: "all", label: "All" }],
      }),
    ]);
    const window = new Window();
    try {
      window.document.body.innerHTML = html;
      for (const [selector, utility, count] of [
        [".k2b-app-workspace__sidebar-item-label-text", "k2b-truncate-fade-lines", 3],
        [".k2b-app-workspace__sidebar-item-description", "k2b-truncate-fade", 2],
        [".k2b-app-workspace__sidebar-item-context-label", "k2b-truncate-fade", 1],
        [".k2b-app-workspace__level-title h2 > span", "k2b-truncate-fade", 1],
        [".k2b-app-workspace__level-title p", "k2b-truncate-fade", 1],
        [".k2b-sidebar-switcher__copy > span", "k2b-truncate-fade-lines", 1],
        [".k2b-sidebar-switcher__copy > small", "k2b-truncate-fade", 1],
        [".k2b-settings__tabs button > span", "k2b-truncate-fade", 1],
        [".k2b-settings__tab-group-label", "k2b-truncate-fade", 1],
        [".k2b-tab-bar a > span", "k2b-truncate-fade", 1],
        ['.k2b-spotlight-button[data-variant="sidebar"] > span', "k2b-truncate-fade", 1],
        ['.k2b-tabs[data-variant="pill"] [role="tab"] > span', "k2b-truncate-fade", 1],
      ] as const) {
        const elements = window.document.querySelectorAll(selector);
        expect(elements.length, `${message}: ${selector}`).toBe(count);
        for (const element of elements) expect(element.classList.contains(utility), `${message}: ${selector}`).toBe(true);
      }
      expect(
        window.document.querySelectorAll(
          "a.k2b-truncate-fade, button.k2b-truncate-fade, [tabindex].k2b-truncate-fade, a.k2b-truncate-fade-lines, button.k2b-truncate-fade-lines, [tabindex].k2b-truncate-fade-lines",
        ).length,
        message,
      ).toBe(0);
      expect(window.document.querySelector('.k2b-spotlight-button[data-variant="default"] .k2b-truncate-fade')).toBeNull();
    } finally {
      window.happyDOM.abort();
    }
  });
});
