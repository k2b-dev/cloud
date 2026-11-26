import { describe, expect, test } from "bun:test";
import type { RelativeDateContext } from "@k2b/stdlib";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import "./ssr-test-plugin";

const { LocaleProvider } = await import("@k2b/ui");
const { default: NoteDetails } = await import("./NoteDetails");
const base = "2026-10-16T19:30:00.000Z";
const created = "2026-10-13T19:30:00.000Z";
const edited = "2026-10-16T19:18:00.000Z";
const dateConfig: RelativeDateContext = { locale: "de", timeZone: "UTC", base };
const jana = { kind: "user" as const, id: "jana", displayName: "Jana Berger", avatarHash: null };
const creator = { kind: "user" as const, id: "paul", displayName: "Paul Wagner", avatarHash: null };
type Props = Parameters<typeof NoteDetails>[0];

const renderPanel = (overrides: Partial<Props> = {}) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return createComponent(NoteDetails, {
          mode: "edit",
          fullWidth: false,
          initiallyOpen: true,
          tocItems: [
            { id: "title", level: 1, text: "Wareneingang" },
            { id: "intro", level: 2, text: "Überblick" },
            { id: "next", level: 3, text: "Anlieferung" },
          ],
          taskProgress: { done: 2, total: 4 },
          attachments: [],
          backlinks: [],
          relations: { outgoing: [], tags: [] },
          accessVisible: false,
          canManageAccess: false,
          namedBlocks: [],
          currentNotebookId: "book01",
          notebookId: "book01",
          noteId: "note01",
          noteTitle: "Wareneingang",
          contentMd: "# Wareneingang",
          createdAt: created,
          updatedAt: edited,
          lockedAt: null,
          historyIncomplete: false,
          isLocked: false,
          canWrite: true,
          currentUserId: "me",
          noteAuthors: { createdBy: creator, lastEditedBy: jana },
          initialCommentsPage: { items: [], page: 1, perPage: 30, total: 0, hasNext: false },
          dateConfig,
          now: base,
          ...overrides,
        });
      },
    }),
  );
const inspect = (overrides: Partial<Props>, check: (document: Document) => void) => {
  const dom = createDomTestHarness();
  try {
    dom.root.innerHTML = renderPanel(overrides);
    check(dom.document);
  } finally {
    dom.cleanup();
  }
};
const text = (element: Element | null | undefined) => element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
/** A section of the details by its title. */
const titled = (root: ParentNode, title: string) =>
  [...root.querySelectorAll('[data-k2-part="Section"]')].find((section) => text(section.querySelector("h3")) === title) ?? null;
const sectionTitles = (root: ParentNode) => [...root.querySelectorAll('[data-k2-part="Section"] h3')].map((title) => text(title));

