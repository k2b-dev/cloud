import { expect, jest, spyOn, test } from "bun:test";
import type { NotificationQuietSettings } from "@k2b/cloud/contracts";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../../ui/test/dom";

const waitFor = async (condition: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const off: NotificationQuietSettings = {
  doNotDisturbUntil: null,
  quietHours: { timeZone: "Europe/Berlin", periods: [] },
  state: { active: false, reason: null, until: null, nextStart: null },
};

const mockFetch = (route: (method: string, path: string, body: unknown) => Response | Promise<Response> | undefined) => {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const spy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(new URL(String(input), "http://localhost/"), init);
        const path = new URL(request.url).pathname;
        const text = await request.text();
        const body = text ? JSON.parse(text) : undefined;
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
    return { ui: await import("@k2b/ui"), QuietTimeSettings: (await import("./QuietTimeSettings.island.tsx")).default };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();

const mount = (dom: DomTestHarness, initial: NotificationQuietSettings, locale = "en") => {
  const { ui, QuietTimeSettings } = modules!;
  delegateEvents(["input", "click"]);
  return render(
    () =>
      createComponent(ui.LocaleProvider, {
        locale,
        get children() {
          return createComponent(QuietTimeSettings, { initial, dateConfig: { timeZone: "Europe/Berlin" } });
        },
      }),
    dom.root,
  );
};
const button = (dom: DomTestHarness, label: string) =>
  [...dom.document.querySelectorAll("button")].find((element) => element.textContent?.trim() === label) as HTMLButtonElement | undefined;
const status = (dom: DomTestHarness) => dom.root.querySelector(".k2b-status-badge")?.textContent?.trim();
const pauseTrigger = (dom: DomTestHarness) => dom.root.querySelector<HTMLButtonElement>(".k2b-date-trigger")!;
const periodRows = (dom: DomTestHarness) => dom.root.querySelectorAll('[aria-label="Remove quiet hours"]').length;
/** Run due fake timers, then let the requests they started settle. */
const advance = async (ms: number) => {
  jest.advanceTimersByTime(ms);
  for (let turn = 0; turn < 20; turn += 1) await new Promise<void>((resolve) => queueMicrotask(resolve));
};
const iso = (offset: number) => new Date(Date.now() + offset).toISOString();
const nights = { timeZone: "Europe/Berlin", periods: [{ days: [1, 2, 3, 4, 5, 6, 7], start: "22:00", end: "07:00" }] };

if (isServer) test.skip("requires browser conditions", () => {});
else {
  test("pausing from a preset saves the end and shows it in the status", async () => {
    const dom = createDomTestHarness();
    const until = new Date(Date.now() + 60 * 60_000);
    const fetch = mockFetch((method, path, body) => {
      if (method !== "PATCH" || path !== "/api/me/notifications/quiet") return undefined;
      const requested = (body as { doNotDisturbUntil: string }).doNotDisturbUntil;
      return Response.json({
        ...off,
        doNotDisturbUntil: requested,
        state: { active: true, reason: "doNotDisturb", until: requested, nextStart: null },
      });
    });
    const dispose = mount(dom, off);
    try {
      expect(status(dom)).toBe("Off");
      button(dom, "For 1 hour")!.click();
      await waitFor(() => fetch.calls.length === 1, "pause request");
      const requested = Date.parse((fetch.calls[0]!.body as { doNotDisturbUntil: string }).doNotDisturbUntil);
      // Rounded up to the next minute.
      expect(requested - until.getTime()).toBeGreaterThanOrEqual(-1_000);
      expect(requested - until.getTime()).toBeLessThan(61_000);
      await waitFor(() => status(dom)?.startsWith("Paused until") === true, "paused status");
    } finally {
      dispose();
      fetch.restore();
      dom.cleanup();
    }
  });

  test("quiet hours are saved only on request and need a day", async () => {
    const dom = createDomTestHarness();
    const fetch = mockFetch((method, path, body) => {
      if (method !== "PATCH" || path !== "/api/me/notifications/quiet") return undefined;
      return Response.json({ ...off, quietHours: (body as { quietHours: NotificationQuietSettings["quietHours"] }).quietHours });
    });
    const dispose = mount(dom, off, "de");
    try {
      expect(status(dom)).toBe("Aus");
      expect(dom.root.textContent).toContain("Noch keine Ruhezeiten.");
      expect(button(dom, "Speichern")!.disabled).toBeTrue();
      button(dom, "Ruhezeit hinzufügen")!.click();
      await waitFor(() => !button(dom, "Speichern")!.disabled, "save enabled");
      expect(fetch.calls).toHaveLength(0);
      button(dom, "Speichern")!.click();
      await waitFor(() => fetch.calls.length === 1, "save request");
      expect(fetch.calls[0]!.body).toEqual({
        quietHours: { timeZone: "Europe/Berlin", periods: [{ days: [1, 2, 3, 4, 5, 6, 7], start: "22:00", end: "07:00" }] },
      });
      await waitFor(() => button(dom, "Speichern")!.disabled, "saved state is clean");
    } finally {
      dispose();
      fetch.restore();
      dom.cleanup();
    }
  });

  test("keeps period edits made while saving and takes no pause meanwhile", async () => {
    const dom = createDomTestHarness();
    let answer: ((response: Response) => void) | undefined;
    const fetch = mockFetch((method, path) => {
      if (method !== "PATCH" || path !== "/api/me/notifications/quiet") return undefined;
      return new Promise<Response>((resolve) => {
        answer = resolve;
      });
    });
    const dispose = mount(dom, off);
    try {
      button(dom, "Add quiet hours")!.click();
      await waitFor(() => !button(dom, "Save")!.disabled, "save enabled");
      button(dom, "Save")!.click();
      await waitFor(() => fetch.calls.length === 1, "save request");
      // A second write could land before this one and be overwritten by its older snapshot.
      expect(pauseTrigger(dom).disabled).toBeTrue();
      button(dom, "Add quiet hours")!.click();
      await waitFor(() => periodRows(dom) === 2, "second period");
      const submitted = (fetch.calls[0]!.body as { quietHours: NotificationQuietSettings["quietHours"] }).quietHours;
      answer!(Response.json({ ...off, quietHours: submitted }));
      await waitFor(() => !pauseTrigger(dom).disabled, "save finished");
      expect(periodRows(dom)).toBe(2);
      expect(button(dom, "Save")!.disabled).toBeFalse();
    } finally {
      dispose();
      fetch.restore();
      dom.cleanup();
    }
  });

  test("refreshes when a pause ends inside quiet hours and again after a failed request", async () => {
    jest.useFakeTimers();
    const dom = createDomTestHarness();
    let failures = 1;
    const fetch = mockFetch((method, path) => {
      if (method !== "GET" || path !== "/api/me/notifications/quiet") return undefined;
      if (failures-- > 0) return Response.json({ code: "UNAVAILABLE" }, { status: 503 });
      return Response.json({
        ...off,
        quietHours: nights,
        state: { active: true, reason: "quietHours", until: iso(8 * 3_600_000), nextStart: null },
      });
    });
    // Paused for one more minute; the quiet hours it ends in run for eight more hours.
    const dispose = mount(dom, {
      doNotDisturbUntil: iso(60_000),
      quietHours: nights,
      state: { active: true, reason: "doNotDisturb", until: iso(8 * 3_600_000), nextStart: null },
    });
    try {
      expect(status(dom)).toStartWith("Paused until");
      await advance(59_000);
      expect(fetch.calls).toHaveLength(0);
      await advance(3_000);
      expect(fetch.calls).toHaveLength(1);
      expect(status(dom)).toStartWith("Paused until");
      await advance(30_000);
      expect(fetch.calls).toHaveLength(2);
      expect(status(dom)).toStartWith("Quiet hours until");
      // Nothing else changes before the quiet hours end; long waits check in hourly.
      await advance(59 * 60_000);
      expect(fetch.calls).toHaveLength(2);
    } finally {
      dispose();
      fetch.restore();
      dom.cleanup();
      jest.useRealTimers();
    }
  });

  test("waits instead of polling while the server still reports a change this clock has passed", async () => {
    jest.useFakeTimers();
    const dom = createDomTestHarness();
    const behind = {
      ...off,
      quietHours: nights,
      state: { active: true, reason: "quietHours" as const, until: iso(-5_000), nextStart: null },
    };
    const fetch = mockFetch((method, path) =>
      method === "GET" && path === "/api/me/notifications/quiet" ? Response.json(behind) : undefined,
    );
    const dispose = mount(dom, behind);
    try {
      await advance(29_000);
      expect(fetch.calls).toHaveLength(0);
      await advance(2_000);
      expect(fetch.calls).toHaveLength(1);
      await advance(10_000);
      expect(fetch.calls).toHaveLength(1);
    } finally {
      dispose();
      fetch.restore();
      dom.cleanup();
      jest.useRealTimers();
    }
  });
}
