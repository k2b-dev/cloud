import { describe, expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import type { SpaceItem, SpaceItemClaim } from "@/contracts";
import { createDomTestHarness } from "../../ui/test/dom";

const now = "2026-09-26T08:00:00.000Z";
const adminId = "33333333-3333-4333-8333-333333333333";
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
  createdBy: adminId,
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
  return Response.json({ claim: { ...claim, actor: { kind: "user", id: adminId } } });
});
if (!isServer) {
  mock.module("@/api/client", () => ({
    apiClient: { [":id"]: { items: { [":itemId"]: { release: { $post: release }, claim: { $post: claimTask } } } } },
  }));
}

/** Polls through microtasks until the condition holds; fails instead of waiting on wall-clock time. */
const waitFor = async (condition: () => boolean) => {
  for (let turn = 0; turn < 200 && !condition(); turn++) await Promise.resolve();
  expect(condition()).toBe(true);
};

describe("Spaces claim take-over", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("asks for confirmation with the take-over explanation before releasing somebody else's claim", async () => {
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
          currentUserId: adminId,
          initialCommentsPage: { items: [], page: 1, perPage: 50, total: 0, hasNext: false },
          commentTarget: { itemId: item.id, recurrenceId: null },
          recurringContext: null,
          canWrite: true,
          isAdmin: true,
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

    takeOver().click();
    await waitFor(() => dialog() !== null);
    expect(dialog()!.textContent).toContain("Take over releases the claim of Mira Beck and marks you as working on it.");
    dialogButton("Cancel")!.click();
    await waitFor(() => takeOver().getAttribute("aria-busy") !== "true");
    expect(calls).toEqual([]);

    takeOver().click();
    await waitFor(() => dialogButton("Take over") !== undefined);
    dialogButton("Take over")!.click();
    await waitFor(() => calls.length === 2);
    expect(calls).toEqual(["release", "claim"]);
    expect(release.mock.calls[0]![0].json).toEqual({ claimId: claim.id, force: true });
    await waitFor(() => dom.document.body.textContent?.includes("Took over from Mira Beck") === true);

    dispose();
    dom.cleanup();
  });
});
