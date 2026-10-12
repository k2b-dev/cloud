import { describe, expect, test } from "bun:test";
import type { WorkflowActionStep, WorkflowExecuteActionContext } from "@k2b/cloud/workflows/runtime";
import type { RemoteMessagePrecondition } from "../contracts";
import { mailWorkflowMessagePrecondition, projectMailWorkflowMessagePrecondition } from "./workflow-message-preconditions";
import {
  applyMailMessageTransition,
  mailWorkflowMessageStateTransitions,
  mailWorkflowProjectedMessage,
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
  const alias = structuredClone(canonical);
  const context = { source: { message: canonical } };
  const ctx = {
    invocation: { context },
    evaluate: async (value: unknown) => value,
    resolveReference: async () => alias,
  } as unknown as WorkflowExecuteActionContext;
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
  expect(mailWorkflowProjectedMessage(context, alias)).toBe(canonical);
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
  const other = { ...alias, id: "other" };
  expect(mailWorkflowProjectedMessage(context, other)).toBe(other);
});
