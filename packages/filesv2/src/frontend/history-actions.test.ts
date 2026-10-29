import { describe, expect, test } from "bun:test";
import { current, entry, env, gone, hidden, snapshot } from "../../test/history-fixtures";
import {
  dayGroups,
  type HistoryActions,
  historyRows,
  metaParts,
  missingCase,
  plain,
  rowAction,
  searchHits,
  sentence,
} from "./history-actions";
import { historyCatalog, historyMessages } from "./history-messages";

const de = historyMessages("de");
const en = historyMessages("en");
const single = (value: ReturnType<typeof entry>) => historyRows([value], { batches: true })[0]!;
const text = (value: ReturnType<typeof entry>, context: "activity" | "item" | "chain" = "activity", locale = de) =>
  plain(sentence(single(value), locale, env, { context }));

describe("history catalog", () => {
  test("German covers every English message", () => {
    expect(historyCatalog.check()).toEqual([]);
  });
});

describe("history sentences never reveal a hidden side", () => {
  test("a move into a hidden place names neither destination nor a path", () => {
    const moved = entry({ action: "item.move", before: gone("vertrieb/Kunden/Gehälter_2026.xlsx"), after: hidden });
    expect(text(moved)).toBe("Lukas Pohl hat Gehälter_2026.xlsx verschoben, an einen Ort, den du nicht sehen kannst");
    expect(text(moved, "chain")).toBe(
      "Lukas Pohl hat das Element von Team Vertrieb › Kunden an einen Ort verschoben, den du nicht sehen kannst",
    );
    expect(rowAction(single(moved), de, { onOpen: () => {} })).toBeNull();
  });

  test("a move out of a hidden place names only the visible destination", () => {
    const moved = entry({ action: "item.move", before: hidden, after: current("vertrieb/Archiv/Bericht.pdf", { directory: false }) });
    expect(text(moved)).toBe("Lukas Pohl hat Bericht.pdf von einem Ort, den du nicht sehen kannst, nach Team Vertrieb › Archiv verschoben");
  });

  test("a stored snapshot describes the move but never offers navigation", () => {
    const opened: unknown[] = [];
    const actions: HistoryActions = { onOpen: (target) => opened.push(target) };
    const own = entry({ action: "item.move", before: snapshot("vertrieb/Kunden/A"), after: snapshot("vertrieb/Archiv/A") });
    expect(rowAction(single(own), de, actions)).toBeNull();
    const live = entry({ action: "item.move", before: gone("vertrieb/Kunden/A"), after: current("vertrieb/Archiv/A") });
    const action = rowAction(single(live), de, actions)!;
    expect(action.label).toBe("Dorthin springen");
    void action.run();
    expect(opened).toEqual([{ kind: "side", side: live.after }]);
  });
});

