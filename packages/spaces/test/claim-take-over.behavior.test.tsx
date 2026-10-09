import { describe, expect, mock, test } from "bun:test";
import { createComponent, createMemo, createRoot, getOwner } from "solid-js";
import { isServer, render } from "solid-js/web";
import type { SpaceItem, SpaceItemClaim } from "@/contracts";
import { createDomTestHarness } from "../../ui/test/dom";

const now = "2026-09-26T08:00:00.000Z";
/** A writer, not a Space admin: claims coordinate work, and anyone who may change the task may take one over. */
const writerId = "33333333-3333-4333-8333-333333333333";
const claim: SpaceItemClaim = {
  id: "55555555-5555-4555-8555-555555555555",
  actor: { kind: "user", id: "44444444-4444-4444-8444-444444444444" },
  displayName: "Mira Beck",
  avatarHash: null,
  claimedAt: now,
};
const item: SpaceItem = {
  id: "Item01",
  spaceId: "Space1",
  columnId: null,
  title: "Planning",
  description: null,
  location: null,
  url: null,
  startsAt: null,
  endsAt: null,
  allDay: false,
  deadline: null,
  estimatedDurationMinutes: null,
  activeBlockerCount: 0,
  priority: null,
  recurrence: null,
  recurringEventId: null,
  recurrenceId: null,
  rank: "1024",
  completedAt: null,
  createdBy: writerId,
  createdAt: now,
  updatedAt: now,
  assignees: [],
  tags: [],
  claim,
};

const calls: string[] = [];
const release = mock(async (_input: { json: { claimId: string; force?: boolean } }) => {
  calls.push("release");
  return Response.json({ claim: null });
});
const claimTask = mock(async (_input: { json: { claimId: string } }) => {
  calls.push("claim");
  return Response.json({ claim: { ...claim, actor: { kind: "user", id: writerId } } });
});
const complete = mock(async (_input: { json: { completed: boolean; claimId?: string; force?: boolean } }) => {
  calls.push("complete");
  return Response.json({ ...item, claim: null, completedAt: now });
});
if (!isServer) {
  mock.module("@/api/client", () => ({
    apiClient: {
      [":id"]: { items: { [":itemId"]: { release: { $post: release }, claim: { $post: claimTask }, completed: { $post: complete } } } },
    },
  }));
}

/** Polls through microtasks until the condition holds; fails instead of waiting on wall-clock time. */
const waitFor = async (condition: () => boolean) => {
  for (let turn = 0; turn < 200 && !condition(); turn++) await Promise.resolve();
  expect(condition()).toBe(true);
};

/**
 * Clicks under a probe root and counts the computations the click handler created. In the browser the handler
 * runs without an owner, so each of them would leak and log Solid's development warning "computations created
 * outside a `createRoot` or `render` will never be disposed"; the tests run Solid's production build, which stays silent.
 */
const clickCreatedComputations = (target: HTMLElement) =>
  createRoot((dispose) => {
    target.click();
    const created = getOwner()?.owned?.length ?? 0;
    dispose();
    return created;
  });

