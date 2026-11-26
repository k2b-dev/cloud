import { expect, test } from "bun:test";
import { actorId, baseId, historyBinding, historyFixture, home, otherId, publicBaseId } from "../../test/activity-reader-fixture";
import { testActor } from "../../test/files-call";
import type { ListingFactRow, ListingFactsInput } from "../data/listing-facts";
import { FilesError } from "./errors";
import { createListingFactsReader } from "./listing-facts";

const page = {
  binding: historyBinding,
  baseId: publicBaseId,
  folder: "",
  items: [{ path: "new", target: `${home}/new`, itemId: "stable-a", directory: true }],
};
const call = { actor: testActor };
function fixture(rows: ListingFactRow[] = [{ path: "new", author_id: otherId, links: 2 }]) {
  const f = historyFixture();
  const inputs: ListingFactsInput[] = [];
  const names: string[][] = [];
  const reader = createListingFactsReader({
    requestContext: (...args) => f.deps.requestContext(...args),
    displayNames: async (entries) => {
      names.push(entries.flatMap((entry) => (entry.principal.type === "user" ? [entry.principal.userId] : [])));
      return f.deps.displayNames(entries);
    },
    data: async (input) => {
      inputs.push(input);
      return rows;
    },
  });
  return { ...f, reader, inputs, names };
}

test("listing projects live names once for distinct visible authors and preserves the caller's link count", async () => {
  const f = fixture([
    { path: "new", author_id: otherId, links: 2 },
    { path: "nested/file", author_id: otherId, links: 0 },
    { path: "deleted", author_id: actorId, links: 1 },
  ]);
  const result = await f.reader(call, page);
  expect(result.get("new")).toEqual({ author: { userId: otherId, name: "Live name" }, links: 2 });
  expect(result.get("nested/file")?.author?.name).toBe("Live name");
  expect(result.get("deleted")).toEqual({ author: null, links: 1 });
  expect(f.names).toEqual([[otherId, actorId]]);
  expect(f.authorized).toEqual([""]);
  expect(f.inputs[0]).toMatchObject({ userId: actorId, bindingId: baseId, history: true, items: page.items });
});

test("foreign admin listing hides the author without resolving names or using unaudited history", async () => {
  const f = fixture();
  f.setAdmin(true);
  f.setMember(false);
  expect((await f.reader(call, page)).get("new")).toEqual({ author: null, links: 2 });
  expect(f.inputs[0]?.history).toBe(false);
  expect(f.names).toEqual([]);
  expect(f.authorized).toEqual([]);
  expect(f.adminReads).toEqual([]);
});

test("history-unavailable and POSIX listings never resolve names", async () => {
  for (const mode of ["unavailable", "posix"] as const) {
    const f = fixture();
    const context = f.deps.requestContext;
    f.deps.requestContext = async (...args) => ({ ...(await context(...args)), historyAvailable: mode !== "unavailable" });
    const selected = mode === "posix" ? { ...page, binding: { ...historyBinding, area: "freeipa" as const } } : page;
    expect((await f.reader(call, selected)).get("new")?.author).toBeNull();
    expect(f.names).toEqual([]);
    expect(f.inputs[0]?.history).toBe(false);
  }
});

test("denied and mismatched read-only folder proofs suppress names; outages propagate", async () => {
  for (const mode of ["denied", "changed", "outage"] as const) {
    const f = fixture();
    const context = f.deps.requestContext;
    f.deps.requestContext = async (...args) => {
      const current = await context(...args);
      return {
        ...current,
        readOnlyAuthorized: async (base, path) => {
          if (mode !== "changed") throw new FilesError(mode === "denied" ? "forbidden" : "unavailable", mode === "denied" ? 403 : 503);
          return { ...(await current.readOnlyAuthorized(base, path)), target: "another/folder" };
        },
      };
    };
    if (mode === "outage") await expect(f.reader(call, page)).rejects.toMatchObject({ status: 503 });
    else expect((await f.reader(call, page)).get("new")?.author).toBeNull();
    expect(f.names).toEqual([]);
  }
});

test("empty pages do not query facts or names", async () => {
  const f = fixture();
  expect((await f.reader(call, { ...page, items: [] })).size).toBe(0);
  expect(f.inputs).toEqual([]);
  expect(f.names).toEqual([]);
});
