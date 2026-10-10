import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../../../../ui/test/dom";
import type { SpaceColumn, SpaceItem } from "../../../../contracts";
import { COLLAPSE_MS, createLeavingItems, LEAVE_DELAY_MS } from "../shared/leaving";
import { SPACES_DATA_INVALIDATED_EVENT, type SpacesDataInvalidation } from "../workspace/workspace-events";

const domTest = isServer ? test.skip : test;
const USER = "33333333-3333-4333-8333-333333333333";
const columns: SpaceColumn[] = [
  { id: "Col001", spaceId: "Space1", name: "To Do", color: null, rank: "1024", isDone: false },
  { id: "Col002", spaceId: "Space1", name: "Doing", color: null, rank: "2048", isDone: false },
  { id: "Col009", spaceId: "Space1", name: "Done", color: null, rank: "9000", isDone: true },
];

const task = (id: string, title: string, columnId: string, rank: string): SpaceItem => ({
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
  rank,
  completedAt: null,
  createdBy: null,
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-01T10:00:00.000Z",
  assignees: [],
  tags: [],
  claim: null,
});

/** The server: completing moves a task to the done status, as Spaces does; moving sets status, rank, and completion. */
let server: Map<string, SpaceItem>;
let requests: { path: string; body: Record<string, unknown> }[];
let dom: DomTestHarness;
let dispose: (() => void) | undefined;
let fetchSpy: ReturnType<typeof spyOn> | undefined;

beforeEach(() => {
  server = new Map(
    [
      task("TaskA", "Draft agenda", "Col001", "1024"),
      task("TaskB", "Book room", "Col002", "2048"),
      task("TaskC", "Send invites", "Col002", "3072"),
    ].map((item) => [item.id, item]),
  );
  requests = [];
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  fetchSpy?.mockRestore();
  jest.useRealTimers();
  dom?.cleanup();
});

const order = (items: SpaceItem[]) =>
  items.sort(
    (a, b) =>
      Number(columns.find((c) => c.id === a.columnId)!.rank) - Number(columns.find((c) => c.id === b.columnId)!.rank) ||
      Number(a.rank) - Number(b.rank),
  );

/** Renders the list as the list route wires it, under a filter that shows open tasks or every task. */
const mount = async (status: "active" | "all") => {
  dom = createDomTestHarness();
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(input), "http://localhost/").pathname;
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        requests.push({ path, body });
        const id = path.split("/")[5]!;
        const current = server.get(id)!;
        const next = path.endsWith("/completed")
          ? {
              ...current,
              completedAt: body.completed ? "2026-10-10T09:00:00.000Z" : null,
              columnId: body.completed ? "Col009" : "Col001",
              rank: "99999",
            }
          : {
              ...current,
              columnId: String(body.columnId),
              rank: String(body.rank),
              completedAt: body.completed ? "2026-10-10T09:00:00.000Z" : null,
            };
        server.set(id, next);
        return Response.json(next);
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  const listed = () => order([...server.values()].filter((item) => status === "all" || !item.completedAt));
  const [items, setItems] = createSignal(listed());
  const refresh = (event: Event) =>
    (event as CustomEvent<SpacesDataInvalidation>).detail.cover(
      Promise.resolve().then(() => {
        setItems(listed());
      }),
    );
  window.addEventListener(SPACES_DATA_INVALIDATED_EVENT, refresh);
  const { default: ItemList } = await import("./ItemList");
  const disposeRender = render(() => {
    const leaving = createLeavingItems<SpaceItem>();
    return (
      <ItemList
        items={items()}
        columns={columns}
        tags={[]}
        spaceId="Space1"
        groupBy="none"
        baseUrl="/app/spaces/Space1"
        canWrite
        currentUserId={USER}
        leaving={leaving}
      />
    );
  }, dom.root);
  dispose = () => {
    disposeRender();
    window.removeEventListener(SPACES_DATA_INVALIDATED_EVENT, refresh);
  };
};

/** Lets the requests, the refresh, and the reactions to them run; the clock stands still. */
const settle = async () => {
  for (let step = 0; step < 50; step += 1) await Promise.resolve();
};
const box = (title: string) => dom.root.querySelector<HTMLInputElement>(`input[aria-label="Mark complete: ${title}"]`);
const row = (title: string) => box(title)?.closest<HTMLElement>("[data-space-list-row]") ?? null;
const titles = () => [...dom.root.querySelectorAll("[data-space-list-row] a span.block")].map((element) => element.textContent);
const collapsing = (title: string) => row(title)?.className.includes("grid-rows-[0fr]") ?? false;
/** The Undo of the open toast; a closing toast stays in the document for its animation. */
const undoButton = () =>
  [...document.querySelectorAll<HTMLButtonElement>(".k2b-toast__action")].find(
    (button) => button.textContent === "Undo" && !button.closest("[data-closing]"),
  ) ?? null;

// Solid listens for delegated clicks on the document of the first test, so the test that needs them comes first.
domTest("hands keyboard focus to the next task's box when a ticked task leaves, and ignores the box while its change runs", async () => {
  await mount("active");
  jest.useFakeTimers();
  box("Book room")!.focus();
  box("Book room")!.click();
  // A second press before the change is in neither unticks the box nor sends again. A browser's click can be
  // cancelled; happy-dom's `click()` cannot, so the test sends one that can.
  box("Book room")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  expect(box("Book room")!.checked).toBe(true);
  await settle();
  expect(requests).toHaveLength(1);
  expect(document.activeElement).toBe(box("Book room"));
  jest.advanceTimersByTime(LEAVE_DELAY_MS + COLLAPSE_MS);
  await settle();
  expect(titles()).toEqual(["Draft agenda", "Send invites"]);
  expect(document.activeElement).toBe(box("Send invites"));
});

