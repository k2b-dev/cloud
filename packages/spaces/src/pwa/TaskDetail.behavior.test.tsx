import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../ui/test/dom";
import type { TaskDetailState } from "./TaskDetail";
import type { PwaTask } from "./task";

const waitFor = async (condition: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

/** Invented demo task. */
const task: PwaTask = {
  shortId: "Item01",
  spaceShortId: "Space1",
  spaceName: "Summer fair",
  spaceColor: "#16a34a",
  title: "Order the tents",
  event: false,
  completed: false,
  deadline: null,
  deadlineAllDay: false,
  startsAt: null,
  endsAt: null,
  allDay: false,
  location: null,
  people: [],
  description: null,
  checklist: [
    { id: "Chk001", label: "Ask the rental", completed: true },
    { id: "Chk002", label: "Pay the deposit", completed: false },
  ],
  canWrite: true,
  statusId: "Col001",
  statuses: [
    { id: "Col001", name: "Open", color: "#94a3b8", done: false },
    { id: "Col009", name: "Done", color: "#16a34a", done: true },
  ],
  tags: [],
  claim: null,
  blocked: false,
};
const ENTRY = "/api/spaces/Space1/items/Item01/checklist/Chk002";

type Answer = Response | Promise<Response> | "offline";
let pending: ((answer: Response) => void) | undefined;
const answers: Answer[] = [];
const calls: { method: string; path: string; body: unknown }[] = [];
const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
  Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost/");
      calls.push({
        method: init?.method ?? "GET",
        path: url.pathname,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      const answer = answers.shift() ?? new Promise<Response>((resolve) => (pending = resolve));
      if (answer === "offline") throw new TypeError("Failed to fetch");
      return answer;
    },
    { preconnect: globalThis.fetch.preconnect },
  ),
);

