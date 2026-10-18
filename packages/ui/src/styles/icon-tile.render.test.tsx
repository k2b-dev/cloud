import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-icon-tile-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const {
  AppOverview,
  AppWorkspace,
  Avatar,
  FileTree,
  FileTypeIcon,
  fileTypeOf,
  LinkCard,
  PanelDialog,
  Placeholder,
  StatusBadge,
  Widget,
  WidgetStatus,
} = await import("../index");
const css = readFileSync(resolve(import.meta.dir, "../../dist/styles.css"), "utf8");
const render = (children: () => JSX.Element) => renderToString(children);
const classesFor = (html: string, token: string) =>
  [...html.matchAll(/class="([^"]*)"/g)].map((match) => match[1]!.split(/\s+/)).filter((classes) => classes.includes(token));
const tile = (html: string, token: string, expected = true) => {
  const wrappers = classesFor(html, token);
  expect(wrappers.length, token).toBeGreaterThan(0);
  for (const classes of wrappers) expect(classes.includes("k2b-icon-tile"), token).toBe(expected);
};

// Read the compiled package, including grouped selectors produced by the CSS compiler.
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
  selector: match[1]!.slice(match[1]!.lastIndexOf(";") + 1).trim(),
  body: match[2]!,
}));
const declarationsFor = (selector: string) => rules.filter((rule) => rule.selector.split(",").includes(selector));