describe("history rows", () => {
  test("a batch reads as one row counting only the visible members", () => {
    const batch = ["Angebote 2025", "Messe 2025", "Kalkulation_Q3.xlsx"].map((name) =>
      entry({
        action: "item.move",
        batchId: "b1",
        via: "agent",
        before: gone(`vertrieb/Kunden/${name}`),
        after: current(`vertrieb/Archiv/2025/${name}`),
      }),
    );
    const other = entry({ action: "file.upload", after: current("vertrieb/Kunden/x.pdf", { directory: false }) });
    const rows = historyRows([batch[0]!, other, batch[1]!, batch[2]!], { batches: true });
    expect(rows.map((row) => row.kind)).toEqual(["batch", "single"]);
    expect(plain(sentence(rows[0]!, de, env, { context: "activity" }))).toBe(
      "Assistant im Auftrag von Lukas Pohl hat 3 Elemente nach Team Vertrieb › Archiv › 2025 verschoben",
    );
  });

  test("consecutive editor saves of one person and run read as one row; another person starts a new row", () => {
    const save = (actor: string, minute: number) =>
      entry({
        action: "file.edit",
        via: "office",
        actor: { kind: "user", userId: actor, name: actor === "tom" ? "Tom Albers" : "Mia Schulz" },
        time: `2026-10-19T15:${minute}:00.000Z`,
        after: current("vertrieb/Proof.pdf", { directory: false }),
      });
    const rows = historyRows([save("tom", 20), save("tom", 15), save("tom", 10), save("mia", 5), save("tom", 1)], { batches: false });
    expect(rows.map((row) => [row.kind, row.entries.length])).toEqual([
      ["saves", 3],
      ["single", 1],
      ["single", 1],
    ]);
    const meta = metaParts(rows[0]!, de, "de", env, { context: "item", dated: false });
    expect(meta.map((part) => ("text" in part ? part.text : ""))).toEqual(["gestern, 17:20", "Office-Editor", "3-mal gespeichert"]);
  });

  test("days follow the person's time zone, not UTC", () => {
    const lateEvening = entry({ action: "folder.create", time: "2026-10-19T22:30:00.000Z", after: current("vertrieb/Neu") });
    const groups = dayGroups(historyRows([lateEvening], { batches: false }), "de", de, env);
    expect(groups[0]).toMatchObject({ label: "Heute", detail: "Dienstag, 20.10." });
  });

  test("an unclear or running entry says so in words and offers a check, never a jump", () => {
    const unclear = entry({
      action: "item.move",
      state: "unclear",
      before: gone("vertrieb/K.xlsx"),
      after: current("vertrieb/Archiv/K.xlsx", { directory: false }),
    });
    expect(text(unclear)).toBe("Lukas Pohl verschiebt K.xlsx nach Team Vertrieb › Archiv");
    const meta = metaParts(single(unclear), de, "de", env, { context: "activity", dated: true });
    expect(meta[0]).toMatchObject({ kind: "status", label: "Ausgang unklar" });
    expect(meta.at(-1)).toMatchObject({ kind: "text", text: "Dateien sucht einen Beleg" });
    expect(rowAction(single(unclear), de, { onOpen: () => {} })).toBeNull();
    expect(rowAction(single(unclear), de, { onRecheck: async () => {} })?.label).toBe("Jetzt prüfen");
    const running = entry({ action: "item.move", state: "pending", before: gone("a/M"), after: current("a/P/M") });
    expect(metaParts(single(running), en, "en", env, { context: "activity", dated: true })[0]).toMatchObject({ label: "Running" });
  });

  test("an observed difference names no person, time of change or cause", () => {
    const differs = entry({
      action: "item.differs",
      actor: { kind: "observed", userId: null, name: null },
      via: "observed",
      before: current("a/Preisliste.xlsx", { directory: false }),
      time: "2026-10-20T07:12:00.000Z",
    });
    expect(text(differs)).toBe("Preisliste.xlsx weicht vom letzten Stand in Cloud ab");
    const meta = metaParts(single(differs), de, "de", env, { context: "activity", dated: true }).map((part) =>
      "text" in part ? part.text : "",
    );
    expect(meta).toEqual(["bemerkt um 09:12", "ohne Eintrag in Cloud", "Ursache unbekannt"]);
  });

  test("a deleted account stays a deleted account and an unknown app is not named by its ID", () => {
    const deleted = entry({ action: "item.trash", actor: { kind: "user", userId: null, name: null }, before: gone("a/Entwurf.docx") });
    expect(text(deleted)).toBe("Gelöschtes Konto hat Entwurf.docx in den Papierkorb verschoben");
    const app = entry({ action: "file.create", via: "app:crm-x", after: current("a/R.pdf", { directory: false }) });
    expect(text(app, "activity", en)).toBe("Another app on behalf of Lukas Pohl created R.pdf");
  });

  test("the execution link appears only for a URL the parent supports", () => {
    const agent = entry({
      action: "item.move",
      via: "agent",
      execution: { invocationId: "i1", requestId: null, callingApp: "assistant", origin: "assistant" },
      before: gone("a/X"),
      after: current("b/X"),
    });
    const without = metaParts(single(agent), de, "de", env, { context: "activity", dated: true });
    expect(without.some((part) => part.kind === "link")).toBe(false);
    const linked = metaParts(
      single(agent),
      de,
      "de",
      { ...env, executionHref: () => "/app/assistant/runs/i1" },
      { context: "activity", dated: true },
    );
    expect(linked.at(-1)).toEqual({ kind: "link", href: "/app/assistant/runs/i1", label: "Ausführung ansehen" });
  });
});

