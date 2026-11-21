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
type TransferRequest = { itemId: string; wormholeId: string; json: Record<string, unknown> };
const transfers: TransferRequest[] = [];
let answerTransfer: (request: TransferRequest) => Promise<Response> = pending;
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
            wormholes: {
              [":wormholeId"]: {
                $post: (request: { param: { itemId: string; wormholeId: string }; json: TransferRequest["json"] }) => {
                  const transfer = { itemId: request.param.itemId, wormholeId: request.param.wormholeId, json: request.json };
                  transfers.push(transfer);
                  return answerTransfer(transfer);
                },
              },
            },
          },
        },
      },
    },
  }));
}

/** Reads one column as its card ids in order, or `empty`. */
const columnSlots = (document: Document, label: string) => {
  const section = Array.from(document.querySelectorAll("section[data-spaces-kanban-column]")).find(
    (entry) => entry.querySelector("h3")?.textContent === label,
  )!;
  const ids = Array.from(section.querySelectorAll<HTMLElement>("a[data-spaces-kanban-card]"), (card) => card.dataset.itemId);
  return ids.length ? ids.join(" ") : "empty";
};

const flush = async () => {
  for (let step = 0; step < 5; step++) await Promise.resolve();
};

const CURRENT_USER = "77777777-7777-4777-8777-777777777777";
const archiveWormhole: SpaceWormhole = {
  id: "Worm01",
  sourceSpaceId: SPACE_ID,
  color: "#8b5cf6",
  rank: "1024",
  target: { spaceId: "Space2", spaceName: "Archive", spaceColor: "#8b5cf6", columnId: "Col009", columnName: "Inbox", columnIsDone: false },
  createdAt: NOW,
  updatedAt: NOW,
};

/** Renders the board over the three columns Open, Review, and Later with keyboard and menu helpers. */
const renderBoard = async (initialBuckets: ReturnType<typeof bucket>[], wormholes: SpaceWormhole[] = []) => {
  const dom = createDomTestHarness();
  const { default: KanbanBoard } = await import("../src/frontend/[id]/_components/kanban/KanbanBoard");
  const { defaultFilter } = await import("../src/frontend/[id]/_components/filter/types");
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
        filter: defaultFilter,
        folded: new Set<string>(),
        onToggleFolded: () => undefined,
        selectedItemId: "",
        initialBuckets,
        pageSize: 30,
        canWrite: true,
        currentUserId: CURRENT_USER,
        wormholes,
      }),
    dom.root,
  );
  const key = (target: Element, value: string) =>
    target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }) as unknown as Event);
  const slots = () => ["Open", "Review", "Later"].map((label) => `${label}: ${columnSlots(dom.document, label)}`);
  const columnOf = (itemId: string) =>
    ["Open", "Review", "Later"].findIndex((label) => columnSlots(dom.document, label).split(" ").includes(itemId));
  const gripOf = (itemId: string) => dom.document.querySelector<HTMLButtonElement>(`[data-sortable-handle="${itemId}"]`);
  /**
   * Moves a card with the shared engine's keyboard lift: Space lifts, the arrows choose the column, Home and the
   * arrows choose `index`, its place once moved, and Enter drops. Waits until the answered move has settled.
   */
  const drop = async (itemId: string, column: number, index: number) => {
    const sent = moves.length;
    const grip = gripOf(itemId)!;
    grip.focus();
    key(grip, " ");
    for (let attempt = 0; attempt < 20 && !dom.document.querySelector("[data-sortable-target], [data-sortable-dragging]"); attempt++)
      await flush();
    const from = columnOf(itemId);
    for (let step = 0; step < Math.abs(column - from); step++) key(grip, column > from ? "ArrowRight" : "ArrowLeft");
    key(grip, "Home");
    for (let step = 0; step < index; step++) key(grip, "ArrowDown");
    key(grip, "Enter");
    for (let attempt = 0; attempt < 40 && (moves.length === sent || !gripOf(itemId)); attempt++) await flush();
    expect(moves.length).toBe(sent + 1);
    expect(gripOf(itemId)).not.toBeNull();
  };
  /** Sends a card through the wormhole from its menu: "Move to another Space" and the wormhole's entry. */
  const dropOnWormhole = async (itemId: string) => {
    const click = async (find: () => HTMLElement | null | undefined) => {
      for (let attempt = 0; attempt < 20 && !find(); attempt++) await flush();
      find()!.click();
      await flush();
    };
    const item = (label: string) =>
      [...dom.document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((entry) => entry.textContent?.includes(label));
    await click(() => dom.document.querySelector<HTMLElement>(`[data-spaces-kanban-card-menu="${itemId}"]`));
    await click(() => item("Move to another Space"));
    await click(() => item("Archive · Inbox"));
  };
  return { dom, dispose, slots, drop, dropOnWormhole };
};

