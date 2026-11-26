import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../../ui/test/ssr-test-plugin";

const root = mkdtempSync(join(tmpdir(), "spaces-admin-render-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: AdminSpaces } = await import("./AdminSpaces");
const { LocaleProvider } = await import("@k2b/ui");

const render = () =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "en",
      get children() {
        return createComponent(AdminSpaces, {
          nav: {
            title: "Administration",
            icon: "settings",
            groups: [{ items: [{ label: "Spaces", icon: "layout-kanban", href: "/admin/spaces", current: true }] }],
          },
          rows: [],
          search: "",
          page: 1,
          totalPages: 1,
          total: 0,
          orphaned: 0,
          accessEntries: 0,
        });
      },
    }),
  );

describe("Spaces in the administration", () => {
  test("the current place is its entry in the navigation, not a title again in the head", () => {
    const html = render();
    expect(html).toMatch(/aria-current="page"[^>]*href="\/admin\/spaces"/);
    const head = html.slice(html.indexOf('data-slot="head"'), html.indexOf('data-k2-part="Pane"'));
    expect(head).toContain('type="search"');
    expect(head).not.toContain(">Spaces<");
  });
});