const load = async () => {
  const dom = createDomTestHarness();
  try {
    return { ui: await import("@k2b/ui"), TaskDetail: (await import("./TaskDetail")).default };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();

let dom: DomTestHarness | undefined;
let dispose = () => {};
afterEach(() => {
  dispose();
  dom?.cleanup();
  modules?.ui.toast.dismissAll();
  answers.length = 0;
  calls.length = 0;
  pending = undefined;
  extra = {};
});

let update: (state: TaskDetailState) => void;
/** Props beyond the state for one test, such as being offline or reading the task again. */
let extra: Record<string, unknown> = {};
const mount = (state: TaskDetailState) => {
  dom = createDomTestHarness();
  delegateEvents(["click", "input", "change"]);
  return show(state);
};
/** Renders into the current document, as a page of an app that starts again on the same device. */
const show = (state: TaskDetailState) => {
  const { ui, TaskDetail } = modules!;
  const [current, setCurrent] = createSignal(state);
  update = setCurrent;
  dom!.root.replaceChildren();
  dispose = render(
    () =>
      createComponent(ui.LocaleProvider, {
        locale: "en",
        get children() {
          return createComponent(TaskDetail, {
            get state() {
              return current();
            },
            userId: "0b8f2d4e-1c3a-4f5b-9d6e-7a8b9c0d1e2f",
            dateConfig: { locale: "en", timeZone: "UTC" },
            listHref: "/pwa/spaces",
            onRetry: () => {},
            onCompletedChange: () => {},
            ...extra,
          });
        },
      }),
    dom!.root,
  );
  return dom!.root;
};

const boxes = (root: HTMLElement) => [...root.querySelectorAll<HTMLInputElement>(".spaces-pwa-task__checklist input")];
const aside = (root: HTMLElement) => root.querySelector(".spaces-pwa-task__aside")!;

test("a checked item shows at once with a spinner at its place, and the count follows once saved", async () => {
  const root = mount({ kind: "ready", task });
  boxes(root)[1]!.click();
  expect(boxes(root).map((box) => box.checked)).toEqual([true, true]);
  expect(root.querySelector(".spaces-pwa-task__slot i.k2b-spin")).not.toBeNull();
  expect(aside(root).textContent).toBe("Saving …");
  expect(calls).toEqual([{ method: "PATCH", path: ENTRY, body: { completed: true } }]);
  pending!(Response.json({ id: "Chk002", completed: true }));
  await waitFor(() => aside(root).textContent === "2 of 2", "the saved count");
  expect(root.querySelector(".spaces-pwa-task__slot i.k2b-spin")).toBeNull();
});

test("an item that is saving takes no second tap, so the box always shows what is saved", async () => {
  const root = mount({ kind: "ready", task });
  boxes(root)[1]!.click();
  expect(boxes(root)[1]!.disabled).toBe(true);
  boxes(root)[1]!.click();
  expect(calls.length).toBe(1);
  pending!(Response.json({ id: "Chk002", completed: true }));
  await waitFor(() => aside(root).textContent === "2 of 2", "the saved count");
  expect(boxes(root)[1]!.checked).toBe(true);
  expect(boxes(root)[1]!.disabled).toBe(false);
});

test("a change that fails springs back, says so above the list, and Retry at its row saves it again", async () => {
  const root = mount({ kind: "ready", task });
  answers.push("offline");
  boxes(root)[1]!.click();
  await waitFor(() => aside(root).textContent === "1 change not saved", "the failure");
  expect(aside(root).getAttribute("data-tone")).toBe("danger");
  expect(boxes(root)[1]!.checked).toBe(false);
  const retry = root.querySelector<HTMLButtonElement>(".spaces-pwa-task__retry")!;
  expect(retry.getAttribute("aria-label")).toBe("“Pay the deposit” not saved. Try again");
  answers.push(Response.json({ id: "Chk002", completed: true }));
  retry.click();
  await waitFor(() => aside(root).textContent === "2 of 2", "the retried save");
  expect(calls.map((call) => call.body)).toEqual([{ completed: true }, { completed: true }]);
});

test("a refused change springs back and the toast names the reason, without Retry", async () => {
  const root = mount({ kind: "ready", task });
  answers.push(Response.json({ message: "Access denied" }, { status: 403 }));
  boxes(root)[1]!.click();
  await waitFor(() => document.body.textContent?.includes("You cannot change tasks in “Summer fair”.") ?? false, "the refusal");
  expect(boxes(root)[1]!.checked).toBe(false);
  expect(root.querySelector(".spaces-pwa-task__retry")).toBeNull();
  expect(aside(root).textContent).toBe("1 of 2");
});

test("a reader without write access sees why everything is off", () => {
  const root = mount({ kind: "ready", task: { ...task, canWrite: false } });
  expect(root.querySelector(".spaces-pwa-task__note")?.textContent).toBe("Read only. You cannot change tasks in “Summer fair”.");
  expect(boxes(root).every((box) => box.disabled)).toBe(true);
  expect(root.querySelector<HTMLButtonElement>("button.spaces-pwa__check")!.disabled).toBe(true);
});

test("an agent among the assignees shows its robot in a square, a person their round picture", () => {
  const agentId = "66666666-6666-4666-8666-666666666666";
  const root = mount({
    kind: "ready",
    task: {
      ...task,
      people: [
        { id: "22222222-2222-4222-8222-222222222222", kind: "user", displayName: "Lena Example", avatarHash: "lena-rev" },
        { id: agentId, kind: "service_account", displayName: "Release agent", avatarHash: null },
      ],
    },
  });
  const [person, agent] = Array.from(root.querySelectorAll<HTMLImageElement>(".spaces-pwa-task__avatars img"));
  expect(person?.getAttribute("src")).toContain("rev=lena-rev");
  expect(person?.getAttribute("data-shape")).toBeNull();
  expect(agent?.getAttribute("src")).toBe(`/api/accounts/users/${agentId}/avatar`);
  expect(agent?.getAttribute("data-shape")).toBe("square");
});

test("opened from a row, the title, Space and date show at once and the rest keeps its place", () => {
  const root = mount({
    kind: "loading",
    item: { ...task, priority: null, deadline: "2026-10-15", deadlineAllDay: true },
  });
  expect(root.querySelector(".spaces-pwa-task__title h3")?.textContent).toBe("Order the tents");
  expect(root.querySelector(".spaces-pwa-task__props time")?.textContent).toBe("Thu, Oct 15");
  expect(root.querySelector('.spaces-pwa-task__loading[aria-busy="true"]')).not.toBeNull();
  // From "My tasks" the row knows neither status nor people: both wait at their place, with the description and checklist.
  expect(root.querySelectorAll(".spaces-pwa-task__sk").length).toBe(6);
  expect(root.querySelectorAll(".spaces-pwa-task__sk--value").length).toBe(2);
});

test("a task that could not be loaded offers Retry; one that is gone leads back to the list", () => {
  let root = mount({ kind: "failed", item: { ...task, priority: null } });
  expect(root.textContent).toContain("The task could not be loaded.");
  expect(root.querySelector("button")?.textContent).not.toBeNull();
  dispose();
  dom?.cleanup();
  root = mount({ kind: "gone" });
  expect(root.textContent).toContain("This task is no longer available.");
  expect(root.querySelector('a[href="/pwa/spaces"]')?.textContent).toBe("Back to the list");
});

const DRAFT = `cloud.pwa.draft:0b8f2d4e-1c3a-4f5b-9d6e-7a8b9c0d1e2f:${encodeURIComponent("spaces.comment:Space1:Item01")}`;
const COMMENTS = "/api/spaces/Space1/items/Item01/comments";
const commentField = (root: HTMLElement) => root.querySelector<HTMLTextAreaElement>(".spaces-pwa-comment textarea");
const sendButton = (root: HTMLElement) => root.querySelector<HTMLButtonElement>('.spaces-pwa-comment button[type="submit"]')!;
const type = (field: HTMLTextAreaElement, text: string) => {
  field.value = text;
  field.dispatchEvent(new Event("input", { bubbles: true }));
};

test("only a reader who may change the task can comment, and not while the task loads", () => {
  let root = mount({ kind: "ready", task });
  expect(commentField(root)?.getAttribute("aria-label")).toBe("Comment");
  expect(commentField(root)?.placeholder).toBe("Write a comment");
  expect(sendButton(root).disabled).toBe(true);
  dispose();
  dom?.cleanup();
  root = mount({ kind: "ready", task: { ...task, canWrite: false } });
  expect(commentField(root)).toBeNull();
  dispose();
  dom?.cleanup();
  root = mount({ kind: "loading", item: { ...task, priority: null } });
  expect(commentField(root)).toBeNull();
});

test("a typed comment is a draft on the device until it is sent, then the field is empty again", async () => {
  let root = mount({ kind: "ready", task });
  type(commentField(root)!, "Tents are booked.");
  expect(dom!.window.localStorage.getItem(DRAFT)).toBe("Tents are booked.");
  // The app was ended: the next start on this device shows the draft again.
  dispose();
  root = show({ kind: "ready", task });
  expect(commentField(root)!.value).toBe("Tents are booked.");
  answers.push(Response.json({ id: "Cmt001" }));
  sendButton(root).click();
  await waitFor(() => dom!.document.body.textContent?.includes("Comment sent") ?? false, "sent");
  expect(calls.at(-1)).toEqual({ method: "POST", path: COMMENTS, body: { requestId: expect.any(String), content: "Tents are booked." } });
  expect(commentField(root)!.value).toBe("");
  expect(dom!.window.localStorage.getItem(DRAFT)).toBeNull();
});

test("a comment that fails to send keeps its text and draft, and Retry sends it again", async () => {
  const root = mount({ kind: "ready", task });
  type(commentField(root)!, "Deposit paid.");
  answers.push("offline");
  sendButton(root).click();
  await waitFor(() => dom!.document.body.textContent?.includes("Comment on “Order the tents” not sent.") ?? false, "failure");
  expect(commentField(root)!.value).toBe("Deposit paid.");
  expect(dom!.window.localStorage.getItem(DRAFT)).toBe("Deposit paid.");
  answers.push(Response.json({ id: "Cmt002" }));
  [...dom!.document.querySelectorAll<HTMLButtonElement>("[data-k2b-toast] button")]
    .find((button) => button.textContent === "Retry")!
    .click();
  await waitFor(() => dom!.document.body.textContent?.includes("Comment sent") ?? false, "sent on retry");
  const attempts = calls.filter((call) => call.path === COMMENTS);
  expect(attempts).toHaveLength(2);
  expect(attempts[1]!.body).toEqual(attempts[0]!.body);
  expect(dom!.window.localStorage.getItem(DRAFT)).toBeNull();
});

test("a late send cannot remove a draft edited after reopening the task", async () => {
  let root = mount({ kind: "ready", task });
  type(commentField(root)!, "First version");
  sendButton(root).click();
  const finishOldSend = pending!;
  dispose();
  root = show({ kind: "ready", task });
  type(commentField(root)!, "A newer draft");
  finishOldSend(Response.json({ id: "Cmt003" }));
  await Bun.sleep(0);
  expect(commentField(root)!.value).toBe("A newer draft");
  expect(dom!.window.localStorage.getItem(DRAFT)).toBe("A newer draft");
});

test("an ambiguous send retains its comment identity across an app restart", async () => {
  let root = mount({ kind: "ready", task });
  type(commentField(root)!, "Already committed, response lost");
  answers.push("offline");
  sendButton(root).click();
  await waitFor(() => dom!.document.body.textContent?.includes("not sent") ?? false, "failure");
  const first = calls.at(-1)!.body;
  dispose();
  root = show({ kind: "ready", task });
  answers.push(Response.json({ id: "Cmt004" }));
  sendButton(root).click();
  await waitFor(() => dom!.document.body.textContent?.includes("Comment sent") ?? false, "reconciled send");
  expect(calls.at(-1)!.body).toEqual(first);
  expect(dom!.window.localStorage.getItem(DRAFT)).toBeNull();
});

test("a changed committed comment keeps the draft and directs the reader to Spaces instead of retrying", async () => {
  const root = mount({ kind: "ready", task });
  type(commentField(root)!, "Keep this text");
  answers.push(Response.json({ message: "Request ID belongs to a different comment" }, { status: 409 }));
  sendButton(root).click();
  await waitFor(() => dom!.document.body.textContent?.includes("already sent and has changed") ?? false, "conflict");
  expect(dom!.window.localStorage.getItem(DRAFT)).toBe("Keep this text");
  expect([...dom!.document.querySelectorAll("[data-k2b-toast] button")].some((button) => button.textContent === "Retry")).toBe(false);
});

test("a token-only storage failure sends nothing, so a fresh runtime cannot duplicate a committed comment", async () => {
  let root = mount({ kind: "ready", task });
  type(commentField(root)!, "Ready to send");
  const storage = dom!.window.localStorage;
  const write = storage.setItem;
  const requestKey = `${DRAFT}${encodeURIComponent(":request")}`;
  const blocked = mock((key: string, value: string) => {
    if (key === requestKey) throw new Error("Quota exceeded");
    write(key, value);
  });
  // Happy DOM's Storage proxy ignores method assignment; define the fault explicitly.
  Object.defineProperty(storage, "setItem", { configurable: true, value: blocked });
  try {
    sendButton(root).click();
    expect(blocked).toHaveBeenCalledWith(requestKey, expect.any(String));
    await waitFor(() => root.textContent?.includes("Device storage is full") ?? false, "storage failure");
    expect(calls.filter((call) => call.path === COMMENTS)).toHaveLength(0);
    expect(storage.getItem(DRAFT)).toBe("Ready to send");
    expect(storage.getItem(requestKey)).toBeNull();
  } finally {
    Object.defineProperty(storage, "setItem", { configurable: true, value: write });
  }
  const persistedText = storage.getItem(DRAFT)!;
  dispose();
  // A fresh runtime loses the helper's memory map and keeps only the durable text.
  (await import("@k2b/cloud/browser/pwa-drafts")).pwaDrafts.clearAll();
  storage.setItem(DRAFT, persistedText);
  root = show({ kind: "ready", task });
  answers.push(Response.json({ id: "Cmt005" }));
  sendButton(root).click();
  await waitFor(() => dom!.document.body.textContent?.includes("Comment sent") ?? false, "safe send after restart");
  expect(calls.filter((call) => call.path === COMMENTS)).toHaveLength(1);
});

test("a snapshot preserves the pending checkbox and comment draft, then replaces settled checklist state", async () => {
  const root = mount({ kind: "ready", task });
  const field = commentField(root)!;
  type(field, "A draft in progress");
  const box = boxes(root)[1]!;
  box.click();
  const finish = pending!;
  field.focus();
  update({ kind: "ready", task: { ...task, title: "Updated elsewhere", checklist: task.checklist.map((entry) => ({ ...entry })) } });
  expect(boxes(root)[1] === box).toBe(true);
  expect(box.checked).toBe(true);
  expect(box.disabled).toBe(true);
  expect(commentField(root) === field).toBe(true);
  expect(field.value).toBe("A draft in progress");
  expect(document.activeElement === field).toBe(true);
  finish(Response.json({ id: "Chk002", completed: true }));
  await waitFor(() => !box.disabled, "the pending write");
  update({ kind: "ready", task: { ...task, checklist: task.checklist.map((entry) => ({ ...entry })) } });
  expect(box.checked).toBe(false);
  expect(field.value).toBe("A draft in progress");
});

process.once("exit", () => fetchSpy.mockRestore());

const menuItem = (label: string) =>
  [
    ...dom!.document.querySelectorAll<HTMLElement>('[role="menuitemradio"], [role="menuitem"], [role="menuitemcheckbox"], [role="option"]'),
  ].find((item) => item.textContent?.includes(label));
const picker = (root: HTMLElement, row: number) => root.querySelectorAll<HTMLElement>(".spaces-pwa-task__props--edit dd")[row]!;

test("the status row moves the task without dragging, with Undo, and a failure puts the status back with ↻", async () => {
  let shown = task;
  extra = {
    onRefresh: async () => update({ kind: "ready", task: shown }),
  };
  const root = mount({ kind: "ready", task, item: { ...task, priority: null, nextShortId: "Item02" } });
  picker(root, 0).querySelector<HTMLButtonElement>("button")!.click();
  answers.push(Response.json({}));
  shown = { ...task, statusId: "Col009", completed: true };
  menuItem("Done")!.click();
  expect(picker(root, 0).textContent).toContain("Done");
  await waitFor(() => (dom!.document.body.textContent ?? "").includes("“Order the tents” is now in “Done”."), "the moved notice");
  expect(calls.at(-1)).toEqual({ method: "POST", path: "/api/spaces/Space1/items/Item01/move", body: { columnId: "Col009" } });
  answers.push(Response.json({}));
  shown = task;
  [...dom!.document.querySelectorAll<HTMLButtonElement>(".k2b-toast__action")].find((action) => action.textContent === "Undo")!.click();
  await waitFor(() => calls.filter((call) => call.path.endsWith("/move")).length === 2, "the move back");
  // Undo puts it back before its old neighbour.
  expect(calls.at(-1)?.body).toEqual({ columnId: "Col001", beforeItemId: "Item02" });
  await waitFor(() => picker(root, 0).textContent?.includes("Open") ?? false, "the old status");
});

test("a move that cannot reach the server puts the status back, with ↻ in its row and a notice", async () => {
  extra = { onRefresh: async () => {} };
  const root = mount({ kind: "ready", task });
  answers.push("offline");
  picker(root, 0).querySelector<HTMLButtonElement>("button")!.click();
  menuItem("Done")!.click();
  await waitFor(() => root.querySelector('[aria-label="Status: try again"]') !== null, "the retry in the row");
  expect(picker(root, 0).textContent).toContain("Open");
  expect(dom!.document.body.textContent).toContain("Status not saved. “Order the tents” stays in “Open”.");
  // ↻ in the row repeats the move that failed.
  answers.push(Response.json({}));
  root.querySelector<HTMLButtonElement>('[aria-label="Status: try again"]')!.click();
  await waitFor(() => calls.filter((call) => call.path.endsWith("/move")).length === 2, "the repeated move");
  expect(calls.at(-1)?.body).toEqual({ columnId: "Col009" });
});

test("a task loaded without a date shows none, even when the row it was opened from had one", () => {
  const root = mount({
    kind: "ready",
    task: { ...task, deadline: null },
    item: { ...task, priority: null, deadline: "2026-10-15", deadlineAllDay: true, preview: { deadline: "2026-10-15" } },
  });
  expect(picker(root, 1).textContent).toContain("No date");
});

test("a blocked task keeps the done status closed and says why", () => {
  const root = mount({ kind: "ready", task: { ...task, blocked: true } });
  picker(root, 0).querySelector<HTMLButtonElement>("button")!.click();
  const done = menuItem("Done")!;
  expect(done.getAttribute("aria-disabled") === "true" || (done as HTMLButtonElement).disabled).toBe(true);
  expect(done.textContent).toContain("Finish the blocking tasks first");
});

test("a person is added or removed alone, so a change by someone else meanwhile stays", async () => {
  extra = { onRefresh: async () => {} };
  const root = mount({ kind: "ready", task });
  const people = [{ id: "22222222-2222-4222-8222-222222222222", kind: "user", displayName: "Lena Example", avatarHash: null, uid: "lena" }];
  answers.push(Response.json(people));
  const trigger = picker(root, 2).querySelector<HTMLButtonElement>("button")!;
  trigger.dispatchEvent(new FocusEvent("focus"));
  trigger.click();
  await waitFor(() => menuItem("Lena Example") !== undefined, "the people");
  answers.push(Response.json({}));
  menuItem("Lena Example")!.click();
  await waitFor(() => calls.some((call) => call.method === "PATCH"), "the assignment");
  expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ addAssigneeIds: ["22222222-2222-4222-8222-222222222222"] });
  expect(dom!.document.body.textContent).toContain("Each choice applies at once. The sheet stays open.");
});

