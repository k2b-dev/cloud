import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createSignal, type JSX } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import type { ActivityBatchContext, ActivityChain, ActivityEntry } from "../src/activity-contracts";
import type { MarkedEntry } from "../src/contracts";
import type { ActivityVersion, HistoryActions, HistoryEnvironment, RestoreOutcome } from "../src/frontend/history-actions";
import type { ActivityFilters } from "../src/frontend/history-requests";
import type { ActivityRecovery } from "../src/service/activity-actions";
import { chain, current, entry, env, gone, hidden, live, page, snapshot } from "./history-fixtures";

/** Older pages come through the API; each request waits for the test to answer it. */
const requests: { query: Record<string, string>; reply: (response: Response) => void }[] = [];
if (!isServer)
  mock.module("../src/api/client", () => ({
    apiClient: {
      activity: {
        $get: (input: { query: Record<string, string> }) =>
          new Promise<Response>((resolve) => requests.push({ query: structuredClone(input.query), reply: resolve })),
      },
    },
  }));

const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const valentin = { kind: "user" as const, userId: "valentin", name: "Valentin Kolb" };
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 20, 10, 54, seconds)).toISOString();
const BASES = [{ id: "cloud:groups:vertrieb", label: "Team Vertrieb" }];

/** The API bulk case from the feedback: each file renamed in Inbox, then moved on; newest first. */
const bulk = (count: number) =>
  Array.from({ length: count }, (_, index) => {
    const name = `Rechnung-${index + 1}.pdf`;
    return [
      entry({
        action: "item.move",
        time: at(50 - index * 2),
        actor: valentin,
        via: "api",
        before: snapshot(`vertrieb/Inbox/${name}`, { directory: false }),
        after: live(`vertrieb/Buchhaltung/ebay/${name}`, { directory: false }),
      }),
      entry({
        action: "item.rename",
        time: at(49 - index * 2),
        actor: valentin,
        via: "api",
        before: snapshot(`vertrieb/Inbox/scan-${index + 1}.pdf`, { directory: false }),
        after: snapshot(`vertrieb/Inbox/${name}`, { directory: false }),
      }),
    ];
  }).flat();

