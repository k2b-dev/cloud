import { afterAll, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import type { MaintenanceStatus } from "@k2b/cloud/contracts/maintenance";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../../../ui/test/dom";

// 14:10 in Berlin; every time below is read in that zone.
const NOW = new Date("2026-11-16T13:10:00.000Z");
const PATH = "/admin/settings/maintenance";
/** What the server suggests at 14:10: 15:15 in Berlin. */
const SUGGESTED = "2026-11-16T14:15:00.000Z";

const off: MaintenanceStatus = { active: false, apps: { ready: 11, total: 11, starting: [] } };
const active: MaintenanceStatus = {
  active: true,
  startedAt: "2026-11-16T13:02:00.000Z",
  startedBy: { id: "u-lea", label: "Lea Muster" },
  until: "2026-11-16T13:30:00.000Z",
  apps: { ready: 9, total: 11, starting: ["files", "mail"] },
};

const waitFor = async (condition: () => boolean, label: string, timeoutMs = 2_000) => {
  for (let attempt = 0; attempt < timeoutMs / 10; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const mockFetch = (route: (method: string, path: string, body: unknown, url: URL) => Response | Promise<Response> | undefined) => {
  const calls: { method: string; path: string; body: unknown; url: string }[] = [];
  const spy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(new URL(String(input), "http://localhost/"), init);
        const url = new URL(request.url);
        const text = await request.text();
        const body: unknown = text ? JSON.parse(text) : undefined;
        calls.push({ method: request.method, path: url.pathname, body, url: url.href });
        return route(request.method, url.pathname, body, url) ?? Response.json({ code: "UNAVAILABLE" }, { status: 503 });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  return { calls, restore: () => spy.mockRestore() };
};

const load = async () => {
  const dom = createDomTestHarness();
  try {
    return { ui: await import("@k2b/ui"), Maintenance: (await import("./Maintenance.island.tsx")).default };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();

const mount = (dom: DomTestHarness, initial: MaintenanceStatus, suggestedEnd = SUGGESTED) => {
  const { ui, Maintenance } = modules!;
  delegateEvents(["input", "click"]);
  return render(
    () =>
      createComponent(ui.LocaleProvider, {
        locale: "en",
        get children() {
          return createComponent(Maintenance, {
            initial,
            appNames: { files: "Files", mail: "Mail" },
            dateConfig: { timeZone: "Europe/Berlin", locale: "en" },
            path: PATH,
            suggestedEnd,
          });
        },
      }),
    dom.root,
  );
};
const button = (dom: DomTestHarness, label: string, scope = "body") =>
  [...dom.document.querySelectorAll<HTMLButtonElement>(`${scope} button`)].find((element) => element.textContent?.trim() === label);
const type = (element: HTMLInputElement | HTMLTextAreaElement | null | undefined, value: string) => {
  if (!element) throw new Error("Missing field");
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
};
const apiCalls = (calls: { method: string; path: string }[]) => calls.map((call) => `${call.method} ${call.path}`);
const bypassLink = (token: string) => ({
  url: `https://cloud.test/?cloud-maintenance-bypass=${token}`,
  expiresAt: "2026-11-17T01:10:00.000Z",
});

/**
 * The gateway's half as the page meets it: the link answers a redirect and lets this browser in only for a token the
 * gateway accepts; its status reports `bypass: true` only after that.
 */
const gateway = (accepts: (token: string) => boolean) => {
  let inside = false;
  return {
    route: (method: string, path: string, url: URL): Response | undefined => {
      if (method === "GET" && path === PATH && url.searchParams.has("cloud-maintenance-bypass")) {
        if (accepts(url.searchParams.get("cloud-maintenance-bypass")!)) inside = true;
        return new Response(null, { status: 303, headers: { Location: PATH } });
      }
      if (method === "GET" && path === "/_cloud/gateway/status")
        return Response.json({ maintenance: { active: true, until: null, ...(inside ? { bypass: true } : {}) } });
      return undefined;
    },
  };
};
/** A promise the test settles when it chooses. */
const deferred = <T,>() => {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
};

if (isServer) test.skip("requires browser conditions", () => {});
else {
  beforeAll(() => setSystemTime(NOW));
  afterAll(() => setSystemTime());

  test("starting switches maintenance on, lets this browser past the wall on this page's origin, then reloads", async () => {
    const dom = createDomTestHarness();
    const navigate = spyOn(dom.window.location, "assign").mockImplementation(() => {});
    const reload = spyOn(dom.window.location, "reload").mockImplementation(() => {});
    const wall = gateway((token) => token === "token");
    const fetch = mockFetch((method, path, _body, url) => {
      if (method === "POST" && path === "/api/admin/maintenance/on")
        return Response.json({ ...active, message: "Wir spielen Version 2.4 ein." });
      if (method === "POST" && path === "/api/admin/maintenance/bypass") return Response.json(bypassLink("token"));
      return wall.route(method, path, url);
    });
    const dispose = mount(dom, off);
    try {
      type(dom.root.querySelector("textarea"), "Wir spielen Version 2.4 ein.");
      button(dom, "Start maintenance")!.click();
      await waitFor(() => reload.mock.calls.length > 0, "reload");
      expect(apiCalls(fetch.calls)).toEqual([
        "POST /api/admin/maintenance/on",
        "POST /api/admin/maintenance/bypass",
        `GET ${PATH}`,
        "GET /_cloud/gateway/status",
      ]);
      expect(fetch.calls[0]!.body).toEqual({ message: "Wir spielen Version 2.4 ein.", until: SUGGESTED });
      // The link is followed on this page's origin, not the link's host, so the host-only cookie lands here.
      expect(fetch.calls[2]!.url).toBe(`http://localhost${PATH}?cloud-maintenance-bypass=token`);
      // The browser does not leave the page; the reload comes only after the gateway confirmed the bypass.
      expect(navigate).not.toHaveBeenCalled();
      expect(reload).toHaveBeenCalledTimes(1);
      // Until the reload, the page shows the running maintenance and keeps its action busy.
      expect(dom.root.textContent).toContain("Everyone except you sees the maintenance page right now.");
    } finally {
      dispose();
      fetch.restore();
      navigate.mockRestore();
      reload.mockRestore();
      dom.cleanup();
    }
  });

  test("while starting, End maintenance is disabled and not announced as ending", async () => {
    const dom = createDomTestHarness();
    const link = deferred<Response>();
    const fetch = mockFetch((method, path) => {
      if (method === "POST" && path === "/api/admin/maintenance/on") return Response.json(active);
      if (method === "POST" && path === "/api/admin/maintenance/bypass") return link.promise;
      return undefined;
    });
    const dispose = mount(dom, off);
    try {
      button(dom, "Start maintenance")!.click();
      await waitFor(() => Boolean(button(dom, "End maintenance")), "running state while the link is pending");
      const end = button(dom, "End maintenance")!;
      expect(end.disabled).toBe(true);
      expect(end.getAttribute("aria-busy")).toBeNull();
      expect(end.getAttribute("aria-label")).toBeNull();
      expect(dom.root.textContent).not.toContain("Ending maintenance…");
      expect(button(dom, "Move end")!.disabled).toBe(true);
    } finally {
      link.settle(Response.json({ code: "INTERNAL" }, { status: 500 }));
      dispose();
      fetch.restore();
      dom.cleanup();
    }
  });

  test("an end that has passed meanwhile stays in the form with a reason and starts nothing", async () => {
    const dom = createDomTestHarness();
    const fetch = mockFetch(() => undefined);
    // The page stayed open: its suggestion now lies in the past.
    const dispose = mount(dom, off, "2026-11-16T12:00:00.000Z");
    try {
      button(dom, "Start maintenance")!.click();
      await waitFor(() => (dom.root.textContent ?? "").includes("This time has already passed."), "time error");
      expect(fetch.calls).toEqual([]);
    } finally {
      dispose();
      fetch.restore();
      dom.cleanup();
    }
  });

  test("a failed start says nothing changed and lets the admin try again", async () => {
    const dom = createDomTestHarness();
    const navigate = spyOn(dom.window.location, "assign").mockImplementation(() => {});
    const fetch = mockFetch(() => Response.json({ code: "INTERNAL" }, { status: 500 }));
    const dispose = mount(dom, off);
    try {
      button(dom, "Start maintenance")!.click();
      await waitFor(() => Boolean(dom.root.querySelector('[role="alert"]')), "error");
      expect(dom.root.querySelector('[role="alert"]')!.textContent).toContain("Maintenance did not start.");
      expect(apiCalls(fetch.calls)).toEqual(["POST /api/admin/maintenance/on"]);
      expect(fetch.calls[0]!.body).toEqual({ until: SUGGESTED });
      expect(navigate).not.toHaveBeenCalled();
      expect(button(dom, "Start maintenance")!.disabled).toBe(false);
    } finally {
      dispose();
      fetch.restore();
      navigate.mockRestore();
      dom.cleanup();
    }
  });

  test("after starting, focus lands on the running state instead of falling to the page", async () => {
    const dom = createDomTestHarness();
    const link = deferred<Response>();
    const fetch = mockFetch((method, path) => {
      if (method === "POST" && path === "/api/admin/maintenance/on") return Response.json(active);
      if (method === "POST" && path === "/api/admin/maintenance/bypass") return link.promise;
      return undefined;
    });
    const dispose = mount(dom, off);
    try {
      const start = button(dom, "Start maintenance")!;
      start.focus();
      start.click();
      await waitFor(() => Boolean(dom.root.querySelector("[data-maintenance-active-state]")), "running state");
      await waitFor(() => dom.document.activeElement?.hasAttribute("data-maintenance-active-state") === true, "focus on the state");
      expect(dom.document.activeElement).not.toBe(dom.document.body);
    } finally {
      link.settle(Response.json({ code: "INTERNAL" }, { status: 500 }));
      dispose();
      fetch.restore();
      dom.cleanup();
    }
  });

  test("an end the server refuses says why at the field, not as a general failure", async () => {
    const dom = createDomTestHarness();
    // This browser's clock is behind the server's: the end it still considers future has passed there.
    const fetch = mockFetch((method, path) =>
      method === "POST" && path === "/api/admin/maintenance/on"
        ? Response.json({ message: "until must be in the future", code: "BAD_INPUT" }, { status: 400 })
        : undefined,
    );
    const dispose = mount(dom, off);
    try {
      button(dom, "Start maintenance")!.click();
      await waitFor(() => (dom.root.textContent ?? "").includes("This time has already passed."), "field error");
      expect(dom.root.textContent).not.toContain("Maintenance did not start.");
      expect(button(dom, "Start maintenance")!.disabled).toBe(false);
    } finally {
      dispose();
      fetch.restore();
      dom.cleanup();
    }
  });

  test("a cleared end starts maintenance without a planned end", async () => {
    const dom = createDomTestHarness();
    const fetch = mockFetch(() => Response.json({ code: "INTERNAL" }, { status: 500 }));
    const dispose = mount(dom, off);
    try {
      dom.root.querySelector<HTMLButtonElement>('button[aria-label="Clear date"]')!.click();
      await waitFor(() => !dom.root.querySelector('button[aria-label="Clear date"]'), "end cleared");
      button(dom, "Start maintenance")!.click();
      await waitFor(() => fetch.calls.length > 0, "start request");
      expect(fetch.calls[0]!.body).toEqual({});
    } finally {
      dispose();
      fetch.restore();
      dom.cleanup();
    }
  });

  test("a failed bypass link keeps the running state visible and retries only the link", async () => {
    const dom = createDomTestHarness();
    const reload = spyOn(dom.window.location, "reload").mockImplementation(() => {});
    let bypassAnswers = 0;
    const wall = gateway((token) => token === "again");
    const fetch = mockFetch((method, path, _body, url) => {
      if (method === "POST" && path === "/api/admin/maintenance/on") return Response.json(active);
      if (method === "POST" && path === "/api/admin/maintenance/bypass") {
        bypassAnswers += 1;
        return bypassAnswers === 1 ? Response.json({ code: "INTERNAL" }, { status: 500 }) : Response.json(bypassLink("again"));
      }
      return wall.route(method, path, url);
    });
    const dispose = mount(dom, off);
    try {
      button(dom, "Start maintenance")!.click();
      await waitFor(() => Boolean(dom.root.querySelector('[role="alert"]')), "error");
      expect(dom.root.querySelector('[role="alert"]')!.textContent).toContain("Maintenance is on, but your link");
      expect(dom.root.textContent).toContain("Active");
      button(dom, "Try again")!.click();
      await waitFor(() => reload.mock.calls.length > 0, "reload");
      expect(apiCalls(fetch.calls).filter((call) => call.endsWith("/on"))).toHaveLength(1);
      expect(fetch.calls.find((call) => call.path === PATH)!.url).toBe(`http://localhost${PATH}?cloud-maintenance-bypass=again`);
    } finally {
      dispose();
      fetch.restore();
      reload.mockRestore();
      dom.cleanup();
    }
  });

  test("a gateway that never confirms the bypass leaves the page in place, says so, and retries only the link step", async () => {
    const dom = createDomTestHarness();
    const reload = spyOn(dom.window.location, "reload").mockImplementation(() => {});
    let links = 0;
    // The gateway has not learned the maintenance yet, so the first link sets nothing; the retry's link works.
    const wall = gateway((token) => token === "second");
    const fetch = mockFetch((method, path, _body, url) => {
      if (method === "POST" && path === "/api/admin/maintenance/on") return Response.json(active);
      if (method === "POST" && path === "/api/admin/maintenance/bypass") {
        links += 1;
        return Response.json(bypassLink(links === 1 ? "first" : "second"));
      }
      return wall.route(method, path, url);
    });
    const dispose = mount(dom, off);
    try {
      button(dom, "Start maintenance")!.click();
      await waitFor(() => Boolean(dom.root.querySelector('[role="alert"]')), "notice after the bounded wait", 6_000);
      expect(dom.root.querySelector('[role="alert"]')!.textContent).toContain("Maintenance is on, but your link");
      expect(dom.root.textContent).toContain("Everyone sees the maintenance page right now, you too from your next page load.");
      expect(dom.root.textContent).not.toContain("Everyone except you");
      expect(reload).not.toHaveBeenCalled();
      // Bounded: fifteen link-and-status rounds, then it stops asking.
      const firstRound = apiCalls(fetch.calls);
      expect(firstRound.filter((call) => call === `GET ${PATH}`)).toHaveLength(15);
      expect(firstRound.filter((call) => call === "GET /_cloud/gateway/status")).toHaveLength(15);
      expect(button(dom, "End maintenance")!.disabled).toBe(false);

      fetch.calls.length = 0;
      button(dom, "Try again")!.click();
      await waitFor(() => reload.mock.calls.length > 0, "reload after the retry");
      expect(apiCalls(fetch.calls)).toEqual(["POST /api/admin/maintenance/bypass", `GET ${PATH}`, "GET /_cloud/gateway/status"]);
      expect(dom.root.querySelector('[role="alert"]')).toBeNull();
    } finally {
      dispose();
      fetch.restore();
      reload.mockRestore();
      dom.cleanup();
    }
  }, 15_000);

  test("moving the end starts from the current end, saves it and shows the answer", async () => {
    const dom = createDomTestHarness();
    const fetch = mockFetch((method, path) =>
      method === "POST" && path === "/api/admin/maintenance/until"
        ? Response.json({ ...active, until: "2026-11-17T00:30:00.000Z" })
        : undefined,
    );
    const dispose = mount(dom, active);
    try {
      expect(dom.root.textContent).toContain("14:30");
      button(dom, "Move end")!.click();
      await waitFor(() => Boolean(button(dom, "Save", "dialog")), "end dialog");
      // The dialog names the viewer's time zone through its date-time field.
      button(dom, "Save", "dialog")!.click();
      await waitFor(() => (dom.root.textContent ?? "").includes("01:30"), "new end after midnight");
      expect(apiCalls(fetch.calls)).toEqual(["POST /api/admin/maintenance/until"]);
      expect(fetch.calls[0]!.body).toEqual({ until: "2026-11-16T13:30:00.000Z" });
      expect(dom.document.querySelector("[data-move-end-dialog]")).toBeNull();
    } finally {
      modules!.ui.dialogCore.close();
      dispose();
      fetch.restore();
      dom.cleanup();
    }
  });

  test("a refresh answer that left before a moved end does not overwrite it; the next refresh applies again", async () => {
    const dom = createDomTestHarness();
    // The page refreshes every ten seconds; the test runs that refresh by hand instead of waiting.
    const interval = spyOn(globalThis, "setInterval");
    const tick = () => {
      const refresh = interval.mock.calls.find((call) => call[1] === 10_000)?.[0];
      if (typeof refresh !== "function") throw new Error("Missing refresh timer");
      refresh();
    };
    const stale = deferred<Response>();
    let reads = 0;
    const fetch = mockFetch((method, path) => {
      if (method === "GET" && path === "/api/admin/maintenance") {
        reads += 1;
        return reads === 1
          ? stale.promise
          : Response.json({ ...active, until: "2026-11-17T00:30:00.000Z", apps: { ready: 11, total: 11, starting: [] } });
      }
      if (method === "POST" && path === "/api/admin/maintenance/until")
        return Response.json({ ...active, until: "2026-11-17T00:30:00.000Z" });
      return undefined;
    });
    const dispose = mount(dom, active);
    try {
      // The refresh leaves with the old end …
      tick();
      await waitFor(() => reads === 1, "refresh request");
      // … the end moves while it is on its way …
      button(dom, "Move end")!.click();
      await waitFor(() => Boolean(button(dom, "Save", "dialog")), "end dialog");
      button(dom, "Save", "dialog")!.click();
      await waitFor(() => (dom.root.textContent ?? "").includes("01:30"), "moved end");
      // … and its late answer, still with the old end, changes nothing.
      stale.settle(Response.json(active));
      await Bun.sleep(50);
      expect(dom.root.textContent).toContain("01:30");
      expect(dom.root.textContent).not.toContain("14:30");
      expect(dom.root.textContent).toContain("9 of 11");
      // A refresh that leaves after the write applies as before.
      tick();
      await waitFor(() => (dom.root.textContent ?? "").includes("11 of 11"), "next refresh");
      expect(dom.root.textContent).toContain("01:30");
    } finally {
      modules!.ui.dialogCore.close();
      dispose();
      fetch.restore();
      interval.mockRestore();
      dom.cleanup();
    }
  });

  test("without a future end the dialog suggests one; a failed save stays in the dialog and keeps the old end", async () => {
    const dom = createDomTestHarness();
    const fetch = mockFetch(() => Response.json({ code: "INTERNAL" }, { status: 500 }));
    const noEnd: MaintenanceStatus = { active: true, startedAt: active.startedAt, startedBy: active.startedBy, apps: active.apps };
    const dispose = mount(dom, noEnd);
    try {
      button(dom, "Move end")!.click();
      await waitFor(() => Boolean(button(dom, "Save", "dialog")), "end dialog");
      button(dom, "Save", "dialog")!.click();
      await waitFor(() => Boolean(dom.document.querySelector('[data-move-end-dialog] [role="alert"]')), "error in dialog");
      expect(dom.document.querySelector("[data-move-end-dialog]")!.textContent).toContain("The end was not moved.");
      expect(fetch.calls[0]!.body).toEqual({ until: "2026-11-16T14:15:00.000Z" });
      button(dom, "Cancel", "dialog")!.click();
      await waitFor(() => !dom.document.querySelector("[data-move-end-dialog]"), "dialog closed");
      expect(dom.root.textContent).not.toContain("Planned until");
    } finally {
      modules!.ui.dialogCore.close();
      dispose();
      fetch.restore();
      dom.cleanup();
    }
  });

  test("an end the server refuses in the dialog says why at the field and keeps the dialog open", async () => {
    const dom = createDomTestHarness();
    const fetch = mockFetch((method, path) =>
      method === "POST" && path === "/api/admin/maintenance/until"
        ? Response.json({ message: "until must be in the future", code: "BAD_INPUT" }, { status: 400 })
        : undefined,
    );
    const dispose = mount(dom, active);
    try {
      button(dom, "Move end")!.click();
      await waitFor(() => Boolean(button(dom, "Save", "dialog")), "end dialog");
      button(dom, "Save", "dialog")!.click();
      const dialog = () => dom.document.querySelector("[data-move-end-dialog]");
      await waitFor(() => (dialog()?.textContent ?? "").includes("This time has already passed."), "field error in dialog");
      expect(dialog()!.textContent).not.toContain("The end was not moved.");
      expect(button(dom, "Save", "dialog")!.disabled).toBe(false);
    } finally {
      modules!.ui.dialogCore.close();
      dispose();
      fetch.restore();
      dom.cleanup();
    }
  });

  test("ending asks first; cancel changes nothing, confirm switches off and reloads", async () => {
    const dom = createDomTestHarness();
    const reload = spyOn(dom.window.location, "reload").mockImplementation(() => {});
    const fetch = mockFetch((method, path) =>
      method === "POST" && path === "/api/admin/maintenance/off" ? Response.json(off) : undefined,
    );
    const dispose = mount(dom, active);
    try {
      button(dom, "End maintenance")!.click();
      await waitFor(() => Boolean(dom.document.querySelector("dialog")), "confirm prompt");
      expect(dom.document.querySelector("dialog")!.textContent).toContain("Everyone sees the Cloud again.");
      button(dom, "Cancel", "dialog")!.click();
      await waitFor(() => !dom.document.querySelector("dialog[open]"), "prompt closed");
      expect(fetch.calls).toEqual([]);

      button(dom, "End maintenance")!.click();
      await waitFor(() => Boolean(button(dom, "End maintenance", "dialog")), "confirm prompt again");
      button(dom, "End maintenance", "dialog")!.click();
      await waitFor(() => reload.mock.calls.length > 0, "reload");
      expect(apiCalls(fetch.calls)).toEqual(["POST /api/admin/maintenance/off"]);
    } finally {
      modules!.ui.dialogCore.close();
      dispose();
      fetch.restore();
      reload.mockRestore();
      dom.cleanup();
    }
  });
}
