import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { reviewFixture } from "../_internal/capability-review.test-fixture";
import type { CapabilityActionReviewData } from "../contracts/capabilities";
import { AiBackgroundApprovalRequiredError, authorizeBackgroundAction } from "./background-review";
import { aiChatTasks } from "./chat-tasks";

afterEach(() => mock.restore());

const message =
  "NEEDS_APPROVAL: Create task needs the user's approval every time, and routines never ask. Stop and say in one sentence what was missing.";
const fixture = () => ({
  authorizeCapability: spyOn(aiChatTasks, "authorizeCapability").mockImplementation(async () => {}),
  markNeedsApproval: spyOn(aiChatTasks, "markNeedsApproval").mockImplementation(async () => {}),
  input: {
    turnId: "turn",
    mandate: { id: "mandate", revision: 1 },
    appId: "tasks",
    capabilityId: "create",
    kind: "action" as "query" | "action",
    args: { title: "Test" },
    approval: "rememberable" as "none" | "rememberable" | "always",
    hasReview: true,
    action: "Create task",
    review: mock<() => Promise<CapabilityActionReviewData | null>>(async () => ({ message: "Create task?" })),
  },
});

describe("authorizeBackgroundAction", () => {
  test("mandate denial precedes review and leaves no approval marker", async () => {
    const { input, authorizeCapability, markNeedsApproval } = fixture();
    const denied = new Error("Mandate denied");
    authorizeCapability.mockRejectedValue(denied);
    await expect(authorizeBackgroundAction(input)).rejects.toBe(denied);
    expect(input.review).not.toHaveBeenCalled();
    expect(markNeedsApproval).not.toHaveBeenCalled();
  });

  for (const kind of ["query", "action"] as const) {
    test(`${kind} with approval none checks only the mandate`, async () => {
      const { input: base, authorizeCapability, markNeedsApproval } = fixture();
      const input = { ...base, kind, approval: "none" as const };
      expect(await authorizeBackgroundAction(input)).toBeNull();
      expect(authorizeCapability).toHaveBeenCalledWith({
        mandate: input.mandate,
        appId: "tasks",
        capabilityId: "create",
        kind,
        input: input.args,
        approval: "none",
      });
      expect(input.review).not.toHaveBeenCalled();
      expect(markNeedsApproval).not.toHaveBeenCalled();
    });
  }

  test("a query with no approval field never reviews", async () => {
    const { input: base } = fixture();
    const input = { ...base, kind: "query" as const, approval: undefined };
    await authorizeBackgroundAction(input);
    expect(input.review).not.toHaveBeenCalled();
  });

  for (const approval of ["always", undefined] as const) {
    test(`an Action with approval ${approval} refuses even when its review would return a scope`, async () => {
      const { input: base, markNeedsApproval } = fixture();
      const input = { ...base, approval };
      input.review.mockResolvedValue({ message: "Create task?", approvalScope: "tasks:own" });
      const run = mock(async () => {});
      const call = async () => {
        await authorizeBackgroundAction(input);
        await run();
      };
      await expect(call()).rejects.toMatchObject({ code: "NEEDS_APPROVAL", action: "Create task", message });
      expect(input.review).not.toHaveBeenCalled();
      expect(markNeedsApproval).toHaveBeenCalledTimes(1);
      expect(markNeedsApproval).toHaveBeenCalledWith({ turnId: "turn", action: "Create task" });
      expect(run).not.toHaveBeenCalled();
    });

    test(`cancellation before refusing approval ${approval} leaves no approval marker`, async () => {
      const { input, markNeedsApproval } = fixture();
      const abort = new DOMException("Routine stopped", "AbortError");
      await expect(authorizeBackgroundAction({ ...input, approval, signal: AbortSignal.abort(abort) })).rejects.toBe(abort);
      expect(input.review).not.toHaveBeenCalled();
      expect(markNeedsApproval).not.toHaveBeenCalled();
    });
  }

  for (const outcome of ["no scope", "null", "throws", "no declared review"] as const) {
    test(`${outcome} refuses with the exact model error and a durable marker`, async () => {
      const { input, markNeedsApproval } = fixture();
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
      expect(markNeedsApproval).toHaveBeenCalledWith({ turnId: "turn", action: "Create task" });
      if (!input.hasReview) expect(input.review).not.toHaveBeenCalled();
    });
  }

  test("a scope allows the call and returns that review without replacing mandate authority", async () => {
    const { input, authorizeCapability, markNeedsApproval } = fixture();
    const review = { message: "Create task?", approvalScope: "tasks:own" };
    input.review.mockResolvedValue(review);
    expect(await authorizeBackgroundAction(input)).toBe(review);
    expect(authorizeCapability).toHaveBeenCalledTimes(1);
    expect(input.review).toHaveBeenCalledTimes(1);
    expect(markNeedsApproval).not.toHaveBeenCalled();
  });

  for (const duringReview of [false, true]) {
    test(`cancellation ${duringReview ? "during" : "before"} review rethrows the abort without marking approval`, async () => {
      const { input, markNeedsApproval } = fixture();
      const controller = new AbortController();
      const abort = new DOMException("Routine stopped", "AbortError");
      if (duringReview)
        input.review.mockImplementation(async () => {
          controller.abort(abort);
          throw new Error("Review cancelled");
        });
      else controller.abort(abort);
      await expect(authorizeBackgroundAction({ ...input, signal: controller.signal })).rejects.toBe(abort);
      expect(markNeedsApproval).not.toHaveBeenCalled();
    });
  }

  test("marker persistence failure also prevents execution", async () => {
    const { input, markNeedsApproval } = fixture();
    const error = new Error("Database unavailable");
    markNeedsApproval.mockRejectedValue(error);
    await expect(authorizeBackgroundAction(input)).rejects.toBe(error);
  });

  test("approval error has the stable code and exact message", () => {
    expect(new AiBackgroundApprovalRequiredError("Create task")).toMatchObject({ code: "NEEDS_APPROVAL", message });
  });
});