describe("Spaces claim take-over", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("asks for confirmation with the take-over explanation before releasing somebody else's claim, without leaking computations", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    const { default: ItemDetailPanel } = await import("../src/frontend/[id]/_components/detail/ItemDetailPanel");
    const dispose = render(
      () =>
        createComponent(ItemDetailPanel, {
          item,
          columns: [],
          tags: [],
          wormholes: [],
          spaceId: item.spaceId,
          baseUrl: "/app/spaces/Space1",
          currentUserId: writerId,
          initialCommentsPage: { items: [], page: 1, perPage: 50, total: 0, hasNext: false },
          commentTarget: { itemId: item.id, recurrenceId: null },
          recurringContext: null,
          canWrite: true,
          mailIntegrationAvailable: false,
          scrollPreserveKey: "test-detail",
        }),
      dom.root,
    );
    const takeOver = () => dom.root.querySelector<HTMLButtonElement>('[data-spaces-claim-action="take-over"]')!;
    const dialog = () => dom.document.querySelector<HTMLDialogElement>('dialog[aria-label="Take over task"]');
    const dialogButton = (label: string) =>
      [...(dialog()?.querySelectorAll<HTMLButtonElement>("footer button") ?? [])].find((button) => button.textContent === label);

    expect(dom.root.textContent).not.toContain("Take over releases the claim");

    expect(clickCreatedComputations(takeOver())).toBe(0);
    await waitFor(() => dialog() !== null);
    expect(dialog()!.textContent).toContain("Take over releases the claim of Mira Beck and marks you as working on it.");
    dialogButton("Cancel")!.click();
    await waitFor(() => takeOver().getAttribute("aria-busy") !== "true");
    expect(calls).toEqual([]);

    expect(clickCreatedComputations(takeOver())).toBe(0);
    await waitFor(() => dialogButton("Take over") !== undefined);
    dialogButton("Take over")!.click();
    await waitFor(() => calls.length === 2);
    expect(calls).toEqual(["release", "claim"]);
    expect(release.mock.calls[0]![0].json).toEqual({ claimId: claim.id, force: true });
    await waitFor(() => dom.document.body.textContent?.includes("Took over from Mira Beck") === true);

    dispose();
    dom.cleanup();
  });

  test("completing somebody else's claimed task asks once, and takes the claim over in the same request", async () => {
    calls.splice(0);
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    const { default: ItemDetailPanel } = await import("../src/frontend/[id]/_components/detail/ItemDetailPanel");
    const dispose = render(
      () =>
        createComponent(ItemDetailPanel, {
          item,
          columns: [],
          tags: [],
          wormholes: [],
          spaceId: item.spaceId,
          baseUrl: "/app/spaces/Space1",
          currentUserId: writerId,
          initialCommentsPage: { items: [], page: 1, perPage: 50, total: 0, hasNext: false },
          commentTarget: { itemId: item.id, recurrenceId: null },
          recurringContext: null,
          canWrite: true,
          mailIntegrationAvailable: false,
          scrollPreserveKey: "test-detail",
        }),
      dom.root,
    );
    const completeButton = () =>
      [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Mark complete")!;
    const dialog = () => dom.document.querySelector<HTMLDialogElement>('dialog[aria-label="Take over task"]');
    const dialogButton = (label: string) =>
      [...(dialog()?.querySelectorAll<HTMLButtonElement>("footer button") ?? [])].find((button) => button.textContent === label);

    completeButton().click();
    await waitFor(() => dialog() !== null);
    expect(dialog()!.textContent).toContain("Claimed by Mira Beck – take over and complete?");
    dialogButton("Cancel")!.click();
    await waitFor(() => dialog() === null);
    expect(calls).toEqual([]);

    // The panel reloads the Space data once the completion is saved; the test ends after that, not before.
    const { SPACES_DATA_INVALIDATED_EVENT } = await import("../src/frontend/[id]/_components/workspace/workspace-events");
    let reloaded = false;
    dom.window.addEventListener(SPACES_DATA_INVALIDATED_EVENT, () => {
      reloaded = true;
    });
    completeButton().click();
    await waitFor(() => dialogButton("Take over and complete") !== undefined);
    dialogButton("Take over and complete")!.click();
    await waitFor(() => reloaded);
    expect(calls).toEqual(["complete"]);
    expect(complete.mock.calls[0]![0].json).toEqual({ completed: true, claimId: claim.id, force: true });

    dispose();
    dom.cleanup();
  });

  test("runs the shown claim action on click without reading the caller's prop expressions", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    const { default: ClaimButton } = await import("../src/frontend/[id]/_components/shared/claim/ClaimButton");
    const handled: string[] = [];
    // Shaped like the getters Solid compiles for `canTakeOver={a && b}` or `claim={x ? y : null}`: every read creates a memo.
    const dispose = render(
      () =>
        [false, true].map((compact) =>
          createComponent(ClaimButton, {
            get claim() {
              return createMemo(() => true)() ? claim : null;
            },
            get currentUserId() {
              return createMemo(() => writerId)();
            },
            get canTakeOver() {
              return createMemo(() => true)() && true;
            },
            compact,
            onClaim: () => handled.push("claim"),
            onRelease: () => handled.push("release"),
            onTakeOver: () => handled.push(compact ? "compact take-over" : "take-over"),
          }),
        ),
      dom.root,
    );

    const buttons = [...dom.root.querySelectorAll<HTMLButtonElement>('[data-spaces-claim-action="take-over"]')];
    expect(buttons).toHaveLength(2);
    expect(buttons.map(clickCreatedComputations)).toEqual([0, 0]);
    expect(handled).toEqual(["take-over", "compact take-over"]);

    dispose();
    dom.cleanup();
  });
});
