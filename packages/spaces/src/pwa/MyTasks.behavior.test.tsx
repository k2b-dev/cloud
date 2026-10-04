import { expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../ui/test/dom";
import type { OverviewView, OverviewWork } from "../overview-contracts";

const waitFor = async (condition: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

/** Invented demo work. */
const task = (shortId: string, title: string): OverviewWork["items"][number] => ({
  shortId,
  spaceShortId: "Space1",
  spaceName: "Summer fair",
  spaceColor: "#16a34a",
  title,
  priority: null,
  startsAt: null,
  endsAt: null,
  deadline: null,
});
const tents = task("Item01", "Order the tents");
const flyer = task("Item02", "Write the flyer");
const snapshot = (view: OverviewView, items: OverviewWork["items"]): OverviewWork => ({
  view,
  counts: { mine: items.length, today: 0, upcoming: 3 },
  items,
});

type Call = { method: string; path: string; search: string; body: unknown };
type Answer = Response | Promise<Response> | "offline";
const mockFetch = (route: (call: Call) => Answer | undefined) => {
  const calls: Call[] = [];
  const spy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input), "http://localhost/");
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        const call = { method: init?.method ?? "GET", path: url.pathname, search: url.search, body };
        calls.push(call);
        const answer = route(call) ?? Response.json({ message: "Unavailable" }, { status: 503 });
        if (answer === "offline") throw new TypeError("Failed to fetch");
        return answer;
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  return { calls, restore: () => spy.mockRestore() };
};
const COMPLETED = "/api/spaces/Space1/items/Item01/completed";
const WORK = "/api/spaces/overview/work";

