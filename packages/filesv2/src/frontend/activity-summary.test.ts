import { describe, expect, test } from "bun:test";
import { entry, env, live } from "../../test/history-fixtures";
import { activitySummary } from "./activity-summary";
import { historyMessages } from "./history-messages";

const t = historyMessages("de");

describe("the summary beside Activity", () => {
  test("counts each change once, as the list's counter does, even when a page brings it again", () => {
    const upload = entry({ action: "file.upload", after: live("vertrieb/Kunden/Angebot.pdf", { directory: false }) });
    const summary = activitySummary([upload, upload], t, env);
    expect(summary.people).toEqual([{ key: "lukas", label: "Lukas Pohl", count: 1 }]);
    expect(summary.kinds.map((kind) => [kind.kind, kind.count])).toEqual([["added", 1]]);
  });

  test("tells people with the same name apart by who they are, not by their name", () => {
    const first = entry({ action: "file.edit", actor: { kind: "user", userId: "anna-1", name: "Anna Weber" } });
    const second = entry({ action: "file.edit", actor: { kind: "user", userId: "anna-2", name: "Anna Weber" } });
    expect(activitySummary([first, second], t, env).people.map((person) => [person.key, person.count])).toEqual([
      ["anna-1", 1],
      ["anna-2", 1],
    ]);
  });

  test("groups places by the storage and their first folder, most changed first, and names the kind of change", () => {
    const entries = [
      entry({ action: "file.upload", after: live("vertrieb/Kunden/Lindqvist/Aufmass.pdf", { directory: false }) }),
      entry({ action: "file.edit", after: live("vertrieb/Kunden/Oswald/Plan.pdf", { directory: false }) }),
      entry({ action: "item.trash", before: live("vertrieb/Archiv/Alt.pdf", { directory: false }) }),
    ];
    const summary = activitySummary(entries, t, env);
    expect(summary.places.map((place) => [place.label, place.count])).toEqual([
      ["Team Vertrieb › Kunden", 2],
      ["Team Vertrieb › Archiv", 1],
    ]);
    // one change each: in the order of their names
    expect(summary.kinds.map((kind) => kind.label)).toEqual(["Geändert", "Gelöscht", "Neu"]);
  });
});
