import { describe, expect, test } from "bun:test";
import { fileResult, minutesAgo, SIDEBAR_NOW, sidebarSnapshot } from "./AssistantChatSidebar.fixture";
import { buildContextBoxModel, CONTEXT_BOX_ROW_LIMIT, contextBoxPending, contextBoxWhen } from "./chat-context-box";

const copy = {
  results: "Ergebnisse",
  sourcesSummary: ({ pages, searches, items }: { pages: number; searches: number; items: number }) => `${items}/${pages}/${searches}`,
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
    const empty = build(sidebarSnapshot({ results: [], sources: [], sourceCount: 0 }));
    expect(empty.empty).toBe(true);
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
