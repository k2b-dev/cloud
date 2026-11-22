import { afterEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import type { LocalTag } from "../../service/local-tags";
import { type MailDropHost, type MailDropItem, runMailDrop } from "./mail-drop-actions";

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
const NOW = new Date("2026-11-21T09:00:00.000Z");
const items: MailDropItem[] = [
  { conversationId: "c1", workStatus: "needs_action", snoozedUntil: null, localTags: [tag("old")], revision: 4 },
  { conversationId: "c2", workStatus: "needs_action", snoozedUntil: null, localTags: [], revision: 9 },
];
const done = (ids: string[]) => ({ changed: ids.map((conversationId, index) => ({ conversationId, revision: 20 + index })), failed: 0 });

const host = (overrides: Partial<MailDropHost> = {}) => {
  const calls = {
    success: [] as Array<{ title: string; message: string; undo?: { label: string; run: () => void } }>,
    failed: [] as Array<{ notice: Parameters<MailDropHost["failed"]>[0]; retry: () => void }>,
    errors: [] as Array<{ title: string; message: string }>,
  };
  const value: MailDropHost = {
    assign: mock(async () => {}),
    move: mock(async () => {}),
    complete: mock(async (ids: string[]) => done(ids)),
    restoreWork: mock(async () => {}),
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

type Params = Parameters<typeof runMailDrop<MailDropItem>>[0];
const run = (
  action: Params["action"],
  target: ReturnType<typeof host>,
  options: { items?: Params["items"]; retry?: () => void } = {},
): Promise<void> =>
  runMailDrop({
    action,
    items: options.items ?? items,
    currentUserId: ME,
    locale: "de",
    host: target.value,
    text: { undo: "Rückgängig", assignFailed: "Zuweisen fehlgeschlagen" },
    retry: options.retry ?? (() => void run(action, target, options)),
  });

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Mail drop actions", () => {
  afterEach(() => setSystemTime());

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

  test("done reports with Undo, and Undo puts back only what the drop changed, at the revision the drop left", async () => {
    const target = host({ complete: mock(async () => ({ changed: [{ conversationId: "c2", revision: 10 }], failed: 0 })) });
    await run({ kind: "done" }, target);
    expect(target.calls.success[0]).toMatchObject({ title: "Als erledigt markiert", message: "1 Unterhaltung ist erledigt." });
    target.calls.success[0]?.undo?.run();
    await flush();
    expect(target.value.restoreWork).toHaveBeenCalledWith([
      { conversationId: "c2", state: { workStatus: "needs_action", snoozedUntil: null }, expectedRevision: 10 },
    ]);
    expect(target.calls.success.at(-1)).toEqual({ title: "Rückgängig gemacht", message: "Der vorherige Stand ist wieder da." });
  });

  test("Undo of done brings back a waiting status and a snooze that still runs; a snooze that ran out stays gone", async () => {
    setSystemTime(NOW);
    const target = host();
    await run({ kind: "done" }, target, {
      items: [
        { ...items[0]!, workStatus: "waiting", snoozedUntil: "2026-11-22T08:00:00.000Z" },
        { ...items[1]!, snoozedUntil: "2026-11-21T08:00:00.000Z" },
      ],
    });
    target.calls.success[0]?.undo?.run();
    await flush();
    expect(target.value.restoreWork).toHaveBeenCalledWith([
      { conversationId: "c1", state: { workStatus: "waiting", snoozedUntil: "2026-11-22T08:00:00.000Z" }, expectedRevision: 20 },
      { conversationId: "c2", state: { workStatus: "needs_action", snoozedUntil: null }, expectedRevision: 21 },
    ]);
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
    const target = host({ addTag: mock(async () => []), complete: mock(async () => done([])) });
    await run({ kind: "tag", tagId: "t1", name: "Rechnung" }, target);
    await run({ kind: "done" }, target);
    expect(target.calls.success).toEqual([]);
  });

  test("rows of one conversation name it once in every request", async () => {
    const target = host();
    await run({ kind: "done" }, target, { items: [items[0]!, { ...items[0]!, revision: 7 }, items[1]!] });
    expect(target.value.complete).toHaveBeenCalledWith(["c1", "c2"]);
  });

  test("done that finds only some conversations reports the rest in the same notice and keeps Undo", async () => {
    const target = host({ complete: mock(async () => ({ changed: [{ conversationId: "c1", revision: 5 }], failed: 1 })) });
    await run({ kind: "done" }, target);
    expect(target.calls.success).toHaveLength(1);
    expect(target.calls.success[0]).toMatchObject({
      title: "Als erledigt markiert",
      message: "1 Unterhaltung ist erledigt. 1 Unterhaltung wurde nicht gefunden.",
    });
    expect(target.calls.success[0]?.undo).toBeDefined();
    expect(target.calls.failed).toEqual([]);
  });

  test("done that finds none says so and that nothing changed", async () => {
    const target = host({ complete: mock(async () => ({ changed: [], failed: 2 })) });
    await run({ kind: "done" }, target);
    expect(target.calls.success).toEqual([]);
    expect(target.calls.errors).toEqual([
      { title: "Nicht gespeichert", message: "2 Unterhaltungen wurden nicht gefunden. Es wurde nichts geändert." },
    ]);
  });

  test("a move this view cannot make fails visibly instead of ending silently", async () => {
    const target = host({
      move: mock(async () => Promise.reject(new Error("Aus dieser Ansicht lassen sich diese Unterhaltungen nicht verschieben"))),
    });
    await run({ kind: "move", folderId: "claims", name: "Reklamationen" }, target);
    expect(target.calls.failed[0]?.notice.message).toBe(
      "Aus dieser Ansicht lassen sich diese Unterhaltungen nicht verschieben. Es wurde nichts geändert.",
    );
  });

  test("a failed drop says nothing changed and offers the same drop again", async () => {
    let attempts = 0;
    const target = host({
      assign: mock(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("Zugriff verweigert");
      }),
    });
    const retry = mock(() => void run({ kind: "assign", userId: "p1", name: "Mira Schulz" }, target));
    await run({ kind: "assign", userId: "p1", name: "Mira Schulz" }, target, { retry });
    expect(target.calls.failed[0]?.notice).toEqual({
      title: "Nicht gespeichert",
      message: "Zugriff verweigert. Es wurde nichts geändert.",
      retryLabel: "Erneut versuchen",
    });
    // Try again goes back through the caller, which applies its rules again.
    target.calls.failed[0]?.retry();
    await flush();
    expect(retry).toHaveBeenCalledTimes(1);
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
