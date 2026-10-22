import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(join(tmpdir(), "notebooks-overview-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: NotebooksOverview } = await import("./NotebooksOverview.island.tsx");
const { LocaleProvider } = await import("@k2b/ui");

const renderOverview = (initialActivityError: string | null = null, locale = "en") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(NotebooksOverview, {
          notebooks: [
            {
              id: "Book01",
              name: "Product",
              description: "Product knowledge",
              icon: "ti ti-bulb",
              noteCount: 12,
              lastEditedAt: "2026-08-20T10:00:00.000Z",
            },
          ],
          templates: [{ id: "blank", name: "Project", description: "Project notes", icon: "ti ti-template" }],
          recentNotes: [
            {
              id: "Note01",
              notebookId: "Book01",
              notebookName: "Product",
              notebookIcon: "ti ti-bulb",
              title: "Launch plan",
              updatedAt: "2026-08-20T10:00:00.000Z",
            },
          ],
          initialActivity: {
            items: [
              {
                id: "1",
                notebook: { id: "Book01", name: "Product", icon: "ti ti-bulb" },
                note: { id: "Note01", title: "Launch plan" },
                noteVersionId: null,
                actor: { kind: "user", id: "00000000-0000-4000-8000-000000000001", displayName: "Sofie", avatarHash: null },
                action: "note.edited",
                metadata: {},
                occurrenceCount: 1,
                createdAt: "2026-08-20T10:00:00.000Z",
                lastOccurredAt: "2026-08-20T10:00:00.000Z",
              },
            ],
            nextCursor: null,
          },
          initialActivityError,
          initialPinnedNotebookIds: ["Book01"],
          dateConfig: { locale, timeZone: "Europe/Berlin", firstDayOfWeek: 1 },
        });
      },
    }),
  );

describe("Notebooks overview", () => {
  test("renders the recent cross-notebook workspace and stable desktop activity panel", () => {
    const html = renderOverview();
    expect(html).toContain('class="k2b-app-workspace notebooks-overview-workspace"');
    expect(html).toMatch(/class="k2b-app-workspace notebooks-overview-workspace"[^>]*data-flat="true"/);
    // Notebooks are object rows in a stacked-on-mobile sidebar, not a page tree.
    expect(html).toMatch(/<nav[^>]*aria-label="Notebooks"[^>]*data-mobile="stacked"/);
    expect(html).toContain('class="k2b-app-workspace__sidebar-all" aria-haspopup="dialog" aria-expanded="false"');
    expect(html).not.toContain("k2b-app-workspace__nav-tree");
    expect(html).toContain("--k2b-workspace-sidebar-width:304px");
    expect(html.match(/data-variant="object"/g)).toHaveLength(1);
    expect(html).toContain('href="/app/notebooks/Book01"');
    expect(html).toContain("12 notes");
    expect(html).toMatch(/class="k2b-app-workspace__main[^"]*notebooks-overview-main ?"[^>]*data-width="content"/);
    expect(html).toContain("Unpin Product");
    // The main area is a page: title, scope, primary create action, search.
    expect(html).toMatch(/<h2 class="k2b-panel-header__title is-large">Recently edited<\/h2>/);
    expect(html).toMatch(/class="k2b-tag notebooks-overview-scope"[^>]*>.*All notebooks/);
    expect(html).toContain("New notebook");
    expect(html).toContain("Search");
    expect(html).toContain('href="/app/notebooks/Book01/notes/Note01"');
    expect(html).toContain("Launch plan");
    expect(html).toContain("Sofie");
    expect(html).toContain("Edited “Launch plan” in Product");
    expect(html).toMatch(/class="k2b-paper notebooks-overview-activity-paper /);
    expect(html).toContain("notebooks-overview-activity-list");
    expect(html).toContain("ti ti-pencil notebooks-overview-activity-icon app-accent-text");
    expect(html).toContain('datetime="2026-08-20T10:00:00.000Z"');
    expect(html).not.toContain("k2b-detail-panel__header-icon");
    expect(html).toMatch(/<aside[^>]*id="k2b-workspace-detail-notebooks-overview-activity"(?![^>]*hidden)/);
  });

  test("distinguishes an activity failure from an empty history", () => {
    const html = renderOverview("Activity service unavailable");
    expect(html).toContain("Could not load activity");
    expect(html).toContain("Activity service unavailable");
    expect(html).toContain("Retry");
    expect(html).not.toContain("No activity yet");
  });

  test("renders German copy for a regional request locale during SSR", () => {
    const html = renderOverview(null, "de-CH");
    expect(html).toContain("Neues Notizbuch");
    expect(html).toContain("Zuletzt bearbeitet");
    expect(html).toContain("Alle Notizbücher");
    expect(html).toContain("12 Notizen");
    expect(html).toContain("Product lösen");
    expect(html).not.toContain("New notebook");
  });
});

test("recent note icons use shared tiles with app ink and platform row focus", () => {
  const html = renderOverview();
  const row = html.match(/<a\b[^>]*class="[^"]*\bnotebooks-overview-note\b[^"]*"[^>]*>/)?.[0];
  const icons = [...html.matchAll(/<span\b[^>]*class="[^"]*\bnotebooks-overview-note-icon\b[^"]*"[^>]*>/g)];
  expect(row).toBeDefined();
  expect(row?.match(/\bclass="([^"]*)"/)?.[1]?.split(/\s+/)).toContain("focus-ui");
  expect(icons).toHaveLength(1);
  for (const [icon] of icons) {
    const classes = icon.match(/\bclass="([^"]*)"/)?.[1]?.split(/\s+/);
    expect(classes).toContain("k2b-icon-tile");
    expect(classes).toContain("app-accent-text");
    expect(icon).not.toMatch(/\bstyle\s*=/);
  }
  expect(html).not.toMatch(/color-mix\([^;"}]*--app-accent/);
  expect(html).not.toContain("bg-[var(--ui-selected)]");
});

test("recent note CSS leaves the chip and focus treatment to shared utilities", () => {
  const css = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8");
  const rule = css.match(/(?:^|\n)\.notebooks-overview-note-icon\s*\{([^}]*)\}/)?.[1];
  expect(rule).toBeDefined();
  expect(rule).not.toMatch(/box-shadow|color-mix|border-radius|background/);
  expect(css).not.toMatch(/\.dark\s+\.notebooks-overview-note-icon\b[^{}]*\{/);
  expect(css).not.toMatch(/\.notebooks-overview-note:focus-visible\s*\{[^}]*--app-accent/);
});
