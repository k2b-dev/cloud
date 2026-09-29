import { describe, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../ui/test/dom";
import type { PublicSection, PublicStatus, Venue, VenueDashboard } from "../src/contracts";

const flush = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

const buttonNamed = (root: ParentNode, name: string) => {
  const button = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.getAttribute("aria-label") === name || entry.textContent?.trim() === name,
  );
  if (!button) throw new Error(`No button named ${name}`);
  return button;
};

/** The open dialog: its panel for prompts, the dialog itself for panel dialogs. */
const panel = (dom: DomTestHarness) =>
  dom.document.querySelector<HTMLElement>(".k2b-dialog__panel") ?? dom.document.querySelector<HTMLElement>("dialog");

/** Closes an error prompt, so the next test's dialogs do not queue behind it. */
const dismissPrompt = async (dom: DomTestHarness) => {
  const open = panel(dom);
  const buttons = open ? [...open.querySelectorAll<HTMLButtonElement>("button")] : [];
  buttons.at(-1)?.click();
  await flush();
};

const type = (input: HTMLInputElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

const venue: Venue = {
  id: "Cafe01",
  slug: "campus-cafe",
  name: "Campus Café",
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

const section = (id: string, title: string, position: number, enabled = true): PublicSection => ({
  id,
  venueId: "Cafe01",
  kind: "notice",
  title,
  content: { text: `${title} text` },
  enabled,
  position,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
});

const dashboardWith = (sections: PublicSection[], venueOverrides: Partial<Venue> = {}): VenueDashboard => ({
  venue: { ...venue, ...venueOverrides },
  openingRules: [],
  overrides: [],
  templates: [],
  slots: [],
  otherAssignments: [],
  outlook: { startDate: "2026-09-28", endDate: "2026-10-04", missingPeople: 0, nextGap: null },
  assignments: [],
  myUpcomingShifts: [],
  myShiftCount: 0,
  sections,
  feedback: null,
  feedbackEntries: [],
  feedbackEntriesPage: null,
});

const previewOf = (dashboard: VenueDashboard): PublicStatus => ({
  venue: dashboard.venue,
  open: false,
  spontaneousOpen: false,
  statusLabel: "Closed",
  todayLabel: "Closed today",
  nextOpeningLabel: null,
  activeWindowLabel: null,
  upcomingOpenings: [],
  upcomingExceptions: [],
  openingRules: [],
  sections: dashboard.sections.filter((entry) => entry.enabled),
});

type Request = { method: string; path: string; body: unknown };
type Responder = (request: Request) => Response | Promise<Response>;

/**
 * Mounts the Public page view for an admin. `respond` answers the view's own requests, except the preview, which
 * mirrors the current workspace data. Reconciling applies `onReconcile` to the workspace data, like a reload; with
 * `heldReloads`, each reload waits until the test calls the function it adds there.
 */
const mountEditor = async (
  dom: DomTestHarness,
  options: {
    sections: PublicSection[];
    venue?: Partial<Venue>;
    respond: Responder;
    onReconcile?: (current: VenueDashboard) => VenueDashboard;
    heldReloads?: Array<() => void>;
  },
) => {
  const requests: Request[] = [];
  const toasts: (string | undefined)[] = [];
  const originalFetch = globalThis.fetch;
  const [dashboard, setDashboard] = createSignal(dashboardWith(options.sections, options.venue));
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), "http://localhost");
    const request = { method: init?.method ?? "GET", path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null };
    if (request.path.endsWith("/public-preview")) return Response.json(previewOf(dashboard()));
    requests.push(request);
    return options.respond(request);
  }) as typeof fetch;
  const { LocaleProvider } = await import("@k2b/ui");
  const { PublicPageEditor } = await import("../src/frontend/_components/venue-workspace/public-page-editor");
  const dispose = render(
    () => (
      <LocaleProvider locale="en">
        <PublicPageEditor
          dashboard={dashboard()}
          initialPreview={previewOf(dashboard())}
          initialSectionId={null}
          reconcile={async (message) => {
            toasts.push(message);
            const held = options.heldReloads;
            if (held) await new Promise<void>((resolve) => held.push(resolve));
            setDashboard((current) => options.onReconcile?.(current) ?? current);
            return true;
          }}
        />
      </LocaleProvider>
    ),
    dom.root,
  );
  const list = () => dom.root.querySelector<HTMLElement>("[data-public-sections]")!;
  const rowTitles = () => [...list().querySelectorAll("[data-section-row]")].map((entry) => entry.textContent);
  const previewTitles = () =>
    [...dom.root.querySelectorAll("[data-public-preview] [data-public-section] h2")].map((entry) => entry.textContent);
  return {
    requests,
    toasts,
    list,
    rowTitles,
    previewTitles,
    dashboard,
    cleanup: () => {
      dispose();
      globalThis.fetch = originalFetch;
    },
  };
};

