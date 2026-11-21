import { describe, expect, mock, test } from "bun:test";
import type { LocalTag } from "../../service/local-tags";
import { type MailDropHost, runMailDrop } from "./mail-drop-actions";

const ME = "00000000-0000-4000-8000-000000000001";
const tag = (id: string): LocalTag => ({
  id,
  mailboxId: "box",
  name: id,
  color: "#0369a1",
  revision: 1,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
});
const items = [
  { conversationId: "c1", workStatus: "needs_action" as const, localTags: [tag("old")], revision: 4 },
  { conversationId: "c2", workStatus: "needs_action" as const, localTags: [], revision: 9 },
];

const host = (overrides: Partial<MailDropHost> = {}) => {
  const calls = {
    success: [] as Array<{ title: string; message: string; undo?: { label: string; run: () => void } }>,
    failed: [] as Array<{ notice: Parameters<MailDropHost["failed"]>[0]; retry: () => void }>,
    errors: [] as Array<{ title: string; message: string }>,
  };
  const value: MailDropHost = {
    assign: mock(async () => {}),
    move: mock(async () => {}),
    complete: mock(async (ids: string[]) => ids),
    addTag: mock(async (ids: string[]) => ids),
    setTags: mock(async () => {}),
    rememberFolder: mock(() => {}),
    success: (notice, undo) => void calls.success.push({ ...notice, ...(undo ? { undo } : {}) }),
    failed: (notice, retry) => void calls.failed.push({ notice, retry }),
    error: (notice) => void calls.errors.push(notice),
    active: () => true,
    ...overrides,
  };
  return { value, calls };
};

const run = (action: Parameters<typeof runMailDrop>[0]["action"], target: ReturnType<typeof host>, locale = "de") =>
  runMailDrop({
    action,
    items,
    currentUserId: ME,
    locale,
    host: target.value,
    text: { undo: "Rückgängig", assignFailed: "Zuweisen fehlgeschlagen" },
  });

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Mail drop actions", () => {
  test("assign to me adds the dragging person and keeps everyone else", async () => {
    const target = host();
    await run({ kind: "assign-me" }, target);
    expect(target.value.assign).toHaveBeenCalledWith(["c1", "c2"], { mode: "add", userId: ME, name: null });
  });

  test("a person target assigns that person; Assign to someone else opens the search", async () => {
    const target = host();
    await run({ kind: "assign", userId: "p1", name: "Mira Schulz" }, target);
    await run({ kind: "choose-assignee" }, target);
    expect(target.value.assign).toHaveBeenNthCalledWith(1, ["c1", "c2"], { mode: "add", userId: "p1", name: "Mira Schulz" });
    expect(target.value.assign).toHaveBeenNthCalledWith(2, ["c1", "c2"], null);
  });

  test("a folder drop moves every dragged conversation and remembers the folder", async () => {
    const target = host();
    await run({ kind: "move", folderId: "claims", name: "Reklamationen" }, target);
    expect(target.value.move).toHaveBeenCalledWith(items, "claims");
    expect(target.value.rememberFolder).toHaveBeenCalledWith("claims");
  });

  test("done reports with Undo, and Undo reopens only what the drop changed", async () => {
    const target = host({ complete: mock(async (ids: string[], completion: "done" | "open") => (completion === "done" ? ["c2"] : ids)) });
    await run({ kind: "done" }, target);
    expect(target.calls.success[0]).toMatchObject({ title: "Als erledigt markiert", message: "1 Unterhaltung ist erledigt." });
    target.calls.success[0]?.undo?.run();
    await flush();
    expect(target.value.complete).toHaveBeenLastCalledWith(["c2"], "open");
    expect(target.calls.success.at(-1)).toEqual({ title: "Rückgängig gemacht", message: "Der vorherige Stand ist wieder da." });
  });

  test("a tag drop reports with Undo, and Undo puts back each conversation's earlier tags at its next revision", async () => {
    const target = host();
    await run({ kind: "tag", tagId: "t1", name: "Rechnung" }, target);
    expect(target.value.addTag).toHaveBeenCalledWith(["c1", "c2"], "t1");
    expect(target.calls.success[0]).toMatchObject({ title: "Tag hinzugefügt", message: "„Rechnung“ an 2 Unterhaltungen." });
    target.calls.success[0]?.undo?.run();
    await flush();
    expect(target.value.setTags).toHaveBeenCalledWith("c1", ["old"], 5);
    expect(target.value.setTags).toHaveBeenCalledWith("c2", [], 10);
  });

  test("nothing to change reports nothing", async () => {
    const target = host({ addTag: mock(async () => []), complete: mock(async () => []) });
    await run({ kind: "tag", tagId: "t1", name: "Rechnung" }, target);
    await run({ kind: "done" }, target);
    expect(target.calls.success).toEqual([]);
  });

  test("a failed drop says nothing changed and offers the same drop again", async () => {
    let attempts = 0;
    const target = host({
      assign: mock(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("Zugriff verweigert");
      }),
    });
    await run({ kind: "assign", userId: "p1", name: "Mira Schulz" }, target);
    expect(target.calls.failed[0]?.notice).toEqual({
      title: "Nicht gespeichert",
      message: "Zugriff verweigert. Es wurde nichts geändert.",
      retryLabel: "Erneut versuchen",
    });
    target.calls.failed[0]?.retry();
    await flush();
    expect(target.value.assign).toHaveBeenCalledTimes(2);
    expect(target.calls.failed).toHaveLength(1);
  });

  test("a failed Undo says so instead of claiming success", async () => {
    const target = host({ setTags: mock(async () => Promise.reject(new Error("Unterhaltung wurde geändert"))) });
    await run({ kind: "tag", tagId: "t1", name: "Rechnung" }, target);
    target.calls.success[0]?.undo?.run();
    await flush();
    expect(target.calls.errors).toEqual([{ title: "Rückgängig machen fehlgeschlagen", message: "Unterhaltung wurde geändert" }]);
    expect(target.calls.success).toHaveLength(1);
  });

  test("a closed workspace reports nothing", async () => {
    const target = host({ active: () => false, assign: mock(async () => Promise.reject(new Error("gone"))) });
    await run({ kind: "assign-me" }, target);
    expect(target.calls.failed).toEqual([]);
  });
});
