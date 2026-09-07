import { describe, expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import type { SpaceComment, SpaceItem } from "../src/contracts";

const now = "2026-09-07T10:00:00.000Z";
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
  createdBy: "user",
  createdAt: now,
  updatedAt: now,
  assignees: [],
  tags: [],
};
const comment = (id: string, content: string): SpaceComment => ({
  id,
  content,
  itemId: item.id,
  recurrenceId: null,
  userId: "user",
  userName: "Valentin",
  userAvatarHash: null,
  createdAt: now,
  updatedAt: now,
  canEdit: false,
  canDelete: false,
});
const page = (index: number, content: string) => ({
  items: [comment(`Com00${index}`, content)],
  page: index,
  perPage: 1,
  total: 2,
  hasNext: index === 1,
});
const flush = async () => {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
};

describe("Spaces live detail comments", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }
  test("refreshes every loaded comments page before acknowledgement without losing the real composer draft", async () => {
    const dom = createDomTestHarness();
    const requests: Array<{ page: number; signal?: AbortSignal; resolve: (response: Response) => void }> = [];
    mock.module("@/api/client", () => ({
      apiClient: {
        [":id"]: {
          items: {
            [":itemId"]: {
              comments: {
                page: {
                  $get: ({ query }: { query: { page: string } }, options?: { init?: { signal?: AbortSignal } }) =>
                    new Promise<Response>((resolve) => {
                      requests.push({ page: Number(query.page), signal: options?.init?.signal, resolve });
                    }),
                },
              },
            },
          },
        },
      },
    }));
    const { default: ItemDetailPanel } = await import("../src/frontend/[id]/_components/detail/ItemDetailPanel");
    const { invalidateSpacesData } = await import("../src/frontend/[id]/_components/workspace/workspace-events");
    const dispose = render(
      () =>
        createComponent(ItemDetailPanel, {
          item,
          columns: [],
          tags: [],
          wormholes: [],
          spaceId: item.spaceId,
          baseUrl: "/app/spaces/Space1",
          currentUserId: "user",
          initialCommentsPage: page(1, "Original comment"),
          commentTarget: { itemId: item.id, recurrenceId: null },
          recurringContext: null,
          canWrite: true,
          mailIntegrationAvailable: false,
          scrollPreserveKey: "test-detail",
        }),
      dom.root,
    );
    const composer = dom.root.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(composer).not.toBeNull();
    composer.value = "Unsent draft";
    composer.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    composer.focus();
    const earlier = [...dom.root.querySelectorAll("button")].find((button) => button.textContent?.includes("Load earlier comments"))!;
    earlier.click();
    await flush();
    expect(requests[0]?.page).toBe(2);
    requests[0]!.resolve(Response.json(page(2, "Older comment")));
    await flush();
    expect(dom.root.textContent).toContain("Older comment");
    let applied = false;
    const coverage = invalidateSpacesData(["detail"], "7-0", item.id).then(() => {
      applied = true;
    });
    await flush();
    expect(requests[1]?.page).toBe(1);
    requests[1]!.resolve(Response.json(page(1, "Updated comment")));
    await flush();
    expect(applied).toBe(false);
    expect(requests[2]?.page).toBe(2);
    expect(dom.root.textContent).toContain("Original comment");
    requests[2]!.resolve(Response.json(page(2, "Updated older comment")));
    await coverage;
    await flush();
    expect(dom.root.textContent).toContain("Updated comment");
    expect(dom.root.textContent).toContain("Updated older comment");
    expect(dom.root.querySelector("textarea")).toBe(composer);
    expect(composer.value).toBe("Unsent draft");
    expect(dom.document.activeElement).toBe(composer);
    const closingCoverage = invalidateSpacesData(["detail"], "8-0", item.id);
    await flush();
    dispose();
    await closingCoverage;
    expect(requests.at(-1)?.signal?.aborted).toBe(true);
    dom.cleanup();
  });
});
