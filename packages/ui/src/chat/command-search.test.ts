import { describe, expect, test } from "bun:test";
import type { ChatCommand, ChatCommandScope } from "./ChatComposer";
import {
  chatCommandListModel,
  matchesChatCommand,
  parseChatCommandQuery,
  rankChatCommand,
  resolveChatCommandScope,
} from "./command-search";

const command = (label: string, extra: Partial<ChatCommand> = {}): ChatCommand => ({ name: label, label, description: "", ...extra });
const scopes: ChatCommandScope[] = [
  { id: "note", title: "Notizen", words: ["notizen", "note", "notes"] },
  { id: "notebook", title: "Notizbücher", words: ["notizbücher", "notebook", "notebooks"] },
];

describe("command ranking", () => {
  test("uses the full ladder, old names as keywords, and typo tolerance only from four characters", () => {
    const entries = [
      command("Rechnungen abgleichen"),
      command("Neue Rechnung"),
      command("Abrechnung"),
      command("Zahlen", { keywords: ["rechnen"] }),
      command("Werkzeug", { app: "Rechner" }),
      command("Hilfe", { description: "Eine Rechnung prüfen" }),
    ];
    expect(entries.map((entry) => rankChatCommand(entry, "rech")?.rank)).toEqual([0, 1, 2, 3, 4, 5]);
    const ranked = chatCommandListModel({
      query: "rech",
      sections: [{ id: "one", label: "One" }],
      commands: [...entries].reverse().map((entry) => ({ ...entry, section: "one" })),
      searchResults: [],
      searchResultsFresh: true,
      searchSettled: true,
      searching: false,
    });
    expect(ranked.rows.map((row) => row.command.name)).toEqual(entries.map((entry) => entry.name));
    const compact = command("Chat kompaktieren", { name: "compact" });
    expect(rankChatCommand(compact, "compact")).toEqual({ rank: 3 });
    expect(rankChatCommand(compact, "kmpakt")).toEqual({ rank: 6 });
    expect(rankChatCommand(compact, "kmp")).toBeNull();
    expect(rankChatCommand(command("Other", { description: "Rechnung" }), "re")).toBeNull();
    expect(rankChatCommand(compact, "  ")).toEqual({ rank: 0 });
  });
  test("maps folded accents, sharp s and combining marks to original title ranges", () => {
    for (const [title, query, rank, range] of [
      ["Übersetzen", "ubersetzen", 0, [0, 10]],
      ["Text kürzen", "kurzen", 1, [5, 11]],
      ["Straße", "strasse", 0, [0, 6]],
      ["Straße prüfen", "pruf", 1, [7, 11]],
      ["Straße pru\u0308fen", "pruf", 1, [7, 12]],
      ["Cafe\u0301", "cafe", 0, [0, 5]],
      ["Abrechnung", "  reCH ", 2, [2, 6]],
      ["Straße", "sse", 2, [4, 6]],
    ] as const)
      expect(rankChatCommand(command(title), query)).toEqual({ rank, highlight: range });
  });
  test("recognizes every specified title word separator", () => {
    for (const separator of [" ", "-", "_", ".", "/", "·", ":", ",", "(", ")", "„", "“", '"', "'"])
      expect(rankChatCommand(command(`Neue${separator}Rechnung`), "rech")?.rank).toBe(1);
  });
});

describe("first-word scopes", () => {
  test("exact wins, otherwise shortest extension wins at three letters; ties resolve to nothing", () => {
    expect(resolveChatCommandScope("notiz", scopes)?.id).toBe("note");
    expect(resolveChatCommandScope("notizb", scopes)?.id).toBe("notebook");
    expect(resolveChatCommandScope("no", scopes)).toBeUndefined();
    expect(resolveChatCommandScope("notizbucher", scopes)?.id).toBe("notebook");
    expect(resolveChatCommandScope("not", [scopes[0]!, { id: "other", title: "Other", words: ["notz"] }])).toBeUndefined();
    expect(resolveChatCommandScope("note", [...scopes, { id: "other", title: "Other", words: ["note"] }])).toBeUndefined();
    expect(resolveChatCommandScope("not", [{ id: "exact", title: "Exact", words: ["not"] }, ...scopes])?.id).toBe("exact");
  });
  test("requires whitespace after the first word and preserves the rest", () => {
    expect(parseChatCommandQuery("notiz", scopes)).toEqual({ query: "notiz" });
    expect(parseChatCommandQuery("notiz \t Q3 ", scopes)).toEqual({ scope: scopes[0], query: "Q3 " });
    expect(parseChatCommandQuery("notiz\tQ3", scopes)).toEqual({ scope: scopes[0], query: "Q3" });
    expect(parseChatCommandQuery("no Q3", scopes)).toEqual({ query: "no Q3" });
  });
});

