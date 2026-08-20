import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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

const renderOverview = (initialActivityError: string | null = null) =>
  renderToString(() =>
    createComponent(NotebooksOverview, {
      notebooks: [{ id: "Book01", name: "Product", description: "Product knowledge", icon: "ti ti-bulb" }],
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
      dateConfig: { locale: "en", timeZone: "Europe/Berlin", firstDayOfWeek: 1 },
    }),
  );

describe("Notebooks overview", () => {
  test("renders the recent cross-notebook workspace and stable desktop activity panel", () => {
    const html = renderOverview();
    expect(html).toContain('class="k2b-app-workspace notebooks-overview-workspace"');
    expect(html).toContain('href="/app/notebooks/Book01"');
    expect(html).toContain("New notebook");
    expect(html).toContain("Search");
    expect(html).toContain("Unpin Product");
    expect(html).toContain('href="/app/notebooks/Book01/notes/Note01"');
    expect(html).toContain("Launch plan");
    expect(html).toContain("Sofie");
    expect(html).toContain("Edited “Launch plan” in Product");
    expect(html).toMatch(/class="k2b-paper notebooks-overview-activity-paper /);
    expect(html).toContain("notebooks-overview-activity-list");
    expect(html).toContain('datetime="2026-08-20T10:00:00.000Z"');
    expect(html).toMatch(/<aside[^>]*id="k2b-workspace-detail-notebooks-overview-activity"(?![^>]*hidden)/);
  });

  test("distinguishes an activity failure from an empty history", () => {
    const html = renderOverview("Activity service unavailable");
    expect(html).toContain("Could not load activity");
    expect(html).toContain("Activity service unavailable");
    expect(html).toContain("Retry");
    expect(html).not.toContain("No activity yet");
  });
});
