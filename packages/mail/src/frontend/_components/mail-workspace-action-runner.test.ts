import { describe, expect, test } from "bun:test";
import type { MailActionId } from "./mail-actions";
import type { MailBulkTarget } from "./mail-bulk-actions";
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

const host = (overrides: Partial<MailWorkspaceActionRunnerHost> = {}) => {
  const events: string[] = [];
  const value: MailWorkspaceActionRunnerHost = {
    resolveTargets: () => [target("one"), target("two")],
    chooseDestinationFolder: async () => "archive",
    roleDestinationFolderId: () => null,
    applyOptimistic: () => events.push("optimistic"),
    clearOptimistic: (ids) => events.push(`clear:${ids.join(",")}`),
    submit: async ({ target: item, sourceFolderId }) => {
      events.push(`submit:${item.conversationId}`);
      return [{ id: `${item.conversationId}:${sourceFolderId}`, state: "queued" }];
    },
    followOutcomes: ({ conversations }) =>
      events.push(`follow:${conversations.map((conversation) => conversation.commands.map((command) => command.id).join("+")).join(",")}`),
    pruneSelection: (ids) => events.push(`prune:${[...ids].join(",")}`),
    removesActiveConversation: () => false,
    refreshAfterSuccess: async () => {
      events.push("refresh");
    },
    reconcile: async () => {
      events.push("reconcile");
    },
    showMissingTarget: async () => {
      events.push("missing");
    },
    showNothingToMove: () => events.push("nothing"),
    showSuccess: (_action, _targets, succeeded) => events.push(`success:${succeeded}`),
    showFailures: async (failures) => {
      events.push(`failures:${failures.length}`);
    },
    showError: async () => {
      events.push("error");
    },
    ...overrides,
  };
  return { host: value, events };
};