const sections = [
  { id: "first", label: "First", searched: true },
  { id: "second", label: "Second" },
];
const model = (extra: Partial<Parameters<typeof chatCommandListModel>[0]> = {}) =>
  chatCommandListModel({
    query: "",
    sections,
    commands: [],
    searchResults: [],
    searchResultsFresh: true,
    searchSettled: true,
    searching: false,
    ...extra,
  });
const names = (rows: ReturnType<typeof model>["rows"]) => rows.map((row) => row.command.name);

describe("section list model", () => {
  test("keeps section order across queries, consumer order in overview and ladder order within each section", () => {
    const commands = [
      command("Neue Rechnung", { section: "second" }),
      command("Abrechnung", { section: "first" }),
      command("Rechnungen", { section: "first" }),
    ];
    expect(names(model({ commands }).rows)).toEqual(["Abrechnung", "Rechnungen", "Neue Rechnung"]);
    for (const query of ["rech", "rechnung", "rech"]) {
      const result = model({ query, commands });
      expect(result.groups.map((group) => group.section?.id)).toEqual(["first", "second"]);
      expect(names(result.rows)).toEqual(["Rechnungen", "Abrechnung", "Neue Rechnung"]);
    }
    expect(names(model({ sections: undefined, commands }).rows)).toEqual(commands.map((entry) => entry.name));
    expect(names(model({ query: "rech", sections: undefined, commands }).rows)).toEqual(["Rechnungen", "Neue Rechnung", "Abrechnung"]);
  });
  test("deduplicates by key: first section wins, then static over server; unknown sections trail", () => {
    const commands = [command("Later", { id: "same", section: "second" }), command("Static", { id: "local", section: "first" })];
    const searchResults = [command("Earlier", { id: "same", section: "first" }), command("Server", { id: "local", section: "first" })];
    expect(names(model({ commands, searchResults }).rows)).toEqual(["Static", "Earlier"]);
    expect(names(model({ commands: [command("Unknown", { section: "unknown" }), command("Plain")] }).rows)).toEqual(["Unknown", "Plain"]);
  });
  test.each(["skills", "apps"])("a non-matching static row in %s cannot swallow a fresh server copy", (section) => {
    const result = model({
      query: "zzz",
      sections: [
        { id: "skills", label: "Skills" },
        { id: "apps", label: "Apps" },
      ],
      commands: [command("Static", { id: "a", section })],
      searchResults: [command("Server", { id: "a", section: "apps" })],
    });
    expect(result.groups.map((group) => group.section?.id)).toEqual(["apps"]);
    expect(names(result.rows)).toEqual(["Server"]);
    expect(result.rows[0]?.server).toBe(true);
  });
  test("settled Assistant-like sections keep only chat or a placeholder for a filtered retained skill", () => {
    const input = {
      query: "neu",
      sections: [
        { id: "skills", label: "Skills", searched: true },
        { id: "files", label: "Files", searched: true, searchOnly: true },
        { id: "apps", label: "Apps", searched: true },
        { id: "chat", label: "Dieser Chat" },
      ],
      commands: [command("Neuer Chat", { section: "chat" })],
      searchSettled: true,
      searchResultsFresh: false,
      searching: true,
    };
    const empty = model({ ...input, searchResults: [] });
    expect(empty.groups.map((group) => group.section?.id)).toEqual(["chat"]);
    expect(empty.groups.some((group) => group.placeholder)).toBe(false);
    const retained = model({ ...input, searchResults: [command("Invoices", { section: "skills" })] });
    expect(retained.groups.map((group) => group.section?.id)).toEqual(["skills", "chat"]);
    expect(retained.groups[0]).toMatchObject({ loading: true, placeholder: true, rows: [] });
    expect(names(retained.rows)).toEqual(["Neuer Chat"]);
    const matching = model({ ...input, searchResults: [command("Neu", { section: "skills" })] });
    expect(matching.groups[0]).toMatchObject({ loading: true, placeholder: false });
    expect(names(matching.groups[0]!.rows)).toEqual(["Neu"]);
  });
  test("not applicable rows appear with their reason only when searched", () => {
    const hidden = command("Compact", { hiddenUntilSearch: true, reason: "Needs messages", section: "second" });
    expect(model({ commands: [hidden], searchResults: [hidden] }).rows).toEqual([]);
    expect(model({ query: "comp", commands: [hidden] }).rows[0]?.command.reason).toBe("Needs messages");
  });
  test("fresh server rows survive no local match; stale rows must match; ties keep static then server order", () => {
    const commands = [command("Rechnung A"), command("Rechnung B")];
    const searchResults = [command("Rechnung C"), command("Unrelated"), command("Rechnung D")];
    expect(names(model({ query: "rech", commands, searchResults }).rows)).toEqual([
      "Rechnung A",
      "Rechnung B",
      "Rechnung C",
      "Rechnung D",
      "Unrelated",
    ]);
    expect(names(model({ query: "rech", commands, searchResults, searchResultsFresh: false }).rows)).toEqual([
      "Rechnung A",
      "Rechnung B",
      "Rechnung C",
      "Rechnung D",
    ]);
  });
  test("scope shows only server rows and keeps hidden rows, ranked by the rest", () => {
    const result = model({
      query: "notiz rech",
      scopes,
      commands: [command("Rechnung static")],
      searchResults: [command("Other", { hiddenUntilSearch: true }), command("Rechnung")],
      searching: true,
    });
    expect(result.scope?.id).toBe("note");
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({ scopeTitle: "Notizen", loading: true, placeholder: false });
    expect(names(result.rows)).toEqual(["Rechnung", "Other"]);
    expect(names(model({ query: "notiz ", scopes, searchResults: [command("Hidden", { hiddenUntilSearch: true })] }).rows)).toEqual([
      "Hidden",
    ]);
  });
  test("loading searched sections reserve empty space only before a search settles or for retained rows", () => {
    for (const query of ["", "xylo"]) {
      const result = model({ query, searching: true, searchSettled: false });
      expect(result.groups[0]).toMatchObject({ section: sections[0], loading: true, placeholder: true });
      expect(result.rows).toEqual([]);
      expect(result.empty).toBe(false);
      expect(result.groups.filter((group) => group.placeholder)).toHaveLength(1);
    }
    expect(model({ query: "xylo", searching: true }).groups).toEqual([]);
    expect(model({ searching: true, commands: [command("Kept", { section: "first" })] }).groups[0]?.placeholder).toBe(false);
    expect(model().empty).toBe(true);
    expect(model().groups.every((group) => !group.placeholder)).toBe(true);
    expect(model({ query: "notiz ", scopes, searching: true }).groups[0]).toMatchObject({
      scopeTitle: "Notizen",
      loading: true,
      placeholder: true,
    });
  });
});

