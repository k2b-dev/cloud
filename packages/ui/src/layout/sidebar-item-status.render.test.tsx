import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { AppWorkspaceSidebarItemStatusProps } from "./AppWorkspace";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-sidebar-status-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: AppWorkspace } = await import("./AppWorkspace");
const { LocaleProvider } = await import("../intl/locale");

const render = (status: AppWorkspaceSidebarItemStatusProps, locale = "en") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(AppWorkspace.SidebarItem, {
          href: "/design",
          get meta() {
            return createComponent(AppWorkspace.SidebarItemStatus, status);
          },
          get children() {
            return createComponent(AppWorkspace.SidebarItemLabel, { children: "Design" });
          },
        });
      },
    }),
  );

const text = (html: string, className: string) => html.match(new RegExp(`class="${className}"[^>]*>([^<]*)<`))?.[1]?.trim();

describe("AppWorkspace.SidebarItemStatus", () => {
  test("renders nothing without unread items, a mention, or muting", () => {
    for (const status of [{}, { unread: 0 }, { unread: false }, { unread: -2 }, { unread: Number.NaN }]) {
      expect(render(status)).not.toContain("k2b-app-workspace__sidebar-item-meta");
    }
  });

  test("shows a count and caps what it shows and says at 99+", () => {
    const html = render({ unread: 3 });
    expect(html).toContain('data-unread="count"');
    expect(text(html, "k2b-app-workspace__sidebar-status-count")).toBe("3");
    expect(html).toContain(", 3 unread");

    // A backend that caps unread at 100 passes 100 for any larger number.
    for (const unread of [100, 1234]) {
      const many = render({ unread });
      expect(text(many, "k2b-app-workspace__sidebar-status-count")).toBe("99+");
      expect(many).toContain(", more than 99 unread<");
    }
  });

  test("shows a quiet dot for new activity without a count", () => {
    const html = render({ unread: true, muted: true });
    expect(html).toContain('data-unread="dot"');
    expect(html).toContain("k2b-app-workspace__sidebar-status-dot");
    expect(html).not.toContain("k2b-app-workspace__sidebar-status-count");
    expect(html).toContain("ti-bell-off");
    expect(html).toContain(", new activity, muted");
  });

  test("marks mentions with @ and an accented count", () => {
    const html = render({ unread: 2, mention: true });
    expect(text(html, "k2b-app-workspace__sidebar-status-mention")).toBe("@");
    expect(html).toContain('data-mention="true"');
    expect(html).toContain(", 2 unread, mentions you");
  });

  test("keeps the unread slot without unread items", () => {
    const html = render({ mention: true });
    expect(html).toContain('<span class="k2b-app-workspace__sidebar-status-unread" aria-hidden="true"></span>');
    expect(html).not.toContain("data-unread=");
  });

  test("keeps the visible marks out of the accessible name and inside the row link", () => {
    const html = render({ unread: 5, mention: true, muted: true });
    const marks = html.match(/class="k2b-app-workspace__sidebar-status-(muted|mention|unread)"[^>]*>/g) ?? [];
    expect(marks).toHaveLength(3);
    for (const mark of marks) expect(mark).toContain('aria-hidden="true"');
    expect(html).toMatch(/<a [^>]*href="\/design"[\s\S]*k2b-sr-only[\s\S]*<\/a>/);
  });

  test("describes the state in German", () => {
    expect(render({ unread: 4, mention: true, muted: true }, "de")).toContain(", 4 ungelesen, erwähnt dich, stummgeschaltet");
    expect(render({ unread: true }, "de")).toContain(", neue Aktivität");
    expect(render({ unread: 100 }, "de")).toContain(", mehr als 99 ungelesen");
  });
});