describe("Mail workspace action runner", () => {
  const signal = () => new AbortController().signal;

  test("consumes each open intent once instead of reacting to later unread snapshots", () => {
    expect(decideMailAutoReadIntent({ intent: 0, consumedIntent: -1, busy: false, unread: false, canSubmit: true })).toBe("consume");
    expect(decideMailAutoReadIntent({ intent: 0, consumedIntent: 0, busy: false, unread: true, canSubmit: true })).toBe("ignore");
    expect(decideMailAutoReadIntent({ intent: 1, consumedIntent: 0, busy: false, unread: true, canSubmit: true })).toBe("read");
  });

  test("waits to consume a new open intent while another action is pending", () => {
    expect(decideMailAutoReadIntent({ intent: 1, consumedIntent: 0, busy: true, unread: true, canSubmit: true })).toBe("wait");
  });

  test("owns the successful optimistic action sequence", async () => {
    const fixture = host();
    await runMailWorkspaceAction("mark_read", {}, fixture.host, signal());
    expect(fixture.events).toEqual([
      "optimistic",
      "submit:one",
      "submit:two",
      "clear:",
      "prune:one,two",
      "follow:one:inbox,two:inbox",
      "refresh",
      "success:2",
    ]);
  });

  test("keeps partial failures explicit and reconciles successful targets", async () => {
    const fixture = host({
      submit: async ({ target: item }) => {
        if (item.conversationId === "two") throw new Error("provider rejected");
        return [{ id: "archive-one", state: "queued" }];
      },
    });
    await runMailWorkspaceAction("archive", {}, fixture.host, signal());
    expect(fixture.events).toContain("clear:two");
    expect(fixture.events).toContain("prune:one");
    // The rejected conversation was already reported; only the queued one is followed.
    expect(fixture.events).toContain("follow:archive-one");
    expect(fixture.events).toContain("failures:1");
  });

  test("reuses correlation and idempotency identities for the same invocation", async () => {
    const submissions: Array<{ correlationId: string; idempotencyKey: string }> = [];
    const fixture = host({
      resolveTargets: () => [target("one")],
      submit: async ({ correlationId, idempotencyKey }) => {
        submissions.push({ correlationId, idempotencyKey });
        return [];
      },
    });
    const execution = { correlationId: "correlation-1", idempotencyKeys: new Map<string, string>() };

    await runMailWorkspaceAction("mark_read", {}, fixture.host, signal(), execution);
    await runMailWorkspaceAction("mark_read", {}, fixture.host, signal(), execution);

    expect(submissions).toHaveLength(2);
    expect(submissions[0]).toEqual(submissions[1]);
    expect(submissions[0]?.correlationId).toBe("correlation-1");
  });

  test("clears optimistic state and rethrows fatal runner failures", async () => {
    const fixture = host({
      resolveTargets: () => {
        throw new Error("target resolution failed");
      },
    });
    await expect(runMailWorkspaceAction("mark_read", {}, fixture.host, signal())).rejects.toThrow("target resolution failed");

    const submitted = host({
      refreshAfterSuccess: async () => {
        throw new Error("refresh failed");
      },
    });
    await expect(runMailWorkspaceAction("mark_read", {}, submitted.host, signal())).rejects.toThrow("refresh failed");
    expect(submitted.events).toContain("clear:one,two");
    expect(submitted.events).toContain("reconcile");
    expect(submitted.events).toContain("error");
  });

  test("normalizes move targets and optimistic fields", () => {
    expect(removeDestinationPlacements([target("one", ["inbox", "archive"]), target("two", ["archive"])], "archive")).toEqual([
      target("one", ["inbox"]),
    ]);
    expect(mailOptimisticFields("flag" satisfies MailActionId)).toEqual(["flagged"]);
    expect(mailOptimisticFields("archive")).toEqual([]);
  });

  test("honors cancellation while the destination picker is open", async () => {
    let releasePicker!: (value: string | null) => void;
    const controller = new AbortController();
    const fixture = host({
      chooseDestinationFolder: () =>
        new Promise<string | null>((resolve) => {
          releasePicker = resolve;
        }),
    });

    const pending = runMailWorkspaceAction("move", {}, fixture.host, controller.signal);
    controller.abort();
    releasePicker("archive");
    await pending;
    expect(fixture.events).toEqual([]);
  });

  test("reconciles a partially submitted multi-placement read", async () => {
    let submittedPlacements = 0;
    const fixture = host({
      resolveTargets: () => [target("one", ["primary", "shared"])],
      submit: async ({ sourceFolderId }) => {
        if (sourceFolderId === "shared") throw new Error("provider rejected");
        return [];
      },
      showFailures: async (failures) => {
        submittedPlacements = failures[0]?.submittedPlacements ?? 0;
        fixture.events.push(`failures:${failures.length}`);
      },
    });

    await runMailWorkspaceAction("mark_read", { silent: true }, fixture.host, signal());
    expect(fixture.events).toContain("clear:one");
    expect(fixture.events).toContain("reconcile");
    expect(fixture.events).toContain("failures:1");
    expect(submittedPlacements).toBe(1);
  });

  test("acts once per conversation when several selected rows belong to it", async () => {
    const submitted: string[] = [];
    const followed: string[] = [];
    const fixture = host({
      resolveTargets: () => [target("one", ["inbox"]), target("one", ["inbox", "projects"]), target("two", ["inbox"])],
      submit: async ({ target: item, sourceFolderId }) => {
        submitted.push(`${item.conversationId}:${sourceFolderId}`);
        return [{ id: `${item.conversationId}:${sourceFolderId}`, state: "queued" }];
      },
      followOutcomes: ({ conversations }) => {
        for (const conversation of conversations)
          followed.push(`${conversation.conversationId}=${conversation.commands.map((command) => command.sourceFolderId).join("+")}`);
      },
    });

    await runMailWorkspaceAction("archive", {}, fixture.host, signal());
    expect(submitted.sort()).toEqual(["one:inbox", "one:projects", "two:inbox"]);
    expect(followed.map((entry) => entry.split("=")[0])).toEqual(["one", "two"]);
    expect(followed[0]?.split("=")[1]?.split("+").sort()).toEqual(["inbox", "projects"]);
    expect(fixture.events).toContain("success:2");
  });

  test("follows the commands a partly submitted conversation already queued, with their folder", async () => {
    const followed: string[] = [];
    const fixture = host({
      resolveTargets: () => [target("one", ["inbox", "projects"])],
      submit: async ({ sourceFolderId }) => {
        if (sourceFolderId === "projects") throw new Error("provider rejected");
        return [{ id: "archive-inbox", state: "queued" }];
      },
      followOutcomes: ({ conversations }) => {
        for (const conversation of conversations)
          for (const command of conversation.commands) followed.push(`${command.id}@${command.sourceFolderId}`);
      },
    });

    await runMailWorkspaceAction("archive", {}, fixture.host, signal());
    expect(fixture.events).toContain("failures:1");
    // The Inbox commands can still fail later; Try again would then repeat the Inbox only, never the
    // Projects request whose outcome is unknown.
    expect(followed).toEqual(["archive-inbox@inbox"]);
  });

  test("keeps the folders the action started from while the list updates them", async () => {
    const listFolders = ["inbox"];
    const submitted: string[] = [];
    const fixture = host({
      resolveTargets: () => [{ conversationId: "one", label: "one", sourceFolderIds: listFolders }],
      submit: async ({ sourceFolderId }) => {
        submitted.push(sourceFolderId);
        // The list store reconciles the same row after a navigation, in place.
        listFolders.splice(0, listFolders.length, "sent", "inbox");
        return [];
      },
    });

    await runMailWorkspaceAction("archive", {}, fixture.host, signal());
    expect(submitted).toEqual(["inbox"]);
  });

  test("leaves conversations alone that already sit in the folder Archive moves to", async () => {
    const submitted: string[] = [];
    const fixture = host({
      resolveTargets: () => [target("one", ["inbox", "archive"]), target("two", ["archive"])],
      roleDestinationFolderId: (actionId) => (actionId === "archive" ? "archive" : null),
      submit: async ({ target: item, sourceFolderId }) => {
        submitted.push(`${item.conversationId}:${sourceFolderId}`);
        return [];
      },
    });

    await runMailWorkspaceAction("archive", {}, fixture.host, signal());
    expect(submitted).toEqual(["one:inbox"]);

    const nothing = host({ resolveTargets: () => [target("two", ["archive"])], roleDestinationFolderId: () => "archive" });
    await runMailWorkspaceAction("archive", {}, nothing.host, signal());
    expect(nothing.events).toEqual(["nothing"]);
  });

  test("follows the commands a user action queued, but not those of a silent read on open", async () => {
    const chosen = host();
    await runMailWorkspaceAction("archive", {}, chosen.host, signal());
    expect(chosen.events).toContain("follow:one:inbox,two:inbox");

    const silent = host();
    await runMailWorkspaceAction("mark_read", { silent: true }, silent.host, signal());
    expect(silent.events.some((event) => event.startsWith("follow:"))).toBe(false);
  });
});
