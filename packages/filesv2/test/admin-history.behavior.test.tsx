import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createSignal, type JSX } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import type { ActivityBasesPage, ActivityEntry, ActivityPage, ActivitySide } from "../src/activity-contracts";
import type { ActivityRequest } from "../src/frontend/ActivityView";
import type { AdminActivityBase, AdminActivityFilters, AdminBasesLoader } from "../src/frontend/admin-history";
import type { HistoryEnvironment } from "../src/frontend/history-actions";

// Native JSX handlers install delegated listeners while this module is evaluated.
const moduleDom = isServer ? undefined : createDomTestHarness();
afterAll(() => moduleDom?.cleanup());

/* Fictional people and places of the approved mockup; Tuesday 20.10.2026 in Berlin, frozen. */
const env: HistoryEnvironment = { now: "2026-10-20T12:30:00.000Z", timeZone: "Europe/Berlin" };
const LUKAS = "33333333-3333-4333-8333-333333333333";
const vertrieb: AdminActivityBase = {
  id: "cloud:groups:11111111-1111-4111-8111-111111111111",
  bindingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  area: "cloud",
  kind: "groups",
  name: "vertrieb",
  displayName: "Team Vertrieb",
  root: "cloud",
  path: "groups/vertrieb",
};
const side = (path: string, directory = true): ActivitySide => ({
  visibility: "full",
  source: "snapshot",
  name: path.split("/").at(-1)!,
  path,
  root: "cloud",
  baseId: vertrieb.bindingId,
  publicBaseId: null,
  itemId: null,
  directory,
  size: null,
  revision: null,
});
let counter = 0;
const entry = (patch: Partial<ActivityEntry> & Pick<ActivityEntry, "action">): ActivityEntry => ({
  id: `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
  state: "done",
  time: "2026-10-20T12:12:00.000Z",
  startedAt: "2026-10-20T12:12:00.000Z",
  finishedAt: "2026-10-20T12:12:00.000Z",
  actor: { kind: "user", userId: LUKAS, name: "Lukas Pohl" },
  via: "web",
  before: { visibility: "hidden" },
  after: { visibility: "hidden" },
  batchId: null,
  ...patch,
});
const page = (items: ActivityEntry[], next: string | null = null): ActivityPage => ({
  items,
  next,
  visibleCount: items.length,
  batches: [],
  exhausted: next === null,
  scanLimitReached: false,
  searchLimitReached: false,
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
const settle = async () => {
  await flush();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await flush();
};
// Wait on the same compiled UI instance the application imports, after its own Back removes the entry.
const dialogBack = async (action: () => void) => {
  const { dialogHistorySettled }: Pick<typeof import("../../ui/src/feedback/dialog-core"), "dialogHistorySettled"> = await import(
    new URL("./feedback/dialog-core.js", import.meta.resolve("@k2b/ui")).href
  );
  action();
  await flush();
  await dialogHistorySettled();
  await flush();
};
const buttonNamed = (root: ParentNode, label: string) =>
  [...root.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent?.trim() === label);

type ExportCall = {
  kind: "preview" | "export";
  query: Record<string, string>;
  signal: AbortSignal;
  reply: ReturnType<typeof deferred<Response>>;
};
const exportCalls: ExportCall[] = [];
const downloads: { name: string; content: unknown }[] = [];
if (!isServer) {
  const call = (kind: ExportCall["kind"]) => (input: { query: Record<string, string> }, options: { init: { signal: AbortSignal } }) => {
    const reply = deferred<Response>();
    exportCalls.push({ kind, query: structuredClone(input.query), signal: options.init.signal, reply });
    return reply.promise;
  };
  mock.module("../src/api/client", () => ({
    apiClient: { admin: { activity: { export: { $get: call("export"), preview: { $get: call("preview") } } } } },
  }));
  const browser = await import("@k2b/stdlib/browser");
  mock.module("@k2b/stdlib/browser", () => ({
    ...browser,
    downloadFileFromContent: (content: unknown, name: string) => downloads.push({ name, content }),
  }));
}

describe("Files administration history", () => {
  if (isServer) {
    test.skip("requires the package DOM runner", () => {});
    return;
  }
  let cleanup = () => {};
  let dom!: ReturnType<typeof createDomTestHarness>;
  beforeEach(() => {
    dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    delegateEvents(["click"]);
    cleanup = () => dom.cleanup();
  });
  afterEach(async () => {
    const { dialogCore } = await import("@k2b/ui");
    if (dialogCore.isOpen())
      await dialogBack(() => {
        while (dialogCore.isOpen()) dialogCore.close();
      });
    // Closing a dialog returns its history entry asynchronously, before the window goes away.
    await settle();
    cleanup();
    exportCalls.length = 0;
    downloads.length = 0;
  });
  const mount = async (view: () => JSX.Element, locale = "de") => {
    const { LocaleProvider } = await import("@k2b/ui");
    dom.document.documentElement.lang = locale;
    const dispose = render(() => <LocaleProvider locale={locale}>{view()}</LocaleProvider>, dom.root);
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
  };
  const history = async (
    options: {
      filters?: AdminActivityFilters;
      bases?: ActivityBasesPage | null;
      loadBases?: AdminBasesLoader;
      initial?: ActivityPage;
      locale?: string;
      changes?: AdminActivityFilters[];
      loads?: { request: ActivityRequest; reply: ReturnType<typeof deferred<ActivityPage>> }[];
    } = {},
  ) => {
    const { default: AdminHistory } = await import("../src/frontend/AdminHistory");
    const filters = options.filters ?? { when: "30" };
    await mount(
      () => (
        <AdminHistory
          env={env}
          filters={filters}
          onFiltersChange={(next) => options.changes?.push(next)}
          bases={options.bases === undefined ? { items: [vertrieb], next: null } : options.bases}
          loadBases={options.loadBases ?? (async () => ({ items: [], next: null }))}
          initial={options.initial ? { filters, page: options.initial } : null}
          load={(request) => {
            const reply = deferred<ActivityPage>();
            options.loads?.push({ request, reply });
            return reply.promise;
          }}
        />
      ),
      options.locale,
    );
    await flush();
  };
  const text = () => dom.document.body.textContent ?? "";

  test("a failed filter change hides the previous rows and retries only the requested filter", async () => {
    const { default: AdminHistory } = await import("../src/frontend/AdminHistory");
    const initial: AdminActivityFilters = { when: "30" };
    const [filters, setFilters] = createSignal(initial);
    const loads: { request: ActivityRequest; reply: ReturnType<typeof deferred<ActivityPage>> }[] = [];
    await mount(() => (
      <AdminHistory
        env={env}
        filters={filters()}
        onFiltersChange={setFilters}
        bases={{ items: [vertrieb], next: null }}
        loadBases={async () => ({ items: [], next: null })}
        initial={{ filters: initial, page: page([entry({ action: "item.move", after: side("groups/vertrieb/Old result") })]) }}
        load={(request) => {
          const reply = deferred<ActivityPage>();
          loads.push({ request, reply });
          return reply.promise;
        }}
      />
    ));
    setFilters({ when: "30", q: "New result" });
    await flush();
    expect(text()).not.toContain("Old result");
    expect(dom.root.querySelector('[aria-busy="true"]')).not.toBeNull();
    loads[0]!.reply.reject(new Error("offline"));
    await flush();
    expect(text()).not.toContain("Old result");
    buttonNamed(dom.root, "Erneut versuchen")!.click();
    await flush();
    expect(loads[1]!.request.q).toBe("New result");
    loads[1]!.reply.resolve(page([entry({ action: "item.move", after: side("groups/vertrieb/New result") })]));
    await flush();
    expect(text()).toContain("New result");
    expect(text()).not.toContain("Old result");
  });

  test("shows the SSR page across all storage as the approved table and as Activity's list, without a request", async () => {
    const loads: { request: ActivityRequest; reply: ReturnType<typeof deferred<ActivityPage>> }[] = [];
    await history({
      loads,
      initial: page([
        entry({
          action: "item.move",
          state: "pending",
          before: side("groups/vertrieb/Messe 2026"),
          after: side("groups/vertrieb/Projekte/Messe 2026"),
        }),
        entry({
          action: "item.differs",
          via: "observed",
          actor: { kind: "observed", userId: null, name: null },
          before: side("groups/vertrieb/Preisliste_2026.xlsx", false),
          time: "2026-10-20T07:12:00.000Z",
        }),
        entry({ action: "item.purge", before: side("groups/vertrieb/Altes Material"), time: "2026-10-15T07:30:00.000Z" }),
        ...["Angebote 2025", "Kalkulation"].map((name) =>
          entry({
            action: "item.move",
            via: "agent",
            batchId: "b1",
            time: "2026-10-14T14:40:00.000Z",
            before: side(`groups/vertrieb/${name}`),
            after: side(`groups/vertrieb/Archiv/2025/${name}`),
          }),
        ),
        entry({
          action: "item.move",
          state: "unclear",
          before: side("groups/vertrieb/Kalkulation.xlsx", false),
          time: "2026-10-14T13:10:00.000Z",
        }),
      ]),
    });
    expect(loads).toHaveLength(0);
    const table = dom.root.querySelector("table")!;
    expect([...table.querySelectorAll("th")].map((cell) => cell.textContent?.trim())).toEqual([
      "Zeit",
      "Wer",
      "Was",
      "Element",
      "Ablage",
      "Weg",
    ]);
    // What assistive technology reads: decorative avatars are hidden.
    const spoken = (cell: Element) => {
      const copy = cell.cloneNode(true) as Element;
      for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
      return copy.textContent?.trim();
    };
    const rows = [...table.querySelectorAll("tbody tr")].map((row) => [...row.querySelectorAll("td")].map(spoken));
    expect(rows[0]).toEqual(["20.10. 14:12", "Lukas Pohl", "LäuftVerschoben", "Messe 2026", "Team Vertrieb", "Web"]);
    expect(rows[1]).toEqual(["20.10. 09:12", "Ohne Eintrag in Cloud", "Weicht ab", "Preisliste_2026.xlsx", "Team Vertrieb", "bemerkt"]);
    expect(rows[2]?.slice(2, 3)).toEqual(["Endgültig gelöscht"]);
    expect(rows[3]).toEqual([
      "14.10. 16:40",
      "Assistant für Lukas Pohl",
      "Verschoben (2)",
      "Angebote 2025 und 1 weitere",
      "Team Vertrieb",
      "Agent",
    ]);
    expect(rows[4]?.[2]).toBe("Ausgang unklarVerschoben");
    // The phone list is the same list as Activity, from the same loaded pages.
    const list = dom.root.querySelector(".filesv2-history-list")!;
    expect(list.querySelector(".filesv2-history-day__title")?.textContent).toContain("Heute");
    expect(list.querySelectorAll(".filesv2-history-row")).toHaveLength(5);
    expect(list.textContent).toContain("Läuft");
    expect(list.textContent).toContain("Ausgang unklar");
  });

  test("loads, fails and retries in place with its filters, offers a reset when empty, and recovers an older page", async () => {
    const loads: { request: ActivityRequest; reply: ReturnType<typeof deferred<ActivityPage>> }[] = [];
    const changes: AdminActivityFilters[] = [];
    await history({ loads, changes });
    expect(text()).toContain("Aktivität wird geladen …");
    expect(loads[0]!.request).toEqual({ from: "2026-09-20T12:30:00.000Z" });
    loads[0]!.reply.reject(new Error("offline"));
    await flush();
    expect(text()).toContain("Die Aktivität konnte nicht geladen werden");
    expect(text()).toContain("Deine Filter bleiben stehen.");
    expect(dom.root.textContent).toContain("Wann");
    buttonNamed(dom.root, "Erneut versuchen")!.click();
    await flush();
    expect(loads).toHaveLength(2);
    loads[1]!.reply.resolve(page([]));
    await flush();
    expect(text()).toContain("Keine Einträge für diese Filter");
    expect(text()).toContain("In allen Ablagen gab es mit diesen Filtern in den letzten 30 Tagen nichts.");
    buttonNamed(dom.root, "Filter zurücksetzen")!.click();
    expect(changes).toEqual([{}]);

    cleanup();
    dom = createDomTestHarness();
    const older: typeof loads = [];
    await history({
      loads: older,
      initial: page([entry({ action: "item.trash", before: side("groups/vertrieb/Entwurf_alt.docx", false) })], "cursor-2"),
    });
    buttonNamed(dom.root, "Ältere Einträge laden")!.click();
    await flush();
    expect(older[0]!.request).toEqual({ from: "2026-09-20T12:30:00.000Z", cursor: "cursor-2" });
    older[0]!.reply.reject(new Error("offline"));
    await flush();
    expect(text()).toContain("Ältere Einträge konnten nicht geladen werden.");
    expect(text()).toContain("Entwurf_alt.docx");
    buttonNamed(dom.root, "Erneut versuchen")!.click();
    await flush();
    older
      .at(-1)!
      .reply.resolve(
        page([entry({ action: "share.create", after: side("groups/vertrieb/Druckdaten"), time: "2026-10-14T08:02:00.000Z" })]),
      );
    await flush();
    expect(text()).toContain("Druckdaten");
    expect(text()).not.toContain("Ältere Einträge konnten nicht geladen werden.");
  });

  test("visible rows request missing binding metadata directly, without walking the remaining base pages", async () => {
    const later = { ...vertrieb, bindingId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", displayName: "Current historical team" };
    const archivedSide = side("archive/old-team/report.pdf", false);
    if (archivedSide.visibility !== "full") throw new Error("fixture");
    archivedSide.baseId = later.bindingId;
    const requests: unknown[] = [];
    const replies = [deferred<ActivityBasesPage>(), deferred<ActivityBasesPage>()];
    await history({
      locale: "en",
      initial: page([entry({ action: "item.trash", before: archivedSide })]),
      bases: { items: [vertrieb], next: vertrieb.bindingId },
      loadBases: (input) => {
        requests.push(input);
        return replies[requests.length - 1]!.promise;
      },
    });
    expect(requests).toEqual([{ bindingIds: later.bindingId }]);
    replies[0]!.reject(new Error("offline"));
    await flush();
    expect(text()).toContain("Storage names could not be loaded.");
    // Retry is visible beside the history; loaded rows and filters stay intact.
    expect(text()).toContain("report.pdf");
    buttonNamed(dom.root, "Try again")!.click();
    await flush();
    expect(requests).toEqual([{ bindingIds: later.bindingId }, { bindingIds: later.bindingId }]);
    replies[1]!.resolve({ items: [later], next: null });
    await flush();
    expect(dom.root.querySelector("table")?.textContent).toContain("Current historical team");
    expect(text()).not.toContain("Storage names could not be loaded.");
    expect(requests).toHaveLength(2);
  });

  test.each(["en", "de"])(
    "the base picker reaches beyond 50 bindings, deduplicates options and recovers a failed page (%s)",
    async (locale) => {
      const requests: { input: unknown; reply: ReturnType<typeof deferred<ActivityBasesPage>> }[] = [];
      const first = Array.from({ length: 50 }, (_, index) => ({
        ...vertrieb,
        bindingId: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      }));
      const later: AdminActivityBase = {
        ...vertrieb,
        id: "cloud:groups:22222222-2222-4222-8222-222222222222",
        bindingId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        displayName: "Later team",
      };
      const changes: AdminActivityFilters[] = [];
      await history({
        locale,
        changes,
        initial: page([]),
        bases: { items: first, next: first[49]!.bindingId },
        loadBases: (input) => {
          const reply = deferred<ActivityBasesPage>();
          requests.push({ input, reply });
          return reply.promise;
        },
      });
      expect(requests).toHaveLength(0);
      buttonNamed(dom.root, locale === "de" ? "Ablage" : "Storage")!.click();
      await flush();
      buttonNamed(dom.document.body, locale === "de" ? "Weitere Ablagen suchen …" : "Find more storage …")!.click();
      await settle();
      const picker = dom.document.querySelector("dialog")!;
      buttonNamed(picker, locale === "de" ? "Weitere Ablagen laden" : "Load more storage")!.click();
      await flush();
      expect(requests).toHaveLength(1);
      expect(requests[0]!.input).toEqual({ after: first[49]!.bindingId });
      expect(picker.textContent).toContain(locale === "de" ? "Ablagen werden geladen …" : "Loading storage …");
      requests[0]!.reply.reject(new Error("offline"));
      await flush();
      expect(picker.textContent).toContain(
        locale === "de" ? "Die Ablagenamen konnten nicht geladen werden" : "Storage names could not be loaded",
      );
      buttonNamed(picker, locale === "de" ? "Erneut versuchen" : "Try again")!.click();
      await flush();
      expect(requests[1]!.input).toEqual(requests[0]!.input);
      requests[1]!.reply.resolve({ items: [later], next: null });
      await flush();
      expect(buttonNamed(picker, locale === "de" ? "Weitere Ablagen laden" : "Load more storage")).toBeUndefined();
      [...picker.querySelectorAll<HTMLButtonElement>('[role="combobox"]')].at(-1)!.click();
      await flush();
      expect(
        [...dom.document.querySelectorAll('[role="option"]')].filter((option) => option.textContent?.includes("Team Vertrieb")),
      ).toHaveLength(1);
      await dialogBack(() => buttonNamed(dom.document.body, "Later team")!.click());
      expect(changes.at(-1)?.baseId).toBe(later.id);
      expect(requests).toHaveLength(2);
    },
  );

  test("base search preserves an empty continuation, reports a terminal empty result, and cancels pending work", async () => {
    const { openAdminBasePicker } = await import("../src/frontend/ExportHistoryDialog");
    const requests: { input: unknown; signal: AbortSignal; reply: ReturnType<typeof deferred<ActivityBasesPage>> }[] = [];
    await mount(
      () => (
        <button
          type="button"
          onClick={() =>
            void openAdminBasePicker({
              bases: { items: [], next: null },
              labels: [],
              title: "Storage",
              load: (input, signal) => {
                const reply = deferred<ActivityBasesPage>();
                requests.push({ input, signal, reply });
                return reply.promise;
              },
            })
          }
        >
          Pick storage
        </button>
      ),
      "en",
    );
    buttonNamed(dom.root, "Pick storage")!.click();
    await settle();
    const picker = dom.document.querySelector("dialog")!;
    const search = picker.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = "Current name";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    buttonNamed(picker, "Search storage")!.click();
    await flush();
    expect(requests[0]!.input).toEqual({ q: "Current name" });
    requests[0]!.reply.resolve({ items: [], next: vertrieb.bindingId });
    await flush();
    expect(picker.textContent).toContain("No match in this part.");
    buttonNamed(picker, "Load more storage")!.click();
    await flush();
    expect(requests[1]!.input).toEqual({ q: "Current name", after: vertrieb.bindingId });
    requests[1]!.reply.resolve({ items: [], next: null });
    await flush();
    expect(picker.textContent).toContain("No recorded storage matches this search.");
    buttonNamed(picker, "Search storage")!.click();
    await flush();
    buttonNamed(picker, "Cancel")!.click();
    await settle();
    expect(requests[2]!.signal.aborted).toBeTrue();
    requests[2]!.reply.resolve({ items: [vertrieb], next: null });
    await settle();
    expect(dom.document.querySelector("dialog")).toBeNull();
  });

  const filters: AdminActivityFilters = { baseId: vertrieb.id, actor: LUKAS, action: "item.move", when: "30", q: "Angebote" };
  const openExport = async () => {
    await history({
      filters,
      locale: "en",
      initial: page([entry({ action: "item.move", after: side("groups/vertrieb/Archiv/Angebote") })]),
    });
    buttonNamed(dom.root, "Export")!.click();
    await settle();
    return dom.document.querySelector("dialog")!;
  };
  const primary = (dialog: HTMLElement) => dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!;

  test("the export selector can choose storage beyond its first metadata page", async () => {
    const later = {
      ...vertrieb,
      id: "cloud:groups:22222222-2222-4222-8222-222222222222",
      bindingId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      displayName: "Later export team",
    };
    const requests: unknown[] = [];
    await history({
      locale: "en",
      initial: page([]),
      bases: { items: [vertrieb], next: vertrieb.bindingId },
      loadBases: async (input) => {
        requests.push(input);
        return { items: [later], next: null };
      },
    });
    buttonNamed(dom.root, "Export")!.click();
    await settle();
    const dialog = dom.document.querySelector("dialog")!;
    dialog.querySelector<HTMLButtonElement>('[role="combobox"]')!.click();
    await flush();
    buttonNamed(dialog, "Find more storage …")!.click();
    await settle();
    const picker = [...dom.document.querySelectorAll("dialog")].at(-1)!;
    buttonNamed(picker, "Load more storage")!.click();
    await flush();
    expect(requests).toEqual([{ after: vertrieb.bindingId }]);
    [...picker.querySelectorAll<HTMLButtonElement>('[role="combobox"]')].at(-1)!.click();
    await flush();
    await dialogBack(() =>
      [...dom.document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
        .findLast((option) => option.textContent?.trim() === "Later export team")!
        .click(),
    );
    expect(exportCalls.at(-1)?.query.baseId).toBe(later.id);
    expect(exportCalls[0]!.signal.aborted).toBeTrue();
    expect(primary(dialog).disabled).toBeTrue();
    expect(dialog.textContent).toContain("Later export team");
  });

  test("counts exactly the current filters, exports them in the chosen format and discards nothing it did not finish", async () => {
    const changes: AdminActivityFilters[] = [];
    const dialog = await openExport();
    expect(dialog.textContent).toContain("Export history");
    expect(dialog.textContent).toContain("At most 1 year.");
    expect(dialog.textContent).toContain("Up to 100,000 rows.");
    expect(dialog.textContent).toContain("Also filtered by: Lukas Pohl, Moved, “Angebote”");
    expect(exportCalls).toHaveLength(1);
    const query = { from: "2026-09-21", to: "2026-10-20", baseId: vertrieb.id, actor: LUKAS, action: "item.move", q: "Angebote" };
    expect(exportCalls[0]).toMatchObject({ kind: "preview", query: { format: "csv", ...query } });
    expect(primary(dialog).disabled).toBeTrue();
    expect(primary(dialog).textContent).toContain("Counting rows …");
    exportCalls[0]!.reply.resolve(Response.json({ count: 8412 }));
    await flush();
    expect(primary(dialog).textContent).toContain("Export 8,412 rows");
    expect(primary(dialog).disabled).toBeFalse();

    // The format does not change the counted rows.
    buttonNamed(dialog, "JSON Lines")!.click();
    await flush();
    expect(exportCalls).toHaveLength(1);
    expect(primary(dialog).disabled).toBeFalse();

    // A broken stream saves nothing and leaves the dialog ready to try again.
    dialog.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(exportCalls[1]).toMatchObject({ kind: "export", query: { format: "jsonl", ...query } });
    exportCalls[1]!.reply.resolve(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"id":"1"}\n'));
            controller.error(new Error("broken"));
          },
        }),
      ),
    );
    await settle();
    expect(downloads).toHaveLength(0);
    expect(dialog.textContent).toContain("The export could not be completed. Nothing was saved. Try again.");
    expect(primary(dialog).disabled).toBeFalse();

    dialog.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    exportCalls[2]!.reply.resolve(new Response('{"id":"1"}\n'));
    await settle();
    expect(downloads.map((download) => download.name)).toEqual(["files-activity-2026-09-21-2026-10-20.jsonl"]);
    expect(dom.document.querySelector("dialog")).toBeNull();
    expect(changes).toEqual([]);
  });

  test("names zero rows, too many rows, lost rights and a failed count truthfully, and only a current count enables export", async () => {
    let dialog = await openExport();
    exportCalls[0]!.reply.resolve(Response.json({ ok: false, code: "activity_export_failed", error: "x" }, { status: 503 }));
    await flush();
    expect(dialog.textContent).toContain("The rows could not be counted.");
    expect(primary(dialog).disabled).toBeTrue();
    buttonNamed(dialog, "Try again")!.click();
    await flush();
    expect(exportCalls).toHaveLength(2);
    exportCalls[1]!.reply.resolve(Response.json({ count: 0 }));
    await flush();
    expect(primary(dialog).textContent).toContain("No rows to export");
    expect(primary(dialog).disabled).toBeTrue();
    expect(dialog.textContent).toContain("No entry matches these filters in this period.");
    buttonNamed(dialog, "Cancel")!.click();
    await settle();
    expect(dom.document.querySelector("dialog")).toBeNull();

    buttonNamed(dom.root, "Export")!.click();
    await settle();
    dialog = dom.document.querySelector("dialog")!;
    exportCalls[2]!.reply.resolve(Response.json({ ok: false, code: "activity_export_limit", error: "x" }, { status: 413 }));
    await flush();
    expect(dialog.textContent).toContain("More than 100,000 entries match. Narrow the period, the storage or the filters.");
    expect(primary(dialog).disabled).toBeTrue();
    buttonNamed(dialog, "Cancel")!.click();
    await settle();

    buttonNamed(dom.root, "Export")!.click();
    await settle();
    dialog = dom.document.querySelector("dialog")!;
    exportCalls[3]!.reply.resolve(Response.json({ ok: false, code: "forbidden", error: "x" }, { status: 403 }));
    await flush();
    expect(dialog.textContent).toContain("You are no longer allowed to export the history.");
    expect(primary(dialog).disabled).toBeTrue();
    expect(exportCalls.filter((call) => call.kind === "export")).toHaveLength(0);
  });

  test("cancel stops the count or the running download and closes the dialog without touching the list filters", async () => {
    let dialog = await openExport();
    const counting = exportCalls[0]!;
    buttonNamed(dialog, "Cancel")!.click();
    await settle();
    expect(counting.signal.aborted).toBeTrue();
    expect(dom.document.querySelector("dialog")).toBeNull();

    buttonNamed(dom.root, "Export")!.click();
    await settle();
    dialog = dom.document.querySelector("dialog")!;
    exportCalls[1]!.reply.resolve(Response.json({ count: 3 }));
    await flush();
    dialog.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    const download = exportCalls[2]!;
    expect(download.kind).toBe("export");
    expect(primary(dialog).getAttribute("aria-busy")).toBe("true");
    buttonNamed(dialog, "Cancel")!.click();
    await settle();
    expect(download.signal.aborted).toBeTrue();
    download.reply.resolve(new Response("late"));
    await settle();
    expect(downloads).toHaveLength(0);
    expect(dom.document.querySelector("dialog")).toBeNull();
  });
});
