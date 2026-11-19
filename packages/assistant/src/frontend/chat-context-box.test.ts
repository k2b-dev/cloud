import { describe, expect, test } from "bun:test";
import type { AssistantChatResult } from "../chat-context";
import { fileResult, minutesAgo, SIDEBAR_NOW, sidebarSnapshot, source } from "./AssistantChatSidebar.fixture";
import { buildContextBoxModel, CONTEXT_BOX_ROW_LIMIT, contextBoxPending, contextBoxWhen } from "./chat-context-box";

const copy = {
  results: "Ergebnisse",
  sourcesSummary: ({ named, pages, searches, items }: { named: readonly string[]; pages: number; searches: number; items: number }) =>
    [...named, `${items}/${pages}/${searches}`].join(", "),
  contextSummary: ({ project, skills }: { project: string | null; skills: number; memories: number; routines: number }) =>
    [project, skills ? `${skills} Skills` : null].filter(Boolean).join(", "),
  contextFallback: "Secrets & Freigaben",
  showInChat: "Im Chat zeigen",
};
const build = (snapshot = sidebarSnapshot(), project: string | null = null) =>
  buildContextBoxModel(snapshot, { locale: "de", formatSize: (bytes) => `${bytes} B`, copy, project });

describe("box model", () => {
  test("names the time of a result from the server's clock: today the time, this week the day, else the date", () => {
    expect(contextBoxWhen(minutesAgo(5), SIDEBAR_NOW, "Europe/Berlin", "de")).toBe("14:25");
    expect(contextBoxWhen("2026-10-01T10:00:00.000Z", SIDEBAR_NOW, "Europe/Berlin", "de")).toBe("Do");
    expect(contextBoxWhen("2026-08-14T10:00:00.000Z", SIDEBAR_NOW, "Europe/Berlin", "de")).toBe("14. Aug.");
  });

  test("files show their size and download while pointing; other results their time and the way back to the chat", () => {
    const [file, view] = build().results.rows;
    expect(file).toMatchObject({ trailing: "1400000 B", open: { kind: "file" }, hover: { kind: "download" } });
    expect(view).toMatchObject({ trailing: "14:09", open: { kind: "jump" }, hover: null });
  });

  test("a view says what it shows with its own sign, never a size, and points back to the chat", () => {
    const view = (key: string, kind: AssistantChatResult["view"], icon: string, seq: number) => ({
      ...fileResult(key, { at: minutesAgo(seq), turn: `t${seq}`, seq, size: 0, mediaType: "application/json" }),
      icon,
      view: kind,
    });
    const rows = build(
      sidebarSnapshot({
        results: [
          view("/views/aufgaben.view.json", "chart", "ti ti-chart-bar", 1),
          // Key figures read "Kennzahlen", not their JSON's size (#91: "0 B" in the box).
          view("/views/kennzahlen.view.json", "stats", "ti ti-numbers", 2),
          view("/views/alt.view.json", "view", "ti ti-file", 3),
        ],
      }),
    ).results.rows;
    expect(rows.map((row) => [row.trailing, row.icon, row.open.kind, row.hover?.kind])).toEqual([
      ["Diagramm", "ti ti-chart-bar", "file", "jump"],
      ["Kennzahlen", "ti ti-numbers", "file", "jump"],
      ["Ansicht", "ti ti-presentation-analytics", "file", "jump"],
    ]);
    expect(rows.some((row) => row.trailing.endsWith(" B"))).toBe(false);
  });

  test("a visualization leads back to its place in the chat, with one action per row", () => {
    const visualization = {
      key: "code_present:c9",
      kind: "visualization" as const,
      title: "Lieferavise je Woche",
      description: null,
      icon: "ti ti-chart-bar",
      deliveredAt: minutesAgo(3),
      turnId: "t9",
      callId: "c9",
      messageSeq: 9,
      presentationId: "00000000-0000-4000-8000-000000000009",
    };
    const [row] = build(sidebarSnapshot({ results: [visualization] })).results.rows;
    expect(row).toMatchObject({
      open: { kind: "jump", target: { presentationId: visualization.presentationId } },
      hover: null,
    });
  });

  test("the three newest results lead; more lead to all", () => {
    const results = Array.from({ length: 6 }, (_, index) =>
      fileResult(`/r${index}.pdf`, { at: minutesAgo(60 - index), turn: "t", seq: 1 }),
    );
    const box = build(sidebarSnapshot({ results }));
    expect(box.results.rows.map((row) => row.title)).toEqual(["r5.pdf", "r4.pdf", "r3.pdf"]);
    expect(box.results).toMatchObject({ count: 6, more: true });
  });

  test("a context line is always there; an empty chat is empty", () => {
    expect(build(sidebarSnapshot({ skills: [], memories: [] })).context).toBe("Secrets & Freigaben");
    expect(build(sidebarSnapshot(), "Einkauf").context).toBe("Einkauf, 1 Skills");
    const empty = build(sidebarSnapshot({ results: [], sources: [], sourceCount: 0, skills: [], memories: [] }));
    expect(empty.empty).toBe(true);
    // A chat whose only content is its context keeps the context line: when its last alarm has rung, the box does not
    // fall back to the empty sentence.
    const contextOnly = build(sidebarSnapshot({ results: [], sources: [], sourceCount: 0, memories: [] }));
    expect([contextOnly.empty, contextOnly.context]).toEqual([false, "1 Skills"]);
  });

  test("the sources line names Cloud items in their app's nouns and counts the rest as items", () => {
    const mails = ["M1", "M2", "M3"].map((id) =>
      source("resource", `mail.message:${id}`, `Mail ${id}`, minutesAgo(5), { ref: { type: "mail.message", id } }),
    );
    const note = source("resource", "notebooks.note:N1", "Notiz", minutesAgo(6), { ref: { type: "notebooks.note", id: "N1" } });
    const snapshot = sidebarSnapshot({
      sources: [...mails, note, ...sidebarSnapshot().sources],
      sourceCount: 6,
      resourceCounts: [{ type: "mail.message", count: 3, label: "3 Mails" }],
    });
    expect(build(snapshot).sources).toBe("3 Mails, 1/1/1");
  });

  test("never more than ten rows, groups included", () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({ key: `r${index}`, icon: "ti ti-code", title: `A${index}`, word: "An" }));
    const groups = ["a", "b", "c", "d"].map((key) => ({ key, label: key, count: 5, rows }));
    const results = Array.from({ length: 5 }, (_, index) => fileResult(`/r${index}.pdf`, { at: minutesAgo(index), turn: "t", seq: 1 }));
    const box = build(sidebarSnapshot({ results, groups }));
    const total = box.results.rows.length + box.groups.reduce((sum, group) => sum + group.rows.length, 0) + 2;
    expect(total).toBeLessThanOrEqual(CONTEXT_BOX_ROW_LIMIT);
    expect(box.groups.every((group) => group.rows.length <= 3)).toBe(true);
  });

  test("counts new results and changed group rows since the held snapshot", () => {
    const held = sidebarSnapshot({
      groups: [{ key: "g", label: "G", count: 1, rows: [{ key: "a", icon: "i", title: "A", word: "Pausiert" }] }],
    });
    const live = sidebarSnapshot({
      results: [fileResult("/neu.pdf", { at: SIDEBAR_NOW, turn: "t", seq: 1 }), ...held.results],
      groups: [{ key: "g", label: "G", count: 1, rows: [{ key: "a", icon: "i", title: "A", word: "Eingeschaltet" }] }],
    });
    expect(contextBoxPending(held, live)).toBe(2);
    expect(contextBoxPending(held, held)).toBe(0);
  });
});
