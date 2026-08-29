import { describe, expect, test } from "bun:test";
import { noteEditCapabilitySummary } from "./capabilities";
import { notebookCapabilityMessages } from "./capability-messages";
import { slashCommandMessages } from "./frontend/[id]/_components/editor/slash-commands/messages";
import { notebookSettingsMessages } from "./frontend/[id]/_components/settings/messages";
import { notebookWorkspaceMessages } from "./frontend/[id]/messages";
import { notebooksAdminMessages } from "./frontend/admin-messages";
import { notebooksPageMessages } from "./frontend/messages";
import { materializeTemplate, templates } from "./templates";

describe("Notebooks internationalization", () => {
  test("keeps every app catalog complete", () => {
    for (const catalog of [
      notebooksPageMessages,
      notebookWorkspaceMessages,
      notebooksAdminMessages,
      notebookSettingsMessages,
      notebookCapabilityMessages,
      slashCommandMessages,
    ]) {
      expect(catalog.check()).toEqual([]);
    }
  });

  test("resolves German regional locales and falls back to English", () => {
    expect(notebooksPageMessages.resolve(["de-CH"]).t.newNotebook).toBe("Neues Notizbuch");
    expect(notebookWorkspaceMessages.resolve(["de-CH"]).t.deleteNote).toBe("Notiz löschen");
    expect(notebooksAdminMessages.resolve(["de-CH"]).t.settings).toBe("Einstellungen");
    expect(notebookCapabilityMessages.resolve(["de-CH"]).t.note).toBe("Notiz");
    expect(notebookWorkspaceMessages.resolve(["de-CH"]).t.sortNotes).toBe("Notizen sortieren");
    expect(notebookWorkspaceMessages.resolve(["de-CH"]).t.updatedSort).toBe("Zuletzt geändert");
    expect(notebooksPageMessages.resolve(["fr"]).t.newNotebook).toBe("New notebook");
  });

  test("keeps capability codes implicit while localizing final summaries", () => {
    expect(noteEditCapabilitySummary([{ kind: "append", content: "Eine Zeile" }], "Plan", true, "de-CH")).toBe(
      "1 Zeile zu „Plan“ hinzugefügt.",
    );
  });

  test("localizes slash-command help by stable command name", () => {
    const { t } = slashCommandMessages.resolve(["de-CH"]);
    expect(t.label({ name: "file", fallback: "Reference file" })).toBe("Datei referenzieren");
    expect(t.label({ name: "upload", fallback: "Upload file" })).toBe("Datei hochladen");
    expect(t.label({ name: "id", fallback: "Readable ID" })).toBe("Lesbare ID");
    expect(t.description({ name: "switch", fallback: "Open a different note in this notebook" })).toBe(
      "Eine andere Notiz in diesem Notizbuch öffnen",
    );
  });

  test("selects explicit German templates without changing stable ids or note keys", () => {
    const german = templates.map((template) => materializeTemplate(template, new Date("2031-01-05T12:00:00Z"), "de-CH"));
    expect(german.map((template) => template.id)).toEqual(["daily-notes", "garden-planner", "recipe-collector", "reading-list"]);
    expect(german.map((template) => template.name)).toEqual(["Tagebuch", "Gartentagebuch", "Rezepte und Vorräte", "Leseliste"]);
    expect(materializeTemplate(templates[0]!, new Date("2031-01-05T12:00:00Z"), "fr").name).toBe("Daily Journal");
    expect(german[0]!.notes.map((note) => note.key)).toEqual(
      materializeTemplate(templates[0]!, new Date("2031-01-05T12:00:00Z"), "en").notes.map((note) => note.key),
    );
  });
});