test("the title saves with the title it started from; a change meanwhile keeps the text and offers the new title", async () => {
  let shown = task;
  extra = { onRefresh: async () => update({ kind: "ready", task: shown }) };
  const root = mount({ kind: "ready", task });
  root.querySelector<HTMLButtonElement>(".spaces-pwa-task__title-button")!.click();
  const field = root.querySelector<HTMLTextAreaElement>(".spaces-pwa-task__title-edit textarea")!;
  expect(root.querySelector(".spaces-pwa-task__title-hint")?.textContent).toBe("Enter saves.Cancel keeps the old title.");
  field.value = "Order two tents";
  field.dispatchEvent(new Event("input", { bubbles: true }));
  answers.push(Response.json({ code: "TITLE_CONFLICT", message: "Title changed" }, { status: 409 }));
  shown = { ...task, title: "Order the big tents" };
  field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await waitFor(
    () => root.querySelector(".spaces-pwa-task__title-hint")?.textContent?.includes("Changed meanwhile") ?? false,
    "the conflict",
  );
  expect(calls.at(-1)).toEqual({
    method: "PATCH",
    path: "/api/spaces/Space1/items/Item01",
    body: { title: "Order two tents", expectedTitle: "Order the tents" },
  });
  expect(field.value).toBe("Order two tents");
  expect(root.querySelector(".spaces-pwa-task__title-hint")?.textContent).toContain("“Order the big tents”");
  [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Use the new title")!.click();
  expect(root.querySelector<HTMLTextAreaElement>(".spaces-pwa-task__title-edit textarea")!.value).toBe("Order the big tents");
});

test("offline the task stays readable, says why, and offers no picker", () => {
  extra = { online: false };
  const root = mount({ kind: "ready", task });
  expect(root.textContent).toContain("Offline. You see the last state. Changing works again with a connection.");
  expect(root.querySelector(".spaces-pwa-task__props--edit button")).toBeNull();
  expect(root.querySelector(".spaces-pwa-task__title-button")).toBeNull();
  expect(boxes(root).every((box) => box.disabled)).toBe(true);
});
