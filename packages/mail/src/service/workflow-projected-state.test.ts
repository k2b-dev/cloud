import { describe, expect, test } from "bun:test";
import type { WorkflowBoundPlan, WorkflowStepOutcome } from "@k2b/cloud/workflows";
import type { WorkflowActionStep, WorkflowExecuteActionContext } from "@k2b/cloud/workflows/runtime";
import type { FrozenMailWorkflowSource } from "./workflow-data";
import {
  applyMailConversationTransition,
  applyMailMessageTransition,
  createMailWorkflowProjectedState,
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
