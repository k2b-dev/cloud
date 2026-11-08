import { describe, expect, test } from "bun:test";
import { entry, env, gone, hidden, live, snapshot } from "../../test/history-fixtures";
import type { ActivityEntry } from "../activity-contracts";
import { historyRows, historyRuns, type Part, plain, RUN_MIN, rowAction, runSentence, sentence } from "./history-actions";
import { historyMessages } from "./history-messages";

const de = historyMessages("de");
const en = historyMessages("en");
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 20, 18, 54, seconds)).toISOString();
const valentin = { kind: "user" as const, userId: "valentin", name: "Valentin Kolb" };

/** The API bulk case: each file renamed in Inbox, then moved to Buchhaltung › ebay; newest first, like the reader. */
function renameThenMove(file: string, seconds: number, patch: Partial<ActivityEntry> = {}) {
  const renamed = `${file}-Rechnung.pdf`;
  const rename = entry({
    action: "item.rename",
    time: at(seconds),
    actor: valentin,
    via: "api",
    before: snapshot(`vertrieb/Inbox/${file}.pdf`, { directory: false }),
    after: snapshot(`vertrieb/Inbox/${renamed}`, { directory: false }),
    ...patch,
  });
  const move = entry({
    action: "item.move",
    time: at(seconds + 1),
    actor: valentin,
    via: "api",
    before: snapshot(`vertrieb/Inbox/${renamed}`, { directory: false }),
    after: live(`vertrieb/Buchhaltung/ebay/${renamed}`, { directory: false }),
    ...patch,
  });
  return [move, rename];
}
const names = (parts: readonly Part[]) => parts.filter((part) => part.kind === "name");

