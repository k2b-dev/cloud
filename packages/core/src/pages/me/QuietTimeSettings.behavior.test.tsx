import { expect, spyOn, test } from "bun:test";
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

const mockFetch = (route: (method: string, path: string, body: unknown) => Response | undefined) => {
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
}
