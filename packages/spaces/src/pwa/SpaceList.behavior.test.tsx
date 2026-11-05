import { afterEach, expect, spyOn, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../ui/test/dom";
import type { SpaceListFilter } from "./paths";
import type { PwaGroup, PwaRow, PwaSpace } from "./space";

const waitFor = async (condition: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

/** Invented demo data. */
const row = (shortId: string, title: string, extra: Partial<PwaRow> = {}): PwaRow => ({
  shortId,
  title,
  statusId: "Col001",
  completed: false,
  startsAt: null,
  endsAt: null,
  deadline: null,
  deadlineAllDay: true,
  overdue: false,
  blocked: false,
  checklist: null,
  tags: [],
  people: [],
  ...extra,
});
const inbox = (rows: PwaRow[], total = rows.length, pages = 1): PwaGroup => ({
  statusId: "Col001",
  total,
  pages,
  totalPages: Math.ceil(total / 30),
  rows,
});
const done = (rows: PwaRow[] = [], total = 7, pages = 0): PwaGroup => ({ statusId: "Col003", total, pages, totalPages: 1, rows });
const space = (groups: PwaGroup[], extra: Partial<PwaSpace> = {}): PwaSpace => ({
  shortId: "Space1",
  name: "Summer fair",
  color: "#16a34a",
  canWrite: true,
  statuses: [
    { id: "Col001", name: "Inbox", color: "#94a3b8", done: false },
    { id: "Col003", name: "Done", color: "#16a34a", done: true },
  ],
  tags: [{ id: "Tag001", name: "Supplier", color: "#0e7490" }],
  filter: { mine: false, tagIds: [], search: "" },
  groups,
  ...extra,
});
const firstPage = Array.from({ length: 30 }, (_, index) => row(`Item${String(index + 10)}`, `Task ${index + 1}`));

let liveApply: (() => Promise<void>) | undefined;
let liveReady: ((ready: boolean) => void) | undefined;
let liveClosed = 0;
let subscriptions = 0;
spyOn(await import("@k2b/cloud/browser/live"), "liveConnection").mockImplementation(() => ({
  subscribe: (_channel, _scope, handlers) => {
    subscriptions += 1;
    liveReady = (ready) => handlers.caughtUp?.(ready);
    liveApply = () =>
      handlers.apply([{ data: handlers.parse({ type: "item.updated", spaceId: "Space1", itemId: "Item01" }), cursor: "1" }]);
    return {
      close: () => {
        liveClosed += 1;
      },
    };
  },
}));

type Call = { method: string; path: string; search: URLSearchParams; body: unknown };
const calls: Call[] = [];
let route: (call: Call) => Response | Promise<Response> | "offline" | undefined = () => undefined;
spyOn(globalThis, "fetch").mockImplementation(
  Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost/");
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      const call = { method: init?.method ?? "GET", path: url.pathname, search: url.searchParams, body };
      calls.push(call);
      const answer = route(call) ?? Response.json({ message: "Unavailable" }, { status: 503 });
      if (answer === "offline") throw new TypeError("Failed to fetch");
      return answer;
    },
    { preconnect: globalThis.fetch.preconnect },
  ),
);

