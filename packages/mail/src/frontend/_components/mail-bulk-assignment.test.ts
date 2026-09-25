import { describe, expect, test } from "bun:test";
import type { ConversationAssignmentResult } from "../../service/collaboration";
import { mailWorkspaceMessages } from "../mail-workspace-messages";
import type { MailAssigneeChoice } from "./mail-assign-picker";
import { type MailBulkAssignmentHost, runMailBulkAssignment } from "./mail-bulk-assignment";

const maria = { id: "00000000-0000-4000-8000-000000000001", uid: "maria", displayName: "Maria", avatarHash: null };

const harness = (
  choice: MailAssigneeChoice | null,
  respond: (ids: string[], assigneeUserId: string | null) => ConversationAssignmentResult,
) => {
  const calls: Array<{ ids: string[]; assigneeUserId: string | null }> = [];
  const successes: Array<{ message: string; undo?: { label: string; run: () => void } }> = [];
  const errors: Array<{ message: string; title?: string }> = [];
  let cleared = 0;
  let refreshes = 0;
  const host: MailBulkAssignmentHost = {
    chooseAssignee: async () => choice,
    assign: async (ids, assigneeUserId) => {
      calls.push({ ids, assigneeUserId });
      return respond(ids, assigneeUserId);
    },
    clearSelection: () => {
      cleared += 1;
    },
    refresh: async () => {
      refreshes += 1;
      return null;
    },
    success: (message, undo) => successes.push({ message, undo }),
    error: (message, title) => errors.push({ message, title }),
    active: () => true,
  };
  return { host, calls, successes, errors, cleared: () => cleared, refreshes: () => refreshes };
};

const allOk = (ids: string[], assigneeUserId: string | null): ConversationAssignmentResult => ({
  assignee: assigneeUserId ? maria : null,
  results: ids.map((conversationId) => ({ conversationId, status: "ok" })),
});

describe("Mail bulk assignment", () => {
  test("assigns, clears the selection, refreshes, and offers an undo that unassigns", async () => {
    const t = mailWorkspaceMessages.resolve(["en"]).t;
    const run = harness({ assigneeUserId: maria.id }, allOk);

    await runMailBulkAssignment(["Conv01", "Conv02"], run.host, t);

    expect(run.calls).toEqual([{ ids: ["Conv01", "Conv02"], assigneeUserId: maria.id }]);
    expect(run.cleared()).toBe(1);
    expect(run.refreshes()).toBe(1);
    expect(run.successes).toHaveLength(1);
    expect(run.successes[0]!.message).toBe("2 conversations assigned to Maria");
    expect(run.successes[0]!.undo?.label).toBe("Undo");

    run.successes[0]!.undo!.run();
    await Bun.sleep(0);
    expect(run.calls[1]).toEqual({ ids: ["Conv01", "Conv02"], assigneeUserId: null });
    expect(run.refreshes()).toBe(2);
    expect(run.successes[1]).toEqual({ message: "Assignment removed from 2 conversations", undo: undefined });
    expect(run.errors).toEqual([]);
  });

  test("speaks German and names partial failures with their count", async () => {
    const t = mailWorkspaceMessages.resolve(["de"]).t;
    const run = harness({ assigneeUserId: maria.id }, (ids) => ({
      assignee: maria,
      results: ids.map((conversationId) => ({ conversationId, status: conversationId === "Gone01" ? "not_found" : "ok" })),
    }));

    await runMailBulkAssignment(["Conv01", "Gone01", "Conv02"], run.host, t);

    expect(run.successes[0]!.message).toBe("2 Unterhaltungen an Maria zugewiesen");
    expect(run.successes[0]!.undo?.label).toBe("Rückgängig");
    expect(run.errors).toEqual([
      {
        title: "1 von 3 Unterhaltungen wurden nicht geändert",
        message: "Sie gehören nicht mehr zu diesem Postfach. Aktualisiere die Liste, um den aktuellen Stand zu sehen.",
      },
    ]);

    run.successes[0]!.undo!.run();
    await Bun.sleep(0);
    expect(run.calls[1]).toEqual({ ids: ["Conv01", "Conv02"], assigneeUserId: null });
  });

  test("unassigning confirms without an undo and a dismissed picker changes nothing", async () => {
    const t = mailWorkspaceMessages.resolve(["en"]).t;
    const unassign = harness({ assigneeUserId: null }, allOk);
    await runMailBulkAssignment(["Conv01"], unassign.host, t);
    expect(unassign.successes).toEqual([{ message: "Removed the assignee from 1 conversation", undo: undefined }]);

    const dismissed = harness(null, allOk);
    await runMailBulkAssignment(["Conv01"], dismissed.host, t);
    expect(dismissed.calls).toEqual([]);
    expect(dismissed.cleared()).toBe(0);
  });
});
