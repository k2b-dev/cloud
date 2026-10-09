import { describe, expect, test } from "bun:test";
import {
  applyMailCollaborationPatch,
  applyMailTagIds,
  createMailDetailUpdateQueue,
  type MailDetailUpdateOperation,
  queuedCollaborationPatch,
  queuedReminderDueAt,
  queuedTagIds,
} from "./mail-detail-update-queue";

const conversationId = "00000000-0000-4000-8000-000000000001";
const mailboxId = "00000000-0000-4000-8000-000000000002";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe("Mail detail update queue", () => {
  test("overlays optimistic collaboration and tag choices without changing revisions", () => {
    const collaboration = {
      conversationId,
      assignees: [{ id: "00000000-0000-4000-8000-000000000004", uid: "bo", displayName: "Bo", avatarHash: null }],
      workStatus: "needs_action" as const,
      snoozedUntil: null,
      revision: 3,
    };
    const assignee = {
      id: "00000000-0000-4000-8000-000000000003",
      uid: "ada",
      displayName: "Ada",
      avatarHash: null,
      permission: "write" as const,
      scope: "assigned" as const,
      description: "Ada",
    };
    expect(
      applyMailCollaborationPatch(
        collaboration,
        // Bo stays, known from the current state; Ada comes from the assignable users.
        {
          assigneeUserIds: ["00000000-0000-4000-8000-000000000004", assignee.id],
          completion: "done",
          snoozedUntil: "2026-07-23T08:00:00Z",
        },
        [assignee],
      ),
    ).toEqual({
      ...collaboration,
      assignees: [
        ...collaboration.assignees,
        { id: assignee.id, uid: assignee.uid, displayName: assignee.displayName, avatarHash: assignee.avatarHash },
      ],
      workStatus: "done",
      snoozedUntil: null,
    });

    const firstTag = {
      id: "00000000-0000-4000-8000-000000000010",
      mailboxId,
      name: "First",
      color: "#008080",
      revision: 1,
      createdAt: "2026-07-22T00:00:00.000Z",
      updatedAt: "2026-07-22T00:00:00.000Z",
    };
    const secondTag = { ...firstTag, id: "00000000-0000-4000-8000-000000000011", name: "Second" };
    expect(applyMailTagIds({ conversationId, conversationRevision: 3, tags: [firstTag] }, [firstTag, secondTag], [secondTag.id])).toEqual({
      conversationId,
      conversationRevision: 3,
      tags: [secondTag],
    });
  });

  test("serializes updates and coalesces adjacent pending values", async () => {
    const first = deferred<string>();
    const calls: MailDetailUpdateOperation[] = [];
    const successes: Array<{ result: string; queued: readonly MailDetailUpdateOperation[] }> = [];
    const queue = createMailDetailUpdateQueue<string>({
      run: async (operation) => {
        calls.push(operation);
        return calls.length === 1 ? first.promise : `saved-${calls.length}`;
      },
      onSuccess: (result, _operation, queued) => successes.push({ result, queued }),
      onError: () => undefined,
    });

    queue.enqueue({ kind: "collaboration", patch: { completion: "done" } });
    queue.enqueue({ kind: "collaboration", patch: { completion: "open" } });
    queue.enqueue({ kind: "collaboration", patch: { snoozedUntil: "2026-07-23T08:00:00Z" } });
    queue.enqueue({ kind: "tags", tagIds: ["one"] });
    queue.enqueue({ kind: "tags", tagIds: ["one", "two"] });

    expect(calls).toEqual([{ kind: "collaboration", patch: { completion: "done" } }]);
    expect(queuedCollaborationPatch(queue.pending())).toEqual({
      completion: "open",
      snoozedUntil: "2026-07-23T08:00:00Z",
    });
    expect(queuedTagIds(queue.pending())).toEqual(["one", "two"]);
    expect(queuedReminderDueAt(queue.pending())).toEqual({ pending: false, dueAt: null });

    first.resolve("saved-1");
    await Bun.sleep(0);
    await Bun.sleep(0);

    expect(calls).toEqual([
      { kind: "collaboration", patch: { completion: "done" } },
      { kind: "collaboration", patch: { completion: "open" } },
      { kind: "collaboration", patch: { snoozedUntil: "2026-07-23T08:00:00Z" } },
      { kind: "tags", tagIds: ["one", "two"] },
    ]);
    expect(successes.at(-1)?.queued).toEqual([]);
  });

  test("reports the latest pending reminder intent", () => {
    expect(queuedReminderDueAt([{ kind: "reminder", dueAt: "2026-07-23T08:00:00Z" }, { kind: "cancel_reminder" }])).toEqual({
      pending: true,
      dueAt: null,
    });
  });

  test("clears queued work after a failure", async () => {
    const errors: string[] = [];
    const calls: string[] = [];
    const queue = createMailDetailUpdateQueue<string>({
      run: async (operation) => {
        calls.push(operation.kind);
        throw new Error("revision conflict");
      },
      onSuccess: () => undefined,
      onError: (error) => {
        errors.push(error.message);
      },
    });

    queue.enqueue({ kind: "collaboration", patch: { completion: "open" } });
    queue.enqueue({ kind: "tags", tagIds: ["one"] });
    await Bun.sleep(0);

    expect(calls).toEqual(["collaboration"]);
    expect(errors).toEqual(["revision conflict"]);
    expect(queue.pending()).toEqual([]);
  });

  test("aborts active work and ignores its result after reset", async () => {
    const first = deferred<string>();
    const successes: string[] = [];
    let aborted = false;
    const queue = createMailDetailUpdateQueue<string>({
      run: async (_operation, signal) => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        return first.promise;
      },
      onSuccess: (result) => successes.push(result),
      onError: () => undefined,
    });

    queue.enqueue({ kind: "reminder", dueAt: "2026-07-23T08:00:00Z" });
    queue.reset();
    first.resolve("stale");
    await Bun.sleep(0);

    expect(aborted).toBeTrue();
    expect(successes).toEqual([]);
    expect(queue.pending()).toEqual([]);
  });
});
