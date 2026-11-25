import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";

const root = mkdtempSync(join(tmpdir(), "notebooks-overview-render-tests-"));
registerSsrTestPlugin({ dev: true, rootDir: root });

process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: NotebooksOverview } = await import("./NotebooksOverview.island.tsx");
const { LocaleProvider } = await import("@k2b/ui");

// The rendered text as a parser reads it: text nodes only, without tags or hydration comments.
const textOf = (html: string) => {
  let plain = "";
  new HTMLRewriter()
    .onDocument({
      text(chunk) {
        plain += chunk.text;
      },
    })
    .transform(html);
  return plain;
};

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
          now: "2026-08-20T12:00:00.000Z",
        });
      },
    }),
  );

describe("Notebooks overview on v2", () => {
  test("the server renders the notebooks, the notes edited last and the activity with their data", () => {
    const html = renderOverview();
    // one v2 workspace: the notebooks as places, pinned ones with the flag and their own "…"
    expect(html.match(/data-k2-part="Workspace"/g)).toHaveLength(1);
    expect(html).toContain(`data-k2-part="Nav"`);
    expect(html).toMatch(/aria-current="page" href="\/app\/notebooks"/);
    expect(html).toContain(`href="/app/notebooks/Book01"`);
    expect(html).toContain(`<span class="k2-ni-count">12</span>`);
    expect(html).toContain("Unpin Product");
    // the head: search and the one primary action
    expect(html).toContain("Search");
    // the head primary and its phone twin (Workspace primary)
    expect(html.match(/data-variant="primary"/g)?.length).toBe(2);
    expect(html).toContain("New notebook");
    // the notes edited last open their note; the activity names the person and links to the note
    expect(html).toContain(`href="/app/notebooks/Book01/notes/Note01"`);
    expect(html).toContain("Launch plan");
    expect(html).toContain("Sofie");
    expect(html).toContain("Edited “Launch plan” in Product");
    expect(html).toContain("2 hours ago");
    // no loading state on the first picture, and no v1 workspace
    expect(html).not.toContain(`data-k2-part="Loading"`);
    expect(html).not.toContain("k2b-app-workspace");
  });

  test("an activity failure is not an empty history", () => {
    const html = renderOverview("Activity service unavailable");
    expect(textOf(html)).toContain("Activity service unavailable");
    expect(html).toContain("Reload");
    expect(html).not.toContain("Notebook and note changes will appear here.");
    // the entries that are there stay below the notice
    expect(html.indexOf("Activity service unavailable")).toBeLessThan(html.indexOf("Edited “Launch plan” in Product"));
  });

  test("German copy for a regional request locale", () => {
    const html = renderOverview(null, "de-CH");
    expect(html).toContain("Neues Notizbuch");
    expect(html).toContain("Zuletzt bearbeitet");
    expect(html).toContain("Alle Notizbücher");
    expect(html).toContain("Product lösen");
    expect(html).not.toContain("New notebook");
  });
});
