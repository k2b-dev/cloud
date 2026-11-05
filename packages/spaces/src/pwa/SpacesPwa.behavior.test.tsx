import { afterEach, expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../ui/test/dom";
import type { OverviewWork } from "../overview-contracts";
import type { PwaTask } from "./task";

const waitFor = async (condition: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

/** Invented demo work. */
const row = (shortId: string, title: string): OverviewWork["items"][number] => ({
  shortId,
  spaceShortId: "Space1",
  spaceName: "Summer fair",
  spaceColor: "#16a34a",
  title,
  priority: null,
  startsAt: null,
  endsAt: null,
  deadline: "2026-10-15",
  deadlineAllDay: true,
  canWrite: true,
});
const work: OverviewWork = {
  view: "mine",
  counts: { mine: 2, today: 0, upcoming: 0 },
  items: [row("Item01", "Order the tents"), row("Item02", "Write the flyer")],
};
const detail = (shortId: string, title: string): PwaTask => ({
  ...row(shortId, title),
  spaceColor: "#16a34a",
  event: false,
  completed: false,
  startsAt: null,
  endsAt: null,
  allDay: false,
  location: null,
  people: [],
  description: `About ${title}.`,
  checklist: [],
  canWrite: true,
});

let liveApply: (events: unknown[]) => Promise<void>;
let liveResync: () => Promise<void>;
let liveReady: (ready: boolean) => void;
let liveRevoked: () => void;
let liveUnavailable: () => void;
let closed = 0;
const scopes: unknown[] = [];
const liveSpy = spyOn(await import("@k2b/cloud/browser/live"), "liveConnection").mockImplementation(() => ({
  subscribe: (_channel, scope, handlers) => {
    scopes.push(scope);
    liveApply = (events) => handlers.apply(events.map((data) => ({ data: handlers.parse(data), cursor: "spaces.2" })));
    liveResync = handlers.resync;
    liveReady = (ready) => handlers.caughtUp?.(ready);
    liveRevoked = () => handlers.revoked?.("access_denied");
    liveUnavailable = handlers.unavailable;
    return {
      close: () => {
        closed += 1;
      },
    };
  },
}));
const requests: string[] = [];
const waiting = new Map<string, (response: Response) => void>();
const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
  Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost/");
      requests.push(`${init?.method ?? "GET"} ${url.pathname}${url.search} ${new Headers(init?.headers).get("accept") ?? ""}`.trim());
      return new Promise<Response>((resolve) => waiting.set(url.pathname, resolve));
    },
    { preconnect: globalThis.fetch.preconnect },
  ),
);

const load = async () => {
  const dom = createDomTestHarness();
  try {
    return { ui: await import("@k2b/ui"), SpacesPwa: (await import("./SpacesPwa.island")).default };
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
  requests.length = 0;
  waiting.clear();
  scopes.length = 0;
  closed = 0;
  modules?.ui.toast.dismissAll();
});

const mount = (path: string, initialTask?: PwaTask) => {
  const { ui, SpacesPwa } = modules!;
  dom = createDomTestHarness();
  delegateEvents(["click", "input", "change"]);
  dom.window.history.replaceState(null, "", path);
  dispose = render(
    () =>
      createComponent(ui.LocaleProvider, {
        locale: "en",
        get children() {
          return createComponent(SpacesPwa, {
            userId: "0b8f2d4e-1c3a-4f5b-9d6e-7a8b9c0d1e2f",
            initialList: { kind: "mine", view: "mine" },
            me: { id: "0b8f2d4e-1c3a-4f5b-9d6e-7a8b9c0d1e2f", kind: "user", displayName: "Mia Muster", avatarHash: null },
            initialWork: work,
            spaces: [{ shortId: "Space1", name: "Summer fair", color: "#16a34a", openCount: 2, canWrite: true, pinned: false }],
            dateConfig: { locale: "en", timeZone: "UTC" },
            initialTask,
          });
        },
      }),
    dom.root,
  );
  return dom.root;
};
const level = (root: HTMLElement) =>
  [...root.querySelectorAll("[data-workspace-level]")].map((element) => element.getAttribute("data-workspace-level-shown"));

