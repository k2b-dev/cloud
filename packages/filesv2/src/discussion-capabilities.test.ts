import { afterEach, expect, mock, test } from "bun:test";
import { assertDiscussionContainersPage } from "@k2b/cloud/capabilities/testing";
import { type CapabilityExecutionContext, DiscussionContainersDataSchema, DiscussionContainersInputSchema } from "@k2b/cloud/contracts";

import { testActor } from "../test/files-call";

const calls: unknown[] = [];
let denied = false;

const context: CapabilityExecutionContext = {
  actor: testActor,
  accessSubject: { type: "user", userId: "subject" },
  user: testActor.kind === "user" ? testActor.user : null,
  locale: "en",
  requestId: "test",
  origin: "app",
  signal: new AbortController().signal,
};
class FilesError extends Error {
  constructor(
    public code: string,
    public status: number,
  ) {
    super(code);
  }
}
mock.module("./api/api-error", () => ({ apiError: (error: FilesError) => ({ code: error.code, status: error.status }) }));
mock.module("./files-call", () => ({
  capabilityCall: (value: unknown) => {
    calls.push(value);
    return value;
  },
}));
mock.module("./service", () => ({
  FilesError,
  filesService: {
    baseNames: async () => {
      if (denied) throw new FilesError("forbidden", 403);
      return [{ id: "a" }, { id: "b" }];
    },
    discussionFolderPage: async (call: unknown, input: { baseId: string; after?: string }) => {
      expect(call).toBe(context);
      return {
        items: Array.from({ length: 4 }, (_, i) => ({
          ref: { type: "filesv2.folder", id: `${input.baseId}${input.after ?? ""}${i}` },
          title: `Folder ${i}`,
        })),
        next: input.after ? null : "source-next",
      };
    },
  },
}));
const { discussionQueries } = await import("./discussion-capabilities");
const query = discussionQueries["folder.containers"];
afterEach(() => {
  denied = false;
  calls.length = 0;
});

test("container pagination preserves every row with changing limits, source pages and bases", async () => {
  let cursor: string | undefined;
  const ids = [];
  let pages = 0;
  do {
    const result = await query.run(DiscussionContainersInputSchema.parse({ limit: pages % 2 ? 3 : 1, cursor }), context);
    if (!result.ok) throw new Error(result.error.message);
    expect(DiscussionContainersDataSchema.safeParse(result.data.data).success).toBe(true);
    assertDiscussionContainersPage(result.data);
    ids.push(...result.data.data.items.map((item) => item.ref.id));
    cursor = result.data.data.next ?? undefined;
    if (++pages > 16) throw new Error("Pagination did not progress");
  } while (cursor);
  expect(ids).toHaveLength(16);
  expect(new Set(ids).size).toBe(16);
  expect(calls.every((call) => call === context)).toBe(true);
});

test("empty filtered pages retain continuation and changed query or invalid cursor fails", async () => {
  const result = await query.run(DiscussionContainersInputSchema.parse({ query: "absent" }), context);
  if (!result.ok) throw new Error(result.error.message);
  expect(result.data.data.items).toEqual([]);
  expect(result.data.data.next).not.toBeNull();
  assertDiscussionContainersPage(result.data);
  for (const input of [{ cursor: "invalid" }, { cursor: result.data.data.next, query: "changed" }])
    expect((await query.run(DiscussionContainersInputSchema.parse(input), context)).ok).toBe(false);
});

test("caller permission denial remains a visible failure under the incoming identity", async () => {
  denied = true;
  await expect(query.run(DiscussionContainersInputSchema.parse({}), context)).rejects.toMatchObject({ code: "forbidden", status: 403 });
  expect(calls).toEqual([context]);
});
