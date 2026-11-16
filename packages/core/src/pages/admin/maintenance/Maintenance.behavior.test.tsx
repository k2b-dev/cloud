import { afterAll, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import type { MaintenanceStatus } from "@k2b/cloud/contracts/maintenance";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../../../ui/test/dom";

// 14:10 in Berlin; every time below is read in that zone.
const NOW = new Date("2026-11-16T13:10:00.000Z");
const PATH = "/admin/settings/maintenance";

const off: MaintenanceStatus = { active: false, apps: { ready: 11, total: 11, starting: [] } };
const active: MaintenanceStatus = {
  active: true,
  startedAt: "2026-11-16T13:02:00.000Z",
  startedBy: { id: "u-lea", label: "Lea Muster" },
  until: "2026-11-16T13:30:00.000Z",
  apps: { ready: 9, total: 11, starting: ["files", "mail"] },
};

const waitFor = async (condition: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const mockFetch = (route: (method: string, path: string, body: unknown) => Response | Promise<Response> | undefined) => {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const spy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(new URL(String(input), "http://localhost/"), init);
        const path = new URL(request.url).pathname;
        const text = await request.text();
        const body: unknown = text ? JSON.parse(text) : undefined;
        calls.push({ method: request.method, path, body });
        return route(request.method, path, body) ?? Response.json({ code: "UNAVAILABLE" }, { status: 503 });
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

const mount = (dom: DomTestHarness, initial: MaintenanceStatus) => {
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

if (isServer) test.skip("requires browser conditions", () => {});
else {
  beforeAll(() => setSystemTime(NOW));
  afterAll(() => setSystemTime());

  test("starting switches maintenance on, then opens the bypass link back to this page", async () => {
    const dom = createDomTestHarness();
    const navigate = spyOn(dom.window.location, "assign").mockImplementation(() => {});
    const fetch = mockFetch((method, path) => {
      if (method === "POST" && path === "/api/admin/maintenance/on")
        return Response.json({ ...active, message: "Wir spielen Version 2.4 ein." });
      if (method === "POST" && path === "/api/admin/maintenance/bypass")
        return Response.json({ url: "https://cloud.test/?cloud-maintenance-bypass=token", expiresAt: "2026-11-17T01:10:00.000Z" });
      if (method === "GET" && path === "/_cloud/gateway/status") return Response.json({ maintenance: { active: true, until: null } });
      return undefined;
    });
    const dispose = mount(dom, off);
    try {
      type(dom.root.querySelector("textarea"), "Wir spielen Version 2.4 ein.");
      type(dom.root.querySelector<HTMLInputElement>('input[placeholder="14:30"]'), "14:30");
      button(dom, "Start maintenance")!.click();
      await waitFor(() => navigate.mock.calls.length > 0, "navigation");
      expect(apiCalls(fetch.calls)).toEqual([
        "POST /api/admin/maintenance/on",
        "POST /api/admin/maintenance/bypass",
        "GET /_cloud/gateway/status",
      ]);
      expect(fetch.calls[0]!.body).toEqual({ message: "Wir spielen Version 2.4 ein.", until: "2026-11-16T13:30:00.000Z" });
      expect(String(navigate.mock.calls[0]![0])).toBe(`https://cloud.test${PATH}?cloud-maintenance-bypass=token`);
      // Until the browser leaves, the page shows the running maintenance and keeps its action busy.
      expect(dom.root.textContent).toContain("Everyone except you sees the maintenance page right now.");
    } finally {
      dispose();
      fetch.restore();
      navigate.mockRestore();
      dom.cleanup();
    }
  });

  test("a time that has passed stays in the form with a reason and starts nothing", async () => {
    const dom = createDomTestHarness();
    const fetch = mockFetch(() => undefined);
    const dispose = mount(dom, off);
    try {
      type(dom.root.querySelector<HTMLInputElement>('input[placeholder="14:30"]'), "09:00");
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
      expect(fetch.calls[0]!.body).toEqual({});
      expect(navigate).not.toHaveBeenCalled();
      expect(button(dom, "Start maintenance")!.disabled).toBe(false);
    } finally {
      dispose();
      fetch.restore();
      navigate.mockRestore();
      dom.cleanup();
    }
  });

  test("a failed bypass link keeps the running state visible and retries only the link", async () => {
    const dom = createDomTestHarness();
    const navigate = spyOn(dom.window.location, "assign").mockImplementation(() => {});
    let bypassAnswers = 0;
    const fetch = mockFetch((method, path) => {
      if (method === "POST" && path === "/api/admin/maintenance/on") return Response.json(active);
      if (method === "POST" && path === "/api/admin/maintenance/bypass") {
        bypassAnswers += 1;
        return bypassAnswers === 1
          ? Response.json({ code: "INTERNAL" }, { status: 500 })
          : Response.json({ url: "https://cloud.test/?cloud-maintenance-bypass=again", expiresAt: "2026-11-17T01:10:00.000Z" });
      }
      if (method === "GET" && path === "/_cloud/gateway/status") return Response.json({ maintenance: { active: true, until: null } });
      return undefined;
    });
    const dispose = mount(dom, off);
    try {
      button(dom, "Start maintenance")!.click();
      await waitFor(() => Boolean(dom.root.querySelector('[role="alert"]')), "error");
      expect(dom.root.querySelector('[role="alert"]')!.textContent).toContain("Maintenance is on, but your link");
      expect(dom.root.textContent).toContain("Active");
      button(dom, "Try again")!.click();
      await waitFor(() => navigate.mock.calls.length > 0, "navigation");
      expect(apiCalls(fetch.calls).filter((call) => call.endsWith("/on"))).toHaveLength(1);
      expect(String(navigate.mock.calls[0]![0])).toBe(`https://cloud.test${PATH}?cloud-maintenance-bypass=again`);
    } finally {
      dispose();
      fetch.restore();
      navigate.mockRestore();
      dom.cleanup();
    }
  });

  test("moving the end sends the new time and shows it", async () => {
    const dom = createDomTestHarness();
    const fetch = mockFetch((method, path) =>
      method === "POST" && path === "/api/admin/maintenance/until"
        ? Response.json({ ...active, until: "2026-11-16T14:00:00.000Z" })
        : undefined,
    );
    const dispose = mount(dom, active);
    try {
      expect(dom.root.textContent).toContain("14:30");
      button(dom, "Move end")!.click();
      await waitFor(() => Boolean(dom.document.querySelector("dialog input")), "end prompt");
      type(dom.document.querySelector<HTMLInputElement>("dialog input"), "15:00");
      button(dom, "Save", "dialog")!.click();
      await waitFor(() => (dom.root.textContent ?? "").includes("15:00"), "new end");
      expect(apiCalls(fetch.calls)).toEqual(["POST /api/admin/maintenance/until"]);
      expect(fetch.calls[0]!.body).toEqual({ until: "2026-11-16T14:00:00.000Z" });
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
