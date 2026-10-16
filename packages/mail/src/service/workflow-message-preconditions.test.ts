import { describe, expect, test } from "bun:test";
import type { WorkflowActionStep, WorkflowExecuteActionContext } from "@k2b/cloud/workflows/runtime";
import { sql } from "bun";
import type { RemoteMessagePrecondition } from "../contracts";
import {
  loadIncomingAutomationSiblingTransitions,
  mailMessageStatePayloadTransitions,
  mailWorkflowMessagePrecondition,
  projectMailWorkflowMessagePrecondition,
} from "./workflow-message-preconditions";
import {
  applyMailMessageTransition,
  mailWorkflowMessageStateTransitions,
  rebindMailWorkflowRestoredOutput,
  restoreMailWorkflowProjectedState,
} from "./workflow-projected-state";

describe("Mail workflow message preconditions", () => {
  const context = {
    source: { message: { remoteMessageRefId: "remote", id: "message", folderId: "folder" } },
    preconditions: {
      message: { remoteMessageRefId: "remote", id: "message", folderId: "folder" },
      remoteState: { modseq: "42", flags: ["seen"], keywords: ["review"] },
    },
  };
  const target = { messageId: "message", remoteMessageRefId: "remote", folderId: "folder" };

  test("returns the receipt-time provider state for the frozen message", () => {
    expect(mailWorkflowMessagePrecondition(context, target)).toEqual({
      modseq: "42",
      flags: ["seen"],
      keywords: ["review"],
    });
  });

  test("fails closed for another message or missing state", () => {
    expect(() => mailWorkflowMessagePrecondition(context, { ...target, messageId: "other" })).toThrow(
      "Frozen remote message preconditions are unavailable",
    );
    expect(() => mailWorkflowMessagePrecondition({ source: context.source }, target)).toThrow(
      "Frozen remote message preconditions are unavailable",
    );
  });
});

test("projects only successful own transitions and keeps the first provider precondition intact", () => {
  const frozen: RemoteMessagePrecondition = { modseq: "42", flags: ["answered"], keywords: ["Review", "Unrelated"] };
  const message = { flags: ["\\Answered", "recent"], keywords: ["Review", "Unrelated"] };
  expect(projectMailWorkflowMessagePrecondition(frozen, mailWorkflowMessageStateTransitions(message))).toBe(frozen);
  expect(applyMailMessageTransition(message, "addKeyword", "REVIEW")).toBe(false);
  expect(projectMailWorkflowMessagePrecondition(frozen, mailWorkflowMessageStateTransitions(message))).toBe(frozen);
  applyMailMessageTransition(message, "addFlag", "seen");
  applyMailMessageTransition(message, "removeFlag", "\\Answered");
  applyMailMessageTransition(message, "removeKeyword", "review");
  applyMailMessageTransition(message, "addKeyword", "Sorted");
  expect(projectMailWorkflowMessagePrecondition(frozen, mailWorkflowMessageStateTransitions(message))).toEqual({
    modseq: undefined,
    flags: ["seen"],
    keywords: ["Unrelated", "Sorted"],
  });
  expect(frozen).toEqual({ modseq: "42", flags: ["answered"], keywords: ["Review", "Unrelated"] });
});

test("drops modseq even after own changes cancel each other and preserves omitted checks", () => {
  const message = { flags: [], keywords: [] };
  applyMailMessageTransition(message, "addFlag", "seen");
  applyMailMessageTransition(message, "removeFlag", "seen");
  expect(
    projectMailWorkflowMessagePrecondition({ modseq: "42", flags: [], keywords: [] }, mailWorkflowMessageStateTransitions(message)),
  ).toEqual({
    modseq: undefined,
    flags: [],
    keywords: [],
  });
  expect(projectMailWorkflowMessagePrecondition({ modseq: null }, mailWorkflowMessageStateTransitions(message))).toEqual({
    modseq: undefined,
  });
});

test("replayed completed actions restore provider expectations before the next action", async () => {
  const message = { flags: [], keywords: ["keep"] };
  const ctx = {
    evaluate: async (value: unknown) => value,
    resolveReference: async () => message,
  } as unknown as WorkflowExecuteActionContext;
  await restoreMailWorkflowProjectedState(
    ctx,
    {
      kind: "action",
      action: "addFlag",
      config: { message: "inputs.message" },
      sourcePath: ["steps", 0],
    } as WorkflowActionStep,
    { state: "completed", output: { action: "addFlag", applied: true, value: "seen" } },
  );
  expect(
    projectMailWorkflowMessagePrecondition({ modseq: "42", flags: [], keywords: ["keep"] }, mailWorkflowMessageStateTransitions(message)),
  ).toEqual({
    modseq: undefined,
    flags: ["seen"],
    keywords: ["keep"],
  });
});

