import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  parseDetailPanelOpen,
  parsePinnedNotebookIds,
  parseSettings,
  readPinnedNotebookIds,
  readSettings,
  setDetailPanelOpen,
  setLastNotebookId,
  setPinnedNotebookIds,
  writeSettings,
} from "./NotebookSettingsStore";

const COOKIE_NAME = "settings-app-notebooks";
let cookie = "";

const cookieHeader = () => cookie;

beforeEach(() => {
  cookie = "";
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      get cookie() {
        return cookie;
      },
      set cookie(value: string) {
        cookie = value.split(";", 1)[0] ?? "";
      },
    },
  });
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { protocol: "http:" },
  });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "document");
  Reflect.deleteProperty(globalThis, "location");
});

describe("NotebookSettingsStore", () => {
  test("clears a persisted source-mode override when switching back to rich mode", () => {
    writeSettings("first", { richMode: "source" });
    expect(readSettings("first").richMode).toBe("source");

    writeSettings("first", { richMode: "rich" });

    expect(readSettings("first").richMode).toBe("rich");
    expect(parseSettings(cookieHeader(), "first").richMode).toBe("rich");
  });

  test("preserves preferences for other notebooks and when changing the last notebook", () => {
    writeSettings("first", { richMode: "source" });
    writeSettings("second", { lastNoteId: "note-2", navigatorSort: "title", treeSort: "created" });
    setLastNotebookId("second");

    expect(parseSettings(cookieHeader(), "first").richMode).toBe("source");
    expect(parseSettings(cookieHeader(), "second").lastNoteId).toBe("note-2");
    expect(parseSettings(cookieHeader(), "second").navigatorSort).toBe("title");
    expect(parseSettings(cookieHeader(), "second").treeSort).toBe("created");
    expect(parseSettings(cookieHeader(), "first").navigatorSort).toBe("updated");
    expect(parseSettings(cookieHeader(), "first").treeSort).toBe("title");
  });

  test("persists detail-panel visibility for server rendering", () => {
    setDetailPanelOpen(true);
    expect(parseDetailPanelOpen(cookieHeader())).toBe(true);

    setDetailPanelOpen(false);
    expect(parseDetailPanelOpen(cookieHeader())).toBe(false);
    expect(decodeURIComponent(cookie)).toContain(COOKIE_NAME);
  });

  test("persists a bounded, unique pinned notebook order for server rendering", () => {
    setPinnedNotebookIds(["Book02", "Book01", "Book02", "invalid-id"]);

    expect(readPinnedNotebookIds()).toEqual(["Book02", "Book01"]);
    expect(parsePinnedNotebookIds(cookieHeader())).toEqual(["Book02", "Book01"]);
  });

  test("ignores malformed preference values", () => {
    cookie = `${COOKIE_NAME}=${encodeURIComponent(
      JSON.stringify({
        sidebarMode: "broken",
        detailPanelOpen: "yes",
        notebooks: { first: { richMode: "broken", navigatorSort: 42, treeSort: "broken", lastNoteId: false } },
      }),
    )}`;

    expect(readSettings("first")).toEqual({
      lastNoteId: null,
      richMode: "rich",
      sidebarMode: "simple",
      navigatorSort: "updated",
      treeSort: "title",
    });
    expect(parseDetailPanelOpen(cookieHeader())).toBe(false);
    expect(parsePinnedNotebookIds(cookieHeader())).toEqual([]);
  });

  test("bounds notebook-specific preferences", () => {
    for (let index = 0; index < 30; index++) {
      writeSettings(`notebook-${index}`, { lastNoteId: `note-${index}` });
    }

    expect(parseSettings(cookieHeader(), "notebook-0").lastNoteId).toBeNull();
    expect(parseSettings(cookieHeader(), "notebook-29").lastNoteId).toBe("note-29");
  });
});