for (const policy of [{ ask: "sends" }, { silent: "you", routines: false }, { silent: "you" }] as const) {
  for (const asks of [false, true])
    test(`policy background gate ${JSON.stringify(policy)} review asks=${asks}`, async () => {
      const { input, markNeedsApproval } = fixture();
      const review = { ...reviewFixture(), ...(asks ? { ask: "sends" as const } : {}) };
      input.review.mockResolvedValue(review);
      const run = mock(async () => {});
      const call = async () => {
        await authorizeBackgroundAction({ ...input, policy });
        await run();
      };
      if ("ask" in policy || ("routines" in policy && policy.routines === false) || asks) {
        await expect(call()).rejects.toMatchObject({ code: "NEEDS_APPROVAL" });
        expect(run).not.toHaveBeenCalled();
        expect(markNeedsApproval).toHaveBeenCalledTimes(1);
        if ("ask" in policy || ("routines" in policy && policy.routines === false)) expect(input.review).not.toHaveBeenCalled();
      } else {
        await call();
        expect(run).toHaveBeenCalledTimes(1);
        expect(markNeedsApproval).not.toHaveBeenCalled();
      }
    });
}

test("a policy routine refuses missing or failing reviews", async () => {
  for (const outcome of ["missing", "failing"] as const) {
    const { input, markNeedsApproval } = fixture();
    markNeedsApproval.mockClear();
    if (outcome === "missing") input.hasReview = false;
    if (outcome === "failing") input.review.mockRejectedValue(new Error("Unavailable"));
    await expect(authorizeBackgroundAction({ ...input, policy: { silent: "you" } })).rejects.toMatchObject({
      code: "NEEDS_APPROVAL",
    });
    expect(markNeedsApproval).toHaveBeenCalledTimes(1);
  }
});

for (const outcome of ["before", "throws", "returns"] as const)
  test(`policy review cancellation ${outcome} rethrows the abort without marking approval`, async () => {
    const { input, markNeedsApproval } = fixture();
    const controller = new AbortController();
    const abort = new DOMException("Routine stopped", "AbortError");
    if (outcome === "before") controller.abort(abort);
    else
      input.review.mockImplementation(async () => {
        controller.abort(abort);
        if (outcome === "throws") throw new Error("Review cancelled");
        return reviewFixture();
      });
    await expect(authorizeBackgroundAction({ ...input, policy: { silent: "you" }, signal: controller.signal })).rejects.toBe(abort);
    if (outcome === "before") expect(input.review).not.toHaveBeenCalled();
    else expect(input.review).toHaveBeenCalledTimes(1);
    expect(markNeedsApproval).not.toHaveBeenCalled();
  });

test("an ungrantable policy stops as needs_approval before a stale mandate grant can authorize it", async () => {
  for (const policy of [{ ask: "sends" }, { silent: "you", routines: false }] as const) {
    const { input, authorizeCapability, markNeedsApproval } = fixture();
    authorizeCapability.mockClear();
    authorizeCapability.mockRejectedValue(new Error("Stale grant denied"));
    await expect(authorizeBackgroundAction({ ...input, policy })).rejects.toMatchObject({ code: "NEEDS_APPROVAL" });
    expect(authorizeCapability).not.toHaveBeenCalled();
    expect(input.review).not.toHaveBeenCalled();
    expect(markNeedsApproval).toHaveBeenCalled();
  }
});