test("restored message aliases use the canonical target projection across actions", async () => {
  const canonical: { id: string; flags: string[]; keywords: string[] } = { id: "message", flags: [], keywords: [] };
  let alias = structuredClone(canonical);
  const context = { source: { message: canonical } };
  const ctx = {
    invocation: { context },
    evaluate: async (value: unknown) => value,
    resolveReference: async () => alias,
  } as unknown as WorkflowExecuteActionContext;
  await rebindMailWorkflowRestoredOutput({
    execute: async () => ({ state: "completed" }),
    restoreCompleted: (_ctx, _step, outcome) => {
      if (outcome.output === canonical) alias = canonical;
    },
  }).restoreCompleted?.(ctx, { kind: "action", action: "setVariable", config: {}, sourcePath: ["steps", 0] } as WorkflowActionStep, {
    state: "completed",
    output: alias,
  });
  await restoreMailWorkflowProjectedState(
    ctx,
    {
      kind: "action",
      action: "addFlag",
      config: { message: "selected" },
      sourcePath: ["steps", 1],
    } as WorkflowActionStep,
    { state: "completed", output: { action: "addFlag", applied: true, value: "seen" } },
  );
  expect(alias).toBe(canonical);
  // A later condition on the alias sees the same state as one on the input.
  expect(alias.flags).toEqual(["seen"]);
  expect(canonical.flags).toEqual(["seen"]);
  expect(
    projectMailWorkflowMessagePrecondition({ modseq: "42", flags: [], keywords: [] }, mailWorkflowMessageStateTransitions(canonical)),
  ).toEqual({
    modseq: undefined,
    flags: ["seen"],
    keywords: [],
  });
});

test("converts confirmed state payloads in provider operation order", () => {
  expect(
    mailMessageStatePayloadTransitions({
      addFlags: ["seen", "answered"],
      removeFlags: ["flagged"],
      addKeywords: ["alpha", "beta"],
      removeKeywords: ["review"],
    }),
  ).toEqual([
    { field: "flags", add: true, value: "seen" },
    { field: "flags", add: true, value: "answered" },
    { field: "flags", add: false, value: "flagged" },
    { field: "keywords", add: true, value: "alpha" },
    { field: "keywords", add: true, value: "beta" },
    { field: "keywords", add: false, value: "review" },
  ]);
});

test("retains modseq without sibling writes and drops it only when a transition applies", () => {
  const frozen: RemoteMessagePrecondition = { modseq: "42", flags: [], keywords: [] };
  expect(
    projectMailWorkflowMessagePrecondition(
      frozen,
      mailMessageStatePayloadTransitions({
        addFlags: [],
        removeFlags: [],
        addKeywords: [],
        removeKeywords: [],
      }),
    ),
  ).toBe(frozen);
  expect(
    projectMailWorkflowMessagePrecondition(
      frozen,
      mailMessageStatePayloadTransitions({
        addFlags: ["seen"],
        removeFlags: [],
        addKeywords: ["alpha"],
        removeKeywords: [],
      }),
    ),
  ).toEqual({ modseq: undefined, flags: ["seen"], keywords: ["alpha"] });
  expect(frozen).toEqual({ modseq: "42", flags: [], keywords: [] });
});

describe("incoming automation sibling transition loading", () => {
  const command = {
    id: "00000000-0000-4000-8000-000000000001",
    mailbox_id: "00000000-0000-4000-8000-000000000002",
    actor_kind: "workflow",
    actor_id: "00000000-0000-4000-8000-000000000003",
    correlation_id: "00000000-0000-4000-8000-000000000004",
    target: {
      remoteMessageRefId: "00000000-0000-4000-8000-000000000005",
      expectedRemoteState: { modseq: "1", flags: [], keywords: [] },
    },
  };

  test("does not query for commands without a workflow UUID and frozen remote state", async () => {
    const db = new Proxy(sql, {
      apply: () => {
        throw new Error("Unexpected SQL query");
      },
    });
    for (const commands of [
      [],
      [{ ...command, actor_kind: "user" }],
      [{ ...command, correlation_id: "not-a-run-id" }],
      [{ ...command, correlation_id: null }],
      [{ ...command, target: { remoteMessageRefId: command.target.remoteMessageRefId } }],
      [{ ...command, target: { expectedRemoteState: command.target.expectedRemoteState } }],
      [{ ...command, target: "invalid JSON" }],
    ]) {
      expect((await loadIncomingAutomationSiblingTransitions(db, commands)).size).toBe(0);
    }
  });

  test("loads a whole command set once, keeps confirmation order, and ignores invalid payloads", async () => {
    const second = { ...command, id: "00000000-0000-4000-8000-000000000006", target: JSON.stringify(command.target) };
    let queries = 0;
    const db = new Proxy(sql, {
      apply: () => {
        queries++;
        return Promise.resolve([
          { command_id: command.id, payload: { addFlags: ["seen"], removeFlags: [], addKeywords: [], removeKeywords: [] } },
          { command_id: command.id, payload: "invalid JSON" },
          { command_id: command.id, payload: { addFlags: ["unsupported"], removeFlags: [], addKeywords: [], removeKeywords: [] } },
          { command_id: command.id, payload: { addFlags: [], removeFlags: ["seen"], addKeywords: ["alpha"], removeKeywords: [] } },
          { command_id: second.id, payload: JSON.stringify({ addFlags: [], removeFlags: [], addKeywords: ["beta"], removeKeywords: [] }) },
        ]);
      },
    });
    const loaded = await loadIncomingAutomationSiblingTransitions(db, [command, second]);
    expect(queries).toBe(1);
    expect(loaded.get(command.id)).toEqual([
      { field: "flags", add: true, value: "seen" },
      { field: "flags", add: false, value: "seen" },
      { field: "keywords", add: true, value: "alpha" },
    ]);
    expect(loaded.get(second.id)).toEqual([{ field: "keywords", add: true, value: "beta" }]);
  });
});
