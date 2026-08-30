import { describe, expect, test } from "bun:test";
import type { NotebookWorkspaceEvent, NotebookWorkspaceInvalidationScope } from "./workspace-events";
import { isPermissionInvalidation } from "./workspace-events";

const invalidated = (scopes: NotebookWorkspaceInvalidationScope[]): NotebookWorkspaceEvent => ({
  v: 1,
  type: "workspace.invalidated",
  notebookId: "nb-1",
  reason: "permissions",
  scopes,
});

describe("isPermissionInvalidation", () => {
  test("a permissions invalidation triggers a re-check", () => {
    expect(isPermissionInvalidation(invalidated(["permissions"]))).toBe(true);
  });

  test("so does a bulk invalidation that includes permissions among other scopes", () => {
    // notebooks.ts publishes exactly this on a bulk change; missing it would
    // leave a withdrawn grant live until the backstop timer fires.
    expect(isPermissionInvalidation(invalidated(["notebook", "tree", "tags", "references", "permissions"]))).toBe(true);
  });

  test("an invalidation that does not touch permissions does not", () => {
    expect(isPermissionInvalidation(invalidated(["notebook", "tree", "tags", "references"]))).toBe(false);
    expect(isPermissionInvalidation(invalidated([]))).toBe(false);
  });

  test("ordinary content events do not", () => {
    // Every note edit is one of these. Re-checking on them would put a database
    // round trip in the path of every keystroke that reaches the topic.
    expect(
      isPermissionInvalidation({
        v: 1,
        type: "note.created",
        notebookId: "nb-1",
        note: { id: "n-1", notebookId: "nb-1" } as never,
      } as NotebookWorkspaceEvent),
    ).toBe(false);
    expect(
      isPermissionInvalidation({
        v: 1,
        type: "note.comments.changed",
        notebookId: "nb-1",
        noteId: "n-1",
        noteShortId: "note01",
      }),
    ).toBe(false);
  });
});
