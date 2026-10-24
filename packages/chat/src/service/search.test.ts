import { expect, test } from "bun:test";
import { chatMessages } from "../messages";
import { ConversationSchema } from "./contracts";
import { SEARCH_LIMIT, SearchHitSchema, SearchQuerySchema, SearchResultSchema } from "./search-contracts";
import { nameMatchRank, rankSearchCandidates, type SearchCandidate } from "./search-ranking";

const at = "2026-10-24T12:00:00.000Z";
const candidate = (key: string, name: string, activity = at, archived = false): SearchCandidate<string> => ({
  hit: key,
  key,
  name,
  activity,
  archived,
});

test("search validates a trimmed, nonempty literal query of at most 100 characters", () => {
  expect(SearchQuerySchema.parse({ q: "  IT  " })).toEqual({ q: "IT" });
  for (const input of [{}, { q: " " }, { q: "x".repeat(101) }, { q: "IT", cursor: "next" }]) {
    expect(SearchQuerySchema.safeParse(input).success).toBe(false);
  }
  expect(SearchQuerySchema.parse({ q: "x".repeat(100) }).q.length).toBe(100);
});

test("ranks exact, name prefix, word prefix and substring literally without ASCII-only boundaries", () => {
  expect(nameMatchRank("IT", "it")).toBe(0);
  expect(nameMatchRank("Ärzte", "ärz")).toBe(1);
  expect(nameMatchRank("IT team", "it")).toBe(1);
  expect(nameMatchRank("Our IT team", "it")).toBe(2);
  expect(nameMatchRank("Mitteilung", "it")).toBe(3);
  expect(nameMatchRank("äIT", "it")).toBe(3);
  expect(nameMatchRank("🙂IT", "it")).toBe(2);
  expect(nameMatchRank("Mitteilung IT", "it")).toBe(2);
  expect(nameMatchRank("50% [done]", "% [")).toBe(3);
  expect(nameMatchRank("Nothing", "[%")).toBeNull();
});

test("archived results sort last; relevance beats activity and ties remain stable", () => {
  const candidates = [
    candidate("old-exact", "IT", "2026-10-01T00:00:00.000Z"),
    candidate("prefix", "IT team"),
    candidate("word", "Team IT"),
    candidate("new-exact", "IT"),
    candidate("archived-exact", "IT", at, true),
    candidate("unrelated", "Sales"),
    candidate("substring", "Mitteilung"),
    candidate("tie-z", "IT"),
    candidate("tie-a", "IT"),
  ];
  expect(rankSearchCandidates(candidates, "it", 20)).toEqual([
    "new-exact",
    "tie-a",
    "tie-z",
    "old-exact",
    "prefix",
    "word",
    "substring",
    "archived-exact",
  ]);
  expect(rankSearchCandidates(candidates.reverse(), "it", 20)).toEqual([
    "new-exact",
    "tie-a",
    "tie-z",
    "old-exact",
    "prefix",
    "word",
    "substring",
    "archived-exact",
  ]);
});

test("the result schema and ranking both cap output at eight hits", () => {
  const hit = SearchHitSchema.parse({ kind: "system", ref: { type: "spaces.space", id: "Space1" }, name: "IT", conversation: null });
  expect(SearchResultSchema.parse({ items: Array(8).fill(hit), systemUnavailable: true }).items).toHaveLength(8);
  expect(SearchResultSchema.safeParse({ items: Array(9).fill(hit) }).success).toBe(false);
  expect(SearchResultSchema.safeParse({ items: [], systemUnavailable: false }).success).toBe(false);
  expect(
    rankSearchCandidates(
      Array.from({ length: 20 }, (_, i) => candidate(String(i), "IT")),
      "it",
      SEARCH_LIMIT,
    ),
  ).toHaveLength(8);
});

test("thread hits carry a minimal parent and optional item kind and completion", () => {
  const thread = {
    kind: "thread",
    conversation: { id: "Chat01", title: "IT", kind: "system" },
    thread: { id: "Task01", name: "Plan", resource: { kind: "task", done: true } },
  } as const;
  expect(SearchHitSchema.parse(thread)).toEqual(thread);
  expect(SearchHitSchema.safeParse({ ...thread, thread: { ...thread.thread, resource: { kind: "unknown", done: true } } }).success).toBe(
    false,
  );
  expect(SearchHitSchema.safeParse({ ...thread, conversation: { id: "bad", title: "IT", kind: "system" } }).success).toBe(false);
});

test("chat hits reuse the complete list summary and keep system conversation summaries nullable", () => {
  const conversation = ConversationSchema.parse({
    id: "Chat01",
    title: "IT",
    name: "IT",
    purpose: null,
    icon: null,
    archived: false,
    pinnedRank: null,
    channel: false,
    member: true,
    unread: 0,
    read: null,
    threads: 1,
    memberCount: 2,
    withGuests: false,
    peerDeactivated: false,
    rev: 0,
    permission: "read",
    createdAt: at,
    lastActivityAt: at,
    lastMessage: null,
  });
  expect(SearchHitSchema.parse({ kind: "chat", conversation })).toEqual({ kind: "chat", conversation });
  expect(SearchHitSchema.safeParse({ kind: "chat", conversation: null }).success).toBe(false);
  expect(
    SearchHitSchema.parse({ kind: "system", ref: { type: "notebooks.notebook", id: "Book01" }, name: "IT", conversation }).conversation,
  ).toEqual(conversation);
});

test("the search feedback catalog supplies the approved German text and English equivalents", () => {
  const de = chatMessages.resolve(["de"]).t;
  const en = chatMessages.resolve(["en"]).t;
  expect(de.searchChats).toBe("Suchen");
  expect(de.searchNoResults({ q: "IT" })).toBe("Nichts gefunden für „IT“");
  expect(de.searchSystemUnavailable).toBe("Suche in Spaces und Notebooks fehlgeschlagen");
  expect(de.retry).toBe("Erneut versuchen");
  expect(de.searchTaskIn({ title: "Frühlingsausstellung" })).toBe("Aufgabe in Frühlingsausstellung");
  expect(en.searchThreadIn({ title: "IT" })).toBe("Thread in IT");
});
