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
  test("renders a labelled list of native links with the open page marked, at most five", () => {
    const html = renderToString(() => createComponent(TabBar, { label: "App", items }));

    expect(html).toMatch(/^<nav class="k2b-tab-bar" aria-label="App"[^>]*><ul>/);
    expect(html.match(/<li>/g)?.length).toBe(5);
    expect(html).not.toContain("Chat");
    expect(html).toContain(
      '<a href="/pwa/" aria-current="page" data-tab="start" data-k2b-title="Example Cloud"><i class="ti ti-home" aria-hidden="true"></i><span>Start</span></a>',
    );
    // Each link names the title of its page, which the shell shows while that page loads; the label by default.
    expect(html).toContain('<a href="/pwa/tasks" data-tab="tasks" data-k2b-title="Tasks">');
    expect(html.match(/aria-current/g)?.length).toBe(1);
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
});