describe("a rename and a move of one item read as one line", () => {
  test("the same person, channel and minute merge into one sentence with the current name as the link", () => {
    const rows = historyRows(renameThenMove("A", 10), { batches: true, merge: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("renameMove");
    const parts = sentence(rows[0]!, de, env, { context: "activity", links: true });
    expect(plain(parts)).toBe("Valentin Kolb hat A.pdf in A-Rechnung.pdf umbenannt und nach Team Vertrieb › Buchhaltung › ebay verschoben");
    // Only the current name is a strong name; the old one is plain text.
    expect(names(parts)).toEqual([
      {
        kind: "name",
        text: "A-Rechnung.pdf",
        href: "/app/filesv2?base=cloud%3Agroups%3Avertrieb&path=Buchhaltung%2Febay&file=Buchhaltung%2Febay%2FA-Rechnung.pdf",
      },
    ]);
    expect(plain(sentence(rows[0]!, en, env, { context: "activity" }))).toBe(
      "Valentin Kolb renamed A.pdf to A-Rechnung.pdf and moved it to Team Vertrieb › Buchhaltung › ebay",
    );
  });

  test("a move before a rename merges too", () => {
    const move = entry({
      action: "item.move",
      time: at(1),
      actor: valentin,
      before: snapshot("vertrieb/Inbox/B.pdf", { directory: false }),
      after: snapshot("vertrieb/Archiv/B.pdf", { directory: false }),
    });
    const rename = entry({
      action: "item.rename",
      time: at(2),
      actor: valentin,
      before: snapshot("vertrieb/Archiv/B.pdf", { directory: false }),
      after: live("vertrieb/Archiv/C.pdf", { directory: false }),
    });
    const rows = historyRows([rename, move], { batches: true, merge: true });
    expect(rows.map((row) => row.kind)).toEqual(["renameMove"]);
    expect(plain(sentence(rows[0]!, de, env, { context: "activity" }))).toBe(
      "Valentin Kolb hat B.pdf in C.pdf umbenannt und nach Team Vertrieb › Archiv verschoben",
    );
  });

  test("another person, another channel, more than a minute apart or another item stays two lines", () => {
    const [move, rename] = renameThenMove("A", 10);
    const lukas = { kind: "user" as const, userId: "lukas", name: "Lukas Pohl" };
    const cases: [ActivityEntry, ActivityEntry][] = [
      [move!, { ...rename!, actor: lukas }],
      [move!, { ...rename!, via: "web" }],
      [{ ...move!, time: at(10 + 61) }, rename!],
      [move!, { ...rename!, after: snapshot("vertrieb/Inbox/Other.pdf", { directory: false }) }],
      [
        { ...move!, before: { ...snapshot("vertrieb/Inbox/A-Rechnung.pdf", { directory: false, itemId: "one" }) } },
        { ...rename!, after: snapshot("vertrieb/Inbox/A-Rechnung.pdf", { directory: false, itemId: "two" }) },
      ],
      [{ ...move!, state: "failed" }, rename!],
    ];
    for (const pair of cases)
      expect(historyRows(pair, { batches: true, merge: true }).map((row) => row.kind)).toEqual(["single", "single"]);
    // Without merging, as in the item detail, both stay their own rows.
    expect(historyRows([move!, rename!], { batches: true }).map((row) => row.kind)).toEqual(["single", "single"]);
  });

  test("a merge never names a side the viewer cannot see", () => {
    const [move, rename] = renameThenMove("A", 10);
    const rows = historyRows([{ ...move!, after: hidden }, rename!], { batches: true, merge: true });
    expect(rows.map((row) => row.kind)).toEqual(["single", "single"]);
    expect(JSON.stringify(rows.map((row) => sentence(row, de, env, { context: "activity", links: true })))).not.toContain("ebay");
  });
});

describe("a run of changes by one person at one time collapses", () => {
  const bulk = (count: number) =>
    historyRows(Array.from({ length: count }, (_, index) => renameThenMove(`F${index}`, 50 - index * 2)).flat(), {
      batches: true,
      merge: true,
    });

  test(`${RUN_MIN} or more lines become one run that keeps every row in order`, () => {
    expect(historyRuns(bulk(RUN_MIN - 1)).map((item) => item.kind)).toEqual(["row", "row", "row", "row"]);
    const runs = historyRuns(bulk(12));
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    if (run.kind !== "run") throw new Error("expected a run");
    expect(run.rows.map((row) => row.kind)).toEqual(Array(12).fill("renameMove"));
    expect(plain(runSentence(run.rows, de, env, "de"))).toBe("Valentin Kolb hat 12 Dateien umbenannt und verschoben");
    expect(plain(runSentence(run.rows, en, env, "en"))).toBe("Valentin Kolb renamed and moved 12 files");
  });

  test("another actor, a gap over a minute or an unfinished change ends the run", () => {
    const rows = bulk(6);
    const lukas = { kind: "user" as const, userId: "lukas", name: "Lukas Pohl" };
    const other = { ...rows[3]!, lead: { ...rows[3]!.lead, actor: lukas } };
    expect(historyRuns([...rows.slice(0, 3), other, ...rows.slice(4)]).map((item) => item.kind)).toEqual(Array(6).fill("row"));
    const late = rows.map((row, index) =>
      index < 3 ? row : { ...row, lead: { ...row.lead, time: at(-120) }, entries: [{ ...row.lead, time: at(-120) }] },
    );
    expect(historyRuns(late).map((item) => item.kind)).toEqual(Array(6).fill("row"));
    const failed = { ...rows[2]!, lead: { ...rows[2]!.lead, state: "failed" as const } };
    expect(historyRuns([...rows.slice(0, 2), failed, ...rows.slice(3)]).map((item) => item.kind)).toEqual(Array(6).fill("row"));
  });

  test("lines inside a run name only the change; other changes keep the full sentence", () => {
    const [pair] = historyRows(renameThenMove("A", 10), { batches: true, merge: true });
    expect(plain(sentence(pair!, de, env, { context: "activity", member: true }))).toBe(
      "A.pdf → A-Rechnung.pdf, nach Team Vertrieb › Buchhaltung › ebay verschoben",
    );
    expect(plain(sentence(pair!, en, env, { context: "activity", member: true }))).toBe(
      "A.pdf → A-Rechnung.pdf, moved to Team Vertrieb › Buchhaltung › ebay",
    );
    const share = entry({ action: "share.create", actor: valentin, after: live("vertrieb/A.pdf", { directory: false }) });
    expect(plain(sentence(historyRows([share], { batches: true })[0]!, de, env, { context: "activity", member: true }))).toBe(
      "Valentin Kolb hat einen öffentlichen Link für A.pdf erstellt",
    );
  });

  test("mixed changes read as changed items", () => {
    const uploads = Array.from({ length: 5 }, (_, index) =>
      entry({
        action: index % 2 ? "file.upload" : "folder.create",
        time: at(30 - index),
        actor: valentin,
        after: snapshot(`vertrieb/Neu/${index}`, { directory: index % 2 === 0 }),
      }),
    );
    const trash = entry({ action: "item.trash", time: at(24), actor: valentin, before: snapshot("vertrieb/x.pdf", { directory: false }) });
    const run = historyRuns(historyRows([...uploads, trash], { batches: true, merge: true }))[0]!;
    if (run.kind !== "run") throw new Error("expected a run");
    expect(plain(runSentence(run.rows, de, env, "de"))).toBe("Valentin Kolb hat 6 Elemente geändert");
  });
});

describe("names lead to where an item is now, and only there", () => {
  test("a current side links its name and every folder; a snapshot says it is no longer available", () => {
    const moved = entry({
      action: "item.move",
      before: snapshot("vertrieb/Inbox/A.pdf", { directory: false }),
      after: live("vertrieb/Buchhaltung/2026/A.pdf", { directory: false }),
    });
    const parts = sentence(historyRows([moved], { batches: true })[0]!, de, env, { context: "activity", links: true });
    expect(parts.find((part) => part.kind === "place")).toEqual({
      kind: "place",
      segments: ["Team Vertrieb", "Buchhaltung", "2026"],
      hrefs: [
        "/app/filesv2?base=cloud%3Agroups%3Avertrieb",
        "/app/filesv2?base=cloud%3Agroups%3Avertrieb&path=Buchhaltung",
        "/app/filesv2?base=cloud%3Agroups%3Avertrieb&path=Buchhaltung%2F2026",
      ],
    });
    const stale = entry({ action: "file.upload", after: snapshot("vertrieb/Inbox/Alt.pdf", { directory: false }) });
    const staleParts = sentence(historyRows([stale], { batches: true })[0]!, de, env, { context: "activity", links: true });
    expect(plain(staleParts)).toBe("Lukas Pohl hat Alt.pdf hochgeladen");
    expect(names(staleParts)).toEqual([{ kind: "name", text: "Alt.pdf", hint: "nicht mehr verfügbar" }]);
    const vanished = entry({ action: "file.overwrite", after: gone("vertrieb/Weg.pdf", { directory: false }) });
    expect(names(sentence(historyRows([vanished], { batches: true })[0]!, de, env, { context: "activity", links: true }))).toEqual([
      { kind: "name", text: "Weg.pdf", hint: "nicht mehr verfügbar" },
    ]);
  });

  test("a linked name replaces the separate jump action; other actions stay", () => {
    const moved = entry({ action: "item.move", before: hidden, after: live("vertrieb/Archiv/A.pdf", { directory: false }) });
    const row = historyRows([moved], { batches: true })[0]!;
    const actions = { onOpen: () => {}, onRecheck: async () => {} };
    expect(rowAction(row, de, actions)?.label).toBe("Dorthin springen");
    expect(rowAction(row, de, actions, { links: true })).toBeNull();
    const unclear = historyRows([{ ...moved, state: "unclear" }], { batches: true })[0]!;
    expect(rowAction(unclear, de, actions, { links: true })?.label).toBe("Jetzt prüfen");
  });

  test("a trashed item needs no second hint, and lists without links stay as they were", () => {
    const trashed = entry({ action: "item.trash", before: snapshot("vertrieb/Alt.pdf", { directory: false }) });
    expect(names(sentence(historyRows([trashed], { batches: true })[0]!, de, env, { context: "activity", links: true }))).toEqual([
      { kind: "name", text: "Alt.pdf" },
    ]);
    const moved = entry({ action: "item.move", before: hidden, after: live("vertrieb/Archiv/A.pdf", { directory: false }) });
    const parts = sentence(historyRows([moved], { batches: true })[0]!, de, env, { context: "activity" });
    expect(JSON.stringify(parts)).not.toMatch(/href|hint/);
  });
});
