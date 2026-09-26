import { describe, expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import type { SpaceItem } from "@/contracts";
import { createDomTestHarness } from "../../ui/test/dom";

const SPACE_ID = "Space1";
const NOW = "2026-09-26T10:00:00.000Z";
const item = (id: string, columnId: string, rank: string): SpaceItem => ({
  id,
  spaceId: SPACE_ID,
  columnId,
  title: id,
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
  rank,
  completedAt: null,
  createdBy: null,
  createdAt: NOW,
  updatedAt: NOW,
  assignees: [],
  tags: [],
  claim: null,
});

const bucket = (columnId: string, label: string, items: SpaceItem[]) => ({
  key: `column:${columnId}`,
  label,
  color: null,
  kind: "column" as const,
  columnId,
  isDone: false,
  items,
  page: 1,
  totalPages: 1,
  total: items.length,
});

const moves: Array<{ itemId: string; columnId: string; rank: string }> = [];
if (!isServer) {
  mock.module("@/api/client", () => ({
    apiClient: {
      [":id"]: {
        items: {
          [":itemId"]: {
            move: {
              // Stays pending so the optimistic order is what the board shows.
              $post: ({ param, json }: { param: { itemId: string }; json: { columnId: string; rank: string } }) => {
                moves.push({ itemId: param.itemId, columnId: json.columnId, rank: json.rank });
                return new Promise<Response>(() => {});
              },
            },
          },
        },
      },
    },
  }));
}

// happy-dom has no layout: give every column body and card a fixed box so drop targets resolve like in a browser.
const COLUMN_BODY = '[data-scroll-preserve^="spaces-kanban-column-"]';
const CARD_TOP = 10;
const CARD_HEIGHT = 50;
const CARD_STRIDE = 60;
const COLUMN_STRIDE = 300;
const cardCenter = (index: number) => CARD_TOP + index * CARD_STRIDE + CARD_HEIGHT / 2;
const columnX = (column: number) => column * COLUMN_STRIDE + 140;
const box = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, x: left, y: top, right: left + width, bottom: top + height, toJSON: () => ({}) }) as DOMRect;

const WORMHOLE_TARGET = '[title^="Move item to"]';

const layOut = (document: Document) => {
  const HTMLElementPrototype = document.defaultView!.HTMLElement.prototype;
  HTMLElementPrototype.getBoundingClientRect = function (this: HTMLElement) {
    // The wormhole target sits right of the three columns.
    if (this.matches(WORMHOLE_TARGET)) return box(3 * COLUMN_STRIDE, 0, 280, 144);
    const body = this.closest<HTMLElement>(COLUMN_BODY);
    if (!body) return box(0, 0, 0, 0);
    const column = Array.from(document.querySelectorAll(COLUMN_BODY)).indexOf(body);
    if (this === body) return box(column * COLUMN_STRIDE, 0, 280, 1000);
    if (this.dataset.cardIndex === undefined) return box(0, 0, 0, 0);
    return box(column * COLUMN_STRIDE + 10, CARD_TOP + Number(this.dataset.cardIndex) * CARD_STRIDE, 260, CARD_HEIGHT);
  };
};

/** Reads one column as its card ids in order, with `|` for the insertion line and `empty` for the empty state. */
const columnSlots = (document: Document, label: string) => {
  const section = Array.from(document.querySelectorAll("section")).find((entry) => entry.querySelector("h3")?.textContent === label)!;
  const body = section.querySelector<HTMLElement>(COLUMN_BODY)!;
  return Array.from(body.children)
    .map((child) => {
      if (child.hasAttribute("data-spaces-kanban-drop-indicator")) return "|";
      if (child.hasAttribute("data-card-index")) return child.querySelector<HTMLElement>("[data-item-id]")!.dataset.itemId;
      return child.textContent === "No items" ? "empty" : null;
    })
    .filter(Boolean)
    .join(" ");
};

const flush = async () => {
  for (let step = 0; step < 5; step++) await Promise.resolve();
};

