import { describe, expect, mock, test } from "bun:test";
import type { CapabilityActionReview } from "../contracts/capabilities";
import { AiBackgroundApprovalRequiredError, authorizeBackgroundAction } from "./background-review";

const message =
  "NEEDS_APPROVAL: Create task needs the user's approval every time, and routines never ask. Stop and say in one sentence what was missing.";
const fixture = () => ({
  turnId: "turn",
  mandate: { id: "mandate", revision: 1 },
  appId: "tasks",
  capabilityId: "create",
  kind: "action" as "query" | "action",
  args: { title: "Test" },
  approval: "rememberable" as "none" | "rememberable" | "always",
  hasReview: true,
  action: "Create task",
  review: mock<() => Promise<CapabilityActionReview | null>>(async () => ({ message: "Create task?" })),
  dependencies: {
    authorizeCapability: mock(async () => {}),
    markNeedsApproval: mock(async (_input: { turnId: string; action: string }) => {}),
  },
});

describe("authorizeBackgroundAction", () => {
  test("mandate denial precedes review and leaves no approval marker", async () => {
    const input = fixture();
    const denied = new Error("Mandate denied");
    input.dependencies.authorizeCapability.mockRejectedValue(denied);
    await expect(authorizeBackgroundAction(input)).rejects.toBe(denied);
    expect(input.review).not.toHaveBeenCalled();
    expect(input.dependencies.markNeedsApproval).not.toHaveBeenCalled();
  });

  for (const kind of ["query", "action"] as const) {
    test(`${kind} with approval none checks only the mandate`, async () => {
      const input = { ...fixture(), kind, approval: "none" as const };
      expect(await authorizeBackgroundAction(input)).toBeNull();
      expect(input.dependencies.authorizeCapability).toHaveBeenCalledWith({
        mandate: input.mandate,
        appId: "tasks",
        capabilityId: "create",
        kind,
        input: input.args,
        approval: "none",
      });
      expect(input.review).not.toHaveBeenCalled();
      expect(input.dependencies.markNeedsApproval).not.toHaveBeenCalled();
    });
  }

  test("a query with no approval field never reviews", async () => {
    const input = { ...fixture(), kind: "query" as const, approval: undefined };
    await authorizeBackgroundAction(input);
    expect(input.review).not.toHaveBeenCalled();
  });

  for (const outcome of ["no scope", "null", "throws", "no declared review"] as const) {
    test(`${outcome} refuses with the exact model error and a durable marker`, async () => {
      const input = fixture();
      if (outcome === "null") input.review.mockResolvedValue(null);
      if (outcome === "throws") input.review.mockRejectedValue(new Error("Provider unavailable"));
      if (outcome === "no declared review") input.hasReview = false;
      const run = mock(async () => {});
      const call = async () => {
        await authorizeBackgroundAction(input);
        await run();
      };
      await expect(call()).rejects.toMatchObject({ code: "NEEDS_APPROVAL", action: "Create task", message });
      expect(run).not.toHaveBeenCalled();
      expect(input.dependencies.markNeedsApproval).toHaveBeenCalledWith({ turnId: "turn", action: "Create task" });
      if (!input.hasReview) expect(input.review).not.toHaveBeenCalled();
    });
  }

  test("a scope allows the call and returns that review without replacing mandate authority", async () => {
    const input = fixture();
    const review = { message: "Create task?", approvalScope: "tasks:own" };
    input.review.mockResolvedValue(review);
    expect(await authorizeBackgroundAction(input)).toBe(review);
    expect(input.dependencies.authorizeCapability).toHaveBeenCalledTimes(1);
    expect(input.review).toHaveBeenCalledTimes(1);
    expect(input.dependencies.markNeedsApproval).not.toHaveBeenCalled();
  });

  for (const duringReview of [false, true]) {
    test(`cancellation ${duringReview ? "during" : "before"} review rethrows the abort without marking approval`, async () => {
      const input = fixture();
      const controller = new AbortController();
      const abort = new DOMException("Routine stopped", "AbortError");
      if (duringReview)
        input.review.mockImplementation(async () => {
          controller.abort(abort);
          throw new Error("Review cancelled");
        });
      else controller.abort(abort);
      await expect(authorizeBackgroundAction({ ...input, signal: controller.signal })).rejects.toBe(abort);
      expect(input.dependencies.markNeedsApproval).not.toHaveBeenCalled();
    });
  }

  test("marker persistence failure also prevents execution", async () => {
    const input = fixture();
    const error = new Error("Database unavailable");
    input.dependencies.markNeedsApproval.mockRejectedValue(error);
    await expect(authorizeBackgroundAction(input)).rejects.toBe(error);
  });

  test("approval error has the stable code and exact message", () => {
    expect(new AiBackgroundApprovalRequiredError("Create task")).toMatchObject({ code: "NEEDS_APPROVAL", message });
  });
});
