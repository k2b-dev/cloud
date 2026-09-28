import { describe, expect, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../ui/test/dom";
import type { ShiftTemplate, ShiftTemplateInput, Venue, VenueDashboard } from "../src/contracts";

const flush = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

const buttonNamed = (root: ParentNode, name: string) => {
  const button = [...root.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.trim() === name);
  if (!button) throw new Error(`No button named ${name}`);
  return button;
};

/** Flushes until `done` holds, for flows that reload data in several steps. */
const settle = async (done: () => boolean) => {
  for (let round = 0; round < 20 && !done(); round += 1) await flush();
};

/** Types `value` into the input the way a browser reports it. */
const type = (input: HTMLInputElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

/** The open dialog: its panel for prompts, the dialog itself for panel dialogs. */
const panel = (dom: DomTestHarness) =>
  dom.document.querySelector<HTMLElement>(".k2b-dialog__panel") ?? dom.document.querySelector<HTMLElement>("dialog");

const venue: Venue = {
  id: "Cafe01",
  slug: "campus-cafe",
  name: "Campus-Café",
  icon: "ti ti-coffee",
  description: null,
  timezone: "Europe/Berlin",
  openMode: "combined",
  signupMode: "both",
  publicEnabled: true,
  feedbackEnabled: true,
  accentColor: "#2563eb",
  logoBase64: null,
  bannerBase64: null,
  icalToken: "calendar-token",
  permission: "admin",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

describe("Venue setup behavior", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("deleting a venue takes its typed name", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input), "http://localhost");
      requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
      return Response.json({ message: "Venue deleted" });
    }) as typeof fetch;
    const { LocaleProvider } = await import("@k2b/ui");
    const { VenueDangerZone } = await import("../src/frontend/_components/venue-workspace/settings");
    const dispose = render(
      () => (
        <LocaleProvider locale="en">
          <VenueDangerZone venue={venue} onPendingChange={() => {}} />
        </LocaleProvider>
      ),
      dom.root,
    );
    try {
      buttonNamed(dom.root, "Delete venue").click();
      await flush();
      const dialog = panel(dom)!;
      expect(dialog.textContent).toContain("Delete “Campus-Café” with its shifts, sign-ups, feedback, and public page?");
      const phrase = dialog.querySelector<HTMLInputElement>("input")!;
      const confirm = buttonNamed(dialog, "Delete venue");
      expect(confirm.disabled).toBe(true);

      type(phrase, "campus-café");
      await flush();
      expect(confirm.disabled).toBe(true);
      confirm.click();
      await flush();
      expect(requests).toEqual([]);

      type(phrase, "Campus-Café");
      await flush();
      expect(confirm.disabled).toBe(false);
      confirm.click();
      await flush();
      expect(requests).toEqual(["DELETE /api/venue/venues/Cafe01"]);
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });

  test("the first venue starts blank from the empty overview; a taken slug shows at the field and keeps the input", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    const bodies: unknown[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(init?.body ? JSON.parse(String(init.body)) : null);
      return Response.json({ message: "Venue slug already exists" }, { status: 409 });
    }) as typeof fetch;
    const { LocaleProvider } = await import("@k2b/ui");
    const { default: VenueOverview } = await import("../src/frontend/_components/VenueOverview.island");
    const dispose = render(
      () => (
        <LocaleProvider locale="en">
          <VenueOverview
            venues={[]}
            templates={[{ id: "cafe", name: "Cafe counter", description: "Opening hours and shifts", icon: "ti ti-coffee" }]}
            initialQuery=""
          />
        </LocaleProvider>
      ),
      dom.root,
    );
    try {
      expect(dom.root.querySelector("input[name='venue-search']")).toBeNull();
      buttonNamed(dom.root.querySelector("[data-venue-empty-actions]")!, "Start blank").click();
      await flush();
      const dialog = panel(dom)!;
      expect(dialog.textContent).toContain("Create venue");
      const name = dialog.querySelector<HTMLInputElement>("input[data-create-venue-name]")!;
      expect(name.placeholder).toBe("Campus-Café");

      // An empty name says so at the field; nothing is sent.
      buttonNamed(dialog, "Create").click();
      await flush();
      expect(dialog.textContent).toContain("Name is required");
      expect(bodies).toEqual([]);

      type(name, "Campus-Café Nord");
      await flush();
      const slug = dialog.querySelector<HTMLInputElement>("input[data-create-venue-slug]")!;
      expect(slug.value).toBe("campus-cafe-nord");
      expect(dialog.querySelector("details")?.open).toBe(false);

      buttonNamed(dialog, "Create").click();
      await flush();
      expect(bodies).toEqual([expect.objectContaining({ name: "Campus-Café Nord", slug: "campus-cafe-nord" })]);
      // The dialog stays with every input, opens Advanced, and names the problem at the slug.
      expect(panel(dom)).toBe(dialog);
      expect(dialog.querySelector("details")?.open).toBe(true);
      expect(name.value).toBe("Campus-Café Nord");
      expect(slug.getAttribute("aria-invalid")).toBe("true");
      expect(dialog.textContent).toContain("Another venue already uses this slug.");

      // An invalid slug is caught before anything is sent.
      type(slug, "Campus Café");
      await flush();
      expect(dialog.textContent).toContain("Use 2 to 80 lowercase letters");
      buttonNamed(dialog, "Create").click();
      await flush();
      expect(bodies).toHaveLength(1);
      // Cancel closes the dialog without creating anything.
      buttonNamed(dialog, "Cancel").click();
      await flush();
      expect(panel(dom)).toBeNull();
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });

  test("a new shift on several weekdays saves one template per day, and fields say what is missing", async () => {
    const dom = createDomTestHarness();
    const { LocaleProvider } = await import("@k2b/ui");
    const { ShiftTemplateDialog } = await import("../src/frontend/_components/venue-workspace/schedule");
    const saved: ShiftTemplateInput[][] = [];
    const closed: boolean[] = [];
    const dispose = render(
      () => (
        <LocaleProvider locale="en">
          <ShiftTemplateDialog
            submit={async (inputs) => {
              saved.push(inputs);
              return null;
            }}
            close={(value) => closed.push(value)}
          />
        </LocaleProvider>
      ),
      dom.root,
    );
    try {
      const weekdays = [...dom.root.querySelectorAll<HTMLInputElement>("[data-shift-weekdays] input[type='checkbox']")];
      expect(weekdays).toHaveLength(7);
      // Monday is chosen at first; add Tuesday to Friday.
      expect(weekdays.map((input) => input.checked)).toEqual([true, false, false, false, false, false, false]);
      for (const input of weekdays.slice(1, 5)) input.click();
      await flush();

      buttonNamed(dom.root, "Add 5 shifts").click();
      await flush();
      expect(saved).toEqual([]);
      expect(dom.root.textContent).toContain("Title is required.");

      const [title, start, end] = [...dom.root.querySelectorAll<HTMLInputElement>("input:not([type='checkbox'])")];
      type(title!, "Counter");
      type(start!, "14");
      start!.dispatchEvent(new Event("blur"));
      type(end!, "1230");
      end!.dispatchEvent(new Event("blur"));
      await flush();
      expect([start!.value, end!.value]).toEqual(["14:00", "12:30"]);
      buttonNamed(dom.root, "Add 5 shifts").click();
      await flush();
      expect(dom.root.textContent).toContain("The end must be after the start.");
      expect(saved).toEqual([]);

      type(end!, "18:00");
      await flush();
      buttonNamed(dom.root, "Add 5 shifts").click();
      await flush();
      expect(saved).toHaveLength(1);
      expect(saved[0]!.map((input) => [input.weekday, input.title, input.startTime, input.endTime])).toEqual(
        [1, 2, 3, 4, 5].map((weekday) => [weekday, "Counter", "14:00", "18:00"]),
      );
      expect(closed).toEqual([true]);
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("pausing a shift saves at once, and a running delete shows progress only on its own row", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    const shift = (id: string, title: string): ShiftTemplate => ({
      id,
      venueId: "Cafe01",
      weekday: 1,
      title,
      startTime: "09:00",
      endTime: "12:00",
      minPeople: 1,
      maxPeople: 2,
      requireTargetForOpening: false,
      active: true,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
    const templates = [shift("Temp01", "Morning counter"), shift("Temp02", "Lunch counter")];
    const context = { venue, openingRules: [], overrides: [], templates, accessEntries: [], apiKeys: [] };
    const requests: { method: string; path: string; body: unknown }[] = [];
    let releaseDelete: (() => void) | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input), "http://localhost");
      const method = init?.method ?? "GET";
      requests.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (method === "DELETE") return new Promise<Response>((resolve) => (releaseDelete = () => resolve(Response.json({ message: "ok" }))));
      if (method === "PATCH") return Response.json(templates[0]);
      return Response.json(context);
    }) as typeof fetch;
    const { LocaleProvider } = await import("@k2b/ui");
    const { SettingsDialog } = await import("../src/frontend/_components/venue-workspace/settings");
    const dashboard = { venue, openingRules: [], overrides: [], templates } as unknown as VenueDashboard;
    const dispose = render(
      () => (
        <LocaleProvider locale="en">
          <SettingsDialog
            dashboard={dashboard}
            accessEntries={[]}
            apiKeys={[]}
            initialTab="schedule"
            onOpenCalendarSubscription={() => {}}
            close={() => {}}
          />
        </LocaleProvider>
      ),
      dom.root,
    );
    try {
      await flush();
      const switches = [...dom.root.querySelectorAll<HTMLInputElement>("input[role='switch']")];
      expect(switches.map((input) => input.getAttribute("aria-label"))).toEqual([
        "“Morning counter” is active",
        "“Lunch counter” is active",
      ]);
      switches[0]!.click();
      await flush();
      expect(requests.filter((request) => request.method === "PATCH")).toEqual([
        {
          method: "PATCH",
          path: "/api/venue/venues/Cafe01/templates/Temp01",
          body: expect.objectContaining({ title: "Morning counter", weekday: 1, active: false }),
        },
      ]);

      // The pause reloads the settings, which renders the rows anew; the next action waits for that.
      const deletes = () => [...dom.root.querySelectorAll<HTMLButtonElement>("button[aria-label='Delete shift']")];
      await settle(() => dom.document.body.textContent?.includes("Shift paused") === true && deletes().every((button) => !button.disabled));
      deletes()[1]!.click();
      await flush();
      buttonNamed(panel(dom)!, "Delete").click();
      await flush();
      expect(requests.filter((request) => request.method === "DELETE").map((request) => request.path)).toEqual([
        "/api/venue/venues/Cafe01/templates/Temp02",
      ]);
      expect(deletes().map((button) => [button.getAttribute("aria-busy"), button.disabled])).toEqual([
        [null, true],
        ["true", true],
      ]);
      releaseDelete?.();
      await settle(() => deletes().every((button) => button.getAttribute("aria-busy") === null && !button.disabled));
      expect(deletes().map((button) => [button.getAttribute("aria-busy"), button.disabled])).toEqual([
        [null, false],
        [null, false],
      ]);
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });
});
