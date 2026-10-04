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
const snapshot = (view: OverviewView, items: OverviewWork["items"], mine = items.length): OverviewWork => ({
  view,
  counts: { mine, today: 0, upcoming: 3 },
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
const ITEM = "/api/spaces/Space1/items/Item01";
const COMPLETED = `${ITEM}/completed`;
const USER_ID = "0b8f2d4e-1c3a-4f5b-9d6e-7a8b9c0d1e2f";
const claimBy = (id: string, displayName: string) => ({
  claim: { id: "5c1d7e9a-2b4f-4a6c-8e0d-1f3a5b7c9d2e", actor: { kind: "user", id }, displayName },
});
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
const mount = (options: { locale?: string; items?: OverviewWork["items"]; mine?: number } = {}): Mounted => {
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
            userId: USER_ID,
            initialView: "mine",
            initialWork: snapshot("mine", options.items ?? [tents, flyer], options.mine),
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

  test("names the blockers on a 409 in the server's words, without Retry, and keeps the task", async () => {
    // The Spaces API words its refusals in the request's language; the app shows them as they are.
    for (const [locale, message] of [
      ["en", "Complete all blocking tasks first"],
      ["de", "Schließe zuerst alle blockierenden Aufgaben ab."],
    ] as const) {
      const fetch = mockFetch((call) =>
        call.method === "POST"
          ? Response.json({ message }, { status: 409 })
          : call.path === ITEM
            ? Response.json({ claim: null })
            : call.path === WORK
              ? Response.json(snapshot("mine", [tents, flyer]))
              : undefined,
      );
      const page = mount({ locale });
      try {
        checkButton(page.dom, "Order the tents")!.click();
        await waitFor(() => toasts(page.dom).length === 1, "blocked notice");
        expect(toasts(page.dom)[0]).toContain(message);
        expect(toastAction(page.dom, locale === "de" ? "Erneut versuchen" : "Retry")).toBeUndefined();
        await waitFor(() => !checkButton(page.dom, "Order the tents")!.disabled, "button free again");
        expect(fetch.calls.map((call) => `${call.method} ${call.path}`)).toEqual([`POST ${COMPLETED}`, `GET ${ITEM}`, `GET ${WORK}`]);
        expect(titles(page.dom)).toEqual(["Order the tents", "Write the flyer"]);
      } finally {
        page.dispose();
        fetch.restore();
      }
    }
  });

  test("completes a task the person claimed with its claim, as on the web", async () => {
    const fetch = mockFetch((call) => {
      if (call.method === "POST") {
        const body = call.body as { claimId?: string };
        return body.claimId === claimBy(USER_ID, "Mia Muster").claim.id
          ? Response.json({})
          : Response.json(
              { message: "Task is claimed; release its current claim before changing ownership or completing it" },
              { status: 409 },
            );
      }
      if (call.path === ITEM) return Response.json(claimBy(USER_ID, "Mia Muster"));
      if (call.path === WORK) return Response.json(snapshot("mine", [flyer]));
      return undefined;
    });
    const page = mount();
    try {
      checkButton(page.dom, "Order the tents")!.click();
      await waitFor(() => titles(page.dom).length === 1, "re-read list");
      expect(fetch.calls).toMatchObject([
        { method: "POST", path: COMPLETED, body: { completed: true } },
        { method: "GET", path: ITEM },
        { method: "POST", path: COMPLETED, body: { completed: true, claimId: claimBy(USER_ID, "").claim.id } },
        { method: "GET", path: WORK },
      ]);
      expect(toasts(page.dom).some((text) => text.includes("Done"))).toBe(true);
    } finally {
      page.dispose();
      fetch.restore();
    }
  });

  test("names the person working on a task someone else claimed", async () => {
    const fetch = mockFetch((call) =>
      call.method === "POST"
        ? Response.json(
            { message: "Task is claimed; release its current claim before changing ownership or completing it" },
            { status: 409 },
          )
        : call.path === ITEM
          ? Response.json(claimBy("9e7d5c3b-1a2f-4e6d-8c0b-3a5f7e9d1c4b", "Jonas Beispiel"))
          : call.path === WORK
            ? Response.json(snapshot("mine", [tents, flyer]))
            : undefined,
    );
    const page = mount();
    try {
      checkButton(page.dom, "Order the tents")!.click();
      await waitFor(() => toasts(page.dom).length === 1, "claimed notice");
      expect(toasts(page.dom)[0]).toContain(
        "Jonas Beispiel is working on “Order the tents”. Take it over in Spaces on the web to finish it.",
      );
      expect(toastAction(page.dom, "Retry")).toBeUndefined();
      expect(fetch.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    } finally {
      page.dispose();
      fetch.restore();
    }
  });

  test("says why without Retry when the Space is read-only or the task is gone, and reads the list again", async () => {
    for (const [status, message, after] of [
      [403, "You cannot change tasks in “Summer fair”.", [tents, flyer]],
      [404, "“Order the tents” is no longer available.", [flyer]],
    ] as const) {
      const fetch = mockFetch((call) =>
        call.method === "POST"
          ? Response.json({ message: "Refused" }, { status })
          : call.path === WORK
            ? Response.json(snapshot("mine", [...after]))
            : undefined,
      );
      const page = mount();
      try {
        checkButton(page.dom, "Order the tents")!.click();
        await waitFor(() => toasts(page.dom).length === 1 && titles(page.dom).length === after.length, `${status} notice`);
        expect(toasts(page.dom)[0]).toContain(message);
        expect(toastAction(page.dom, "Retry")).toBeUndefined();
        expect(fetch.calls.map((call) => `${call.method} ${call.path}`)).toEqual([`POST ${COMPLETED}`, `GET ${WORK}`]);
      } finally {
        page.dispose();
        fetch.restore();
      }
    }
  });

  test("shows an all-day event as all day and says how many items the bounded list leaves out", async () => {
    const fair = {
      ...task("Item03", "Summer fair"),
      startsAt: "2026-10-04T00:00:00.000Z",
      endsAt: "2026-10-05T00:00:00.000Z",
    };
    const meeting = {
      ...task("Item04", "Planning meeting"),
      startsAt: "2026-10-04T00:00:00.000Z",
      endsAt: "2026-10-04T01:00:00.000Z",
    };
    const page = mount({ items: [fair, meeting, tents], mine: 1_234 });
    try {
      const when = [...page.dom.root.querySelectorAll(".spaces-pwa__when")].map((time) => time.textContent ?? "");
      expect(when[0]).toContain("All day");
      expect(when[0]).not.toContain("00:00");
      expect(when[1]).toContain("00:00–01:00");
      expect(page.dom.root.querySelector(".spaces-pwa__more")?.textContent).toBe("1,231 more in Spaces on the web");
    } finally {
      page.dispose();
    }
    const complete = mount();
    try {
      expect(complete.dom.root.querySelector(".spaces-pwa__more")).toBeNull();
    } finally {
      complete.dispose();
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
