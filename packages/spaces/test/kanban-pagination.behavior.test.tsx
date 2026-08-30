import { describe, expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import type { ItemListResult, SpaceItem } from "@/contracts";
import { createDomTestHarness } from "../../ui/test/dom";
import { invalidateSpacesData } from "../src/frontend/[id]/_components/workspace/workspace-events";

const SPACE_ID = "11111111-1111-4111-8111-111111111111";
const COLUMN_ID = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-08-10T10:00:00.000Z";

const item = (id: string, title: string): SpaceItem => ({
  id,
  spaceId: SPACE_ID,
  columnId: COLUMN_ID,
  title,
  description: null,
  location: null,
  url: null,
  startsAt: null,
  endsAt: null,
  allDay: false,
  deadline: null,
  priority: null,
  recurrence: null,
  recurringEventId: null,
  recurrenceId: null,
  rank: "1024",
  completedAt: null,
  createdBy: null,
  createdAt: NOW,
  updatedAt: NOW,
  assignees: [],
  tags: [],
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
};

const requests: Array<{ page: number; signal: AbortSignal; response: ReturnType<typeof deferred<Response>> }> = [];
if (!isServer) {
  mock.module("@/api/client", () => ({
    apiClient: {
      [":id"]: {
        items: {
          filter: {
            $post: ({ json }: { json: { page: number } }, options: { init: { signal: AbortSignal } }) => {
              const response = deferred<Response>();
              requests.push({ page: json.page, signal: options.init.signal, response });
              return response.promise;
            },
          },
        },
      },
    },
  }));
}

const response = (value: ItemListResult) =>
  new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("Spaces Kanban pagination", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("lets canonical view invalidation supersede load-more and atomically rebuild the loaded chain", async () => {
    requests.length = 0;
    const dom = createDomTestHarness();
    const { default: KanbanBoard } = await import("../src/frontend/[id]/_components/kanban/KanbanBoard");
    const initial = item("33333333-3333-4333-8333-333333333333", "Initial card");
    const dispose = render(
      () =>
        createComponent(KanbanBoard, {
          spaceId: SPACE_ID,
          baseUrl: `/app/spaces/${SPACE_ID}?view=kanban`,
          columns: [{ id: COLUMN_ID, spaceId: SPACE_ID, name: "Open", color: null, rank: "1024", isDone: false }],
          tags: [],
          selectedItemId: "",
          initialBuckets: [
            {
              key: `column:${COLUMN_ID}`,
              label: "Open",
              color: null,
              kind: "column",
              columnId: COLUMN_ID,
              isDone: false,
              items: [initial],
              page: 1,
              totalPages: 2,
              total: 2,
            },
          ],
          pageSize: 30,
          canWrite: false,
          currentUserId: "77777777-7777-4777-8777-777777777777",
          wormholes: [],
        }),
      dom.root,
    );

    dom.root.querySelector<HTMLButtonElement>('[aria-label="Load more items in Open"]')!.click();
    await flush();
    expect(requests.map((request) => request.page)).toEqual([2]);

    const coverage = invalidateSpacesData(["view"], "30-0");
    await flush();
    expect(requests[0]!.signal.aborted).toBe(true);
    expect(requests.map((request) => request.page)).toEqual([2, 1]);

    requests[0]!.response.resolve(
      response({ items: [item("44444444-4444-4444-8444-444444444444", "Stale card")], page: 2, pageSize: 30, totalPages: 2, total: 2 }),
    );
    requests[1]!.response.resolve(
      response({ items: [item("55555555-5555-4555-8555-555555555555", "Fresh card")], page: 1, pageSize: 30, totalPages: 1, total: 1 }),
    );
    await coverage;
    await flush();
    expect(dom.root.textContent).toContain("Fresh card");
    expect(dom.root.textContent).not.toContain("Initial card");
    expect(dom.root.textContent).not.toContain("Stale card");
    expect(dom.root.querySelector('[aria-label="Load more items in Open"]')).toBeNull();

    dispose();
    dom.cleanup();
  });
});
