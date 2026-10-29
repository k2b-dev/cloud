import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-mobile-shell-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { MobileShell, TabBar } = await import("../index");

const items = [
  { id: "start", label: "Start", title: "Example Cloud", icon: "ti ti-home", href: "/pwa/", current: true },
  { id: "tasks", label: "Tasks", icon: "ti ti-checkbox", href: "/pwa/tasks" },
  { id: "contacts", label: "Contacts", icon: "ti ti-address-book", href: "/pwa/contacts" },
  { id: "notes", label: "Notes", icon: "ti ti-notes", href: "/pwa/notes" },
  { id: "files", label: "Files", icon: "ti ti-folder", href: "/pwa/files" },
  { id: "chat", label: "Chat", icon: "ti ti-messages", href: "/pwa/chat" },
];

describe("TabBar", () => {
  test("floating is explicit and the default and bar variants retain flat markup", () => {
    const floating = renderToString(() => createComponent(TabBar, { label: "Apps", items, variant: "floating" }));
    expect(floating).toContain('data-variant="floating"');
    for (const variant of [undefined, "bar"] as const) {
      const flat = renderToString(() => createComponent(TabBar, { label: "Apps", items, variant }));
      expect(flat).not.toContain("data-variant");
      expect(floating.replace(' data-variant="floating"', "")).toBe(flat);
    }
  });
  test("renders a labelled list of native links with the open page marked, at most five", () => {
    const html = renderToString(() => createComponent(TabBar, { label: "App", items }));

    expect(html).toMatch(/^<nav class="k2b-tab-bar" aria-label="App"[^>]*><ul>/);
    expect(html.match(/<li>/g)?.length).toBe(5);
    expect(html).not.toContain("Chat");
    expect(html).toContain(
      '<a href="/pwa/" aria-current="page" data-tab="start" data-k2b-title="Example Cloud"><i class="ti ti-home" aria-hidden="true"></i><span class="k2b-truncate-fade">Start</span></a>',
    );
    // Each link names the title of its page, which the shell shows while that page loads; the label by default.
    expect(html).toContain('<a href="/pwa/tasks" data-tab="tasks" data-k2b-title="Tasks">');
    expect(html.match(/aria-current/g)?.length).toBe(1);
  });
  test("a tab's badge sits in its own mark after the label; a tab without one has none", () => {
    const html = renderToString(() => createComponent(TabBar, { label: "App", items: [items[0]!, { ...items[5]!, badge: "3" }] }));
    expect(html).toContain(
      '<a href="/pwa/chat" data-tab="chat" data-k2b-title="Chat"><i class="ti ti-messages" aria-hidden="true"></i><span class="k2b-truncate-fade">Chat</span><span class="k2b-tab-bar__badge">3</span></a>',
    );
    expect(html.match(/k2b-tab-bar__badge/g)?.length).toBe(1);
  });
});

