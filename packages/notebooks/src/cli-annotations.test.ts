import { expect, test } from "bun:test";
import type { CloudCliContext } from "@k2b/cloud/cli";
import { formatAnnotationThread, readAnnotationThread } from "./cli-annotations";
import { type Annotation, AnnotationDataSchema } from "./lib/annotation-contracts";

const rootId = "11111111-1111-4111-8111-111111111111";
const replyId = "22222222-2222-4222-8222-222222222222";
const author = { kind: "user", id: rootId, name: "Mara Keller" };
const fixture = (): Annotation =>
  AnnotationDataSchema.parse({
    id: rootId,
    noteId: "note01",
    from: 7,
    to: 13,
    orphan: false,
    startRel: "",
    endRel: "",
    restoreRevision: "0",
    quote: "target",
    prefix: "Before ",
    suffix: " after",
    body: "Please clarify.\nKeep the context.",
    suggestion: "replacement",
    suggestionState: "rejected",
    suggestionStateBy: author,
    suggestionStateAt: "2026-10-26T14:12:00.000Z",
    suggestionStateVia: "assistant",
    state: "open",
    stateBy: null,
    stateAt: null,
    stateVia: null,
    author,
    via: null,
    createdAt: "2026-10-26T14:02:00.000Z",
    editedAt: null,
    canEdit: false,
    canDelete: false,
    headingPath: ["Handbook", "Membership"],
    acceptedOperationId: null,
    replies: [
      {
        id: replyId,
        author: { kind: "service_account", id: replyId, name: "Review Agent" },
        via: "assistant",
        body: "A clearer phrase.",
        suggestion: "",
        suggestionState: "open",
        suggestionStateBy: null,
        suggestionStateAt: null,
        suggestionStateVia: null,
        createdAt: "2026-10-26T14:10:00.000Z",
        editedAt: null,
        canEdit: false,
        canDelete: false,
      },
    ],
    repliesNextCursor: null,
  });
const context = (fetch: CloudCliContext["fetch"]): CloudCliContext => ({
  args: [],
  flags: {},
  options: { profile: "test", server: "https://example.test", token: "test", locale: "en", output: "text" },
  fetch,
  readJson: async (response) => response.json(),
  getDefault: async () => undefined,
  setDefault: async () => undefined,
  createApiClient: () => {
    throw new Error("Unused");
  },
  print: () => {},
  write: async () => {},
  error: () => {},
  json: () => {},
  jsonLine: () => {},
  table: () => {},
});
test("human thread output includes context, authors, replies, replacement states and provenance", () => {
  const result = formatAnnotationThread(
    fixture(),
    context(async () => Response.json({})),
  );
  for (const value of [
    rootId,
    "open  Mara Keller",
    "2026-10-26 14:02",
    "Handbook › Membership",
    "Before [target] after",
    "Please clarify.",
    'Suggestion (rejected): "replacement"',
    "rejected: Mara Keller · via Assistant",
    `↳ ${replyId}  Review Agent · via Assistant`,
    'Suggestion (open): ""',
  ])
    expect(result).toContain(value);
  const orphan = { ...fixture(), orphan: true };
  expect(
    formatAnnotationThread(
      orphan,
      context(async () => Response.json({})),
    ),
  ).toContain('ORPHANED: the passage was deleted (was: "target")');
});
test("show follows reply pages, retains full text, and detects a repeated cursor", async () => {
  const item = { ...fixture(), replies: [], repliesNextCursor: "page-2" };
  const paths: string[] = [];
  const ctx = context(async (path) => {
    paths.push(path);
    return Response.json(path.includes("/replies?") ? { items: fixture().replies, nextCursor: null } : item);
  });
  expect(await readAnnotationThread(ctx, rootId)).toMatchObject({ quote: "target", replies: fixture().replies, repliesNextCursor: null });
  expect(paths).toEqual([
    `/api/notebooks/annotations/${rootId}`,
    `/api/notebooks/notes/note01/annotations/${rootId}/replies?cursor=page-2`,
  ]);
  const repeated = context(async (path) =>
    Response.json(path.includes("/replies?") ? { items: fixture().replies, nextCursor: "page-2" } : item),
  );
  await expect(readAnnotationThread(repeated, rootId)).rejects.toThrow("did not advance");
});
test("show preserves a continuation instead of silently truncating a large thread", async () => {
  const item = { ...fixture(), repliesNextCursor: "next" };
  const ctx = context(async (path) =>
    Response.json(
      path.includes("/replies?")
        ? { items: Array.from({ length: 30 }, () => ({ ...fixture().replies[0], body: "界".repeat(5000) })), nextCursor: "later" }
        : item,
    ),
  );
  expect(await readAnnotationThread(ctx, rootId)).toMatchObject({ replies: fixture().replies, repliesNextCursor: "next" });
});
