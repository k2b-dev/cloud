import { describe, expect, test } from "bun:test";
import type { RelativeDateContext } from "@k2b/stdlib";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import "./ssr-test-plugin";

const { LocaleProvider } = await import("@k2b/ui");
const { default: NotebookDetailPanel } = await import("./NotebookDetailPanel.island");
const base = "2026-10-16T19:30:00.000Z";
const created = "2026-10-13T19:30:00.000Z";
const edited = "2026-10-16T19:18:00.000Z";
const dateConfig: RelativeDateContext = { locale: "de", timeZone: "UTC", base };
const jana = { kind: "user" as const, id: "jana", displayName: "Jana Berger", avatarHash: null };
const creator = { kind: "user" as const, id: "paul", displayName: "Paul Wagner", avatarHash: null };
type Props = Parameters<typeof NotebookDetailPanel>[0];

const renderPanel = (overrides: Partial<Props> = {}) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return createComponent(NotebookDetailPanel, {
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
const text = (element: Element | null) => element?.textContent?.replace(/\s+/g, " ").trim() ?? "";

describe("Notebook note detail panel", () => {
  test.each(["write", "readonly", "book"] as const)("graph action preserves the explicit %s presentation", (presentationMode) => {
    const html = renderPanel({ presentationMode });
    expect(html).toContain(`href="/app/notebooks/book01?mode=graph&amp;note=note01&amp;from=${presentationMode}"`);
  });

  test("header attributes the last edit, with a frozen relative date", () => {
    inspect({}, (document) => {
      expect(text(document.querySelector(".k2b-detail-panel__supporting > p"))).toMatch(/^Jana Berger · bearbeitet .*12/);
      expect(document.querySelector('time[datetime="2026-10-16T19:18:00.000Z"]')).not.toBeNull();
      expect(text(document.querySelector("h2"))).toBe("Wareneingang");
    });
  });
  test("calls the current editor Du", () => {
    inspect({ currentUserId: jana.id }, (document) =>
      expect(text(document.querySelector(".k2b-detail-panel__supporting > p"))).toMatch(/^Du · bearbeitet/),
    );
  });
  test("locked notes retain comments but omit AI", () => {
    const html = renderPanel({ isLocked: true, lockedAt: edited });
    expect(html).toContain("Gesperrt");
    expect(html).toContain("Kommentieren");
    expect(html).not.toContain("Mit KI bearbeiten");
  });
  test("viewers have read-only context and no writing actions", () => {
    const html = renderPanel({ mode: "read", canWrite: false });
    expect(html).toContain("Nur lesen");
    expect(html).not.toContain("Mit KI bearbeiten");
    expect(html).not.toContain("Kommentieren");
    expect(html).not.toContain("Duplizieren");
  });
  test("read mode omits AI", () => expect(renderPanel({ mode: "read" })).not.toContain("Mit KI bearbeiten"));
  for (const props of [{}, { mode: "read" as const }, { canWrite: false }, { lockedAt: edited, isLocked: true }]) {
    test(`Ansicht and permitted more actions render in ${JSON.stringify(props)}`, () => {
      inspect(props, (document) => {
        expect([...document.querySelectorAll("button")].some((button) => text(button) === "Ansicht")).toBe(true);
        const menu = document.querySelector('[role="menu"][aria-label="Weitere Aktionen"]');
        expect(menu).not.toBeNull();
        for (const label of ["Inhalt kopieren", "Als Markdown herunterladen", "Als PDF exportieren…", "Versionsverlauf", "Im Graph zeigen"])
          expect(text(menu)).toContain(label);
        expect(text(menu).includes("Duplizieren")).toBe(props.canWrite !== false);
        expect(document.querySelector('a[href="/app/notebooks/book01/notes/note01?mode=versions"]')).not.toBeNull();
      });
    });
  }
  test("empty comments read Noch keine with a comment action and no bare zero", () => {
    inspect({}, (document) => {
      const header = document.querySelector(".k2b-discussion__header");
      expect(text(header)).toContain("KommentareNoch keine");
      expect(text(header)).toContain("Kommentieren");
      expect(header?.querySelector(".k2b-count-chip")).toBeNull();
      expect(text(header)).not.toMatch(/\b0\b/);
    });
  });
  for (const tocItems of [
    [],
    [{ id: "title", level: 1, text: "Wareneingang" }],
    [{ id: "one", level: 2, text: "Only one" }],
    [
      { id: "title", level: 1, text: "Wareneingang" },
      { id: "one", level: 2, text: "Only one" },
    ],
  ]) {
    test(`hides Inhalt for ${tocItems.length} headings: ${tocItems.map((item) => item.id)}`, () => {
      inspect({ tocItems }, (document) =>
        expect([...document.querySelectorAll("h3")].some((heading) => text(heading) === "Inhalt")).toBe(false),
      );
    });
  }
  test("two headings below the title form an outline without H-level labels", () => {
    inspect({}, (document) => {
      const rows = [...document.querySelectorAll(".notebook-outline-row")];
      expect(rows.map((row) => text(row))).toEqual(["Überblick", "Anlieferung"]);
      expect(rows.some((row) => /\bH[1-6]\b/.test(text(row)))).toBe(false);
    });
  });
  test("activity has no count and ends with the creator rather than a raw key", () => {
    inspect({}, (document) => {
      const activity = document.querySelector(".notebook-activity");
      expect(activity?.querySelector(".k2b-count-chip")).toBeNull();
      const rows = activity?.querySelectorAll(".k2b-detail-panel__action-title");
      expect(text(rows?.[rows.length - 1] ?? null)).toBe("Paul Wagner hat die Notiz erstellt");
      expect(text(activity)).not.toMatch(/note[. ]created/);
    });
  });
  test("activity initially reserves four skeleton rows and the creation row", () => {
    inspect({}, (document) => {
      expect(document.querySelectorAll(".notebook-activity-skeleton")).toHaveLength(4);
      expect(document.querySelectorAll(".notebook-activity .notebook-activity-row")).toHaveLength(1);
    });
  });
});
