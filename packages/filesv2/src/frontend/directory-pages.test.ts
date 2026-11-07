import { expect, test } from "bun:test";
import { directoryContext, directoryPageCount, directoryPages } from "./directory-pages";
import type { DirectoryView } from "./workspace-state";

const base: DirectoryView["base"] = {
  id: "home",
  name: "Home",
  area: "cloud",
  kind: "users",
  status: "existing",
  reason: null,
  indexEnabled: true,
  versioningEnabled: false,
};
const page = (name: string, next: string | null): DirectoryView => ({
  base,
  path: "",
  items: [{ name, path: name, directory: false, size: 3, modified: "2026-11-07T00:00:00Z" }],
  next,
});

test("reload and back rebuild the complete window; an append only reads the new page", async () => {
  const requests: (string | undefined)[] = [];
  const load = async (cursor?: string) => {
    requests.push(cursor);
    return cursor ? page("B", null) : page("A", "cursor");
  };
  const first = await directoryPages(1, undefined, load, new AbortController().signal);
  const appended = await directoryPages(2, undefined, load, new AbortController().signal, first);
  expect(requests).toEqual([undefined, "cursor"]);
  expect(appended.items.map((item) => item.name)).toEqual(["A", "B"]);
  expect(appended.loadedPages).toBe(2);
  expect(await directoryPages(2, undefined, load, new AbortController().signal)).toEqual(appended);
  const back = await directoryPages(1, undefined, load, new AbortController().signal);
  expect(back.items.map((item) => item.name)).toEqual(["A"]);
});

test("failed or cancelled appends preserve the previous snapshot and cursor for retry", async () => {
  const initial = { ...page("A", "cursor"), loadedPages: 1 };
  const controller = new AbortController();
  await expect(
    directoryPages(
      2,
      undefined,
      async () => {
        throw new Error("offline");
      },
      controller.signal,
      initial,
    ),
  ).rejects.toThrow("offline");
  expect(initial.items).toHaveLength(1);
  expect(initial.next).toBe("cursor");
  controller.abort();
  let calls = 0;
  await expect(
    directoryPages(
      2,
      undefined,
      async () => {
        calls++;
        return page("B", null);
      },
      controller.signal,
      initial,
    ),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});

test("URL replay validates counts and repeated cursors fail instead of looping", async () => {
  for (const value of ["0", "-1", "1.5", "NaN", String(Number.MAX_SAFE_INTEGER + 1)]) {
    expect(() => directoryPageCount(new URLSearchParams({ pages: value }))).toThrow();
  }
  expect(directoryPageCount(new URLSearchParams())).toBe(1);
  expect(directoryPageCount(new URLSearchParams({ pages: "3" }))).toBe(3);
  // Indexed directories can continue beyond the live filesystem scan limit.
  expect(directoryPageCount(new URLSearchParams({ pages: "401" }))).toBe(401);
  await expect(directoryPages(4, undefined, async () => page("A", "same"), new AbortController().signal)).rejects.toThrow("Repeated");
  expect(directoryContext("/app/filesv2?base=home&pages=3&file=A")).toBe(directoryContext("/app/filesv2?base=home"));
  expect(directoryContext("/app/filesv2?base=home&q=a")).not.toBe(directoryContext("/app/filesv2?base=home&q=b"));
});
