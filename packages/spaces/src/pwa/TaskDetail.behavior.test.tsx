import { afterEach, expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
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
});

const mount = (state: TaskDetailState) => {
  const { ui, TaskDetail } = modules!;
  dom = createDomTestHarness();
  delegateEvents(["click", "input", "change"]);
  dispose = render(
    () =>
      createComponent(ui.LocaleProvider, {
        locale: "en",
        get children() {
          return createComponent(TaskDetail, {
            state,
            userId: "0b8f2d4e-1c3a-4f5b-9d6e-7a8b9c0d1e2f",
            dateConfig: { locale: "en", timeZone: "UTC" },
            listHref: "/pwa/spaces",
            onRetry: () => {},
            onCompletedChange: () => {},
          });
        },
      }),
    dom.root,
  );
  return dom.root;
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
  expect(root.querySelectorAll(".spaces-pwa-task__sk").length).toBe(4);
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

process.once("exit", () => fetchSpy.mockRestore());
