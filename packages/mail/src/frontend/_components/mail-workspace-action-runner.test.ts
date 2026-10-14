import { describe, expect, test } from "bun:test";
import { createMailActionQueue } from "./mail-action-queue";
import type { MailActionId } from "./mail-actions";
import { MAIL_BULK_NO_PROVIDER_PLACEMENT, type MailBulkTarget } from "./mail-bulk-actions";
import {
  decideMailAutoReadIntent,
  type MailWorkspaceActionRunnerHost,
  mailOptimisticFields,
  removeDestinationPlacements,
  runMailWorkspaceAction,
} from "./mail-workspace-action-runner";

const target = (conversationId: string, sourceFolderIds = ["inbox"]): MailBulkTarget => ({
  conversationId,
  label: conversationId,
  sourceFolderIds,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
const signal = () => new AbortController().signal;
const host = (overrides: Partial<MailWorkspaceActionRunnerHost> = {}) => {
  const events: string[] = [];
  const offered: Parameters<MailWorkspaceActionRunnerHost["offerUndo"]>[0][] = [];
  const followed: Parameters<MailWorkspaceActionRunnerHost["followOutcomes"]>[0][] = [];
  const failures: Parameters<MailWorkspaceActionRunnerHost["showFailures"]>[] = [];
  const value: MailWorkspaceActionRunnerHost = {
    queue: createMailActionQueue(),
    resolveTargets: () => [target("one"), target("two")],
    chooseDestinationFolder: async () => "archive",
    roleDestinationFolderId: () => null,
    applyOptimistic: () => {
      events.push("optimistic");
    },
    restore: (target) => {
      events.push(`restore:${target.conversationId}`);
    },
    hold: (target) => {
      events.push(`hold:${target.conversationId}`);
    },
    release: (target) => {
      events.push(`release:${target.conversationId}`);
    },
    offerUndo: (params) => {
      offered.push(params);
      events.push("undo-toast");
    },
    announce: (actionId) => {
      events.push(`announce:${actionId}`);
    },
    submit: async ({ target: item, sourceFolderId }) => {
      events.push(`submit:${item.conversationId}`);
      return [{ id: `${item.conversationId}:${sourceFolderId}`, state: "queued" }];
    },
    submitUndo: async ({ commandIds }) => commandIds.map((id) => ({ id, outcome: "cancelled", inverse: null })),
    followOutcomes: (params) => {
      followed.push(params);
      events.push(`follow:${params.target.conversationId}`);
      return () => {
        events.push(`stop:${params.target.conversationId}`);
      };
    },
    reconcile: async () => {
      events.push("reconcile");
      return true;
    },
    releaseOnNextSnapshot: (target) => {
      events.push(`release-next:${target.conversationId}`);
    },
    showMissingTarget: async () => {
      events.push("missing");
    },
    showNothingToMove: () => {
      events.push("nothing");
    },
    showFailures: (...params) => {
      failures.push(params);
      events.push(`failures:${params[0].length}`);
    },
    showUndoFailed: (targets) => {
      events.push(`undo-failed:${targets.map((target) => target.conversationId).join(",")}`);
    },
    showError: () => {
      events.push("error");
    },
    ...overrides,
  };
  return { host: value, events, offered, followed, failures };
};

describe("Mail workspace action runner", () => {
  test("auto-read consumes an intent once and waits only for structure work", () => {
    expect(decideMailAutoReadIntent({ intent: 0, consumedIntent: -1, busy: false, unread: false, canSubmit: true })).toBe("consume");
    expect(decideMailAutoReadIntent({ intent: 0, consumedIntent: 0, busy: false, unread: true, canSubmit: true })).toBe("ignore");
    expect(decideMailAutoReadIntent({ intent: 1, consumedIntent: 0, busy: false, unread: true, canSubmit: true })).toBe("read");
    expect(decideMailAutoReadIntent({ intent: 1, consumedIntent: 0, busy: true, unread: true, canSubmit: true })).toBe("wait");
  });
  test("projection and one bulk Undo toast precede the first await and submit", async () => {
    const hold = deferred<void>();
    const fixture = host({
      submit: async () => {
        await hold.promise;
        return [];
      },
    });
    const action = runMailWorkspaceAction("trash", {}, fixture.host, signal());
    expect(fixture.events).toEqual(["optimistic", "undo-toast"]);
    expect(fixture.offered).toHaveLength(1);
    expect(fixture.offered[0]?.targets).toHaveLength(2);
    hold.resolve();
    await action;
  });
  test("overlapping invocations serialize one conversation in click order and allow another in parallel", async () => {
    const hold = deferred<void>();
    const calls: string[] = [];
    const fixture = host({
      submit: async ({ actionId, target }) => {
        calls.push(`${target.conversationId}:${actionId}`);
        if (actionId === "flag") await hold.promise;
        return [];
      },
    });
    const first = runMailWorkspaceAction("flag", { targets: [target("one")] }, fixture.host, signal());
    const second = runMailWorkspaceAction("trash", { targets: [target("one")] }, fixture.host, signal());
    const third = runMailWorkspaceAction("trash", { targets: [target("two")] }, fixture.host, signal());
    expect(calls).toEqual(["one:flag", "two:trash"]);
    hold.resolve();
    await Promise.all([first, second, third]);
    expect(calls).toEqual(["one:flag", "two:trash", "one:trash"]);
  });
  test("a submit failure restores only its target and Retry reuses correlation and idempotency keys", async () => {
    const submissions: { conversationId: string; correlationId: string; idempotencyKey: string }[] = [];
    let failing = true;
    const fixture = host({
      submit: async ({ target, correlationId, idempotencyKey }) => {
        submissions.push({ conversationId: target.conversationId, correlationId, idempotencyKey });
        if (target.conversationId === "two" && failing) throw new Error("provider rejected");
        return [{ id: target.conversationId, state: "queued" }];
      },
    });
    await runMailWorkspaceAction("trash", {}, fixture.host, signal());
    expect(fixture.events).toContain("restore:two");
    expect(fixture.events).not.toContain("restore:one");
    expect(fixture.failures[0]?.[0][0]?.message).toBe("provider rejected");
    failing = false;
    await fixture.failures[0]![1].retry();
    expect(submissions.filter((submission) => submission.conversationId === "two")[0]).toEqual(submissions.at(-1));
    expect(submissions.filter((submission) => submission.conversationId === "one")).toHaveLength(1);
  });
  test("Undo before send restores immediately, cancels every bulk target and sends no move", async () => {
    const hold = deferred<void>();
    const fixture = host({ queue: createMailActionQueue(1) });
    const earlier = fixture.host.queue.enqueue("one", () => hold.promise);
    const action = runMailWorkspaceAction("trash", {}, fixture.host, signal());
    const undo = fixture.offered[0]!.undo();
    expect(fixture.events).toContain("restore:one");
    expect(fixture.events).toContain("restore:two");
    await action;
    await undo;
    hold.resolve();
    await earlier.result;
    expect(fixture.events.some((event) => event.startsWith("submit:"))).toBe(false);
    expect(fixture.events.filter((event) => event === "announce:undo")).toHaveLength(1);
    await fixture.offered[0]!.undo();
    expect(fixture.events.filter((event) => event === "announce:undo")).toHaveLength(1);
  });
  test("Undo after send waits behind earlier choices, uses returned IDs, polls pending and releases cancelled", async () => {
    const hold = deferred<void>();
    const requests: string[][] = [];
    const fixture = host({
      resolveTargets: () => [target("one")],
      submit: async () => {
        await hold.promise;
        return [{ id: "move", state: "queued" }];
      },
      submitUndo: async ({ commandIds }) => {
        if (requests.length === 1) expect(fixture.events).not.toContain("announce:undo");
        requests.push(commandIds);
        return [{ id: "move", outcome: requests.length === 1 ? "pending" : "cancelled", inverse: null }];
      },
    });
    const action = runMailWorkspaceAction("trash", {}, fixture.host, signal());
    const undo = fixture.offered[0]!.undo();
    expect(fixture.events).toContain("hold:one");
    expect(requests).toEqual([]);
    hold.resolve();
    await action;
    await undo;
    expect(requests).toEqual([["move"], ["move"]]);
    expect(fixture.events).toContain("release:one");
    expect(fixture.followed).toEqual([]);
    expect(fixture.events.filter((event) => event === "announce:undo")).toHaveLength(1);
  });
  test("a reversed Undo follows inverse commands, reconciles before release and stops the original", async () => {
    const fixture = host({
      resolveTargets: () => [target("one")],
      submitUndo: async () => [{ id: "one:inbox", outcome: "reversed", inverse: { id: "inverse", state: "queued", code: null } }],
    });
    await runMailWorkspaceAction("trash", {}, fixture.host, signal());
    const undo = fixture.offered[0]!.undo();
    await Bun.sleep(0);
    expect(fixture.events).toContain("stop:one");
    const inverse = fixture.followed.at(-1)!;
    expect(inverse.commands[0]?.id).toBe("inverse");
    expect(inverse.reportFailures).toBe(false);
    expect(fixture.events).not.toContain("release:one");
    inverse.onSettled({ conversationId: "one", ok: true, expired: false });
    await undo;
    expect(fixture.events.indexOf("reconcile")).toBeLessThan(fixture.events.indexOf("release:one"));
  });
  test("unavailable and failed inverse outcomes release, reconcile and report Undo failure", async () => {
    for (const reversed of [false, true]) {
      const fixture = host({
        resolveTargets: () => [target("one")],
        submitUndo: async () => [
          {
            id: "one:inbox",
            outcome: reversed ? "reversed" : "unavailable",
            inverse: reversed ? { id: "inverse", state: "queued", code: null } : null,
          },
        ],
      });
      await runMailWorkspaceAction("trash", {}, fixture.host, signal());
      const undo = fixture.offered[0]!.undo();
      await Bun.sleep(0);
      if (reversed) fixture.followed.at(-1)!.onSettled({ conversationId: "one", ok: false, expired: true });
      await undo;
      expect(fixture.events).toContain("release:one");
      expect(fixture.events).toContain("reconcile");
      expect(fixture.events).toContain("undo-failed:one");
    }
  });
  test("later failed outcomes restore at once; confirmation reconciles then releases per target", async () => {
    const fixture = host();
    await runMailWorkspaceAction("archive", {}, fixture.host, signal());
    fixture.followed[0]!.onFailure();
    fixture.followed[0]!.onSettled({ conversationId: "one", ok: false, expired: false });
    expect(fixture.events).toContain("restore:one");
    fixture.followed[1]!.onSettled({ conversationId: "two", ok: true, expired: false });
    await Bun.sleep(0);
    expect(fixture.events).toContain("release:two");
    expect(fixture.events).not.toContain("release:one");
  });
  test("bulk Undo after sending covers every conversation with one notice", async () => {
    const undone: string[] = [];
    const fixture = host({
      submitUndo: async ({ target, commandIds }) => {
        undone.push(target.conversationId);
        return commandIds.map((id) => ({ id, outcome: "not_applied", inverse: null }));
      },
    });
    await runMailWorkspaceAction("trash", {}, fixture.host, signal());
    expect(fixture.offered).toHaveLength(1);
    await fixture.offered[0]!.undo();
    expect(undone).toEqual(["one", "two"]);
  });
  test("bulk Undo releases queue slots while inverse outcomes or pending IDs wait", async () => {
    for (const pending of [false, true]) {
      const controller = new AbortController();
      const fixture = host({
        resolveTargets: () => ["one", "two", "three", "four"].map((id) => target(id)),
        submitUndo: async ({ commandIds }) =>
          commandIds.map((id) => ({
            id,
            outcome: pending ? "pending" : "reversed",
            inverse: pending ? null : { id: `inverse:${id}`, state: "queued", code: null },
          })),
      });
      await runMailWorkspaceAction("trash", {}, fixture.host, controller.signal);
      const undo = fixture.offered[0]!.undo();
      let finished = false;
      void undo.then(() => {
        finished = true;
      });
      await Bun.sleep(0);
      expect(finished).toBe(false);
      expect(fixture.host.queue.size()).toBe(0);
      await runMailWorkspaceAction("flag", { targets: [target("five")] }, fixture.host, controller.signal);
      expect(fixture.events).toContain("submit:five");
      expect(fixture.host.queue.size()).toBe(0);
      if (pending) expect(fixture.events).not.toContain("announce:undo");
      else expect(fixture.followed.filter((follow) => !follow.reportFailures)).toHaveLength(4);
      controller.abort();
      await undo;
      if (pending) expect(fixture.events).not.toContain("announce:undo");
    }
  });
  test("Undo reverses accepted commands even when a later placement submission failed", async () => {
    const requests: string[][] = [];
    const fixture = host({
      resolveTargets: () => [target("one", ["inbox", "projects"])],
      submit: async ({ sourceFolderId }) => {
        if (sourceFolderId === "projects") throw new Error("rejected");
        return [{ id: "accepted", state: "queued" }];
      },
      submitUndo: async ({ commandIds }) => {
        requests.push(commandIds);
        return commandIds.map((id) => ({ id, outcome: "cancelled", inverse: null }));
      },
    });
    await runMailWorkspaceAction("trash", {}, fixture.host, signal());
    await fixture.offered[0]!.undo();
    expect(requests).toEqual([["accepted"]]);
    expect(fixture.events).toContain("release:one");
    expect(fixture.events).toContain("announce:undo");
    expect(fixture.events).not.toContain("undo-failed:one");
  });
  test("Undo reports a zero-command success as unavailable, but a failed submission accepted nothing", async () => {
    for (const failed of [false, true]) {
      const requests: string[][] = [];
      const fixture = host({
        resolveTargets: () => [target("one")],
        submit: async () => {
          if (failed) throw new Error("rejected");
          return [];
        },
        submitUndo: async ({ commandIds }) => {
          requests.push(commandIds);
          return [];
        },
      });
      await runMailWorkspaceAction("trash", {}, fixture.host, signal());
      await fixture.offered[0]!.undo();
      expect(requests).toEqual([]);
      expect(fixture.events).toContain("release:one");
      expect(fixture.events.includes("undo-failed:one")).toBe(!failed);
      expect(fixture.events.includes("announce:undo")).toBe(failed);
    }
  });
  test("Undo announces once after immediate cancellation, and never after a request failure", async () => {
    for (const failed of [false, true]) {
      const fixture = host({
        submitUndo: async ({ commandIds }) =>
          commandIds.map((id) => ({ id, outcome: failed ? "unavailable" : "cancelled", inverse: null })),
      });
      await runMailWorkspaceAction("trash", {}, fixture.host, signal());
      await fixture.offered[0]!.undo();
      expect(fixture.events.filter((event) => event === "announce:undo")).toHaveLength(failed ? 0 : 1);
    }
  });
  test("Undo does not announce success when the returned inverse already failed", async () => {
    const fixture = host({
      resolveTargets: () => [target("one")],
      submitUndo: async ({ commandIds }) =>
        commandIds.map((id) => ({ id, outcome: "reversed", inverse: { id: "inverse", state: "failed", code: "PROVIDER_RIGHTS_CHANGED" } })),
      followOutcomes: ({ reportFailures, onSettled }) => {
        if (!reportFailures) onSettled({ conversationId: "one", ok: false, expired: false });
        return () => {};
      },
    });
    await runMailWorkspaceAction("trash", {}, fixture.host, signal());
    await fixture.offered[0]!.undo();
    expect(fixture.events).not.toContain("announce:undo");
    expect(fixture.events).toContain("undo-failed:one");
  });
  test("failed refresh retains removals until a fresh snapshot, for zero commands and settled commands", async () => {
    for (const zeroCommands of [false, true]) {
      const releases: { target: MailBulkTarget; wanted: () => boolean }[] = [];
      const controller = new AbortController();
      const fixture = host({
        resolveTargets: () => [target("one")],
        submit: async () => (zeroCommands ? [] : [{ id: "command", state: "queued" }]),
        reconcile: async () => false,
        releaseOnNextSnapshot: (target, wanted) => {
          releases.push({ target, wanted });
        },
      });
      await runMailWorkspaceAction("trash", {}, fixture.host, controller.signal);
      if (!zeroCommands) fixture.followed[0]!.onSettled({ conversationId: "one", ok: true, expired: false });
      await Bun.sleep(0);
      expect(fixture.events).not.toContain("release:one");
      expect(releases).toHaveLength(1);
      expect(releases[0]?.target).toEqual(target("one"));
      expect(releases[0]?.wanted()).toBe(true);
      await fixture.offered[0]!.undo();
      expect(releases[0]?.wanted()).toBe(false);
    }
  });
  test("toggles reconcile once per invocation, announce and offer no toast; silent read announces nothing", async () => {
    const fixture = host();
    await runMailWorkspaceAction("mark_read", {}, fixture.host, signal());
    expect(fixture.events.filter((event) => event === "reconcile")).toHaveLength(1);
    expect(fixture.events).toContain("announce:mark_read");
    expect(fixture.offered).toHaveLength(0);
    const silent = host();
    await runMailWorkspaceAction("mark_read", { silent: true }, silent.host, signal());
    expect(silent.offered).toHaveLength(0);
    expect(silent.followed).toHaveLength(0);
    expect(silent.events.some((event) => event.startsWith("announce:"))).toBe(false);
  });
  test("reports no placement and preserves partial submission counts and followed folder identities", async () => {
    const fixture = host({
      resolveTargets: () => [target("one", ["inbox", "projects"]), target("two", [])],
      submit: async ({ sourceFolderId }) => {
        if (sourceFolderId === "projects") throw new Error("rejected");
        return [{ id: "inbox-command", state: "queued" }];
      },
    });
    await runMailWorkspaceAction("archive", {}, fixture.host, signal());
    expect(fixture.failures[0]?.[0]).toEqual([
      { conversationId: "one", label: "one", message: "rejected", submittedPlacements: 1 },
      { conversationId: "two", label: "two", message: MAIL_BULK_NO_PROVIDER_PLACEMENT, submittedPlacements: 0 },
    ]);
    expect(fixture.followed[0]?.commands[0]?.sourceFolderId).toBe("inbox");
  });
  test("merges conversation/message targets and snapshots source folders before submission", async () => {
    const listFolders = ["inbox"];
    const calls: string[] = [];
    const fixture = host({
      resolveTargets: () => [
        { ...target("one", listFolders), messageIds: ["a"] },
        { ...target("one", ["projects"]), messageIds: ["b"] },
        { ...target("two"), messageIds: ["c"] },
        target("two"),
      ],
      submit: async ({ target, sourceFolderId }) => {
        calls.push(`${target.conversationId}:${sourceFolderId}:${target.messageIds?.join("+") ?? "all"}`);
        listFolders.push("sent");
        return [];
      },
    });
    await runMailWorkspaceAction("trash", {}, fixture.host, signal());
    expect(calls.sort()).toEqual(["one:inbox:a+b", "one:projects:a+b", "two:inbox:all"]);
  });
  test("Undo respects the public command-ID batch bound for a multi-placement action", async () => {
    const batches: number[] = [];
    const fixture = host({
      resolveTargets: () => [target("one", ["inbox", "projects"])],
      submit: async ({ sourceFolderId }) =>
        Array.from({ length: sourceFolderId === "inbox" ? 500 : 1 }, (_, index) => ({
          id: `${sourceFolderId}-${index}`,
          state: "queued" as const,
        })),
      submitUndo: async ({ commandIds }) => {
        batches.push(commandIds.length);
        return commandIds.map((id) => ({ id, outcome: "cancelled", inverse: null }));
      },
    });
    await runMailWorkspaceAction("trash", {}, fixture.host, signal());
    await fixture.offered[0]!.undo();
    expect(batches).toEqual([500, 1]);
  });
  test("cleanup stops UI following but submissions already queued survive", async () => {
    const hold = deferred<void>();
    const controller = new AbortController();
    const calls: string[] = [];
    const fixture = host({
      submit: async ({ actionId }) => {
        calls.push(actionId);
        if (actionId === "flag") await hold.promise;
        return [{ id: actionId, state: "queued" }];
      },
    });
    const first = runMailWorkspaceAction("flag", { targets: [target("one")] }, fixture.host, controller.signal);
    const second = runMailWorkspaceAction("trash", { targets: [target("one")] }, fixture.host, controller.signal);
    controller.abort();
    hold.resolve();
    await Promise.all([first, second]);
    expect(calls).toEqual(["flag", "trash"]);
    expect(fixture.followed).toEqual([]);
  });
  test("destination-normalized moves and missing targets retain their messages; picker cancellation does nothing", async () => {
    expect(
      removeDestinationPlacements([target("one", ["inbox", "archive"]), target("two", ["archive"]), target("three", [])], "archive"),
    ).toEqual([target("one"), target("three", [])]);
    expect(mailOptimisticFields("flag" satisfies MailActionId)).toEqual(["flagged"]);
    expect(mailOptimisticFields("archive")).toEqual([]);
    const fixture = host({ resolveTargets: () => [target("one", ["archive"])], roleDestinationFolderId: () => "archive" });
    await runMailWorkspaceAction("archive", {}, fixture.host, signal());
    expect(fixture.events).toEqual(["nothing"]);
    const missing = host({ resolveTargets: () => [] });
    await runMailWorkspaceAction("move", { targets: [] }, missing.host, signal());
    expect(missing.events).toEqual([]);
    await runMailWorkspaceAction("archive", {}, missing.host, signal());
    expect(missing.events).toEqual(["missing"]);
    const picker = deferred<string | null>();
    const controller = new AbortController();
    const cancelled = host({ chooseDestinationFolder: () => picker.promise });
    const action = runMailWorkspaceAction("move", {}, cancelled.host, controller.signal);
    controller.abort();
    picker.resolve("archive");
    await action;
    expect(cancelled.events).toEqual([]);
  });
});