describe("Spaces Kanban drop indicator", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("marks the exact landing gap at column top, between cards, at the bottom, in empty columns, and rings the hovered wormhole", async () => {
    moves.length = 0;
    const dom = createDomTestHarness();
    const { default: KanbanBoard } = await import("../src/frontend/[id]/_components/kanban/KanbanBoard");
    const dispose = render(
      () =>
        createComponent(KanbanBoard, {
          spaceId: SPACE_ID,
          baseUrl: `/app/spaces/${SPACE_ID}?view=kanban`,
          columns: [
            { id: "Col001", spaceId: SPACE_ID, name: "Open", color: null, rank: "1024", isDone: false },
            { id: "Col002", spaceId: SPACE_ID, name: "Review", color: null, rank: "2048", isDone: false },
            { id: "Col003", spaceId: SPACE_ID, name: "Later", color: null, rank: "3072", isDone: false },
          ],
          tags: [],
          selectedItemId: "",
          initialBuckets: [
            bucket("Col001", "Open", [
              item("A", "Col001", "1024"),
              item("B", "Col001", "2048"),
              item("C", "Col001", "3072"),
              item("D", "Col001", "4096"),
            ]),
            bucket("Col002", "Review", [item("X", "Col002", "1024"), item("Y", "Col002", "2048")]),
            bucket("Col003", "Later", []),
          ],
          pageSize: 30,
          canWrite: true,
          currentUserId: "77777777-7777-4777-8777-777777777777",
          wormholes: [
            {
              id: "Worm01",
              sourceSpaceId: SPACE_ID,
              color: "#8b5cf6",
              rank: "1024",
              target: {
                spaceId: "Space2",
                spaceName: "Archive",
                spaceColor: "#8b5cf6",
                columnId: "Col009",
                columnName: "Inbox",
                columnIsDone: false,
              },
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
        }),
      dom.root,
    );
    layOut(dom.document);

    const pointer = (type: string, target: EventTarget, x: number, y: number) =>
      target.dispatchEvent(
        new dom.window.PointerEvent(type, {
          bubbles: true,
          button: 0,
          clientX: x,
          clientY: y,
          isPrimary: true,
          pointerId: 1,
          pointerType: "mouse",
        }) as unknown as Event,
      );
    const moveTo = async (column: number, y: number) => {
      pointer("pointermove", dom.window as unknown as EventTarget, columnX(column), y);
      await flush();
    };
    const slots = () => ["Open", "Review", "Later"].map((label) => `${label}: ${columnSlots(dom.document, label)}`);

    const handle = dom.document.querySelector('[data-item-id="A"]')!.closest("article")!.querySelector("[data-dnd-card-handle]")!;
    pointer("pointerdown", handle, columnX(0), cardCenter(0));

    // Over its own slot the drop changes nothing, so the dimmed card is the only marker.
    await moveTo(0, cardCenter(0) + 10);
    expect(slots()).toEqual(["Open: A B C D", "Review: X Y", "Later: empty"]);

    // Lower half of C in the same column: the card lands between C and D, not above C.
    await moveTo(0, cardCenter(2) + 10);
    expect(slots()).toEqual(["Open: A B C | D", "Review: X Y", "Later: empty"]);

    // Below the last card of the source column.
    await moveTo(0, cardCenter(3) + 40);
    expect(slots()).toEqual(["Open: A B C D |", "Review: X Y", "Later: empty"]);

    // Top of another column, between its cards, and below its last card.
    await moveTo(1, cardCenter(0) - 10);
    expect(slots()).toEqual(["Open: A B C D", "Review: | X Y", "Later: empty"]);
    await moveTo(1, cardCenter(0) + 10);
    expect(slots()).toEqual(["Open: A B C D", "Review: X | Y", "Later: empty"]);
    await moveTo(1, cardCenter(1) + 40);
    expect(slots()).toEqual(["Open: A B C D", "Review: X Y |", "Later: empty"]);

    // An empty column marks the top, where the card will appear.
    await moveTo(2, 300);
    expect(slots()).toEqual(["Open: A B C D", "Review: X Y", "Later: | empty"]);

    // The line is painted with the app accent; `--ui-focus` is a box-shadow and cannot color it.
    const line = dom.document.querySelector("[data-spaces-kanban-drop-indicator]")!;
    expect(line.getAttribute("aria-hidden")).toBe("true");
    expect(line.outerHTML).toContain("bg-[var(--ui-app-accent-border)]");
    expect(line.outerHTML).not.toContain("--ui-focus");

    // The active wormhole ring is `--ui-focus` as its own box-shadow layer; nested inside another shadow it drops the whole shadow.
    const wormhole = dom.document.querySelector<HTMLElement>(WORMHOLE_TARGET)!;
    expect(wormhole.style.boxShadow).not.toContain("--ui-focus");
    await moveTo(3, 70);
    expect(slots()).toEqual(["Open: A B C D", "Review: X Y", "Later: empty"]);
    expect(wormhole.style.boxShadow).toStartWith("var(--ui-focus),");

    // Dropping where the line points puts the card exactly there.
    await moveTo(0, cardCenter(2) + 10);
    expect(slots()[0]).toBe("Open: A B C | D");
    pointer("pointerup", dom.window as unknown as EventTarget, columnX(0), cardCenter(2) + 10);
    await flush();
    expect(moves.map(({ itemId, columnId }) => ({ itemId, columnId }))).toEqual([{ itemId: "A", columnId: "Col001" }]);
    expect(BigInt(moves[0]!.rank)).toBeGreaterThan(3072n);
    expect(BigInt(moves[0]!.rank)).toBeLessThan(4096n);
    expect(slots()).toEqual(["Open: B C A D", "Review: X Y", "Later: empty"]);

    dispose();
    dom.cleanup();
  });
});