const load = async () => {
  const dom = createDomTestHarness();
  try {
    return { ui: await import("@k2b/ui"), MyTasks: (await import("./MyTasks.island")).default };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();

type Mounted = { dom: DomTestHarness; reloads: number; dispose: () => void };
const mount = (options: { locale?: string; items?: OverviewWork["items"] } = {}): Mounted => {
  const { ui, MyTasks } = modules!;
  const dom = createDomTestHarness();
  delegateEvents(["click"]);
  dom.window.history.replaceState(null, "", "/pwa/spaces");
  const mounted: Mounted = { dom, reloads: 0, dispose: () => {} };
  Object.assign(dom.window.location, {
    reload: () => {
      mounted.reloads += 1;
    },
  });
  const dispose = render(
    () =>
      createComponent(ui.LocaleProvider, {
        locale: options.locale ?? "en",
        get children() {
          return createComponent(MyTasks, {
            initialView: "mine",
            initialWork: snapshot("mine", options.items ?? [tents, flyer]),
            dateConfig: { locale: options.locale ?? "en", timeZone: "UTC" },
          });
        },
      }),
    dom.root,
  );
  mounted.dispose = () => {
    dispose();
    ui.toast.dismissAll();
    dom.cleanup();
  };
  return mounted;
};

const titles = (dom: DomTestHarness) => [...dom.root.querySelectorAll(".spaces-pwa__title")].map((title) => title.textContent);
const checkButton = (dom: DomTestHarness, title: string) =>
  [...dom.root.querySelectorAll(".spaces-pwa__row")]
    .find((row) => row.querySelector(".spaces-pwa__title")?.textContent === title)
    ?.querySelector<HTMLButtonElement>("button.spaces-pwa__check") ?? null;
/** Open toasts only; a closed one stays in the document while it animates out. */
const OPEN_TOAST = "[data-k2b-toast]:not([data-closing])";
const toasts = (dom: DomTestHarness) => [...dom.document.querySelectorAll(OPEN_TOAST)].map((toast) => toast.textContent ?? "");
const toastAction = (dom: DomTestHarness, label: string) =>
  [...dom.document.querySelectorAll<HTMLButtonElement>(`${OPEN_TOAST} .k2b-toast__action`)].find((action) => action.textContent === label);

if (isServer) test.skip("requires browser conditions", () => {});
else {
  test("checks a task off, keeps its button busy until the list is read again, and Undo reopens it", async () => {
    let finish: (response: Response) => void = () => {};
    let open = [flyer];
    const fetch = mockFetch((call) => {
      if (call.method === "POST" && call.path === COMPLETED) {
        if (call.body && typeof call.body === "object" && "completed" in call.body && call.body.completed === false) {
          open = [tents, flyer];
          return Response.json({});
        }
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }
      if (call.method === "GET" && call.path === WORK) return Response.json(snapshot("mine", open));
      return undefined;
    });
    const page = mount();
    try {
      checkButton(page.dom, "Order the tents")!.click();
      await waitFor(() => fetch.calls.length === 1, "completion request");
      expect(fetch.calls[0]).toMatchObject({ method: "POST", path: COMPLETED, body: { completed: true } });
      expect(checkButton(page.dom, "Order the tents")!.disabled).toBe(true);
      expect(checkButton(page.dom, "Write the flyer")!.disabled).toBe(false);
      // A second tap while the request runs sends nothing.
      checkButton(page.dom, "Order the tents")!.click();
      await Bun.sleep(20);
      expect(fetch.calls).toHaveLength(1);

      finish(Response.json({}));
      await waitFor(() => titles(page.dom).length === 1, "re-read list");
      expect(fetch.calls[1]).toMatchObject({ method: "GET", path: WORK, search: "?view=mine" });
      expect(titles(page.dom)).toEqual(["Write the flyer"]);
      expect(page.dom.root.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toBe("For me 1");
      expect(toasts(page.dom).some((text) => text.includes("Done"))).toBe(true);

      toastAction(page.dom, "Undo")!.click();
      await waitFor(() => titles(page.dom).length === 2, "reopened task");
      expect(fetch.calls.slice(2)).toMatchObject([
        { method: "POST", path: COMPLETED, body: { completed: false } },
        { method: "GET", path: WORK, search: "?view=mine" },
      ]);
    } finally {
      page.dispose();
      fetch.restore();
    }
  });

  test("names the blockers on a 409, in the person's language, and keeps the task", async () => {
    for (const [locale, message] of [
      ["en", "Complete all blocking tasks first"],
      ["de", "Schließe zuerst alle blockierenden Aufgaben ab."],
    ] as const) {
      const fetch = mockFetch(() => Response.json({ message: "Complete all blocking tasks first" }, { status: 409 }));
      const page = mount({ locale });
      try {
        checkButton(page.dom, "Order the tents")!.click();
        await waitFor(() => toasts(page.dom).length === 1, "blocked notice");
        expect(toasts(page.dom)[0]).toContain(message);
        expect(toastAction(page.dom, locale === "de" ? "Erneut versuchen" : "Retry")).toBeUndefined();
        expect(fetch.calls).toHaveLength(1);
        expect(titles(page.dom)).toEqual(["Order the tents", "Write the flyer"]);
        await waitFor(() => !checkButton(page.dom, "Order the tents")!.disabled, "button free again");
      } finally {
        page.dispose();
        fetch.restore();
      }
    }
  });

  test("reloads once when the app session has ended, so the page renews it or leads to pairing", async () => {
    const fetch = mockFetch(() => Response.json({ message: "Authentication required" }, { status: 401 }));
    const page = mount();
    try {
      checkButton(page.dom, "Order the tents")!.click();
      await waitFor(() => page.reloads === 1, "reload");
      await Bun.sleep(20);
      expect(toasts(page.dom)).toEqual([]);
      expect(fetch.calls).toHaveLength(1);
    } finally {
      page.dispose();
      fetch.restore();
    }
  });

  test("offers Retry after a failed or offline request, and Retry saves the task", async () => {
    const answers: Answer[] = [Response.json({ message: "Unavailable" }, { status: 503 }), "offline", Response.json({})];
    const fetch = mockFetch((call) =>
      call.method === "POST" ? answers.shift() : call.path === WORK ? Response.json(snapshot("mine", [flyer])) : undefined,
    );
    const page = mount();
    try {
      checkButton(page.dom, "Order the tents")!.click();
      await waitFor(() => toastAction(page.dom, "Retry") !== undefined, "first Retry");
      expect(toasts(page.dom)[0]).toContain("“Order the tents” could not be marked as done.");
      expect(checkButton(page.dom, "Order the tents")!.disabled).toBe(false);

      toastAction(page.dom, "Retry")!.click();
      await waitFor(() => fetch.calls.length === 2 && toastAction(page.dom, "Retry") !== undefined, "offline Retry");
      toastAction(page.dom, "Retry")!.click();
      await waitFor(() => titles(page.dom).length === 1, "saved on Retry");
      expect(fetch.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
        `POST ${COMPLETED}`,
        `POST ${COMPLETED}`,
        `POST ${COMPLETED}`,
        `GET ${WORK}`,
      ]);
    } finally {
      page.dispose();
      fetch.restore();
    }
  });

  test("switches the view in place and keeps it in the address", async () => {
    const fetch = mockFetch((call) =>
      call.path === WORK ? Response.json(snapshot("upcoming", [task("Item09", "Book the band")])) : undefined,
    );
    const page = mount();
    try {
      const upcoming = [...page.dom.root.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((radio) =>
        radio.textContent?.startsWith("Upcoming"),
      )!;
      upcoming.click();
      await waitFor(() => titles(page.dom).includes("Book the band"), "upcoming work");
      expect(fetch.calls[0]).toMatchObject({ method: "GET", path: WORK, search: "?view=upcoming" });
      expect(page.dom.window.location.pathname + page.dom.window.location.search).toBe("/pwa/spaces?view=upcoming");
    } finally {
      page.dispose();
      fetch.restore();
    }
  });
}