describe("MobileShell", () => {
  test("puts the header, one scroll area in main, and the footer side by side", () => {
    const html = renderToString(() =>
      createComponent(MobileShell, {
        class: "my-app",
        get header() {
          return createComponent(MobileShell.Header, { title: "Tasks" });
        },
        get footer() {
          return createComponent(TabBar, { label: "App", items: items.slice(0, 3) });
        },
        children: "Rows",
      }),
    );

    expect(html).toMatch(
      /^<div class="k2b-mobile-shell my-app"[^>]*><header class="k2b-mobile-shell__header"[^>]*><h1 class="k2b-mobile-shell__title">Tasks<\/h1><\/header><main class="k2b-mobile-shell__main"[^>]*><div [^>]*class="k2b-scroll-area k2b-mobile-shell__body ?"[^>]*>Rows<\/div><\/main><nav class="k2b-tab-bar"/,
    );
  });

  test("the header offers Back as a link or a button and keeps actions after the title", () => {
    const link = renderToString(() =>
      createComponent(MobileShell.Header, { title: "Task", back: { href: "/pwa/tasks", label: "Tasks" }, actions: "Menu" }),
    );
    expect(link).toMatch(/<a aria-label="Tasks" href="\/pwa\/tasks" class="k2b-button k2b-icon-button k2b-mobile-shell__back/);
    expect(link).toContain('class="ti ti-chevron-left"');
    expect(link).toMatch(/<h1 class="k2b-mobile-shell__title">Task<\/h1><div class="k2b-mobile-shell__actions">Menu<\/div>/);

    const button = renderToString(() => createComponent(MobileShell.Header, { title: "Task", back: { onClick: () => {}, label: "Back" } }));
    expect(button).toMatch(/<button [^>]*aria-label="Back"/);
    expect(button).not.toContain("k2b-mobile-shell__actions");
  });

  test("a sidebar comes first and names the app; Start and Settings frame the parts, an empty group is left out", () => {
    const html = renderToString(() =>
      createComponent(MobileShell, {
        get sidebar() {
          return createComponent(MobileShell.Sidebar, {
            label: "App",
            title: "Example Cloud",
            logo: "/branding/logo",
            items: [{ id: "start", label: "Start", icon: "ti ti-home", href: "/pwa/", current: true }],
            sections: [
              {
                title: "Apps",
                items: [
                  { id: "chat", label: "Chat", icon: "ti ti-messages", href: "/pwa/chat", count: 3 },
                  // A badge calls for attention and takes the quiet count's place.
                  { id: "mail", label: "Mail", icon: "ti ti-mail", href: "/pwa/mail", count: 9, badge: "2" },
                ],
              },
              { title: "Empty", items: [] },
            ],
            footer: [{ id: "settings", label: "Settings", icon: "ti ti-settings", href: "/pwa/settings" }],
          });
        },
        get header() {
          return createComponent(MobileShell.Header, { title: "Example Cloud", sidebarTitle: "Start" });
        },
        children: "Rows",
      }),
    );

    expect(html).toMatch(/^<div class="k2b-mobile-shell"[^>]*><nav class="k2b-mobile-shell__sidebar" aria-label="App">/);
    expect(html).toContain('<img src="/branding/logo" alt width="32" height="32"><span class="k2b-truncate-fade">Example Cloud</span>');
    expect(html).toContain('<a href="/pwa/" aria-current="page" data-tab="start" data-k2b-title="Start">');
    expect(html).toContain("<h2>Apps</h2>");
    expect(html).not.toContain("Empty");
    expect(html).toContain('<span class="k2b-mobile-shell__sidebar-count">3</span>');
    expect(html).toContain('<span class="k2b-mobile-shell__sidebar-count">2</span>');
    expect(html).not.toContain('<span class="k2b-mobile-shell__sidebar-count">9</span>');
    expect(html).toMatch(/<div class="k2b-mobile-shell__sidebar-foot"><ul><li><a href="\/pwa\/settings"/);
    // The page's title on the phone names the app; beside the sidebar, which names it already, the page.
    expect(html).toContain(
      '<h1 class="k2b-mobile-shell__title"><span class="k2b-mobile-shell__title-narrow">Example Cloud</span><span class="k2b-mobile-shell__title-wide">Start</span></h1>',
    );
  });

  test("Back can leave the sidebar's own destinations to the sidebar, and content can bring its own heads", () => {
    const back = renderToString(() =>
      createComponent(MobileShell.Header, { title: "Settings", back: { href: "/pwa/", label: "Start", withSidebar: false } }),
    );
    expect(back).toMatch(/<a [^>]*data-with-sidebar="false"[^>]*aria-label="Start"|<a aria-label="Start"[^>]*data-with-sidebar="false"/);

    const bare = renderToString(() =>
      createComponent(MobileShell, {
        scroll: false,
        get header() {
          return createComponent(MobileShell.Header, { title: "Spaces" });
        },
        children: "Levels",
      }),
    );
    expect(bare).toMatch(/^<div class="k2b-mobile-shell" data-k2b-content-heads=""/);
    expect(bare).toMatch(/<main class="k2b-mobile-shell__main"[^>]*>Levels<\/main>/);
    expect(bare).not.toContain("k2b-mobile-shell__body");
  });
});
