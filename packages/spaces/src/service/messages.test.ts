import { describe, expect, test } from "bun:test";
import { checkSpacesMessages, localizeSpacesMessage, spacesMessages } from "./messages";

describe("Spaces messages", () => {
  test("keeps catalogs complete and falls back from regional German locales", () => {
    expect(checkSpacesMessages()).toEqual([]);
    expect(spacesMessages("de-CH").widgetTitle).toBe("Heute");
    expect(spacesMessages("de-CH").starterInProgress).toBe("In Arbeit");
    expect(spacesMessages("fr").widgetTitle).toBe("Today");
  });

  test("localizes known final API messages without changing unknown diagnostics", () => {
    expect(localizeSpacesMessage("Item not found", "de-DE")).toBe("Der Eintrag wurde nicht gefunden");
    expect(localizeSpacesMessage("Item deleted", "de-DE")).toBe("Eintrag gelöscht");
    expect(localizeSpacesMessage("Task blocker removed", "de-CH")).toBe("Blockierende Aufgabe entfernt");
    expect(localizeSpacesMessage("Column abc not found in space", "de-DE")).toBe("Die Spalte abc wurde in diesem Space nicht gefunden");
    expect(localizeSpacesMessage("A task can have at most 20 attachments", "de-DE")).toBe("Eine Aufgabe kann höchstens 20 Anhänge haben");
    expect(localizeSpacesMessage("A task can have at most 50 blockers", "de-DE")).toBe(
      "Eine Aufgabe kann höchstens 50 blockierende Aufgaben haben",
    );
    expect(localizeSpacesMessage("Created calendar event has no public ID", "de-DE")).toBe(
      "Für den erstellten Kalendertermin fehlt die öffentliche ID",
    );
    expect(localizeSpacesMessage("Invitation source could not be reserved", "de-DE")).toBe(
      "Die Quelle der Einladung konnte nicht reserviert werden",
    );
    expect(localizeSpacesMessage("Database unavailable", "de-DE")).toBe("Database unavailable");
  });
});