domTest("keeps a task ticked off under the open filter in place, done, then collapses it and confirms with Undo", async () => {
  await mount("active");
  jest.useFakeTimers();
  box("Book room")!.click();
  // The tick shows at once: the box is filled and the title struck through.
  expect(box("Book room")!.checked).toBe(true);
  expect(row("Book room")!.querySelector("a span.block")!.className).toContain("line-through");

  await settle();
  expect(requests).toEqual([{ path: "/api/spaces/Space1/items/TaskB/completed", body: { completed: true } }]);
  // The refresh no longer lists the task, but the row stays where it was, done.
  expect(titles()).toEqual(["Draft agenda", "Book room", "Send invites"]);
  expect(box("Book room")!.checked).toBe(true);
  expect(undoButton()).not.toBeNull();

  jest.advanceTimersByTime(LEAVE_DELAY_MS - 1);
  expect(collapsing("Book room")).toBe(false);
  jest.advanceTimersByTime(1);
  expect(collapsing("Book room")).toBe(true);
  jest.advanceTimersByTime(COLLAPSE_MS);
  expect(titles()).toEqual(["Draft agenda", "Send invites"]);
});

domTest("lets the reader tick several tasks in a row, each leaving on its own time", async () => {
  await mount("active");
  jest.useFakeTimers();
  box("Draft agenda")!.click();
  await settle();
  jest.advanceTimersByTime(300);
  // Another tick is not held up by the first, and its refresh does not take the first row away.
  box("Send invites")!.click();
  await settle();
  expect(requests.map((request) => request.path)).toEqual([
    "/api/spaces/Space1/items/TaskA/completed",
    "/api/spaces/Space1/items/TaskC/completed",
  ]);
  expect(titles()).toEqual(["Draft agenda", "Book room", "Send invites"]);
  jest.advanceTimersByTime(LEAVE_DELAY_MS - 300);
  expect([collapsing("Draft agenda"), collapsing("Send invites")]).toEqual([true, false]);
  jest.advanceTimersByTime(COLLAPSE_MS);
  expect(titles()).toEqual(["Book room", "Send invites"]);
  jest.advanceTimersByTime(300);
  expect(titles()).toEqual(["Book room"]);
});

domTest("Undo puts a leaving task back exactly, in its status and position, and the row stays", async () => {
  await mount("active");
  jest.useFakeTimers();
  box("Book room")!.click();
  await settle();
  jest.advanceTimersByTime(LEAVE_DELAY_MS + 50);
  expect(collapsing("Book room")).toBe(true);

  undoButton()!.click();
  // The row opens again at once, while the server restores the task.
  expect(collapsing("Book room")).toBe(false);
  expect(box("Book room")!.checked).toBe(false);
  await settle();
  expect(requests.at(-1)).toEqual({
    path: "/api/spaces/Space1/items/TaskB/move",
    body: { columnId: "Col002", rank: "2048", completed: false },
  });
  expect(undoButton()).toBeNull();
  jest.advanceTimersByTime(LEAVE_DELAY_MS + COLLAPSE_MS);
  expect(titles()).toEqual(["Draft agenda", "Book room", "Send invites"]);
  expect(box("Book room")!.checked).toBe(false);
});

domTest("Undo after the row has gone brings the task back in its place", async () => {
  await mount("active");
  jest.useFakeTimers();
  box("Book room")!.click();
  await settle();
  jest.advanceTimersByTime(LEAVE_DELAY_MS + COLLAPSE_MS);
  expect(titles()).toEqual(["Draft agenda", "Send invites"]);

  undoButton()!.click();
  await settle();
  expect(requests.at(-1)?.path).toBe("/api/spaces/Space1/items/TaskB/move");
  expect(titles()).toEqual(["Draft agenda", "Book room", "Send invites"]);
});

domTest("unticking a task while it leaves is its Undo", async () => {
  await mount("active");
  jest.useFakeTimers();
  box("Book room")!.click();
  await settle();
  box("Book room")!.click();
  expect(box("Book room")!.checked).toBe(false);
  await settle();
  expect(requests.map((request) => request.path)).toEqual([
    "/api/spaces/Space1/items/TaskB/completed",
    "/api/spaces/Space1/items/TaskB/move",
  ]);
  expect(undoButton()).toBeNull();
  jest.advanceTimersByTime(LEAVE_DELAY_MS + COLLAPSE_MS);
  expect(titles()).toEqual(["Draft agenda", "Book room", "Send invites"]);
});

domTest(
  "a task that stays in the list shows its new state, keeps focus where it does not move, and is announced instead of a toast",
  async () => {
    await mount("all");
    jest.useFakeTimers();
    box("Send invites")!.focus();
    box("Send invites")!.click();
    await settle();
    jest.advanceTimersByTime(100);
    expect(box("Send invites")!.checked).toBe(true);
    expect(document.activeElement).toBe(box("Send invites"));
    expect(undoButton()).toBeNull();
    expect(document.body.textContent).toContain("Item completed");
    jest.advanceTimersByTime(LEAVE_DELAY_MS + COLLAPSE_MS);
    expect(collapsing("Send invites")).toBe(false);
  },
);