describe("Activity on UI v2", () => {
  if (isServer) {
    test.skip("requires the package DOM runner", () => {});
    return;
  }
  let cleanup = () => {};
  afterEach(() => {
    cleanup();
    requests.length = 0;
  });
  let dom!: ReturnType<typeof createDomTestHarness>;
  // v2 overlays read the phone query at once; the DOM harness has no global matchMedia, so a desktop answers.
  const media = Object.getOwnPropertyDescriptor(globalThis, "matchMedia");
  beforeEach(() => {
    Object.defineProperty(globalThis, "matchMedia", {
      configurable: true,
      value: (query: string) => ({ media: query, matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    });
    dom = createDomTestHarness();
    cleanup = () => dom.cleanup();
  });
  afterEach(() => {
    if (media) Object.defineProperty(globalThis, "matchMedia", media);
    else Reflect.deleteProperty(globalThis, "matchMedia");
  });

  const mount = async (view: () => JSX.Element) => {
    const { LocaleProvider } = await import("@k2b/ui");
    let dispose = render(() => <LocaleProvider locale="de">{view()}</LocaleProvider>, dom.root);
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    await flush();
    return {
      remount: async () => {
        dispose();
        dom.root.textContent = "";
        dispose = render(() => <LocaleProvider locale="de">{view()}</LocaleProvider>, dom.root);
        await flush();
      },
    };
  };

  /** The pane as the screen places it: the first page from the server, the filters from the address. */
  const pane = async (
    items: ActivityEntry[] | null,
    options: {
      filters?: ActivityFilters;
      marks?: MarkedEntry[];
      actions?: HistoryActions;
      next?: string;
      bases?: { id: string; label: string }[];
      loadChain?: (entry: ActivityEntry) => Promise<ActivityChain>;
      loadBatch?: (entry: ActivityEntry, signal: AbortSignal) => Promise<ActivityBatchContext>;
      env?: HistoryEnvironment;
      onReload?: () => void;
    } = {},
  ) => {
    const { default: ActivityPane } = await import("../src/frontend/ActivityPane");
    const { activityQuery } = await import("../src/frontend/activity-query");
    const { historyMessages } = await import("../src/frontend/history-messages");
    const { activityUrl } = await import("../src/frontend/urls");
    const filters = options.filters ?? {};
    const bases = options.bases ?? BASES;
    const query = activityQuery(historyMessages("de"), bases, () => []);
    const state = query.parse(new URL(activityUrl(filters), "https://files.invalid").searchParams).state;
    return mount(() => (
      <ActivityPane
        filters={filters}
        query={query}
        state={state}
        onChange={() => {}}
        initial={items ? page(items, options.next ?? null) : null}
        marks={options.marks}
        bases={bases}
        env={options.env ?? env}
        actions={options.actions ?? {}}
        loadChain={(value) => options.loadChain?.(value) ?? Promise.resolve(chain({}))}
        loadBatch={options.loadBatch ?? (async () => ({ visibleCount: 1, complete: true }))}
        retentionDays={365}
        pending={false}
        onReload={options.onReload ?? (() => {})}
        onPeople={() => {}}
      />
    ));
  };
  const rows = () => [...dom.root.querySelectorAll<HTMLElement>('[data-k2-part="Row"]')];
  const rowWith = (text: string) => rows().find((row) => row.textContent?.includes(text));
  const opener = (row: HTMLElement | undefined) => row?.querySelector<HTMLAnchorElement | HTMLButtonElement>(".k2-row-open");
  const buttonNamed = (root: ParentNode, label: string) =>
    [...root.querySelectorAll<HTMLButtonElement | HTMLAnchorElement>("button, a")].find(
      (element) => element.textContent?.trim() === label || element.getAttribute("aria-label") === label,
    );
  const text = () => dom.root.textContent ?? "";

  test("a current file opens in its folder, and a vanished one is plain with a hint", async () => {
    await pane([
      entry({
        action: "item.move",
        actor: valentin,
        before: snapshot("vertrieb/Inbox/A.pdf", { directory: false }),
        after: live("vertrieb/Buchhaltung/A.pdf", { directory: false }),
      }),
      entry({ action: "file.upload", before: hidden, after: gone("vertrieb/Inbox/Alt.pdf", { directory: false }) }),
    ]);
    const moved = rowWith("A.pdf")!;
    expect(opener(moved)?.getAttribute("href")).toBe(
      "/app/filesv2?base=cloud%3Agroups%3Avertrieb&path=Buchhaltung&file=Buchhaltung%2FA.pdf",
    );
    // One row design everywhere: each change leads with the thing's mark, and under "All" the sentence names the person.
    expect(moved.querySelector('[data-k2-part="Mark"]')).not.toBeNull();
    expect(moved.querySelector('[data-k2-part="Avatar"]')).toBeNull();
    expect(moved.textContent).toContain("Valentin Kolb");
    const vanished = rowWith("Alt.pdf")!;
    expect(vanished.textContent).toContain("Alt.pdf (nicht mehr verfügbar)");
    expect(vanished.querySelector("a")).toBeNull();
    // The day stands once over its changes, so the row says its time alone; the web, the usual channel, is not named.
    expect(dom.root.querySelector(".k2-list-head")?.textContent).toContain("Heute");
    expect(moved.textContent).toContain("14:12");
    expect(moved.textContent).not.toContain("heute");
    expect(vanished.textContent).not.toContain("Web");
    // The row opens the file in its folder; there is no second way to the same place behind a "…".
    expect(buttonNamed(moved, "Aktionen zum Verlauf")).toBeUndefined();
  });

  test("markup, an entity and Markdown in a name read as written and make no element", async () => {
    const name = "<img src=x onerror=alert(1)> & &amp; **bold**.md";
    await pane([
      entry({ action: "file.upload", actor: valentin, before: hidden, after: live(`vertrieb/Inbox/${name}`, { directory: false }) }),
    ]);
    // the review of 26.11. read "script> &amp; **bold**.md": that was the fixture (a slash split the name as a path)
    expect(rowWith("onerror")!.textContent).toContain(name);
    expect(dom.root.querySelector("img")).toBeNull();
    expect(dom.root.querySelector("strong")).toBeNull();
  });

  test("only sides the reader returned as current lead anywhere; a hidden side adds no name, folder or address", async () => {
    await pane([
      entry({ action: "item.move", before: gone("vertrieb/Kunden/Bericht.pdf", { directory: false }), after: hidden }),
      entry({ action: "item.copy", before: hidden, after: live("vertrieb/Archiv/Kopie.pdf", { directory: false }) }),
      entry({ action: "item.move", before: hidden, after: snapshot("vertrieb/Privat/Notiz.pdf", { directory: false }) }),
    ]);
    expect(rowWith("Bericht.pdf")!.textContent).toContain("an einen Ort, den du nicht sehen kannst");
    expect(rowWith("Bericht.pdf")!.querySelector("a")).toBeNull();
    expect(rowWith("Notiz.pdf")!.querySelector("a")).toBeNull();
    const hrefs = [...dom.root.querySelectorAll("a")].map((link) => link.getAttribute("href") ?? "");
    expect(hrefs.some((href) => href.includes("Kopie.pdf"))).toBe(true);
    expect(hrefs.every((href) => !href.includes("Kunden") && !href.includes("Privat"))).toBe(true);
  });

  test("a bulk rename and move reads as one line that opens its changes below it and stays open after coming back", async () => {
    const view = await pane(bulk(12));
    const run = () => rowWith("12 Dateien umbenannt und verschoben")!;
    expect(run().textContent).toContain("Team Vertrieb › Buchhaltung › ebay");
    expect(run().textContent).toContain("12 Änderungen");
    expect(rows()).toHaveLength(1);
    opener(run())!.click();
    await flush();
    expect(rows()).toHaveLength(13);
    // The run names the destination; its lines name only the new and the old name, and each opens its file.
    const first = rows()[1]!;
    expect(first.textContent).toContain("Rechnung-1.pdf, vorher scan-1.pdf");
    expect(opener(first)?.getAttribute("href")).toContain("file=Buchhaltung%2Febay%2FRechnung-1.pdf");
    expect(rows()[0]).toBe(run());
    await view.remount();
    expect(rows()).toHaveLength(13);
    opener(run())!.click();
    await flush();
    expect(rows()).toHaveLength(1);
  });

  test("four merged changes stay single lines", async () => {
    await pane(bulk(4));
    expect(rows()).toHaveLength(4);
    expect(rowWith("Änderungen")).toBeUndefined();
  });

  const openedFile = (path: string, markedAt: string): MarkedEntry => ({
    base: { id: "cloud:groups:vertrieb", name: "vertrieb", kind: "groups", area: "cloud" },
    entry: { name: path.split("/").at(-1)!, path, directory: false, size: 1, modified: markedAt },
    markedAt,
  });

  test('"Me" leads each line with the thing and lists opened files in time order, each leading to the file', async () => {
    await pane(
      [
        entry({
          action: "file.upload",
          time: at(40),
          actor: valentin,
          after: live("vertrieb/Kampagnen/Angebot.pdf", { directory: false }),
        }),
        entry({ action: "file.edit", time: at(10), actor: valentin, after: live("vertrieb/Planung/Budget.xlsx", { directory: false }) }),
      ],
      { filters: { actor: "me" }, marks: [openedFile("Grafik/Logo.svg", at(20))] },
    );
    expect(dom.root.querySelector('[data-k2-part="Row"] [data-k2-part="Avatar"]')).toBeNull();
    expect(rows().map((row) => row.querySelector('[data-k2-part="Mark"]') !== null)).toEqual([true, true, true]);
    const order = ["Angebot.pdf", "Logo.svg", "Budget.xlsx"];
    expect(rows().map((row) => order.find((name) => row.textContent?.includes(name)))).toEqual(order);
    expect(rowWith("Angebot.pdf")!.textContent).toContain("Angebot.pdf hochgeladen in Team Vertrieb › Kampagnen");
    expect(opener(rowWith("Logo.svg"))?.getAttribute("href")).toBe(
      "/app/filesv2?base=cloud%3Agroups%3Avertrieb&path=Grafik&file=Grafik%2FLogo.svg",
    );
  });

  test('"All" never shows opened files; an empty "Me" leads to everyone\'s changes in one link', async () => {
    await pane([entry({ action: "file.upload", after: live("vertrieb/A.pdf", { directory: false }) })], {
      marks: [openedFile("Grafik/Logo.svg", at(20))],
    });
    expect(text()).not.toContain("Logo.svg");
    cleanup();
    dom = createDomTestHarness();
    await pane([], { filters: { actor: "me" }, marks: [] });
    expect(text()).toContain("Noch keine Aktivität von dir");
    expect(buttonNamed(dom.root, "Alle anzeigen")?.getAttribute("href")).toBe("/app/filesv2?view=activity");
  });

  test("a batch opens its visible members, and a failed older page says so and recovers in place", async () => {
    const batch = Array.from({ length: 5 }, (_, index) =>
      entry({
        action: "item.move",
        via: "agent",
        batchId: "b1",
        time: "2026-10-14T14:40:00.000Z",
        before: gone(`vertrieb/Kunden/Ordner ${index + 1}`),
        after: current(`vertrieb/Archiv/2025/Ordner ${index + 1}`),
      }),
    );
    const today = entry({
      action: "file.overwrite",
      via: "office",
      actor: { kind: "user", userId: "mia", name: "Mia Schulz" },
      after: current("vertrieb/Proof.pdf", { directory: false }),
    });
    await pane([today, ...batch], { filters: { baseId: "cloud:groups:vertrieb" }, next: "cursor-2" });
    expect(requests).toHaveLength(0);
    expect(rowWith("Proof.pdf")!.textContent).toContain("Mia Schulz");
    const line = () => rowWith("Assistant im Auftrag von Lukas Pohl hat 5 Elemente nach Team Vertrieb › Archiv › 2025 verschoben")!;
    expect(line().textContent).toContain("5 Elemente");
    opener(line())!.click();
    await flush();
    expect(rows().filter((row) => /Ordner \d$/.test(row.textContent ?? ""))).toHaveLength(5);

    buttonNamed(dom.root, "Ältere Einträge laden")!.click();
    await flush();
    expect(requests[0]!.query).toEqual({ baseId: "cloud:groups:vertrieb", cursor: "cursor-2" });
    requests[0]!.reply(Response.json({ code: "unavailable", message: "offline" }, { status: 503 }));
    await flush();
    expect(text()).toContain("Ältere Einträge konnten nicht geladen werden.");
    expect(rowWith("Proof.pdf")).toBeDefined();
    buttonNamed(dom.root, "Erneut versuchen")!.click();
    await flush();
    const older = entry({ action: "item.trash", time: "2026-10-01T08:00:00.000Z", before: gone("vertrieb/Alt.docx") });
    requests.at(-1)!.reply(Response.json(page([older])));
    await flush();
    expect(text()).toContain("Alt.docx in den Papierkorb verschoben");
    expect(text()).not.toContain("Ältere Einträge konnten nicht geladen werden.");
  });

  test("a failed first page keeps the filters and reads again; filters without changes lead back to where Activity starts", async () => {
    let reloads = 0;
    await pane(null, { filters: { baseId: "cloud:groups:vertrieb", when: "7" }, onReload: () => reloads++ });
    expect(text()).toContain("Die Aktivität konnte nicht geladen werden");
    buttonNamed(dom.root, "Erneut versuchen")!.click();
    expect(reloads).toBe(1);
    cleanup();
    dom = createDomTestHarness();
    await pane([], { filters: { baseId: "cloud:groups:vertrieb", when: "7" } });
    expect(text()).toContain("Keine Einträge für diese Filter");
    expect(buttonNamed(dom.root, "Filter zurücksetzen")?.getAttribute("href")).toBe("/app/filesv2?view=activity&who=me");
  });

  test("POSIX storage has no history and says so once; a mixed overview names it beside Cloud's changes", async () => {
    const { historyMessages } = await import("../src/frontend/history-messages");
    const h = historyMessages("de");
    await pane([], { filters: { baseId: "freeipa:groups:10000000-0000-4000-8000-000000000001" }, bases: [] });
    expect(text()).toContain(h.historyUnavailable);
    expect(buttonNamed(dom.root, h.retry)).toBeUndefined();
    cleanup();
    dom = createDomTestHarness();
    await pane([entry({ action: "file.upload", after: live("vertrieb/A.pdf", { directory: false }) })], {
      bases: [
        { id: "cloud:users:alice", label: "Cloud" },
        { id: "freeipa:users:alice", label: "POSIX" },
      ],
    });
    expect(text()).toContain(h.historyOverviewUnavailable);
    expect(rows().length).toBeGreaterThan(0);
  });

  test("a change's version evidence that cannot be read says so and reads again, then offers the version", async () => {
    const replies: ReturnType<typeof deferred<ActivityVersion | null>>[] = [];
    let restores = 0;
    await pane([entry({ action: "file.overwrite", after: current("vertrieb/Proof.pdf", { directory: false }) })], {
      actions: {
        loadVersion: () => {
          const reply = deferred<ActivityVersion | null>();
          replies.push(reply);
          return reply.promise;
        },
      },
    });
    replies[0]!.reject(new Error("Version list unavailable"));
    await flush();
    expect(text()).toContain("Version list unavailable");
    buttonNamed(dom.root, "Erneut versuchen")!.click();
    await flush();
    replies[1]!.resolve({ current: 3, restorable: 2, restore: async () => void restores++ });
    await flush();
    expect(text()).toContain("Version 3");
    buttonNamed(dom.root, "Version 2 wiederherstellen")!.click();
    await flush();
    expect(restores).toBe(1);
  });

  // ── The search for a vanished item ──────────────────────────────────────────────────────────────────────────────
  const search = (entries: ActivityEntry[], options: Omit<Parameters<typeof pane>[1] & object, "filters"> & { q?: string } = {}) =>
    pane(entries, { filters: { q: options.q ?? "Angebote 2025" }, bases: [], ...options });

  test("a vanished folder moved to a hidden place offers contact, never a destination or a jump", async () => {
    const contacted: unknown[] = [];
    await search([entry({ action: "item.move", before: gone("vertrieb/Kunden/Angebote 2025"), after: hidden })], {
      actions: { onOpen: () => {}, onContact: (person) => contacted.push(person) },
    });
    expect(text()).toContain("Liegt jetzt an einem Ort, den du nicht sehen kannst");
    expect(text()).toContain("Frag Lukas Pohl oder die Administration danach.");
    expect(buttonNamed(dom.root, "Dorthin springen")).toBeUndefined();
    buttonNamed(dom.root, "Nachricht an Lukas Pohl")!.click();
    expect(contacted).toEqual([{ userId: "lukas", name: "Lukas Pohl" }]);
  });

  test("a moved folder names its current place only after the chain resolves it, and says when that is probable", async () => {
    const opened: unknown[] = [];
    const replies: ReturnType<typeof deferred<ActivityChain>>[] = [];
    await search(
      [
        entry({
          action: "item.move",
          via: "agent",
          before: gone("vertrieb/Kunden/Angebote 2025"),
          after: current("vertrieb/Archiv/2025/Angebote 2025"),
        }),
      ],
      {
        actions: { onOpen: (target) => opened.push(target) },
        loadChain: () => {
          const reply = deferred<ActivityChain>();
          replies.push(reply);
          return reply.promise;
        },
      },
    );
    // the filter row counts the hits once; no second line repeats the count
    expect(text()).toContain("1 Treffer im Verlauf");
    expect(text().match(/1 Treffer/g)?.length).toBe(1);
    expect(text()).not.toContain("Liegt jetzt in");
    expect(buttonNamed(dom.root, "Dorthin springen")).toBeUndefined();
    replies[0]!.reject(new Error("timeout"));
    await flush();
    expect(text()).toContain("Der aktuelle Ort konnte nicht geprüft werden.");
    buttonNamed(dom.root, "Erneut versuchen")!.click();
    await flush();
    const endpoint = { baseId: "cloud:groups:vertrieb", path: "Archiv/2025/Angebote 2025", itemId: null };
    replies.at(-1)!.resolve(chain({ endpoint, certainty: "probable" }));
    await flush();
    expect(text()).toContain("Liegt vermutlich in Team Vertrieb › Archiv › 2025");
    expect(text()).toContain("Ohne feste Kennung kann Dateien den neuen Ort nicht sicher bestätigen.");
    expect(text()).toContain("Verschoben am 20.10. um 14:12 vom Assistant im Auftrag von Lukas Pohl.");
    buttonNamed(dom.root, "Dorthin springen")!.click();
    expect(opened).toEqual([{ kind: "endpoint", endpoint }]);
  });

  test("restoring from the trash asks for a new name on a conflict, from the hit and from another match's row", async () => {
    const calls: [string, string | undefined][] = [];
    const trashed = entry({ action: "item.trash", before: gone("vertrieb/Kunden/Angebote 2025") });
    const sheet = entry({ action: "item.trash", before: gone("vertrieb/Kunden/Angebote_2025_Übersicht.xlsx") });
    await search([trashed, sheet], {
      actions: {
        onRestoreTrash: async (value, options): Promise<RestoreOutcome> => {
          calls.push([value.id, options?.name]);
          return options ? { status: "restored" } : { status: "name_conflict" };
        },
      },
    });
    expect(text()).toContain("Liegt im Papierkorb von Team Vertrieb");
    expect(text()).toContain("Es kommt zurück nach Team Vertrieb › Kunden.");
    expect(text()).toContain("Angebote_2025_Übersicht.xlsx liegt im Papierkorb");
    const answer = async (name: string, expected: string) => {
      for (let i = 0; i < 5 && !dom.document.querySelector("dialog"); i++) {
        await new Promise((resolve) => dom.window.requestAnimationFrame(() => resolve(undefined)));
        await flush();
      }
      const dialog = dom.document.querySelector("dialog")!;
      expect(dialog.textContent).toContain("Name schon vergeben");
      const input = dialog.querySelector<HTMLInputElement>('input[maxlength="255"]')!;
      expect(input.value).toBe(expected);
      input.value = name;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      dialog.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flush();
    };
    const restoreButtons = () =>
      [...dom.root.querySelectorAll("button")].filter((button) => button.textContent?.trim() === "Wiederherstellen");
    restoreButtons()[0]!.click();
    await flush();
    await answer("Angebote 2025 alt", "Angebote 2025 (wiederhergestellt)");
    restoreButtons().at(-1)!.click();
    await flush();
    await answer("Übersicht alt.xlsx", "Angebote_2025_Übersicht.xlsx (wiederhergestellt)");
    expect(calls).toEqual([
      [trashed.id, undefined],
      [trashed.id, "Angebote 2025 alt"],
      [sheet.id, undefined],
      [sheet.id, "Übersicht alt.xlsx"],
    ]);
  });

  test("an unclear move says it is unclear and rechecks instead of jumping", async () => {
    let rechecked = 0;
    await search(
      [
        entry({
          action: "item.move",
          state: "unclear",
          before: gone("vertrieb/Kunden/Angebote 2025"),
          after: current("vertrieb/Archiv/2025/Angebote 2025"),
        }),
      ],
      { actions: { onOpen: () => {}, onRecheck: async () => void rechecked++ } },
    );
    expect(text()).toContain("Ausgang unklar");
    expect(text()).toContain("Ob das Verschieben fertig wurde, ist noch unklar.");
    expect(buttonNamed(dom.root, "Dorthin springen")).toBeUndefined();
    buttonNamed(dom.root, "Jetzt prüfen")!.click();
    await flush();
    expect(rechecked).toBe(1);
  });

  // ── An old folder address ───────────────────────────────────────────────────────────────────────────────────────
  test("an old folder address names where its folder went, opens it there, and never jumps without an endpoint", async () => {
    const { default: MovedPane } = await import("../src/frontend/MovedPane");
    const opened: unknown[] = [];
    const endpoint = { baseId: "cloud:groups:vertrieb", path: "Archiv/Kunden/Angebote", itemId: null };
    const [known, setKnown] = createSignal(true);
    await mount(() => (
      <MovedPane
        moved={{
          baseId: "cloud:groups:vertrieb",
          path: "Kunden/Angebote",
          entry: entry({ action: "item.move", before: gone("vertrieb/Kunden"), after: current("vertrieb/Archiv/Kunden") }),
          chain: known() ? chain({ endpoint, certainty: "probable" }) : chain({}),
        }}
        oldAddress={["Team Vertrieb", "Kunden", "Angebote"]}
        env={env}
        onOpen={(target) => opened.push(target)}
        historyHref="/app/filesv2?view=activity&q=Angebote"
      />
    ));
    expect(text()).toContain("„Angebote“ liegt vermutlich in");
    expect(text()).not.toContain("„Kunden“ liegt");
    expect(buttonNamed(dom.root, "Verlauf ansehen")?.getAttribute("href")).toBe("/app/filesv2?view=activity&q=Angebote");
    buttonNamed(dom.root, "Dorthin springen")!.click();
    expect(opened).toEqual([{ kind: "endpoint", endpoint }]);
    setKnown(false);
    await flush();
    expect(text()).toContain("Der aktuelle Ort konnte nicht geprüft werden.");
    expect(buttonNamed(dom.root, "Dorthin springen")).toBeUndefined();
  });
  test("a later chain step names who moved it on", async () => {
    const moved = entry({
      action: "item.move",
      time: "2026-10-14T14:40:00.000Z",
      before: gone("vertrieb/Kunden/Angebote 2025"),
      after: current("vertrieb/Archiv/Angebote 2025", { itemId: "f1" }),
    });
    const later = {
      activityId: "later",
      time: "2026-10-16T08:00:00.000Z",
      actor: { kind: "user" as const, userId: "jana", name: "Jana Berger" },
      via: "web",
      before: current("vertrieb/Archiv/Angebote 2025", { itemId: "f1" }),
      after: current("vertrieb/Archiv/2025/Angebote 2025", { itemId: "f1" }),
    };
    await search([moved], {
      loadChain: async () =>
        chain({
          hops: [later],
          endpoint: { baseId: "cloud:groups:vertrieb", path: "Archiv/2025/Angebote 2025", itemId: "f1" },
          certainty: "verified",
        }),
    });
    expect(text()).toContain("Jana Berger hat es von Team Vertrieb › Archiv weiter nach Team Vertrieb › Archiv › 2025 verschoben");
  });

  test("a vanished item offers recovery only as the server allows it now, and says so when that check fails", async () => {
    const trashed = entry({ action: "item.trash", before: gone("vertrieb/Kunden/Angebote 2025", { directory: true }) });
    const shown: unknown[] = [];
    const replies: ReturnType<typeof deferred<ActivityRecovery>>[] = [];
    await search([trashed], {
      actions: {
        onRestoreTrash: async () => ({ status: "restored" }),
        onShowTrash: (trash) => shown.push(trash),
        loadRecovery: () => {
          const reply = deferred<ActivityRecovery>();
          replies.push(reply);
          return reply.promise;
        },
      },
    });
    // The disappearance side now says it was a folder.
    expect(text()).toContain("Der Ordner kommt zurück");
    expect(text()).toContain("Dateien prüft, was du hier tun kannst");
    expect(buttonNamed(dom.root, "Wiederherstellen")).toBeUndefined();
    replies[0]!.reject(new Error("offline"));
    await flush();
    expect(text()).toContain("Dateien konnte nicht prüfen, was du hier tun kannst.");
    buttonNamed(dom.root, "Erneut versuchen")!.click();
    await flush();
    const trash = { baseId: "cloud:groups:vertrieb", id: "33333333-3333-4333-8333-333333333333", canRestore: false };
    replies.at(-1)!.resolve({ oldLocation: { baseId: trash.baseId, path: "Kunden" }, trash, canMoveBack: false });
    await flush();
    // Still in the trash, but this person may not write the old place: no restore, the trash stays reachable.
    expect(buttonNamed(dom.root, "Wiederherstellen")).toBeUndefined();
    buttonNamed(dom.root, "Im Papierkorb zeigen")!.click();
    expect(shown).toEqual([trash]);
  });

  test("an unclear move opens only the old place the server checked, and a moved item moves back only when allowed", async () => {
    const opened: unknown[] = [];
    await search(
      [
        entry({
          action: "item.move",
          state: "unclear",
          before: gone("vertrieb/Kunden/Messe 2026"),
          after: current("vertrieb/Archiv/Messe 2026"),
        }),
      ],
      {
        q: "Messe 2026",
        actions: {
          onRecheck: async () => {},
          onOpenOldLocation: (place) => opened.push(place),
          onMoveBack: async () => {},
          loadRecovery: async () => ({ oldLocation: { baseId: "cloud:groups:vertrieb", path: "Kunden" }, trash: null, canMoveBack: false }),
        },
      },
    );
    buttonNamed(dom.root, "Alten Ort öffnen")!.click();
    expect(opened).toEqual([{ baseId: "cloud:groups:vertrieb", path: "Kunden" }]);
    expect(buttonNamed(dom.root, "Zurückverschieben")).toBeUndefined();
    expect(buttonNamed(dom.root, "Jetzt prüfen")).toBeDefined();
  });

  test("a vanished item's history counts the visible members of its batch and leads to its run, without a second main deed", async () => {
    const execution = { invocationId: "inv-1", requestId: null, callingApp: null, origin: "assistant" };
    const moved = entry({
      action: "item.move",
      via: "agent",
      batchId: "batch-1",
      execution,
      time: "2026-10-14T14:40:00.000Z",
      before: gone("vertrieb/Kunden/Angebote 2025"),
      after: current("vertrieb/Archiv/2025/Angebote 2025"),
    });
    const sibling = entry({
      action: "item.move",
      via: "agent",
      batchId: "batch-1",
      execution,
      time: "2026-10-14T14:40:00.000Z",
      before: gone("vertrieb/Kunden/Angebote 2025 Übersicht.xlsx", { directory: false }),
      after: current("vertrieb/Archiv/2025/Angebote 2025 Übersicht.xlsx", { directory: false }),
    });
    const renamed = entry({
      action: "item.rename",
      time: "2026-10-02T07:15:00.000Z",
      before: gone("vertrieb/Kunden/Angebote"),
      after: gone("vertrieb/Kunden/Angebote 2025"),
    });
    await search([moved, sibling, renamed], {
      env: { ...env, executionHref: (value) => `/app/filesv2/executions/${value.id}` },
      loadChain: async () =>
        chain({ endpoint: { baseId: "cloud:groups:vertrieb", path: "Archiv/2025/Angebote 2025", itemId: null }, certainty: "verified" }),
      loadBatch: async (value) => {
        expect(value.id).toBe(moved.id);
        return { visibleCount: 42, complete: true };
      },
      actions: { onOpen: () => {}, onMoveBack: async () => {} },
    });
    const history = [...dom.root.querySelectorAll<HTMLElement>('[data-k2-part="Section"]')].find((section) =>
      section.getAttribute("aria-label")?.startsWith("Verlauf"),
    )!;
    const lead = history.querySelector<HTMLElement>('[data-k2-part="Row"]')!;
    expect(lead.textContent).toContain("mit 41 weiteren Elementen");
    // The hit above owns the jump; the history's rows never repeat a deed.
    expect([...history.querySelectorAll("button")].filter((button) => button.textContent?.trim())).toHaveLength(0);
    expect(buttonNamed(dom.root, "Dorthin springen")).toBeDefined();
    buttonNamed(lead, "Aktionen zum Verlauf")!.click();
    await flush();
    const run = [...dom.document.querySelectorAll<HTMLAnchorElement>("a")].find((link) => link.textContent?.includes("Ausführung ansehen"));
    expect(run?.getAttribute("href")).toBe(`/app/filesv2/executions/${moved.id}`);
    // The menu closes before the page goes, so its focus check never runs on a document that is gone.
    dom.document.activeElement?.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  test("the batch context of a vanished item's step retries a failed read, marks a lower bound, and aborts on disposal", async () => {
    const moved = entry({
      action: "item.move",
      batchId: "batch-1",
      before: gone("vertrieb/Angebote"),
      after: current("vertrieb/Archiv/Angebote"),
    });
    const calls: { signal: AbortSignal; reply: ReturnType<typeof deferred<ActivityBatchContext>> }[] = [];
    await search([moved], {
      q: "Angebote",
      loadBatch: (_entry, signal) => {
        const reply = deferred<ActivityBatchContext>();
        calls.push({ signal, reply });
        return reply.promise;
      },
    });
    expect(calls).toHaveLength(1);
    expect(text()).toContain("Weitere Elemente werden geprüft");
    calls[0]!.reply.reject(new Error("offline"));
    await flush();
    expect(text()).toContain("Die weiteren Elemente konnten nicht geprüft werden");
    buttonNamed(dom.root, "Erneut versuchen")!.click();
    await flush();
    calls[1]!.reply.resolve({ visibleCount: 500, complete: false });
    await flush();
    expect(text()).toContain("mit mindestens 499 weiteren Elementen");
    cleanup();
    expect(calls[1]!.signal.aborted || calls.length === 2).toBeTrue();
  });
});