test("a search-only section stays out of the overview, placeholder included, and appears when searched", () => {
  const sections = [
    { id: "files", label: "Files", searched: true, searchOnly: true },
    { id: "chat", label: "This chat" },
  ];
  const input = {
    sections,
    commands: [command("New chat", { section: "chat" })],
    searchResults: [command("report.pdf", { section: "files" })],
    searchResultsFresh: true,
    searchSettled: true,
    searching: true,
  };
  const overview = chatCommandListModel({ ...input, query: "" });
  expect(overview.groups.map((group) => group.section?.id)).toEqual(["chat"]);
  expect(overview.rows.map((row) => row.command.name)).toEqual(["New chat"]);
  const search = chatCommandListModel({ ...input, query: "rep", searching: false });
  expect(search.groups.map((group) => group.section?.id)).toEqual(["files"]);
});

test("matchesChatCommand shares empty, bilingual, accent and typo ranking rules", () => {
  const row = command("Modell wählen", { keywords: ["choose", "model"], description: "Straße prüfen" });
  for (const query of ["", "  ", "modell", "wahlen", "choose", "modle", "strasse"]) expect(matchesChatCommand(row, query)).toBe(true);
  for (const query of ["xyz", "modleeeee"]) expect(matchesChatCommand(row, query)).toBe(false);
});

describe("sections whose local rows are still on their way", () => {
  const input = (query: string, extra: Partial<Parameters<typeof chatCommandListModel>[0]> = {}) =>
    chatCommandListModel({
      query,
      sections: [
        { id: "chat", label: "Chat" },
        { id: "apps", label: "Apps", pending: true },
      ],
      commands: [command("Compact", { section: "chat" })],
      searchResults: [],
      searchResultsFresh: true,
      searchSettled: true,
      searching: false,
      ...extra,
    });
  test("a pending section reserves three rows in the overview and one in a search, and holds Nothing found", () => {
    expect(input("").groups.map((group) => [group.section?.id, group.pendingRows, group.loading])).toEqual([
      ["chat", 0, false],
      ["apps", 3, true],
    ]);
    const search = input("xylo");
    expect(search.groups.map((group) => [group.section?.id, group.pendingRows])).toEqual([["apps", 1]]);
    expect(search.rows).toEqual([]);
    expect(search.empty).toBe(false);
    expect(input("notiz q3", { scopes }).groups[0]).toMatchObject({ scopeTitle: "Notizen", pendingRows: 0 });
  });
  test("a persistent row stays in every search of its section, after the matches", () => {
    const retry = command("Could not load", { section: "chat", persistent: true });
    const rows = input("comp", { commands: [retry, command("Compact", { section: "chat" })] }).rows;
    expect(rows.map((row) => row.command.label)).toEqual(["Compact", "Could not load"]);
    expect(input("xylo", { commands: [retry] }).rows.map((row) => row.command.label)).toEqual(["Could not load"]);
  });
});