test("a row opens its task in place: row data at once, the rest from the task's address, no page load", async () => {
  const root = mount("/pwa/spaces");
  expect(level(root)).toEqual(["1 2 3", "2 3"]);
  root.querySelector<HTMLAnchorElement>('.spaces-pwa__copy[href="/pwa/spaces/Space1/Item01"]')!.click();

  // The same moment: the task is the open level, its row is marked, and the title from the row shows.
  expect(location.pathname).toBe("/pwa/spaces/Space1/Item01");
  expect(level(root)).toEqual(["2 3", "1 2 3"]);
  expect(root.querySelector('.spaces-pwa__row[aria-current="true"]')?.textContent).toContain("Order the tents");
  expect(root.querySelector(".spaces-pwa-task__title h3")?.textContent).toBe("Order the tents");
  expect(root.querySelector('.spaces-pwa-task__loading[aria-busy="true"]')).not.toBeNull();
  await waitFor(() => requests.length === 1, "the task read");
  expect(requests).toEqual(["GET /pwa/spaces/Space1/Item01 application/json"]);

  await waitFor(() => waiting.has("/pwa/spaces/Space1/Item01"), "the tents read");
  waiting.get("/pwa/spaces/Space1/Item01")!(Response.json(detail("Item01", "Order the tents")));
  await waitFor(() => root.textContent?.includes("About Order the tents.") ?? false, "the task");
  expect(root.querySelector(".spaces-pwa-task__loading")).toBeNull();
});

test("a later tap wins over a task that is still loading", async () => {
  const root = mount("/pwa/spaces");
  root.querySelector<HTMLAnchorElement>('.spaces-pwa__copy[href="/pwa/spaces/Space1/Item01"]')!.click();
  root.querySelector<HTMLAnchorElement>('.spaces-pwa__copy[href="/pwa/spaces/Space1/Item02"]')!.click();
  await waitFor(() => waiting.has("/pwa/spaces/Space1/Item02"), "the flyer read");
  waiting.get("/pwa/spaces/Space1/Item02")!(Response.json(detail("Item02", "Write the flyer")));
  await waitFor(() => root.textContent?.includes("About Write the flyer.") ?? false, "the second task");
  waiting.get("/pwa/spaces/Space1/Item01")?.(Response.json(detail("Item01", "Order the tents")));
  await Bun.sleep(20);
  expect(root.querySelector(".spaces-pwa-task__title h3")?.textContent).toBe("Write the flyer");
  expect(location.pathname).toBe("/pwa/spaces/Space1/Item02");
});

