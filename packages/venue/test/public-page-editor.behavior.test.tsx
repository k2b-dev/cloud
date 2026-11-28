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
  const { Workspace } = await import("@k2b/ui/v2");
  const { PublicPageEditor } = await import("../src/frontend/_components/venue-workspace/public-page-editor");
  const dispose = render(
    () => (
      <LocaleProvider locale="en">
        <Workspace>
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
        </Workspace>
      </LocaleProvider>
    ),
    dom.root,
  );
  // The v2 editor: the sections are the rows of the list named "Sections"; each row's title is its first line.
  const list = () => dom.root.querySelector<HTMLElement>('[data-k2-part="List"][aria-label="Sections"]')!;
  const rowTitles = () => [...list().querySelectorAll(".k2-row-title")].map((entry) => entry.textContent);
  const previewTitles = () => [] as string[];
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

describe("Venue public page editor on v2: reordering", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("several fast moves while an order saves are saved one after another, never in parallel, and stay", async () => {
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
      buttonNamed(editor.list(), "Move up: Team day").click();
      await flush();
      // The list moves at once; the first order is on its way.
      expect(editor.rowTitles()).toEqual(["Opening week", "Team day", "Lunch menu"]);
      // Two more moves while it saves: shown at once, not sent yet.
      buttonNamed(editor.list(), "Move up: Team day").click();
      await flush();
      buttonNamed(editor.list(), "Move down: Lunch menu").click();
      await flush();
      expect(editor.rowTitles()).toEqual(["Team day", "Opening week", "Lunch menu"]);
      expect(editor.requests.filter((request) => request.path.endsWith("/sections/order"))).toHaveLength(1);

      held.shift()?.();
      await flush();
      // The moves made meanwhile go out as one order with the latest state, after the first answered.
      expect(editor.requests.filter((request) => request.path.endsWith("/sections/order"))).toHaveLength(2);
      held.shift()?.();
      await flush();
      expect(editor.requests.map((request) => request.body)).toEqual([
        { sectionIds: ["Open01", "Note01", "Menu01"] },
        { sectionIds: ["Note01", "Open01", "Menu01"] },
      ]);
      // After the reload the saved order stays.
      expect(editor.rowTitles()).toEqual(["Team day", "Opening week", "Lunch menu"]);
      expect(held).toHaveLength(0);
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
      buttonNamed(editor.list(), "Move up: Team day").click();
      await flush();
      expect(editor.requests).toHaveLength(1);
      expect(heldReloads).toHaveLength(1);
      // The first order is saved and the workspace reloads; a second move lands in that window.
      buttonNamed(editor.list(), "Move down: Opening week").click();
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

  test("a failed reorder falls back to the order the server confirmed and says why", async () => {
    const dom = createDomTestHarness();
    const editor = await mountEditor(dom, {
      sections: [section("Open01", "Opening week", 1), section("Menu01", "Lunch menu", 2)],
      respond: () => Response.json({ message: "List every section of the venue exactly once" }, { status: 400 }),
    });
    try {
      buttonNamed(editor.list(), "Move up: Lunch menu").click();
      await flush();
      // Back to the confirmed order; the reason shows as a toast, and the reload announces nothing.
      expect(editor.rowTitles()).toEqual(["Opening week", "Lunch menu"]);
      expect(dom.document.body.textContent).toContain("List every section of the venue exactly once");
      expect(editor.toasts).toEqual([undefined]);
    } finally {
      editor.cleanup();
      dom.cleanup();
    }
  });
});