describe("vanished items", () => {
  test("each newest entry maps to exactly one case", () => {
    expect(missingCase(entry({ action: "item.move", after: current("b/A") }))).toBe("moved");
    expect(missingCase(entry({ action: "item.move", after: hidden, before: gone("a/A") }))).toBe("hidden");
    expect(missingCase(entry({ action: "item.trash", before: gone("a/A") }))).toBe("trash");
    expect(missingCase(entry({ action: "item.purge", before: gone("a/A") }))).toBe("purged");
    expect(missingCase(entry({ action: "item.missing", before: gone("a/A") }))).toBe("outside");
    expect(missingCase(entry({ action: "item.move", state: "unclear", after: current("b/A") }))).toBe("unclear");
    expect(missingCase(entry({ action: "item.move", state: "failed", after: current("b/A") }))).toBeNull();
    expect(missingCase(entry({ action: "file.upload", after: current("b/A") }))).toBeNull();
  });

  test("homonyms without fixed IDs only merge at the same visible full path and scope", () => {
    const full = (path: string) => {
      const side = current(path, { directory: false });
      if (side.visibility !== "full") throw new Error("Expected full fixture");
      return side;
    };
    const same = full("team/Reports/report.pdf");
    const sides = [
      same,
      { ...same },
      full("team/Other/report.pdf"),
      { ...same, baseId: "binding-2", publicBaseId: "cloud:groups:other" },
      { ...same, root: "other-root" },
      { ...same, publicBaseId: null },
      { ...same, publicBaseId: null },
      gone("team/Reports/report.pdf", { publicBaseId: "cloud:groups:team", relativePath: "Reports/report.pdf" }),
      gone("team/Reports/report.pdf", { publicBaseId: "cloud:groups:team", relativePath: "Reports/report.pdf" }),
      gone("other/Reports/report.pdf", { publicBaseId: "cloud:groups:other", relativePath: "Reports/report.pdf" }),
      gone("team/Other/report.pdf", { publicBaseId: "cloud:groups:team", relativePath: "Other/report.pdf" }),
      gone("team/Reports/report.pdf"),
      gone("team/Reports/report.pdf"),
    ];
    const hits = searchHits(
      sides.map((after) => entry({ action: "file.upload", after })),
      "report.pdf",
    );
    expect(hits.map((hit) => hit.entries.length)).toEqual([2, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1]);
  });

  test("a fixed ID never merges across roots, bindings, public bases or unbound server snapshots", () => {
    const side = current("team/report.pdf", { itemId: "same-id", directory: false });
    if (side.visibility !== "full") throw new Error("Expected full fixture");
    const sides = [
      side,
      { ...side, path: "team/renamed.pdf" },
      { ...side, root: "another-root" },
      { ...side, baseId: "another-binding" },
      { ...side, publicBaseId: "cloud:groups:another" },
      { ...side, source: "snapshot" as const, publicBaseId: null },
      { ...side, source: "snapshot" as const, publicBaseId: null },
      { ...side, baseId: null },
      { ...side, baseId: null },
    ];
    expect(
      searchHits(
        sides.map((after) => entry({ action: "item.rename", after })),
        "report.pdf",
      ).map((hit) => hit.entries.length),
    ).toEqual([2, 1, 1, 1, 1, 1, 1, 1]);
  });

  test("search hits keep one item together across a rename and put the exact name first", () => {
    const renamed = entry({
      action: "item.rename",
      before: snapshot("a/Angebote", { itemId: "f1" }),
      after: current("a/Angebote 2025", { itemId: "f1" }),
    });
    const moved = entry({ action: "item.move", before: gone("a/Angebote 2025"), after: current("b/Angebote 2025", { itemId: "f1" }) });
    const sheet = entry({ action: "item.trash", before: gone("a/Angebote_2025_Übersicht.xlsx") });
    const hits = searchHits([sheet, moved, renamed], "angebote 2025");
    expect(hits.map((hit) => hit.entries.length)).toEqual([2, 1]);
    expect(hits[0]!.lead).toBe(moved);
  });
});

describe("link entries", () => {
  test("a created link names its recorded expiry; a revoked one does not", () => {
    const created = entry({
      action: "share.create",
      after: current("vertrieb/Druckdaten"),
      share: { expiresAt: "2026-10-31T22:00:00.000Z" },
    });
    const meta = (value: ReturnType<typeof entry>) =>
      metaParts(single(value), de, "de", env, { context: "activity", dated: true }).map((part) => ("text" in part ? part.text : part.kind));
    expect(meta(created)).toContain("gültig bis 31.10.");
    const revoked = entry({
      action: "share.revoke",
      after: current("vertrieb/Druckdaten"),
      share: { expiresAt: "2026-10-31T22:00:00.000Z" },
    });
    expect(meta(revoked).some((part) => part.startsWith("gültig"))).toBe(false);
  });
});