describe("shared icon tile contract", () => {
  test("chips only empty compact and panel placeholders", () => {
    for (const variant of ["compact", "panel", "inline"] as const) {
      for (const state of ["empty", "loading", "error"] as const) {
        const html = render(() => createComponent(Placeholder, { state, variant, icon: "ti ti-inbox", title: "Notes" }));
        tile(html, "k2b-placeholder__icon", state === "empty" && variant !== "inline");
      }
    }
  });

  test("overview, dialog, widget and link card icons use the shared chip", () => {
    tile(
      render(() => createComponent(AppOverview, { title: "Projects", icon: "ti ti-folders", children: "Projects" })),
      "k2b-app-overview__icon",
    );
    tile(
      render(() => createComponent(PanelDialog.Header, { title: "Edit", icon: "ti ti-pencil" })),
      "k2b-panel-dialog__icon",
    );
    tile(
      render(() => createComponent(Widget, { title: "Notes", icon: "ti ti-notebook", children: "Notes" })),
      "k2b-widget__icon",
    );
    tile(
      render(() => createComponent(LinkCard, { title: "Notes", description: "Open notes", href: "/notes", icon: "ti ti-notebook" })),
      "k2b-link-card__icon",
    );
  });

  test("only plain object-row glyphs get a chip; custom avatars and ordinary rows keep their treatment", () => {
    tile(
      render(() => createComponent(AppWorkspace.SidebarItem, { variant: "object", icon: "ti ti-notebook", children: "Notes" })),
      "k2b-app-workspace__sidebar-item-icon",
    );
    tile(
      render(() => createComponent(AppWorkspace.SidebarItem, { variant: "row", icon: "ti ti-notebook", children: "Notes" })),
      "k2b-app-workspace__sidebar-item-icon",
      false,
    );
    const custom = render(() =>
      createComponent(AppWorkspace.SidebarItem, {
        variant: "object",
        icon: "ti ti-notebook",
        get children() {
          return [
            createComponent(AppWorkspace.SidebarItemIcon, {
              get children() {
                return createComponent(Avatar, { name: "Ada Lovelace" });
              },
            }),
            createComponent(AppWorkspace.SidebarItemLabel, { children: "Ada" }),
          ];
        },
      }),
    );
    tile(custom, "k2b-app-workspace__sidebar-item-icon", false);
    tile(custom, "k2b-avatar", false);
  });

  test("file type families and tree rows use the same chip without Tailwind colour utilities", () => {
    for (const [name, type] of [
      ["report.pdf", "pdf"],
      ["budget.xlsx", "sheet"],
      ["photo.png", "image"],
      ["deck.pptx", "slides"],
      ["letter.docx", "document"],
      ["clip.mp4", "video"],
      ["song.mp3", "audio"],
      ["backup.zip", "archive"],
      ["main.ts", "other"],
      ["Projects", "folder"],
    ] as const) {
      const props = { name, folder: type === "folder" };
      const html = render(() => createComponent(FileTypeIcon, props));
      expect(fileTypeOf(props), name).toBe(type);
      expect(html).toContain(`data-file-type="${type}"`);
      expect(html).toContain('data-size="md"');
      tile(html, "k2b-file-type-icon");
      expect(html).not.toMatch(/(?:text|bg)-(?:red|blue|green|yellow|purple|orange)-/);
    }
    const custom = render(() =>
      createComponent(FileTypeIcon, { name: "budget.xlsx", size: "sm", class: "file-marker", icon: "ti ti-star text-red-500" }),
    );
    expect(custom).toContain('data-file-type="sheet"');
    expect(custom).toContain('data-size="sm"');
    expect(custom).toContain("file-marker");
    expect(custom).toContain('class="ti ti-star"');
    expect(custom).not.toContain("text-red-500");
    expect(render(() => createComponent(FileTypeIcon, { name: "Projects", folder: true, open: true, size: "lg" }))).toContain(
      "ti-folder-open",
    );
    expect(fileTypeOf({ name: "download", mediaType: "application/pdf" })).toBe("pdf");
    // A generic text media type, as FileTree passes for entries without one, must not hide a known extension.
    for (const [name, mediaType, type] of [
      ["budget.xlsx", "text/plain", "sheet"],
      ["deck.pptx", "text/plain", "slides"],
      ["letter.docx", "text/plain", "document"],
      ["backup.zip", "text/plain", "archive"],
      ["export.csv", "text/csv", "sheet"],
      ["notes.constructor", undefined, "other"],
    ] as const)
      expect(fileTypeOf({ name, mediaType }), name).toBe(type);
    const tree = render(() =>
      createComponent(FileTree, { entries: [{ path: "/report.pdf" }, { path: "/budget.xlsx" }, { path: "/Projects", kind: "folder" }] }),
    );
    tile(tree, "k2b-content-file-tree__icon");
    expect(tree).toMatch(/<span[^>]*class="[^"]*k2b-content-file-tree__icon[^>]*data-file-type="pdf"[^>]*data-size="sm"/);
    expect(tree).toMatch(/<span[^>]*class="[^"]*k2b-content-file-tree__icon[^>]*data-file-type="sheet"[^>]*data-size="sm"/);
  });

  test("status icons and avatars never acquire the icon tile class", () => {
    const html = render(() => [
      ...(["success", "warning", "danger", "info"] as const).map((tone) => createComponent(WidgetStatus, { title: tone, tone })),
      ...(["info", "ok", "warning", "error", "degraded", "running", "neutral"] as const).map((tone) =>
        createComponent(StatusBadge, { label: tone, tone }),
      ),
      createComponent(Avatar, { name: "Ada Lovelace" }),
      createComponent(Avatar, { name: "Agent", icon: "ti ti-robot", shape: "square" }),
    ]);
    for (const token of ["k2b-widget-status__icon", "k2b-status-badge", "k2b-avatar"]) tile(html, token, false);
    expect(html).not.toContain("k2b-icon-tile");
  });

  test("the compiled shared rule owns the fill and radius in all themes", () => {
    const shared = declarationsFor(".k2b-ui .k2b-icon-tile");
    expect(shared).toHaveLength(1);
    expect(shared[0]!.body).toContain("background:color-mix(in srgb,currentColor var(--k2b-icon-tile-fill),transparent)");
    expect(shared[0]!.body).toContain("border-radius:28%");
    for (const [scope, fill] of [
      [".k2b-ui", "12%"],
      [".k2b-ui[data-theme=dark]", "22%"],
      [".k2b-ui.k2b-dark", "22%"],
      [".dark .k2b-ui", "22%"],
    ]) {
      const values = declarationsFor(scope!).flatMap((rule) =>
        [...rule.body.matchAll(/--k2b-icon-tile-fill:([^;}]*)/g)].map((match) => match[1]),
      );
      expect(values, scope).toEqual([fill]);
    }
  });

  test("component rules never duplicate chip decoration, including state rules", () => {
    for (const token of [
      "k2b-placeholder__icon",
      "k2b-app-overview__icon",
      "k2b-widget__icon",
      "k2b-link-card__icon",
      "k2b-panel-dialog__icon",
      "k2b-file-type-icon",
      "k2b-app-workspace__sidebar-item-icon",
    ]) {
      const owned = rules.filter((rule) =>
        rule.selector.split(",").some((selector) => new RegExp(`\\.${token}(?![\\w-])[^ >+~]*$`).test(selector)),
      );
      expect(owned.length, token).toBeGreaterThan(0);
      for (const rule of owned)
        expect(rule.body, rule.selector).not.toMatch(/(?:^|;)\s*(?:background(?:-[\w-]+)?|box-shadow|border-radius):/);
    }
  });
});
