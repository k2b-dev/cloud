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
});

const mount = (path: string, initialTask?: PwaTask) => {
  const { ui, SpacesPwa } = modules!;
  dom = createDomTestHarness();
  delegateEvents(["click"]);
  dom.window.history.replaceState(null, "", path);
  dispose = render(
    () =>
      createComponent(ui.LocaleProvider, {
        locale: "en",
        get children() {
          return createComponent(SpacesPwa, {
            userId: "0b8f2d4e-1c3a-4f5b-9d6e-7a8b9c0d1e2f",
            initialView: "mine",
            initialWork: work,
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
  expect(requests).toEqual(["GET /pwa/spaces/Space1/Item01 application/json"]);

  waiting.get("/pwa/spaces/Space1/Item01")!(Response.json(detail("Item01", "Order the tents")));
  await waitFor(() => root.textContent?.includes("About Order the tents.") ?? false, "the task");
  expect(root.querySelector(".spaces-pwa-task__loading")).toBeNull();
});

test("a later tap wins over a task that is still loading", async () => {
  const root = mount("/pwa/spaces");
  root.querySelector<HTMLAnchorElement>('.spaces-pwa__copy[href="/pwa/spaces/Space1/Item01"]')!.click();
  root.querySelector<HTMLAnchorElement>('.spaces-pwa__copy[href="/pwa/spaces/Space1/Item02"]')!.click();
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
  expect(back.getAttribute("aria-label")).toBe("Back to Spaces");
  back.click();
  expect(location.pathname).toBe("/pwa/spaces");
  expect(level(root)).toEqual(["1 2 3", "2 3"]);
  expect(root.textContent).toContain("No task selected");

  root.querySelector<HTMLAnchorElement>('.spaces-pwa__copy[href="/pwa/spaces/Space1/Item02"]')!.click();
  waiting.get("/pwa/spaces/Space1/Item02")!(Response.json({ message: "Unavailable" }, { status: 503 }));
  await waitFor(() => root.textContent?.includes("The task could not be loaded.") ?? false, "the failure");
  expect(root.querySelector(".spaces-pwa-task__title h3")?.textContent).toBe("Write the flyer");
  [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Try again")!.click();
  expect(requests.at(-1)).toBe("GET /pwa/spaces/Space1/Item02 application/json");
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
  waiting.get("/pwa/spaces/Space1/Item02")!(Response.json(detail("Item02", "Write the flyer")));
  await waitFor(() => root.textContent?.includes("About Write the flyer.") ?? false, "the flyer");
  await Bun.sleep(20);
  expect(root.textContent).not.toContain("Order the tents.");
});

test("a task that fails to load after Back offers Retry instead of calling it deleted", async () => {
  const root = mount("/pwa/spaces");
  travel("/pwa/spaces/Space1/Item01");
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

process.once("exit", () => fetchSpy.mockRestore());
