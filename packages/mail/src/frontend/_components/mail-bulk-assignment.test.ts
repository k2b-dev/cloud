import { describe, expect, test } from "bun:test";
import type { ConversationAssignmentResult } from "../../service/collaboration";
import { mailWorkspaceMessages } from "../mail-workspace-messages";
import type { MailAssigneeChoice } from "./mail-assign-picker";
import { type MailBulkAssignmentHost, runMailBulkAssignment } from "./mail-bulk-assignment";

const maria = { id: "00000000-0000-4000-8000-000000000001", uid: "maria", displayName: "Maria", avatarHash: null };
const addMaria: MailAssigneeChoice = { mode: "add", userId: maria.id, name: "Maria" };

type Call = { ids: string[]; userIds: string[]; mode: "add" | "remove" | "replace" };

const harness = (
  choice: MailAssigneeChoice | null,
  respond: (ids: string[]) => ConversationAssignmentResult,
  options: { refreshError?: Error | null; assignees?: Record<string, string[]> } = {},
) => {
  const calls: Call[] = [];
  const successes: Array<{ message: string; undo?: { label: string; run: () => void } }> = [];
  const errors: Array<{ message: string; title?: string }> = [];
  const refreshFailures: Array<{ message: string; title: string }> = [];
  let cleared = 0;
  let refreshes = 0;
  const host: MailBulkAssignmentHost = {
    chooseAssignee: async () => choice,
    assign: async (ids, userIds, mode) => {
      calls.push({ ids, userIds, mode });
      return respond(ids);
    },
    assigneesOf: (conversationId) => options.assignees?.[conversationId] ?? null,
    clearSelection: () => {
      cleared += 1;
    },
    refresh: async () => {
      refreshes += 1;
      return options.refreshError ?? null;
    },
    success: (message, undo) => successes.push({ message, undo }),
    error: (message, title) => errors.push({ message, title }),
    refreshFailed: (error, title) => refreshFailures.push({ message: error.message, title }),
    active: () => true,
  };
  return { host, calls, successes, errors, refreshFailures, cleared: () => cleared, refreshes: () => refreshes };
};

const allOk = (ids: string[]): ConversationAssignmentResult => ({
  assignees: [maria],
  results: ids.map((conversationId) => ({ conversationId, status: "ok" })),
});

describe("Mail bulk assignment", () => {
  test("adds a person, keeps the others, and undoes only where the person was added", async () => {
    const t = mailWorkspaceMessages.resolve(["en"]).t;
    // Conv02 already had Maria: the undo must not take her off it.
    const run = harness(addMaria, allOk, { assignees: { Conv01: ["someone-else"], Conv02: [maria.id] } });

    await runMailBulkAssignment(["Conv01", "Conv02"], run.host, t);

    expect(run.calls).toEqual([{ ids: ["Conv01", "Conv02"], userIds: [maria.id], mode: "add" }]);
    expect(run.cleared()).toBe(1);
    expect(run.refreshes()).toBe(1);
    expect(run.successes).toHaveLength(1);
    expect(run.successes[0]!.message).toBe("2 conversations assigned to Maria");
    expect(run.successes[0]!.undo?.label).toBe("Undo");

    run.successes[0]!.undo!.run();
    await Bun.sleep(0);
    expect(run.calls[1]).toEqual({ ids: ["Conv01"], userIds: [maria.id], mode: "remove" });
    expect(run.refreshes()).toBe(2);
    expect(run.successes[1]).toEqual({ message: "Assignment undone for 1 conversation", undo: undefined });
    expect(run.errors).toEqual([]);
  });

  test("removing a person undoes by adding them back", async () => {
    const t = mailWorkspaceMessages.resolve(["en"]).t;
    const run = harness({ mode: "remove", userId: maria.id, name: "Maria" }, allOk, { assignees: { Conv01: [maria.id] } });
    await runMailBulkAssignment(["Conv01"], run.host, t);
    expect(run.successes[0]!.message).toBe("Maria removed from 1 conversation");
    run.successes[0]!.undo!.run();
    await Bun.sleep(0);
    expect(run.calls[1]).toEqual({ ids: ["Conv01"], userIds: [maria.id], mode: "add" });
  });

  test("speaks German and names partial failures with their count", async () => {
    const t = mailWorkspaceMessages.resolve(["de"]).t;
    const run = harness(addMaria, (ids) => ({
      assignees: [maria],
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
    expect(run.calls[1]).toEqual({ ids: ["Conv01", "Conv02"], userIds: [maria.id], mode: "remove" });
  });

  test("removing everyone confirms without an undo and a dismissed picker changes nothing", async () => {
    const t = mailWorkspaceMessages.resolve(["en"]).t;
    const unassign = harness({ mode: "replace", userId: null, name: null }, allOk);
    await runMailBulkAssignment(["Conv01"], unassign.host, t);
    expect(unassign.calls).toEqual([{ ids: ["Conv01"], userIds: [], mode: "replace" }]);
    expect(unassign.successes).toEqual([{ message: "Removed all assignees from 1 conversation", undo: undefined }]);

    const dismissed = harness(null, allOk);
    await runMailBulkAssignment(["Conv01"], dismissed.host, t);
    expect(dismissed.calls).toEqual([]);
    expect(dismissed.cleared()).toBe(0);
  });

  test("a failed reload after a saved assignment is reported as a refresh failure, not as a failed assignment", async () => {
    const t = mailWorkspaceMessages.resolve(["en"]).t;
    const run = harness(addMaria, allOk, { refreshError: new Error(t.refreshMailboxFailed) });

    await runMailBulkAssignment(["Conv01"], run.host, t);

    expect(run.successes.map((success) => success.message)).toEqual(["1 conversation assigned to Maria"]);
    expect(run.refreshFailures).toEqual([{ message: t.refreshMailboxFailed, title: "Assignment saved, refresh failed" }]);
    expect(run.errors).toEqual([]);
  });
});
