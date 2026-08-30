import { describe, expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import type { SpaceItem } from "@/contracts";
import { createDomTestHarness } from "../../ui/test/dom";

const USER_ID = "77777777-7777-4777-8777-777777777777";
const item = (id: string, columnId: string, title: string): SpaceItem => ({
  id,
  spaceId: "Space1",
  columnId,
  title,
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
  createdBy: null,
  createdAt: "2026-08-30T10:00:00.000Z",
  updatedAt: "2026-08-30T10:00:00.000Z",
  assignees: [],
  tags: [],
});

const first = item("Item01", "Col001", "First");
const second = item("Item02", "Col001", "Second");
const third = item("Item03", "Col002", "Third");
const calls: string[] = [];
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

if (!isServer) {
  mock.module("@/api/client", () => ({
    apiClient: {
      [":id"]: {
        items: {
          filter: {
            $post: async ({ json }: { json: { columnIds?: string[] } }) => {
              const items = json.columnIds?.[0] === "Col001" ? [first, second] : [third];
              return response({ items, page: 1, pageSize: 30, totalPages: 1, total: items.length });
            },
          },
          [":itemId"]: {
            $patch: async ({ param }: { param: { itemId: string } }) => {
              calls.push(`assign:${param.itemId}`);
              return response({ ...third, assignees: [{ id: USER_ID, displayName: "Valentin", avatarHash: null }] });
            },
            completed: {
              $post: async ({ param }: { param: { itemId: string } }) => {
                calls.push(`complete:${param.itemId}`);
                return response({ ...third, completedAt: "2026-08-30T12:00:00.000Z" });
              },
            },
          },
        },
      },
    },
  }));
}

const key = (target: EventTarget, value: string) => target.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true }));
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
};

describe("Spaces keyboard shortcuts", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("navigates Kanban spatially and applies actions only to the focused card", async () => {
    calls.length = 0;
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    const { default: KanbanBoard } = await import("../src/frontend/[id]/_components/kanban/KanbanBoard");
    const dispose = render(
      () =>
        createComponent(KanbanBoard, {
          spaceId: "Space1",
          baseUrl: "/app/spaces/Space1?view=kanban",
          columns: [
            { id: "Col001", spaceId: "Space1", name: "Open", color: null, rank: "1024", isDone: false },
            { id: "Col002", spaceId: "Space1", name: "Review", color: null, rank: "2048", isDone: false },
          ],
          tags: [],
          selectedItemId: "",
          initialBuckets: [
            {
              key: "column:Col001",
              label: "Open",
              color: null,
              kind: "column",
              columnId: "Col001",
              isDone: false,
              items: [first, second],
              page: 1,
              totalPages: 1,
              total: 2,
            },
            {
              key: "column:Col002",
              label: "Review",
              color: null,
              kind: "column",
              columnId: "Col002",
              isDone: false,
              items: [third],
              page: 1,
              totalPages: 1,
              total: 1,
            },
          ],
          pageSize: 30,
          canWrite: true,
          currentUserId: USER_ID,
          wormholes: [],
        }),
      dom.root,
    );

    const board = dom.root.querySelector<HTMLElement>('[role="region"][aria-label="Kanban"]')!;
    board.focus();
    key(board, "ArrowDown");
    expect((dom.document.activeElement as HTMLElement).dataset.itemId).toBe("Item01");
    key(dom.document.activeElement!, "ArrowDown");
    expect((dom.document.activeElement as HTMLElement).dataset.itemId).toBe("Item02");
    key(dom.document.activeElement!, "ArrowRight");
    expect((dom.document.activeElement as HTMLElement).dataset.itemId).toBe("Item03");

    key(dom.document.activeElement!, "m");
    await flush();
    key(dom.document.activeElement!, "d");
    await flush();
    expect(calls).toEqual(["assign:Item03", "complete:Item03"]);

    const input = dom.document.createElement("input");
    board.append(input);
    input.focus();
    key(input, "d");
    await flush();
    expect(calls).toEqual(["assign:Item03", "complete:Item03"]);

    dispose();
    dom.cleanup();
  });
});