describe("the note's details on v2", () => {
  test("a detail pane whose head names the note and whose state line names the last edit", () => {
    inspect({}, (document) => {
      const pane = document.querySelector('[data-k2-part="Pane"][data-detail]');
      expect(pane).not.toBeNull();
      expect(text(pane?.querySelector('[data-slot="head"]'))).toContain("Wareneingang");
      expect(text(pane?.querySelector('[data-slot="status"]'))).toMatch(/^Jana Berger · bearbeitet .*12/);
    });
  });
  test("calls the current editor Du", () => {
    inspect({ currentUserId: jana.id }, (document) =>
      expect(text(document.querySelector('[data-slot="status"]'))).toMatch(/^Du · bearbeitet/),
    );
  });
  test("AI only for writers in Write on an unlocked note; locked and read-only say so in the state line", () => {
    expect(renderPanel({})).toContain("Mit KI bearbeiten");
    const locked = renderPanel({ isLocked: true, lockedAt: edited });
    expect(locked).toContain("Gesperrt");
    expect(locked).not.toContain("Mit KI bearbeiten");
    const viewer = renderPanel({ mode: "read", canWrite: false });
    expect(viewer).toContain("Nur lesen");
    expect(viewer).not.toContain("Mit KI bearbeiten");
    expect(renderPanel({ mode: "read" })).not.toContain("Mit KI bearbeiten");
  });
  test("a closed panel renders nothing", () => {
    inspect({ initiallyOpen: false }, (document) => expect(document.querySelector('[data-k2-part="Pane"]')).toBeNull());
  });
  test("sections in the order of use", () => {
    inspect({ accessVisible: true }, (document) => {
      expect(sectionTitles(document).filter((title) => title !== "Kommentare")).toEqual([
        "Gerade hier",
        "Aufgaben",
        "Inhalt",
        "Tags",
        "Verknüpfungen",
        "Zugriff",
        "Eigenschaften",
        "Aktivität",
      ]);
    });
  });
  test("tasks show their progress; the outline leaves out the title heading", () => {
    inspect({}, (document) => {
      expect(text(titled(document, "Aufgaben"))).toContain("2 von 4");
      const rows = [...(titled(document, "Inhalt")?.querySelectorAll('[data-k2-part="Row"]') ?? [])].map((row) => text(row));
      expect(rows).toEqual(["Überblick", "– Anlieferung"]);
    });
    for (const tocItems of [[], [{ id: "title", level: 1, text: "Wareneingang" }], [{ id: "one", level: 2, text: "Only one" }]])
      inspect({ tocItems }, (document) => expect(titled(document, "Inhalt")).toBeNull());
  });
  test("tags lead to the notes list and links show both directions", () => {
    inspect(
      {
        relations: {
          tags: ["kühlkette"],
          outgoing: [{ noteId: "n5", title: "Lagerplätze", notebookId: "book01", notebookName: "Handbuch", updatedAt: created }],
        },
        backlinks: [{ noteId: "n2", title: "Onboarding", notebookId: "book02", notebookName: "Handbuch Versand", updatedAt: created }],
      },
      (document) => {
        expect(document.querySelector('a[href="/app/notebooks/book01/notes?tag=k%C3%BChlkette"]')).not.toBeNull();
        const links = titled(document, "Verknüpfungen");
        expect(text(links)).toContain("Onboarding");
        expect(text(links)).toContain("Handbuch Versand");
        expect(links?.querySelector('a[href="/app/notebooks/book01/notes/n5"]')).not.toBeNull();
      },
    );
    inspect({}, (document) => expect(text(titled(document, "Verknüpfungen"))).toContain("Noch keine"));
  });
  test("attachments: kind and size, files before images", () => {
    const attachment = (id: string, filename: string, mimeType: string) => ({
      id,
      kind: mimeType.startsWith("image/") ? ("image" as const) : ("file" as const),
      filename,
      mimeType,
      sizeBytes: 4_400_000,
      notebookId: "book01",
      createdBy: null,
      createdAt: created,
    });
    inspect(
      {
        attachments: [
          attachment("img001", "Rampe.png", "image/png"),
          attachment("pdf001", "Lieferschein.pdf", "application/pdf"),
          attachment("xls001", "Bestand.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
        ],
      },
      (document) => {
        const rows = [...(titled(document, "Anhänge")?.querySelectorAll('[data-k2-part="Row"]') ?? [])];
        expect(rows.map((row) => text(row.querySelector(".k2-row-title")))).toEqual(["Lieferschein.pdf", "Bestand.xlsx", "Rampe.png"]);
        expect(text(rows[0]?.querySelector(".k2-row-l2"))).toBe("PDF · 4,2 MB");
      },
    );
  });
  test("access is read-only for members, manageable for admins, absent for public-link readers", () => {
    inspect({ accessVisible: true, canManageAccess: false }, (document) => {
      expect(titled(document, "Zugriff")).not.toBeNull();
      expect(text(document.body)).not.toContain("Zugriff verwalten");
    });
    inspect({ accessVisible: true, canManageAccess: true }, (document) => expect(text(document.body)).toContain("Zugriff verwalten"));
    inspect({ accessVisible: false }, (document) => expect(titled(document, "Zugriff")).toBeNull());
  });
  test("properties and the way to the version history", () => {
    inspect({}, (document) => {
      const properties = titled(document, "Eigenschaften");
      expect(text(properties)).toContain("Paul Wagner");
      expect(properties?.querySelector('a[href="/app/notebooks/book01/notes/note01?mode=versions"]')).not.toBeNull();
    });
  });
  test("activity loads after the first picture, in one loading state of its rows, without raw keys", () => {
    inspect({}, (document) => {
      const activity = titled(document, "Aktivität");
      expect(activity?.querySelector('[data-k2-part="Loading"]')).not.toBeNull();
      expect(text(activity)).not.toMatch(/note[. ]created/);
    });
  });
});
