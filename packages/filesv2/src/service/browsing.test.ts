import { describe, expect, test } from "bun:test";
import { FilegateError } from "@k2b/filegate";
import { browsePage } from "./browsing";

describe("globally ordered browsing", () => {
  test("directories exhaust their sorted cursor before the first file page", async () => {
    const requests: unknown[] = [];
    const fetch = async (options: Parameters<Parameters<typeof browsePage>[2]>[0]) => {
      requests.push(options);
      if (options.type === "directories")
        return options.after ? { items: ["Z folder"] } : { items: ["A folder"], next: "directory-page-2" };
      return { items: ["A file", "Z file"] };
    };
    const first = await browsePage({ sort: "size", order: "desc" }, "root:path", fetch);
    const second = await browsePage({ sort: "size", order: "desc", after: first.next! }, "root:path", fetch);
    expect([...first.items, ...second.items]).toEqual(["A folder", "Z folder", "A file", "Z file"]);
    expect(second.next).toBeNull();
    expect(requests).toEqual([
      { sort: "size", order: "desc", type: "directories", after: undefined, limit: 50 },
      { sort: "size", order: "desc", type: "directories", after: "directory-page-2", limit: 50 },
      { sort: "size", order: "desc", type: "files", limit: 50 },
    ]);
  });
  test("a small folder shows files on its first page and file cursors retain their fixed limit", async () => {
    const requests: unknown[] = [];
    const fetch = async (options: Parameters<Parameters<typeof browsePage>[2]>[0]) => {
      requests.push(options);
      if (options.type === "directories") return { items: ["folder A", "folder B"] };
      if (options.after) return { items: ["remaining file"] };
      return { items: Array.from({ length: options.limit! }, (_, index) => `file ${index}`), next: "files-continuation" };
    };
    const first = await browsePage({}, "small", fetch);
    expect(first.items).toHaveLength(52);
    expect(first.items.slice(0, 3)).toEqual(["folder A", "folder B", "file 0"]);
    const second = await browsePage({ after: first.next! }, "small", fetch);
    expect(second).toEqual({ items: ["remaining file"], next: null, total: null });
    expect(requests).toEqual([
      { sort: "name", order: "asc", type: "directories", after: undefined, limit: 50 },
      { sort: "name", order: "asc", type: "files", limit: 50 },
      { sort: "name", order: "asc", type: "files", after: "files-continuation", limit: 50 },
    ]);
  });
  test("mixed sorting and type filters are passed upstream without local rearrangement", async () => {
    const requests: unknown[] = [];
    const fetch = async (options: unknown) => {
      requests.push(options);
      return { items: ["Z", "a"] };
    };
    expect((await browsePage({ groupFolders: false, sort: "modified" }, "path", fetch)).items).toEqual(["Z", "a"]);
    await browsePage({ type: "files" }, "path", fetch);
    expect(requests).toEqual([
      { sort: "modified", order: "asc", type: "all", after: undefined, limit: 50 },
      { sort: "name", order: "asc", type: "files", after: undefined, limit: 50 },
    ]);
  });
  test("relevance reads one ungrouped query and keeps the first page's total on every continuation", async () => {
    const requests: { sort?: string; type?: string; after?: string }[] = [];
    const fetch = async (options: Parameters<Parameters<typeof browsePage>[2]>[0]) => {
      requests.push(options);
      return options.after ? { items: ["third"], total: 99 } : { items: ["best", "second"], next: "more", total: 3 };
    };
    const first = await browsePage({ sort: "relevance" }, "search", fetch);
    expect(first).toMatchObject({ items: ["best", "second"], total: 3 });
    expect(await browsePage({ sort: "relevance", after: first.next! }, "search", fetch)).toEqual({
      items: ["third"],
      next: null,
      total: 3,
    });
    expect(requests.map(({ sort, type, after }) => ({ sort, type, after }))).toEqual([
      { sort: "relevance", type: "all", after: undefined },
      { sort: "relevance", type: "all", after: "more" },
    ]);
    // Grouped folders and files are two queries, so neither total is the whole result.
    expect((await browsePage({}, "search", async () => ({ items: ["only"], total: 1 }))).total).toBeNull();
    await expect(browsePage({ sort: "name", after: first.next! }, "search", fetch)).rejects.toMatchObject({ code: "cursor_invalid" });
  });
  test("empty indexed page keeps its cursor; an exhausted empty directory phase advances once", async () => {
    let calls = 0;
    const result = await browsePage({}, "path", async () => {
      calls++;
      return { items: [], next: "scan-next" };
    });
    expect(result.next).not.toBeNull();
    expect(calls).toBe(1);
    const files = await browsePage({}, "path", async (options) => (options.type === "directories" ? { items: [] } : { items: ["file"] }));
    expect(files).toEqual({ items: ["file"], next: null, total: null });
  });
  test("query, location, and malformed cursor changes reject before reading", async () => {
    const first = await browsePage({}, "root/path", async () => ({ items: ["one"], next: "next" }));
    const forbidden = async () => {
      throw new Error("must not read");
    };
    for (const input of [
      { after: "not-a-cursor" },
      { after: first.next!, sort: "size" as const },
      { after: first.next!, groupFolders: false },
    ])
      await expect(browsePage(input, "root/path", forbidden)).rejects.toMatchObject({ code: "cursor_invalid", status: 409 });
    await expect(browsePage({ after: first.next! }, "other/path", forbidden)).rejects.toMatchObject({ code: "cursor_invalid" });
  });
});

test("query bindings keep cursor size independent of long storage paths", async () => {
  const scope = "long/".repeat(819);
  const page = await browsePage({ groupFolders: false }, scope, async () => ({ items: ["one"], next: "upstream" }));
  expect(page.next!.length).toBeLessThan(256);
  await expect(
    browsePage({ groupFolders: false, after: page.next! }, `${scope}different`, async () => ({ items: [] })),
  ).rejects.toMatchObject({ code: "cursor_invalid" });
});

test("strict upstream continuation errors never return the already read directory half", async () => {
  for (const status of [403, 404]) {
    let reads = 0;
    await expect(
      browsePage({}, "strict", async (options) => {
        reads++;
        if (options.type === "directories") return { items: ["visible-folder"] };
        throw new FilegateError(status, status === 403 ? "forbidden" : "not_found", "changed");
      }),
    ).rejects.toMatchObject({ status });
    expect(reads).toBe(2);
  }
});
