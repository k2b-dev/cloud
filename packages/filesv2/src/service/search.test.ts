import { expect, test } from "bun:test";
import { FilegateError } from "@k2b/filegate";
import type { FilesRoot } from "./filegate-facade";
import { highlight, mayMatchTrashFolder, searchPage, trashHits } from "./search";

const failure = (status: number, code: string) => new FilegateError(status, code, code);
/** A root that answers each search call with the next scripted outcome. */
const scripted = (...outcomes: (Error | { items: []; total?: number })[]) => {
  const calls: unknown[] = [];
  const root = {
    search: async (_q: string, options: unknown) => {
      calls.push(options);
      const next = outcomes.shift();
      if (!next) throw new Error("unexpected search");
      if (next instanceof Error) throw next;
      return next;
    },
  } as unknown as FilesRoot;
  return { root, calls };
};
const options = { path: "home/alice", sort: "relevance" as const, match: "fuzzy" as const, in: "path" as const };

test("a busy root is retried twice, independent of one restart of a changed first page", async () => {
  const busy = failure(429, "search_busy");
  const restart = scripted(failure(409, "cursor_invalid"), busy, busy, { items: [] });
  expect(await searchPage(restart.root, "rechnung", options)).toEqual({ items: [] });
  expect(restart.calls).toHaveLength(4);
  await expect(searchPage(scripted(busy, busy, busy).root, "rechnung", options)).rejects.toMatchObject({ code: "search_busy" });
  // A continuation never restarts on its own: its pages belong to the old observation.
  await expect(searchPage(scripted(failure(409, "cursor_invalid")).root, "x", { ...options, after: "c" })).rejects.toMatchObject({
    code: "cursor_invalid",
  });
  await expect(searchPage(scripted(failure(413, "limit_exceeded")).root, "x", options)).rejects.toMatchObject({ code: "search_limited" });
  await expect(searchPage(scripted(failure(400, "invalid_argument")).root, "x", options)).rejects.toMatchObject({ code: "invalid_input" });
}, 10_000);

test("a Filegate that does not answer in time is unavailable; the caller's own cancellation stays a cancellation", async () => {
  const silent = {
    search: (_q: string, { signal }: { signal: AbortSignal }) =>
      new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
  } as unknown as FilesRoot;
  const caller = new AbortController();
  const cancelled = searchPage(silent, "x", { ...options, signal: caller.signal });
  caller.abort();
  await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
});

test("a trash count never covers a word that could match the trash folder's own name", async () => {
  for (const word of ["trash", "Trash", "tras", "rash", "ash", "sh", "h", "hauptakte", "trsh", "trashy", "tr-ash", "st"])
    expect([word, mayMatchTrashFolder(word)]).toEqual([word, true]);
  for (const word of ["rechnung", "report", "kunden", "oktober", "2026", "pdf"])
    expect([word, mayMatchTrashFolder(word)]).toEqual([word, false]);
  const counted = scripted({ items: [], total: 2 });
  expect(await trashHits(counted.root, "rechnung", { ...options, path: "home/alice/trash" })).toBe(2);
  // The search for "trash" would count trashed entries through the folder name above it but not below it.
  expect(await trashHits(scripted().root, "trash report", { ...options, path: "home/alice/trash" })).toBeNull();
  // Without a trash folder nothing is hidden; a spent budget makes the total unknown instead of failing the search.
  expect(await trashHits(scripted(failure(404, "not_found")).root, "rechnung", { ...options, path: "home/alice/trash" })).toBe(0);
  expect(await trashHits(scripted(failure(413, "limit_exceeded")).root, "rechnung", { ...options, path: "t" })).toBeNull();
  // Other sorts drop loose hits depending on the rest of the selection, so the two queries are not comparable.
  expect(await trashHits(scripted().root, "rechnung", { ...options, sort: "name", path: "t" })).toBeNull();
});

test("name matches are moved into the path below the searched folder, counted in code points", () => {
  expect(highlight("Kunden/Bäckerei/Rechnung.pdf", [[0, 8]], "name")).toEqual([[16, 24]]);
  expect(highlight("🧾/Rechnung.pdf", [[0, 8]], "name")).toEqual([[2, 10]]);
  expect(highlight("Kunden/Rechnung.pdf", [[0, 6]], "path")).toEqual([[0, 6]]);
  expect(highlight("Rechnung.pdf", undefined, "path")).toEqual([]);
});