const load = async () => {
  const dom = createDomTestHarness();
  try {
    return { ui: await import("@k2b/ui"), SpaceList: (await import("./SpaceList")).default };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();

let dom: DomTestHarness | undefined;
let dispose = () => {};
afterEach(() => {
  dispose();
  modules?.ui.toast.dismissAll();
  dom?.cleanup();
  calls.length = 0;
  route = () => undefined;
  liveApply = undefined;
  liveReady = undefined;
  liveClosed = 0;
  subscriptions = 0;
});

const mount = (initial: PwaSpace | null | undefined, options: { online?: boolean; searching?: boolean; locale?: string } = {}) => {
  const { ui, SpaceList } = modules!;
  dom = createDomTestHarness();
  delegateEvents(["click", "input"]);
  dom.window.history.replaceState(null, "", "/pwa/spaces/Space1");
  const [filter, setFilter] = createSignal<SpaceListFilter>(initial?.filter ?? { mine: false, tagIds: [], search: "" });
  const changes: SpaceListFilter[] = [];
  dispose = render(
    () =>
      createComponent(ui.LocaleProvider, {
        locale: options.locale ?? "en",
        get children() {
          return createComponent(SpaceList, {
            userId: "0b8f2d4e-1c3a-4f5b-9d6e-7a8b9c0d1e2f",
            spaceShortId: "Space1",
            entry: { shortId: "Space1", name: "Summer fair", color: "#16a34a", openCount: 3, canWrite: true, pinned: false },
            initial,
            get filter() {
              return filter();
            },
            dateConfig: { locale: "en", timeZone: "UTC" },
            online: options.online ?? true,
            searching: options.searching ?? false,
            onFilterChange: (next: SpaceListFilter) => {
              changes.push(next);
              setFilter(next);
            },
            onSearchClose: () => {},
            taskHref: (entry: PwaRow) => `/pwa/spaces/Space1/${entry.shortId}?list=space`,
            onOpen: () => {},
          });
        },
      }),
    dom.root,
  );
  return { root: dom.root, changes };
};

const titles = (root: HTMLElement) => [...root.querySelectorAll(".spaces-pwa__title")].map((title) => title.textContent);
const heads = (root: HTMLElement) =>
  [...root.querySelectorAll(".spaces-pwa-space__group-head")].map((head) => `${head.textContent} ${head.getAttribute("aria-expanded")}`);
const button = (root: HTMLElement, text: string) =>
  [...root.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.trim() === text);
const OPEN_TOAST = "[data-k2b-toast]:not([data-closing])";
const toasts = () => [...dom!.document.querySelectorAll(OPEN_TOAST)].map((toast) => toast.textContent ?? "");
const toastAction = (label: string) =>
  [...dom!.document.querySelectorAll<HTMLButtonElement>(`${OPEN_TOAST} .k2b-toast__action`)].find((action) => action.textContent === label);

if (isServer) test.skip("requires browser conditions", () => {});
else {
  test("each status shows its first 30 rows and loads the next page in place; a failed page offers Retry at its end", async () => {
    const { root } = mount(space([inbox(firstPage, 42), done()]));
    expect(heads(root)).toEqual(["Inbox42 true", "Done7 false"]);
    expect(titles(root)).toHaveLength(30);
    route = () => "offline";
    button(root, "Load 12 more")!.click();
    await waitFor(() => root.textContent?.includes("More could not be loaded.") ?? false, "the failed page");
    expect(calls.at(-1)?.search.get("status")).toBe("Col001");
    expect(calls.at(-1)?.search.get("page")).toBe("2");
    const kept = root.querySelector(".spaces-pwa__title");
    route = ({ search }) =>
      search.get("status") === "Col001"
        ? Response.json(
            inbox(
              Array.from({ length: 12 }, (_, index) => row(`Next${index}`, `Later ${index + 1}`)),
              42,
            ),
          )
        : undefined;
    button(root, "Try again")!.click();
    await waitFor(() => titles(root).length === 42, "the second page");
    // The rows already shown keep their elements.
    expect(root.querySelector(".spaces-pwa__title")).toBe(kept);
    expect(button(root, "Load 12 more")).toBeUndefined();
  });

  test("a done status starts folded with its count and reads its rows when unfolded; its check reopens", async () => {
    const { root } = mount(space([inbox([row("Item01", "Order the tents")]), done()]));
    route = ({ search }) =>
      search.get("status") === "Col003"
        ? Response.json(done([row("Item09", "Print posters", { completed: true, statusId: "Col003" })], 7, 1))
        : undefined;
    root.querySelectorAll<HTMLButtonElement>(".spaces-pwa-space__group-head")[1]!.click();
    expect(heads(root)).toEqual(["Inbox1 true", "Done7 true"]);
    await waitFor(() => titles(root).includes("Print posters"), "the done rows");
    const reopen = root.querySelector<HTMLButtonElement>('[aria-label="Reopen “Print posters”"]')!;
    expect(reopen.getAttribute("aria-pressed")).toBe("true");
    let reopened: unknown;
    route = (call) => {
      if (call.method === "POST" && call.path.endsWith("/completed")) {
        reopened = call.body;
        return Response.json({});
      }
      return Response.json(space([inbox([row("Item01", "Order the tents"), row("Item09", "Print posters")]), done([], 6, 1)]));
    };
    reopen.click();
    await waitFor(() => heads(root).includes("Inbox2 true"), "the reopened task in its open status");
    expect(reopened).toEqual({ completed: false });
    // The read covers the page the done status shows.
    expect(calls.at(-1)?.search.getAll("load")).toEqual(["Col003:1"]);
  });

  test("checking off removes the row at once with Undo, which reopens it after the completion", async () => {
    const { root } = mount(space([inbox([row("Item01", "Order the tents"), row("Item02", "Write the flyer")]), done()]));
    const sent: unknown[] = [];
    route = (call) => {
      if (call.method === "POST") {
        sent.push(call.body);
        return Response.json({});
      }
      return Response.json(space([inbox([row("Item02", "Write the flyer")]), done([], 8)]));
    };
    root.querySelector<HTMLButtonElement>('[aria-label="Mark “Order the tents” as done"]')!.click();
    expect(titles(root)).toEqual(["Write the flyer"]);
    await waitFor(() => heads(root).includes("Done8 false"), "the completion read");
    expect(toasts().some((text) => text.includes("Done"))).toBe(true);
    route = (call) => {
      if (call.method === "POST") {
        sent.push(call.body);
        return Response.json({});
      }
      return Response.json(space([inbox([row("Item01", "Order the tents"), row("Item02", "Write the flyer")]), done()]));
    };
    toastAction("Undo")!.click();
    await waitFor(() => titles(root).length === 2, "the reopened row");
    expect(sent).toEqual([{ completed: true }, { completed: false }]);
  });

  test("a check that cannot reach the server springs back and offers Retry", async () => {
    const { root } = mount(space([inbox([row("Item01", "Order the tents")]), done()]));
    route = () => "offline";
    root.querySelector<HTMLButtonElement>('[aria-label="Mark “Order the tents” as done"]')!.click();
    await waitFor(() => toasts().some((text) => text.includes("could not be marked as done")), "the failure");
    expect(titles(root)).toEqual(["Order the tents"]);
    expect(toastAction("Try again")).toBeDefined();
  });

  test("filters narrow the list: statuses without a match step aside, and no match offers Reset filters", async () => {
    const { root, changes } = mount(space([inbox([row("Item01", "Order the tents")]), done()]));
    route = ({ search }) =>
      search.get("mine") === "1"
        ? Response.json(space([inbox([]), done([], 0)], { filter: { mine: true, tagIds: [], search: "" } }))
        : undefined;
    root.querySelector<HTMLButtonElement>(".spaces-pwa-space__filters button")!.click();
    expect(changes.at(-1)).toEqual({ mine: true, tagIds: [], search: "" });
    // The chips and the last rows stay while the narrower list loads.
    expect(root.querySelector(".spaces-pwa-space__filters")).not.toBeNull();
    await waitFor(() => root.textContent?.includes("No task is assigned to you") ?? false, "the empty filter");
    expect(button(root, "Reset filters")).toBeDefined();
    expect(button(root, "Reset")).toBeDefined();
    button(root, "Reset filters")!.click();
    expect(changes.at(-1)).toEqual({ mine: false, tagIds: [], search: "" });
  });

  test("the search counts its matches in open tasks and keeps them in the address", async () => {
    const { root, changes } = mount(space([inbox([row("Item01", "Order the tents")]), done()]), { searching: true });
    expect(root.querySelector(".spaces-pwa-space__filters")).toBeNull();
    route = ({ search }) =>
      search.get("q") === "tent"
        ? Response.json(space([inbox([row("Item01", "Order the tents")])], { filter: { mine: false, tagIds: [], search: "tent" } }))
        : undefined;
    const field = root.querySelector<HTMLInputElement>(".spaces-pwa-space__search input")!;
    field.value = "tent";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => changes.at(-1)?.search === "tent", "the search in the address");
    await waitFor(() => root.querySelector(".spaces-pwa-space__hits")?.textContent === "1 match in open tasks", "the count");
    expect(heads(root)).toEqual(["Inbox1 true"]);
  });

  test("offline the checks stay off; a Space that loads offline says it waits for the connection", async () => {
    const shown = mount(space([inbox([row("Item01", "Order the tents")]), done()]), { online: false });
    await Bun.sleep(0);
    expect(shown.root.querySelector<HTMLButtonElement>("button.spaces-pwa__check")?.disabled).toBe(true);
    dispose();
    dom?.cleanup();
    route = () => "offline";
    const loading = mount(undefined, { online: false });
    expect(loading.root.querySelector('[aria-busy="true"]')).not.toBeNull();
    await waitFor(
      () => loading.root.textContent?.includes("Offline. The Space loads again with a connection.") ?? false,
      "the offline state",
    );
    expect(loading.root.textContent).toContain("“Summer fair” could not be loaded");
    route = () => Response.json(space([inbox([row("Item01", "Order the tents")])]));
    button(loading.root, "Try again")!.click();
    await waitFor(() => titles(loading.root).includes("Order the tents"), "the Space after Retry");
  });

  test("a live change reads the Space again, and lost access says so with the way back", async () => {
    const { root } = mount(space([inbox([row("Item01", "Order the tents")]), done()]));
    route = () => Response.json({ message: "Not found" }, { status: 404 });
    await waitFor(() => liveApply !== undefined, "the subscription");
    await liveApply!();
    await waitFor(() => root.textContent?.includes("You no longer have access to “Summer fair”") ?? false, "the lost access");
    expect(root.querySelector('a[href="/pwa/spaces"]')?.textContent).toContain("To My tasks");
    // Without access the Space's channel closes.
    await waitFor(() => liveClosed > 0, "the closed channel");
  });

  test("a fresh read keeps the one live subscription, so a caught-up channel reads the Space once", async () => {
    mount(space([inbox([row("Item01", "Order the tents")]), done()]));
    route = () => Response.json(space([inbox([row("Item01", "Order the tents"), row("Item02", "Write the flyer")]), done()]));
    await waitFor(() => liveReady !== undefined, "the subscription");
    liveReady!(true);
    await waitFor(() => calls.length === 1, "the read after catching up");
    await Bun.sleep(400);
    expect(subscriptions).toBe(1);
    expect(calls).toHaveLength(1);
  });

  test("a page asked for under another filter never mixes into the new one", async () => {
    const { root } = mount(space([inbox(firstPage, 42), done()]));
    let answerPage: (response: Response) => void = () => {};
    route = ({ search }) =>
      search.get("status")
        ? new Promise<Response>((resolve) => {
            answerPage = resolve;
          })
        : Response.json(
            space([inbox([row("Item01", "Order the tents")]), done([], 0)], { filter: { mine: true, tagIds: [], search: "" } }),
          );
    button(root, "Load 12 more")!.click();
    root.querySelector<HTMLButtonElement>(".spaces-pwa-space__filters button")!.click();
    await waitFor(() => titles(root).length === 1, "the narrower list");
    answerPage(Response.json(inbox([row("Late01", "Unassigned task")], 42)));
    await Bun.sleep(20);
    expect(titles(root)).toEqual(["Order the tents"]);
  });

  test("a done status whose first page fails offers Retry instead of waiting", async () => {
    const { root } = mount(space([inbox([row("Item01", "Order the tents")]), done()]));
    route = () => "offline";
    root.querySelectorAll<HTMLButtonElement>(".spaces-pwa-space__group-head")[1]!.click();
    await waitFor(() => root.textContent?.includes("More could not be loaded.") ?? false, "the failed first page");
    expect(button(root, "Try again")).toBeDefined();
  });

  test("an empty Space says so, and the German list names its parts in German", async () => {
    const empty = mount(space([inbox([]), done([], 0)]), { locale: "de" });
    expect(empty.root.textContent).toContain("Noch keine Aufgaben in „Summer fair“");
    expect(empty.root.querySelector(".spaces-pwa-space__filters")).toBeNull();
    dispose();
    dom?.cleanup();
    const full = mount(space([inbox([row("Item01", "Order the tents", { blocked: true, checklist: { done: 5, total: 12 } })]), done()]), {
      locale: "de",
    });
    expect(full.root.querySelector(".spaces-pwa-space__blocked")?.textContent).toBe("Blockiert");
    expect(full.root.querySelector('[aria-label="Checkliste 5 von 12"]')?.textContent).toBe("5/12");
    expect(button(full.root, "Zurücksetzen")).toBeUndefined();
  });
}
