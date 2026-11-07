import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-sidebar-note-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: AppWorkspace } = await import("./AppWorkspace");

const render = (props: { note?: string; noteTone?: "neutral" | "warning" | "danger" }) =>
  renderToString(() =>
    createComponent(AppWorkspace.SidebarItem, { href: "/apps/mail", description: "0.53.0 · /mail", ...props, children: "Mail" }),
  );

test("a note is a third line after the description and carries its tone", () => {
  const html = render({ note: "3 deliveries failed", noteTone: "danger" });
  const description = html.indexOf("k2b-app-workspace__sidebar-item-description");
  const note = html.indexOf("k2b-app-workspace__sidebar-item-note");
  expect(description).toBeGreaterThan(-1);
  expect(note).toBeGreaterThan(description);
  expect(html).toMatch(/class="k2b-app-workspace__sidebar-item-note k2b-truncate-fade" data-tone="danger"[^>]*>3 deliveries failed</);
  expect(render({ note: "Never started" })).toContain('data-tone="neutral"');
});

test("a row without a note keeps its two lines", () => {
  expect(render({})).not.toContain("sidebar-item-note");
});