/** The workspace data after a reorder: the sections in the order the last order request saved. */
const applySavedOrder = (requests: Request[]) => (current: VenueDashboard) => {
  const last = requests.filter((request) => request.path.endsWith("/sections/order")).at(-1);
  const ids = (last?.body as { sectionIds: string[] } | undefined)?.sectionIds;
  if (!ids) return current;
  const byId = new Map(current.sections.map((entry) => [entry.id, entry]));
  return { ...current, sections: ids.map((id, index) => ({ ...byId.get(id)!, position: index + 1 })) };
};

describe("Venue public page view behavior", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("moving a section with the keyboard shows at once, saves the whole order, keeps focus, and says where it went", async () => {
    const dom = createDomTestHarness();
    const held: Array<() => void> = [];
    const requests: Request[] = [];
    const editor = await mountEditor(dom, {
      sections: [section("Open01", "Opening week", 1), section("Menu01", "Lunch menu", 2), section("Note01", "Team day", 3)],
      respond: (request) => {
        requests.push(request);
        return new Promise((resolve) => held.push(() => resolve(Response.json([]))));
      },
      onReconcile: (current) => applySavedOrder(requests)(current),
    });
    try {
      const up = buttonNamed(editor.list(), "Move Team day up");
      up.focus();
      up.click();
      await flush();
      // The list moves at once, and focus stays on the moved row's control.
      expect(editor.rowTitles()).toEqual(["Opening week", "Team day", "Lunch menu"]);
      expect(dom.document.activeElement?.getAttribute("aria-label")).toBe("Move Team day up");
      expect(editor.list().textContent).toContain("“Team day” is now at position 2 of 3.");

      // A second move while the first saves is saved right after it, never in parallel.
      (dom.document.activeElement as HTMLButtonElement).click();
      await flush();
      expect(editor.rowTitles()).toEqual(["Team day", "Opening week", "Lunch menu"]);
      // At the top, Move up is disabled, so focus lands on Move down of the same row.
      expect(dom.document.activeElement?.getAttribute("aria-label")).toBe("Move Team day down");
      expect(editor.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
        "PUT /api/venue/venues/Cafe01/sections/order",
      ]);

      held.shift()?.();
      await flush();
      held.shift()?.();
      await flush();
      expect(editor.requests.map((request) => request.body)).toEqual([
        { sectionIds: ["Open01", "Note01", "Menu01"] },
        { sectionIds: ["Note01", "Open01", "Menu01"] },
      ]);
      // After the reload the saved order stays, in the list and in the preview.
      expect(editor.rowTitles()).toEqual(["Team day", "Opening week", "Lunch menu"]);
      await flush();
      expect(editor.previewTitles()).toEqual(["Team day", "Opening week", "Lunch menu"]);
    } finally {
      editor.cleanup();
      dom.cleanup();
    }
  });

  test("a move made while the saved order reloads is saved too and never snaps back", async () => {
    const dom = createDomTestHarness();
    const heldReloads: Array<() => void> = [];
    const requests: Request[] = [];
    const editor = await mountEditor(dom, {
      sections: [section("Open01", "Opening week", 1), section("Menu01", "Lunch menu", 2), section("Note01", "Team day", 3)],
      respond: (request) => {
        requests.push(request);
        return Response.json([]);
      },
      onReconcile: (current) => applySavedOrder(requests)(current),
      heldReloads,
    });
    try {
      buttonNamed(editor.list(), "Move Team day up").click();
      await flush();
      expect(editor.requests).toHaveLength(1);
      expect(heldReloads).toHaveLength(1);

      // The first order is saved and the workspace reloads; a second move lands in that window.
      buttonNamed(editor.list(), "Move Opening week down").click();
      await flush();
      expect(editor.rowTitles()).toEqual(["Team day", "Opening week", "Lunch menu"]);

      heldReloads.shift()?.();
      await flush();
      // The reload brings the first order only; the list keeps the second move and saves it.
      expect(editor.rowTitles()).toEqual(["Team day", "Opening week", "Lunch menu"]);
      expect(editor.requests.map((request) => request.body)).toEqual([
        { sectionIds: ["Open01", "Note01", "Menu01"] },
        { sectionIds: ["Note01", "Open01", "Menu01"] },
      ]);

      heldReloads.shift()?.();
      await flush();
      expect(editor.rowTitles()).toEqual(["Team day", "Opening week", "Lunch menu"]);
      expect(editor.requests).toHaveLength(2);
      expect(heldReloads).toHaveLength(0);
    } finally {
      editor.cleanup();
      dom.cleanup();
    }
  });

  test("while the order saves, a section's menu offers neither a copy nor a delete", async () => {
    const dom = createDomTestHarness();
    let finish: () => void = () => {};
    const editor = await mountEditor(dom, {
      sections: [section("Open01", "Opening week", 1), section("Menu01", "Lunch menu", 2)],
      respond: () => new Promise((resolve) => (finish = () => resolve(Response.json([])))),
    });
    const menuItem = (label: string) =>
      [...dom.document.querySelectorAll<HTMLElement>("[role='menuitem']")].find((item) => item.textContent?.includes(label))!;
    try {
      buttonNamed(editor.list(), "Move Lunch menu up").click();
      await flush();
      buttonNamed(editor.list(), "More actions for “Opening week”").click();
      await flush();
      expect(menuItem("Duplicate section").getAttribute("aria-disabled")).toBe("true");
      expect(menuItem("Delete section").getAttribute("aria-disabled")).toBe("true");
      menuItem("Delete section").click();
      await flush();
      expect(panel(dom)).toBeNull();

      finish();
      await flush();
      expect(menuItem("Duplicate section").getAttribute("aria-disabled")).toBeNull();
      expect(menuItem("Delete section").getAttribute("aria-disabled")).toBeNull();
    } finally {
      editor.cleanup();
      dom.cleanup();
    }
  });

  test("a failed reorder falls back to the order the server confirmed", async () => {
    const dom = createDomTestHarness();
    const editor = await mountEditor(dom, {
      sections: [section("Open01", "Opening week", 1), section("Menu01", "Lunch menu", 2)],
      respond: () => Response.json({ message: "List every section of the venue exactly once" }, { status: 400 }),
    });
    try {
      buttonNamed(editor.list(), "Move Lunch menu up").click();
      await flush();
      expect(editor.rowTitles()).toEqual(["Opening week", "Lunch menu"]);
      expect(panel(dom)?.textContent).toContain("List every section of the venue exactly once");
      // The workspace reloads the confirmed order without announcing anything.
      expect(editor.toasts).toEqual([undefined]);
      await dismissPrompt(dom);
      expect(panel(dom)).toBeNull();
    } finally {
      editor.cleanup();
      dom.cleanup();
    }
  });

  test("the visibility switch saves only the visibility and flips back when the save fails", async () => {
    const dom = createDomTestHarness();
    let fail = false;
    let finish: () => void = () => {};
    const editor = await mountEditor(dom, {
      sections: [section("Open01", "Opening week", 1), section("Draft1", "Winter hours", 2, false)],
      respond: () =>
        new Promise((resolve) => {
          finish = () => resolve(fail ? Response.json({ message: "Section not saved" }, { status: 500 }) : Response.json({}));
        }),
      onReconcile: (current) => ({
        ...current,
        sections: current.sections.map((entry) => (entry.id === "Draft1" ? { ...entry, enabled: true } : entry)),
      }),
    });
    try {
      const toggle = () => editor.list().querySelector<HTMLInputElement>('input[aria-label="Show “Winter hours” on the public page"]')!;
      expect(toggle().checked).toBe(false);
      expect(editor.previewTitles()).toEqual(["Opening week"]);

      toggle().click();
      await flush();
      // The switch shows the asked state and waits; the other rows stay usable.
      expect(toggle().checked).toBe(true);
      expect(toggle().disabled).toBe(true);
      expect(editor.list().querySelector<HTMLInputElement>('input[aria-label="Show “Opening week” on the public page"]')!.disabled).toBe(
        false,
      );
      expect(editor.requests).toEqual([{ method: "PATCH", path: "/api/venue/venues/Cafe01/sections/Draft1", body: { enabled: true } }]);

      finish();
      await flush();
      await flush();
      expect(editor.toasts).toEqual(["The section is on the public page"]);
      expect(toggle().checked).toBe(true);
      expect(editor.previewTitles()).toEqual(["Opening week", "Winter hours"]);

      fail = true;
      toggle().click();
      await flush();
      finish();
      await flush();
      await flush();
      expect(toggle().checked).toBe(true);
      expect(toggle().disabled).toBe(false);
      expect(panel(dom)?.textContent).toContain("Section not saved");
      await dismissPrompt(dom);
      expect(panel(dom)).toBeNull();
    } finally {
      editor.cleanup();
      dom.cleanup();
    }
  });

  test("the public page switch reads the venue fresh and saves it with only the switch changed", async () => {
    const dom = createDomTestHarness();
    const editor = await mountEditor(dom, {
      sections: [],
      venue: { publicEnabled: false },
      respond: (request) =>
        request.method === "GET"
          ? Response.json({ venue: { ...venue, name: "Campus Café Nord", publicEnabled: false } })
          : Response.json({ ...venue, publicEnabled: true }),
      onReconcile: (current) => ({ ...current, venue: { ...current.venue, publicEnabled: true } }),
    });
    try {
      expect(dom.root.textContent).toContain("The public page is off.");
      const toggle = dom.root.querySelector<HTMLInputElement>("[data-public-page-bar] input[role='switch']")!;
      toggle.click();
      await flush();
      await flush();
      expect(editor.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
        "GET /api/venue/venues/Cafe01/settings-context",
        "PATCH /api/venue/venues/Cafe01",
      ]);
      expect(editor.requests[1]!.body).toMatchObject({ name: "Campus Café Nord", slug: "campus-cafe", publicEnabled: true });
      expect(editor.toasts).toEqual(["The public page is on"]);
      expect(dom.root.textContent).not.toContain("The public page is off.");
    } finally {
      editor.cleanup();
      dom.cleanup();
    }
  });

  test("a new section says at its fields what is missing and shows a failed save in the dialog", async () => {
    const dom = createDomTestHarness();
    let accept = false;
    const editor = await mountEditor(dom, {
      sections: [],
      respond: () =>
        accept
          ? Response.json(section("New001", "Opening week", 1), { status: 201 })
          : Response.json({ message: "Venue storage is busy" }, { status: 503 }),
    });
    try {
      buttonNamed(dom.root, "Add section").click();
      await flush();
      const dialog = panel(dom)!;
      expect(dialog.textContent).toContain("Add public section");

      buttonNamed(dialog, "Add section").click();
      await flush();
      expect(dialog.textContent).toContain("Title is required.");
      expect(editor.requests).toEqual([]);

      const title = dialog.querySelector<HTMLInputElement>("input:not([type='checkbox'])")!;
      type(title, "Opening week");
      await flush();
      buttonNamed(dialog, "Add section").click();
      await flush();
      // The server's answer stays in the dialog with the input.
      expect(panel(dom)).toBe(dialog);
      expect(dialog.textContent).toContain("Venue storage is busy");
      expect(title.value).toBe("Opening week");

      accept = true;
      buttonNamed(dialog, "Add section").click();
      await flush();
      await flush();
      expect(editor.requests.at(-1)).toMatchObject({
        method: "POST",
        path: "/api/venue/venues/Cafe01/sections",
        body: { title: "Opening week" },
      });
      expect(panel(dom)).toBeNull();
      expect(editor.toasts).toEqual(["Section added"]);
    } finally {
      editor.cleanup();
      dom.cleanup();
    }
  });

  test("a copy is a draft at the end with a localized title", async () => {
    const dom = createDomTestHarness();
    const editor = await mountEditor(dom, {
      sections: [section("Open01", "Opening week", 3)],
      respond: () => Response.json(section("Copy01", "Opening week (copy)", 4, false), { status: 201 }),
    });
    try {
      buttonNamed(editor.list(), "More actions for “Opening week”").click();
      await flush();
      const duplicate = [...dom.document.querySelectorAll<HTMLElement>("[role='menuitem']")].find((item) =>
        item.textContent?.includes("Duplicate section"),
      )!;
      duplicate.click();
      await flush();
      expect(editor.requests).toEqual([
        {
          method: "POST",
          path: "/api/venue/venues/Cafe01/sections",
          body: { kind: "notice", title: "Opening week (copy)", content: { text: "Opening week text" }, enabled: false, position: 4 },
        },
      ]);
      expect(editor.toasts).toEqual(["Section duplicated"]);
    } finally {
      editor.cleanup();
      dom.cleanup();
    }
  });
});