describe("Spaces Kanban moves", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("a transfer ends the claim: one question takes someone else's over, the holder's own ends without one", async () => {
    transfers.length = 0;
    answerTransfer = async ({ itemId }) =>
      Response.json({
        item: { ...item(itemId, "Col009", "1024"), spaceId: "Space2" },
        destination: archiveWormhole.target,
        removedTagCount: 0,
        removedAssigneeCount: 0,
        removedDependencyCount: 0,
      });
    const claim = (id: string, actorId: string, displayName: string) => ({
      id,
      actor: { kind: "user" as const, id: actorId },
      displayName,
      avatarHash: null,
      claimedAt: NOW,
    });
    const foreign = claim("55555555-5555-4555-8555-555555555555", "44444444-4444-4444-8444-444444444444", "Mira Beck");
    const own = claim("66666666-6666-4666-8666-666666666666", CURRENT_USER, "Me");
    const { dom, dispose, slots, dropOnWormhole } = await renderBoard(
      [
        bucket("Col001", "Open", [
          { ...item("A", "Col001", "1024"), claim: foreign },
          { ...item("B", "Col001", "2048"), claim: own },
        ]),
        bucket("Col002", "Review", []),
        bucket("Col003", "Later", []),
      ],
      [archiveWormhole],
    );
    const { toast } = await import("@k2b/ui");
    const errors = spyOn(toast, "error").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
    const successes = spyOn(toast, "success").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
    const dialog = () => dom.document.querySelector<HTMLDialogElement>('dialog[aria-label="Take over task"]');
    const dialogButton = (label: string) =>
      [...(dialog()?.querySelectorAll<HTMLButtonElement>("footer button") ?? [])].find((button) => button.textContent === label);
    const settle = async (condition: () => boolean) => {
      for (let attempt = 0; attempt < 50 && !condition(); attempt++) await flush();
      expect(condition(), condition.toString()).toBe(true);
    };

    // Cancel: nothing is sent, and the card stays where it was.
    await dropOnWormhole("A");
    await settle(() => dialogButton("Cancel") !== undefined);
    expect(dialog()!.textContent).toContain("Claimed by Mira Beck – take over and move?");
    dialogButton("Cancel")!.click();
    await settle(() => dialog() === null);
    await flush();
    expect(transfers).toEqual([]);
    expect(slots()).toEqual(["Open: A B", "Review: empty", "Later: empty"]);

    // Confirm: the transfer takes over the exact claim the board showed.
    await dropOnWormhole("A");
    await settle(() => dialogButton("Take over and move") !== undefined);
    dialogButton("Take over and move")!.click();
    await settle(() => transfers.length === 1);
    expect(transfers[0]).toEqual({ itemId: "A", wormholeId: "Worm01", json: { claimId: foreign.id, force: true } });
    await settle(() => slots()[0] === "Open: B");

    // Removing the card is optimistic. Wait for the answered transfer before starting another drag.
    await settle(() => successes.mock.calls.length === 1);

    // The holder's own claim ends without a question.
    await dropOnWormhole("B");
    await settle(() => transfers.length === 2);
    expect(dialog()).toBeNull();
    expect(transfers[1]).toEqual({ itemId: "B", wormholeId: "Worm01", json: { claimId: own.id } });
    await settle(() => successes.mock.calls.length === 2);
    expect(errors).not.toHaveBeenCalled();

    answerTransfer = pending;
    dispose();
    await flush();
    errors.mockRestore();
    successes.mockRestore();
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
    const { toast } = await import("@k2b/ui");
    const errors = spyOn(toast, "error").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));

    await drop("X", 0, 0);
    expect(slots()).toEqual(["Open: X A B C D", "Review: Y Z", "Later: empty"]);
    await drop("Y", 0, 2);
    expect(slots()).toEqual(["Open: X A Y B C D", "Review: Z", "Later: empty"]);
    await drop("Z", 0, 6);
    expect(slots()).toEqual(["Open: X A Y B C D Z", "Review: empty", "Later: empty"]);
    await drop("B", 2, 0);
    expect(slots()).toEqual(["Open: X A Y C D Z", "Review: empty", "Later: B"]);
    await drop("X", 0, 5);
    expect(slots()).toEqual(["Open: A Y C D Z X", "Review: empty", "Later: B"]);

    expect(moves).toEqual([
      { itemId: "X", json: { columnId: "Col001", beforeItemId: "A" } },
      { itemId: "Y", json: { columnId: "Col001", afterItemId: "A" } },
      { itemId: "Z", json: { columnId: "Col001", afterItemId: "D" } },
      { itemId: "B", json: { columnId: "Col003" } },
      { itemId: "X", json: { columnId: "Col001", afterItemId: "Z" } },
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
    const { toast } = await import("@k2b/ui");
    const errors = spyOn(toast, "error").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
    const settle = async (expected: string[]) => {
      for (let attempt = 0; attempt < 20 && JSON.stringify(slots()) !== JSON.stringify(expected); attempt++) await flush();
      expect(slots()).toEqual(expected);
    };

    await drop("Y", 0, 3);
    expect(moves.at(-1)).toEqual({ itemId: "Y", json: { columnId: "Col001", afterItemId: "C" } });
    for (let attempt = 0; attempt < 40 && errors.mock.calls.length === 0; attempt++) await flush();
    expect(errors).toHaveBeenCalledWith("The neighboring item is no longer in the target column; reload and try again");
    await settle(["Open: A B", "Review: X Y", "Later: C"]);

    await drop("Y", 0, 2);
    expect(moves.at(-1)).toEqual({ itemId: "Y", json: { columnId: "Col001", afterItemId: "B" } });
    await settle(["Open: A B Y", "Review: X", "Later: C"]);
    expect(errors).toHaveBeenCalledTimes(1);

    answerFilter = pending;
    dispose();
    await flush();
    errors.mockRestore();
    dom.cleanup();
  });
});
