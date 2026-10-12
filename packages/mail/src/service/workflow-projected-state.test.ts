import { describe, expect, test } from "bun:test";
import type { WorkflowBoundPlan, WorkflowStepOutcome } from "@k2b/cloud/workflows";
import type { WorkflowActionStep, WorkflowExecuteActionContext } from "@k2b/cloud/workflows/runtime";
import type { FrozenMailWorkflowSource } from "./workflow-data";
import {
  applyMailConversationTransition,
  applyMailMessageTransition,
  createMailWorkflowProjectedState,
  rebindMailWorkflowRestoredOutput,
  restoreMailWorkflowProjectedState,
} from "./workflow-projected-state";

const plan = {
  inputs: [
    { name: "message", type: "mailMessage", config: {} },
    { name: "conversation", type: "mailConversation", config: {} },
  ],
} as WorkflowBoundPlan;

const source = {
  message: { id: "message", folderId: "inbox", keywords: ["finance"] },
  conversation: { id: "conversation", workStatus: "needs_action", summary: null, summaryRevision: 1, revision: 2 },
} as unknown as FrozenMailWorkflowSource;

describe("Mail workflow projected state", () => {
  test("shares projected objects between context and declared inputs without mutating the snapshot", () => {
    const projected = createMailWorkflowProjectedState(plan, source, { caller: "kept" });

    expect(projected.inputs.message).toBe(projected.source.message);
    expect(projected.inputs.conversation).toBe(projected.source.conversation);
    expect(projected.inputs.caller).toBe("kept");

    applyMailMessageTransition(projected.source.message, "moveMessage", "archive");
    expect((projected.inputs.message as Record<string, unknown>).folderId).toBe("archive");
    expect(source.message.folderId).toBe("inbox");
  });

  test("rebinds nested restored message and conversation aliases without changing other objects", async () => {
    const message = { id: "message", flags: [] };
    const conversation = { id: "conversation", workStatus: "done" };
    const output = {
      nested: [{ message: structuredClone(message), conversation: structuredClone(conversation) }],
      other: { id: "other" },
      scalar: null,
    };
    const ctx = { invocation: { context: { source: { message, conversation } } } } as unknown as WorkflowExecuteActionContext;
    const handler = rebindMailWorkflowRestoredOutput({
      execute: async () => ({ state: "completed" }),
      restoreCompleted: (_ctx, _step, restored) => {
        expect(restored.output).toEqual(output);
        const value = restored.output;
        if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.nested))
          throw new Error("Expected nested output");
        const nested = value.nested[0];
        if (!nested || typeof nested !== "object" || Array.isArray(nested)) throw new Error("Expected nested aliases");
        expect(nested.message).toBe(message);
        expect(nested.conversation).toBe(conversation);
      },
    });
    await handler.restoreCompleted?.(
      ctx,
      { kind: "action", action: "setVariable", config: {}, sourcePath: ["steps", 0] } as WorkflowActionStep,
      { state: "completed", output },
    );
    expect(output.nested[0]?.message).not.toBe(message);
    expect(output.nested[0]?.conversation).not.toBe(conversation);
  });

  test("applies message transitions idempotently with stable keyword comparison", () => {
    const message = structuredClone(source.message);

    expect(applyMailMessageTransition(message, "addKeyword", "FINANCE")).toBe(false);
    expect(applyMailMessageTransition(message, "addKeyword", "Review")).toBe(true);
    expect(applyMailMessageTransition(message, "removeKeyword", "review")).toBe(true);
    expect(applyMailMessageTransition(message, "removeKeyword", "review")).toBe(false);
    expect(message.keywords).toEqual(["finance"]);
  });

  test("projects conversation revisions only when state changes", () => {
    if (!source.conversation) throw new Error("Expected workflow conversation fixture");
    const conversation = structuredClone(source.conversation);

    expect(applyMailConversationTransition(conversation, "setConversationStatus", "needs_action")).toBe(false);
    expect(applyMailConversationTransition(conversation, "setConversationStatus", "done")).toBe(true);
    expect(conversation).toMatchObject({ workStatus: "done", revision: 3 });
  });

  test("keeps stored single-user workflow actions as set replacement", () => {
    const conversation = { assigneeUserIds: ["first", "second"], revision: 1 };
    expect(applyMailConversationTransition(conversation, "assignConversation", "second")).toBeTrue();
    expect(conversation).toEqual({ assigneeUserIds: ["second"], revision: 2 });
    expect(applyMailConversationTransition(conversation, "assignConversation", "second")).toBeFalse();
    expect(applyMailConversationTransition(conversation, "assignConversation", null)).toBeTrue();
    expect(conversation).toEqual({ assigneeUserIds: [], revision: 3 });
    expect(applyMailConversationTransition(conversation, "assignConversation", null)).toBeFalse();
  });

  test("projects summary and summary revision independently", () => {
    if (!source.conversation) throw new Error("Expected workflow conversation fixture");
    const conversation = structuredClone(source.conversation);

    expect(applyMailConversationTransition(conversation, "setConversationSummary", "Current context")).toBe(true);
    expect(conversation).toMatchObject({ summary: "Current context", summaryRevision: 2, revision: 3 });
  });

  test("keeps schedule-only inputs when no message source exists", () => {
    const projected = createMailWorkflowProjectedState(plan, {}, { slot: "2026-07-22T08:00:00.000Z" });

    expect(projected.source).toEqual({});
    expect(projected.inputs).toEqual({ slot: "2026-07-22T08:00:00.000Z" });
  });

  test("restores completed message and conversation projections before later steps", async () => {
    const projected = createMailWorkflowProjectedState(plan, source, {});
    const variables = new Map<string, unknown>();
    const ctx = {
      plan,
      variables: {
        get: (name: string) => variables.get(name),
        has: (name: string) => variables.has(name),
        set: (name: string, value: unknown) => variables.set(name, value),
      },
      evaluate: async (value: unknown) => value,
      resolveReference: async (reference: string) =>
        reference === "message" ? projected.inputs.message : reference === "conversation" ? projected.inputs.conversation : undefined,
    } as unknown as WorkflowExecuteActionContext;

    await restoreMailWorkflowProjectedState(
      ctx,
      { kind: "action", action: "moveMessage", config: { message: "message" }, sourcePath: ["steps", 0] } as WorkflowActionStep,
      { state: "completed", output: { action: "moveMessage", applied: true, value: "archive" } } as Extract<
        WorkflowStepOutcome,
        { state: "completed" }
      >,
    );
    await restoreMailWorkflowProjectedState(
      ctx,
      {
        kind: "action",
        action: "setConversationStatus",
        config: { conversation: "conversation" },
        sourcePath: ["steps", 1],
      } as WorkflowActionStep,
      {
        state: "completed",
        output: { action: "setConversationStatus", applied: true, value: "done", revision: 8 },
      } as Extract<WorkflowStepOutcome, { state: "completed" }>,
    );

    expect(projected.source.message.folderId).toBe("archive");
    expect(projected.source.conversation).toMatchObject({ workStatus: "done", revision: 8 });
  });
});