test("the way back leads to the list in place, and a task that failed to load offers Retry", async () => {
  const root = mount("/pwa/spaces/Space1/Item01", detail("Item01", "Order the tents"));
  expect(level(root)).toEqual(["2 3", "1 2 3"]);
  const back = root.querySelector<HTMLAnchorElement>(".k2b-app-workspace__level-back")!;
  expect(back.getAttribute("aria-label")).toBe("Back to My tasks");
  back.click();
  expect(location.pathname).toBe("/pwa/spaces");
  expect(level(root)).toEqual(["1 2 3", "2 3"]);
  expect(root.textContent).toContain("No task selected");

  root.querySelector<HTMLAnchorElement>('.spaces-pwa__copy[href="/pwa/spaces/Space1/Item02"]')!.click();
  await waitFor(() => waiting.has("/pwa/spaces/Space1/Item02"), "the flyer read");
  waiting.get("/pwa/spaces/Space1/Item02")!(Response.json({ message: "Unavailable" }, { status: 503 }));
  await waitFor(() => root.textContent?.includes("The task could not be loaded.") ?? false, "the failure");
  expect(root.querySelector(".spaces-pwa-task__title h3")?.textContent).toBe("Write the flyer");
  [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Try again")!.click();
  expect(requests.at(-1)).toBe("GET /pwa/spaces/Space1/Item02 application/json");
});

test("header Back consumes the list-to-task entry and Forward reopens the task", async () => {
  const root = mount("/pwa/spaces");
  const length = history.length;
  root.querySelector<HTMLAnchorElement>('.spaces-pwa__copy[href="/pwa/spaces/Space1/Item01"]')!.click();
  expect(history.length).toBe(length + 1);
  await waitFor(() => waiting.has("/pwa/spaces/Space1/Item01"), "the tents read");
  waiting.get("/pwa/spaces/Space1/Item01")!(Response.json(detail("Item01", "Order the tents")));
  await waitFor(() => root.textContent?.includes("About Order the tents.") ?? false, "task loaded");
  root.querySelector<HTMLAnchorElement>(".k2b-app-workspace__level-back")!.click();
  await waitFor(() => location.pathname === "/pwa/spaces", "Back to list");
  expect(history.length).toBe(length + 1);
  expect(level(root)).toEqual(["1 2 3", "2 3"]);
  history.forward();
  await waitFor(() => location.pathname === "/pwa/spaces/Space1/Item01", "Forward to task");
  await waitFor(() => waiting.has("/pwa/spaces/Space1/Item01"), "the tents read");
  waiting.get("/pwa/spaces/Space1/Item01")!(Response.json(detail("Item01", "Order the tents")));
  await waitFor(() => root.textContent?.includes("About Order the tents.") ?? false, "task restored");
  expect(history.length).toBe(length + 1);
});

test("Back from a deep link replaces its entry with the list", () => {
  const root = mount("/pwa/spaces/Space1/Item01", detail("Item01", "Order the tents"));
  const length = history.length;
  root.querySelector<HTMLAnchorElement>(".k2b-app-workspace__level-back")!.click();
  expect(location.pathname).toBe("/pwa/spaces");
  expect(history.length).toBe(length);
});

const travel = (path: string) => {
  const view = dom!.window;
  view.history.replaceState(view.history.state, "", path);
  view.dispatchEvent(new view.PopStateEvent("popstate", { state: view.history.state }));
};

test("Back and Forward show the task their address names, and a late answer for another task never replaces it", async () => {
  const root = mount("/pwa/spaces/Space1/Item02", detail("Item02", "Write the flyer"));
  travel("/pwa/spaces/Space1/Item01");
  // The flyer's controls are gone at once; the tents load.
  await waitFor(() => root.querySelector('.spaces-pwa-task__loading[aria-busy="true"]') !== null, "the loading task");
  expect(root.textContent).not.toContain("About Write the flyer.");
  travel("/pwa/spaces/Space1/Item02");
  await waitFor(() => requests.filter((request) => request.includes("/Item02")).length === 1, "the flyer's read");
  waiting.get("/pwa/spaces/Space1/Item01")?.(Response.json(detail("Item01", "Order the tents")));
  await waitFor(() => waiting.has("/pwa/spaces/Space1/Item02"), "the flyer read");
  waiting.get("/pwa/spaces/Space1/Item02")!(Response.json(detail("Item02", "Write the flyer")));
  await waitFor(() => root.textContent?.includes("About Write the flyer.") ?? false, "the flyer");
  await Bun.sleep(20);
  expect(root.textContent).not.toContain("Order the tents.");
});

test("a task that fails to load after Back offers Retry instead of calling it deleted", async () => {
  const root = mount("/pwa/spaces");
  travel("/pwa/spaces/Space1/Item01");
  await waitFor(() => waiting.has("/pwa/spaces/Space1/Item01"), "the tents read");
  waiting.get("/pwa/spaces/Space1/Item01")!(Response.json({ message: "Unavailable" }, { status: 503 }));
  await waitFor(() => root.textContent?.includes("The task could not be loaded.") ?? false, "the failure");
  expect(root.textContent).not.toContain("no longer available");
});

test("another view keeps the open task in the address, and Back's view reaches the list", async () => {
  const root = mount("/pwa/spaces/Space1/Item01", detail("Item01", "Order the tents"));
  [...root.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((radio) => radio.textContent?.startsWith("Upcoming"))!.click();
  expect(`${location.pathname}${location.search}`).toBe("/pwa/spaces/Space1/Item01?view=upcoming");
  travel("/pwa/spaces/Space1/Item01");
  await waitFor(() => root.querySelector('[role="radio"][aria-checked="true"]')?.textContent?.startsWith("For me") ?? false, "the view");
});

const answerTask = async (response: Response) => {
  const path = "/pwa/spaces/Space1/Item01";
  await waitFor(() => waiting.has(path), "task refresh");
  waiting.get(path)!(response);
  waiting.delete(path);
};

test("a live event re-reads the open task, preserves its draft and focus, and waits for snapshot coverage", async () => {
  const root = mount("/pwa/spaces/Space1/Item01", detail("Item01", "Order the tents"));
  expect(scopes).toEqual([{ space: "Space1" }]);
  const field = root.querySelector<HTMLTextAreaElement>("textarea")!;
  field.value = "Keep my draft";
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.focus();
  root.scrollTop = 120;
  let covered = false;
  const update = liveApply([{ type: "item.updated", itemId: "Item01" }]).then(() => {
    covered = true;
  });
  await waitFor(() => waiting.has("/pwa/spaces/Space1/Item01"), "the covering read");
  expect(covered).toBe(false);
  expect(root.querySelector(".spaces-pwa-task__loading")).toBeNull();
  await answerTask(Response.json({ ...detail("Item01", "New task title"), deadline: "2026-11-10", deadlineAllDay: true }));
  await update;
  expect(root.querySelector(".spaces-pwa-task__title h3")?.textContent).toBe("New task title");
  expect(root.querySelector("textarea")).toBe(field);
  expect(field.value).toBe("Keep my draft");
  expect(document.activeElement).toBe(field);
  expect(root.scrollTop).toBe(120);
});

test("a task that loses access turns into the existing not-found state after the authorized read", async () => {
  const root = mount("/pwa/spaces/Space1/Item01", detail("Item01", "Order the tents"));
  liveRevoked();
  await answerTask(Response.json({ message: "Not found" }, { status: 404 }));
  await waitFor(() => root.textContent?.includes("This task is no longer available.") ?? false, "not found");
  expect(root.querySelector("textarea")).toBeNull();
  expect(root.textContent).not.toContain("About Order the tents.");
});

test("subscription confirmation closes the initial snapshot gap once, and resync awaits a new read", async () => {
  const root = mount("/pwa/spaces/Space1/Item01", detail("Item01", "Order the tents"));
  liveReady(true);
  await answerTask(Response.json(detail("Item01", "Changed before subscribing")));
  await waitFor(() => root.textContent?.includes("Changed before subscribing") ?? false, "gap covered");
  liveReady(false);
  liveReady(true);
  await Bun.sleep(0);
  expect(requests).toHaveLength(1);
  const update = liveResync();
  await answerTask(Response.json(detail("Item01", "After resync")));
  await update;
  expect(root.textContent).toContain("After resync");
  dispose();
  expect(closed).toBe(1);
});

test("foreground and network return refresh an open task without replacing it with loading UI", async () => {
  const root = mount("/pwa/spaces/Space1/Item01", detail("Item01", "Order the tents"));
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("online"));
  await answerTask(Response.json(detail("Item01", "Updated while away")));
  await waitFor(() => root.textContent?.includes("Updated while away") ?? false, "foreground update");
  expect(root.querySelector(".spaces-pwa-task__loading")).toBeNull();
  expect(requests.filter((request) => request.includes("/Space1/Item01"))).toHaveLength(1);
});

test("terminal live failure keeps the task and draft, and offers persistent reload recovery", async () => {
  const root = mount("/pwa/spaces/Space1/Item01", detail("Item01", "Order the tents"));
  const field = root.querySelector<HTMLTextAreaElement>("textarea")!;
  field.value = "Keep this draft";
  field.dispatchEvent(new Event("input", { bubbles: true }));
  const reload = spyOn(window.location, "reload").mockImplementation(() => {});
  try {
    liveUnavailable();
    await answerTask(Response.json(detail("Item01", "Latest snapshot")));
    await waitFor(() => root.textContent?.includes("Latest snapshot") ?? false, "last snapshot");
    expect(document.body.textContent).toContain("Live updates are unavailable right now");
    expect(field.value).toBe("Keep this draft");
    expect(reload).not.toHaveBeenCalled();
    const action = [...document.querySelectorAll<HTMLButtonElement>("[data-k2b-toast] button")].find(
      (button) => button.textContent === "Reload",
    );
    expect(Boolean(action)).toBe(true);
    action!.click();
    expect(reload).toHaveBeenCalledTimes(1);
  } finally {
    reload.mockRestore();
  }
});

test("a failed read when reopening the last task keeps the snapshot and offers Retry", async () => {
  const root = mount("/pwa/spaces/Space1/Item01", detail("Item01", "Order the tents"));
  root.querySelector<HTMLAnchorElement>(".k2b-app-workspace__level-back")!.click();
  await Bun.sleep(0);
  root.querySelector<HTMLAnchorElement>('.spaces-pwa__copy[href="/pwa/spaces/Space1/Item01"]')!.click();
  await answerTask(Response.json({ message: "Unavailable" }, { status: 503 }));
  await waitFor(() => document.body.textContent?.includes("The task could not be loaded.") ?? false, "refresh failure");
  expect(root.textContent).toContain("About Order the tents.");
  const retry = [...document.querySelectorAll<HTMLButtonElement>("[data-k2b-toast] button")].find(
    (button) => button.textContent === "Try again",
  );
  expect(Boolean(retry)).toBe(true);
  retry!.click();
  await answerTask(Response.json(detail("Item01", "Recovered task")));
  await waitFor(() => root.textContent?.includes("Recovered task") ?? false, "retry snapshot");
});

process.once("exit", () => {
  fetchSpy.mockRestore();
  liveSpy.mockRestore();
});
