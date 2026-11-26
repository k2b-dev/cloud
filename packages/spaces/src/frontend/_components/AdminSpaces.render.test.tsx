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

type Extra = {
  rows?: { id: string; name: string; description: string | null; color: string; permissionCount: number }[];
  orphaned?: number;
};
const render = (extra: Extra = {}) =>
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
          rows: extra.rows ?? [],
          search: "",
          page: 1,
          totalPages: 1,
          total: extra.rows?.length ?? 0,
          orphaned: extra.orphaned ?? 0,
          accessEntries: 31,
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

  test("the first band counts the Spaces, names the ones nobody can open in red, and each row carries its sign", () => {
    const rows = [
      { id: "Space1", name: "Planning", description: null, color: "#6366f1", permissionCount: 0 },
      { id: "Space2", name: "Ideas", description: "Team work", color: "#2563eb", permissionCount: 1_234_567 },
    ];
    const html = render({ rows, orphaned: 1 });
    const band = html.slice(html.indexOf('data-k2-part="Cells"'), html.indexOf('data-k2-part="Table"'));
    expect(band).toContain("31 access entries");
    expect(band).toMatch(/data-status="bad"[^>]*>.*1 Space/s);
    expect(html).not.toContain('data-k2-part="StatusRow"');
    // Every Space shows its mark in its colour; a missing description is left empty, never a grey filler.
    expect(html.match(/data-k2-part="Mark"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).not.toContain("No description");
    // A count past a thousand reads with its separator.
    expect(html).toContain("1,234,567 access entries");
    // Nobody unreachable is no exception: the band says all are reachable, in plain words.
    expect(render({ rows: [rows[1]!], orphaned: 0 })).toContain("all reachable");
  });
});
