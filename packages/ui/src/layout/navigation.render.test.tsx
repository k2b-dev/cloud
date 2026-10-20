import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { createNavigation, type NavigationOptions } from "./navigation-model";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-navigation-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: Navigation } = await import("./Navigation");
const items = () => [{ id: "inbox", label: "Inbox", href: "/inbox" }];
const render = (switcher?: NavigationOptions["switcher"]) =>
  renderToString(() => createComponent(Navigation, { navigation: createNavigation({ items, switcher }), label: "Mail" }));

describe("Navigation rendering", () => {
  test("renders the container switcher before the rows inside the landmark", () => {
    const html = render(() => ({ currentId: "team", label: "Team", icon: "ti-mail", switchLabel: "Switch mailbox" }));
    expect(html).toMatch(/<nav[^>]*>[\s\S]*k2b-sidebar-switcher__trigger[\s\S]*k2b-navigation__row[\s\S]*<\/nav>/);
    expect(html).toContain("Loading...");
    expect(html).toContain('href="/inbox"');
  });

  test("without a switcher the landmark contains only navigation rows", () => {
    const html = render();
    expect(html).not.toContain("k2b-sidebar-switcher");
    expect(html).not.toContain('role="dialog"');
    expect(html).toMatch(/<nav[^>]*><ul /);
    expect(html).toContain('href="/inbox"');
  });

  test("container context is explicit and independent of the current destination", () => {
    const navigation = createNavigation({
      items: () => [
        {
          id: "projects",
          label: "Projects",
          href: "/projects",
          context: true,
          children: [{ id: "work", label: "Work", href: "/projects/work", active: true }],
        },
        { id: "other", label: "Other", href: "/other", context: false },
        { id: "help", label: "Help", href: "/help" },
      ],
    });
    const html = renderToString(() => createComponent(Navigation, { navigation, label: "Workspace" }));
    expect(html).toContain('data-context="true"');
    expect(html).toContain('data-context="false"');
    expect(html.match(/data-context=/g)).toHaveLength(2);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(/<a\b[^>]*aria-current="page"[^>]*>/.exec(html)?.[0]).toContain('href="/projects/work"');
    expect(html).not.toContain("aria-disabled");
  });
});
