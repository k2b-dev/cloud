import { describe, expect, mock, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import type { SpaceItem, SpaceWormhole } from "@/contracts";
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

const bucket = (columnId: string, label: string, items: SpaceItem[], pages = { totalPages: 1, total: items.length }) => ({
  key: `column:${columnId}`,
  label,
  color: null,
  kind: "column" as const,
  columnId,
  isDone: false,
  items,
  page: 1,
  ...pages,
});

type MoveRequest = { itemId: string; json: { columnId: string } & Record<string, unknown> };
const moves: MoveRequest[] = [];
const pending = () => new Promise<Response>(() => {});
// Moves stay pending unless a test answers them, so the optimistic order is what the board shows.
let answerMove: (request: MoveRequest) => Promise<Response> = pending;
// Canonical refreshes stay pending unless a test answers them with the columns the server holds.
let answerFilter: (columnId: string) => Promise<Response> = pending;
if (!isServer) {
  mock.module("@/api/client", () => ({
    apiClient: {
      [":id"]: {
        items: {
          filter: { $post: (request: { json: { columnIds?: string[] } }) => answerFilter(request.json.columnIds?.[0] ?? "") },
          [":itemId"]: {
            move: {
              $post: (request: { param: { itemId: string }; json: MoveRequest["json"] }) => {
                const move = { itemId: request.param.itemId, json: request.json };
                moves.push(move);
                return answerMove(move);
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

/** Renders the board over the three columns Open, Review, and Later with a fixed layout and pointer helpers. */
const renderBoard = async (initialBuckets: ReturnType<typeof bucket>[], wormholes: SpaceWormhole[] = []) => {
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
        initialBuckets,
        pageSize: 30,
        canWrite: true,
        currentUserId: "77777777-7777-4777-8777-777777777777",
        wormholes,
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
  const handleOf = (itemId: string) =>
    dom.document.querySelector(`[data-item-id="${itemId}"]`)?.closest("article")?.querySelector("[data-dnd-card-handle]") ?? null;
  /** Drags a card to `y` in `column`, releases it, and waits until the answered move has settled. */
  const drop = async (itemId: string, column: number, y: number) => {
    const card = dom.document.querySelector(`[data-item-id="${itemId}"]`)!.closest<HTMLElement>("article")!;
    const sourceColumn = Array.from(dom.document.querySelectorAll(COLUMN_BODY)).indexOf(card.closest(COLUMN_BODY)!);
    const sent = moves.length;
    pointer("pointerdown", handleOf(itemId)!, columnX(sourceColumn), cardCenter(Number(card.dataset.cardIndex)));
    await moveTo(column, y);
    pointer("pointerup", dom.window as unknown as EventTarget, columnX(column), y);
    // The handle returns once the answered move has settled and the board accepts the next drag.
    for (let attempt = 0; attempt < 20 && (moves.length === sent || !handleOf(itemId)); attempt++) {
      await flush();
    }
    expect(moves.length).toBe(sent + 1);
    expect(handleOf(itemId)).not.toBeNull();
  };
  return { dom, dispose, pointer, moveTo, slots, drop };
};

describe("Spaces Kanban drop indicator", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("marks the exact landing gap at column top, between cards, at the bottom, in empty columns, and rings the hovered wormhole", async () => {
    moves.length = 0;
    const { dom, dispose, pointer, moveTo, slots } = await renderBoard(
      [
        bucket("Col001", "Open", [
          item("A", "Col001", "1024"),
          item("B", "Col001", "2048"),
          item("C", "Col001", "3072"),
          item("D", "Col001", "4096"),
        ]),
        bucket("Col002", "Review", [item("X", "Col002", "1024"), item("Y", "Col002", "2048")]),
        bucket("Col003", "Later", []),
      ],
      [
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
    );

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
    expect(moves).toEqual([{ itemId: "A", json: { columnId: "Col001", afterItemId: "C", completed: false } }]);
    expect(slots()).toEqual(["Open: B C A D", "Review: X Y", "Later: empty"]);

    dispose();
    dom.cleanup();
  });

  test("sends the card a drop lands next to instead of a rank, also below the last loaded card of a paged column", async () => {
    moves.length = 0;
    answerMove = async ({ itemId, json }) => Response.json(item(itemId, json.columnId, "0"));
    // Open shows its first page only: E and F exist on the server but are not loaded.
    const { dom, dispose, slots, drop } = await renderBoard([
      bucket(
        "Col001",
        "Open",
        [item("A", "Col001", "1024"), item("B", "Col001", "2048"), item("C", "Col001", "3072"), item("D", "Col001", "4096")],
        { totalPages: 2, total: 6 },
      ),
      bucket("Col002", "Review", [item("X", "Col002", "1024"), item("Y", "Col002", "2048"), item("Z", "Col002", "3072")]),
      bucket("Col003", "Later", []),
    ]);
    // Unmounting aborts the pending canonical refreshes, which the board reports after the DOM is gone.
    const { prompts } = await import("@k2b/ui");
    const errors = spyOn(prompts, "error").mockResolvedValue(undefined);

    await drop("X", 0, cardCenter(0) - 10);
    expect(slots()).toEqual(["Open: X A B C D", "Review: Y Z", "Later: empty"]);
    await drop("Y", 0, cardCenter(1) + 10);
    expect(slots()).toEqual(["Open: X A Y B C D", "Review: Z", "Later: empty"]);
    await drop("Z", 0, cardCenter(5) + 40);
    expect(slots()).toEqual(["Open: X A Y B C D Z", "Review: empty", "Later: empty"]);
    await drop("B", 2, 300);
    expect(slots()).toEqual(["Open: X A Y C D Z", "Review: empty", "Later: B"]);
    await drop("X", 0, cardCenter(5) + 40);
    expect(slots()).toEqual(["Open: A Y C D Z X", "Review: empty", "Later: B"]);

    expect(moves).toEqual([
      { itemId: "X", json: { columnId: "Col001", beforeItemId: "A", completed: false } },
      { itemId: "Y", json: { columnId: "Col001", afterItemId: "A", completed: false } },
      { itemId: "Z", json: { columnId: "Col001", afterItemId: "D", completed: false } },
      { itemId: "B", json: { columnId: "Col003", completed: false } },
      { itemId: "X", json: { columnId: "Col001", afterItemId: "Z", completed: false } },
    ]);
    expect(errors).not.toHaveBeenCalled();

    dispose();
    await flush();
    errors.mockRestore();
    dom.cleanup();
  });

  test("shows the columns Spaces holds after a rejected move, so the retry names a current neighbor", async () => {
    moves.length = 0;
    // What Spaces holds. Someone else has already moved C to Later; this board has not heard of it yet.
    const server: Record<string, SpaceItem[]> = {
      Col001: [item("A", "Col001", "1024"), item("B", "Col001", "2048")],
      Col002: [item("X", "Col002", "1024"), item("Y", "Col002", "2048")],
      Col003: [item("C", "Col003", "1024")],
    };
    answerFilter = async (columnId) => {
      const items = server[columnId] ?? [];
      return Response.json({ items, total: items.length, page: 1, pageSize: 30, totalPages: 1 });
    };
    answerMove = async ({ itemId, json }) => {
      if (json.afterItemId === "C")
        return Response.json({ message: "The neighboring item is no longer in the target column; reload and try again" }, { status: 409 });
      const moved = item(itemId, json.columnId, "3072");
      for (const columnId of Object.keys(server)) server[columnId] = server[columnId]!.filter((entry) => entry.id !== itemId);
      server[json.columnId]!.push(moved);
      return Response.json(moved);
    };
    const { dom, dispose, slots, drop } = await renderBoard([
      bucket("Col001", "Open", [item("A", "Col001", "1024"), item("B", "Col001", "2048"), item("C", "Col001", "3072")]),
      bucket("Col002", "Review", [item("X", "Col002", "1024"), item("Y", "Col002", "2048")]),
      bucket("Col003", "Later", []),
    ]);
    const { prompts } = await import("@k2b/ui");
    const errors = spyOn(prompts, "error").mockResolvedValue(undefined);
    const settle = async (expected: string[]) => {
      for (let attempt = 0; attempt < 20 && JSON.stringify(slots()) !== JSON.stringify(expected); attempt++) await flush();
      expect(slots()).toEqual(expected);
    };

    await drop("Y", 0, cardCenter(2) + 10);
    expect(moves.at(-1)).toEqual({ itemId: "Y", json: { columnId: "Col001", afterItemId: "C", completed: false } });
    expect(errors).toHaveBeenCalledWith("The neighboring item is no longer in the target column; reload and try again");
    await settle(["Open: A B", "Review: X Y", "Later: C"]);

    await drop("Y", 0, cardCenter(1) + 10);
    expect(moves.at(-1)).toEqual({ itemId: "Y", json: { columnId: "Col001", afterItemId: "B", completed: false } });
    await settle(["Open: A B Y", "Review: X", "Later: C"]);
    expect(errors).toHaveBeenCalledTimes(1);

    answerFilter = pending;
    dispose();
    await flush();
    errors.mockRestore();
    dom.cleanup();
  });
});
