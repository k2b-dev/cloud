import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createSignal, type JSX } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import type { ActivityPage, ShareAccessCounts, ShareAccessPeriod } from "../src/activity-contracts";
import type { ShareView } from "../src/contracts";
import type { ActivityVersion } from "../src/frontend/history-actions";
import type { ShareAccessRequest } from "../src/frontend/ShareHistory";
import { current, entry, env, gone, page } from "./history-fixtures";

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
const buttonNamed = (root: ParentNode, label: string) =>
  [...root.querySelectorAll<HTMLButtonElement | HTMLAnchorElement>("button, a")].find((element) => element.textContent?.trim() === label);

describe("Files history components", () => {
  if (isServer) {
    test.skip("requires the package DOM runner", () => {});
    return;
  }
  let cleanup = () => {};
  afterEach(() => cleanup());
  // UI modules touch `window` while loading, so every component loads after the DOM exists.
  let dom!: ReturnType<typeof createDomTestHarness>;
  beforeEach(() => {
    dom = createDomTestHarness();
    cleanup = () => dom.cleanup();
  });
  const mount = async (view: () => JSX.Element, locale = "de") => {
    const { LocaleProvider } = await import("@k2b/ui");
    const dispose = render(() => <LocaleProvider locale={locale}>{view()}</LocaleProvider>, dom.root);
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    return dom;
  };

  test.each(["de", "en"])("POSIX item history shows a localized notice in %s", async (locale) => {
    const { default: ItemHistory } = await import("../src/frontend/ItemHistory");
    const { FilesApiError } = await import("../src/frontend/file-preview");
    const { historyMessages } = await import("../src/frontend/history-messages");
    const load = async () => {
      throw new FilesApiError("history_unavailable", "Transport text in another language");
    };
    const dom = await mount(() => <ItemHistory env={env} directory={false} source="posix-item" unavailable load={load} />, locale);
    await flush();
    expect(dom.root.textContent).toContain(historyMessages(locale).historyUnavailable);
    expect(dom.root.textContent).not.toContain("Transport text");
    expect(buttonNamed(dom.root, historyMessages(locale).retry)).toBeUndefined();
    expect(dom.root.querySelector('[role="status"]')).not.toBeNull();
    expect(dom.root.querySelectorAll(".filesv2-history-row")).toHaveLength(0);
  });

  test("activity version evidence retries, restores the exact saved content, and disappears for a new row", async () => {
    const { HistoryRow } = await import("../src/frontend/history-rows");
    const original = entry({ action: "file.overwrite", after: current("vertrieb/Proof.pdf", { directory: false }) });
    const [value, setValue] = createSignal(original);
    const requests: { signal: AbortSignal; reply: ReturnType<typeof deferred<ActivityVersion | null>> }[] = [];
    let restores = 0;
    let changes = 0;
    const dom = await mount(() => (
      <HistoryRow
        row={{ key: value().id, kind: "single", lead: value(), entries: [value()] }}
        env={env}
        context="activity"
        dated
        variant="list"
        actions={{
          loadVersion: (_entry, signal) => {
            const reply = deferred<ActivityVersion | null>();
            requests.push({ signal, reply });
            return reply.promise;
          },
        }}
        onChanged={() => changes++}
      />
    ));
    await flush();
    expect(requests).toHaveLength(1);
    requests[0]!.reply.reject(new Error("Version list unavailable"));
    await flush();
    expect(dom.root.textContent).toContain("Version list unavailable");
    buttonNamed(dom.root, "Erneut versuchen")!.click();
    await flush();
    requests[1]!.reply.resolve({
      current: 3,
      restorable: 2,
      restore: async () => {
        restores++;
      },
    });
    await flush();
    expect(dom.root.textContent).toContain("Version 3");
    buttonNamed(dom.root, "Version 2 wiederherstellen")!.click();
    await flush();
    expect(restores).toBe(1);
    expect(changes).toBe(1);
    setValue(entry({ action: "item.move", after: current("vertrieb/Elsewhere") }));
    await flush();
    expect(dom.root.textContent).not.toContain("Version 3");
    expect(dom.root.textContent).not.toContain("Version 2 wiederherstellen");
  });

  test("item history shows four rows, counts only a complete history, and recovers a failed load in place", async () => {
    const { default: ItemHistory } = await import("../src/frontend/ItemHistory");
    const file = current("vertrieb/Proof.pdf", { directory: false });
    const items = [
      entry({ action: "file.overwrite", via: "office", time: "2026-10-20T06:52:00.000Z", after: file }),
      ...[20, 18, 16, 14].map((minute) =>
        entry({
          action: "file.edit",
          via: "office",
          actor: { kind: "user", userId: "tom", name: "Tom Albers" },
          time: `2026-10-19T15:${minute}:00.000Z`,
          after: file,
        }),
      ),
      entry({ action: "item.rename", time: "2026-10-15T09:03:00.000Z", before: gone("vertrieb/Proof_v1.pdf"), after: file }),
      entry({
        action: "file.upload",
        actor: { kind: "visitor", userId: null, name: null },
        via: "link",
        time: "2026-10-13T08:30:00.000Z",
        after: file,
      }),
      entry({ action: "file.create", time: "2026-10-12T08:30:00.000Z", after: file }),
      entry({
        action: "item.copy",
        time: "2026-10-11T08:30:00.000Z",
        before: file,
        after: current("vertrieb/Kopie.pdf", { directory: false }),
      }),
    ];
    const replies: ReturnType<typeof deferred<ActivityPage>>[] = [];
    const dom = await mount(() => (
      <ItemHistory
        env={env}
        directory={false}
        source="proof"
        activityHref="/app/filesv2/activity?item=proof"
        load={() => {
          const reply = deferred<ActivityPage>();
          replies.push(reply);
          return reply.promise;
        }}
      />
    ));
    await flush();
    expect(dom.root.querySelectorAll(".filesv2-history-row--skeleton")).toHaveLength(4);
    replies[0]!.reject(new Error("down"));
    await flush();
    expect(dom.root.textContent).toContain("Verlauf nicht geladen.");
    buttonNamed(dom.root, "Erneut versuchen")!.click();
    await flush();
    replies.at(-1)!.resolve(page(items));
    await flush();
    const rows = () => dom.root.querySelectorAll(".filesv2-history-row:not(.filesv2-history-row--skeleton)");
    expect(rows()).toHaveLength(4);
    expect(dom.root.textContent).toContain("Tom Albers hat die Datei im Editor bearbeitet");
    expect(dom.root.textContent).toContain("4-mal gespeichert");
    expect(dom.root.textContent).toContain("Lukas Pohl hat Proof_v1.pdf in Proof.pdf umbenannt");
    expect(dom.root.textContent).toContain("Besucher eines Upload-Links hat die Datei hochgeladen");
    expect(buttonNamed(dom.root, "Alles in Aktivität")?.getAttribute("href")).toBe("/app/filesv2/activity?item=proof");
    buttonNamed(dom.root, "2 ältere anzeigen")!.click();
    await flush();
    expect(rows()).toHaveLength(6);
  });

  test("link facts show counts and shortened networks, page further networks, and keep a failed revoke visible", async () => {
    const { default: ShareHistory, createShareAccess } = await import("../src/frontend/ShareHistory");
    const share = {
      id: "11111111-1111-4111-8111-111111111111",
      kind: "download",
      title: "Druckdaten für Hoffmann",
      state: "active",
      expiresAt: "2026-10-31T22:00:00.000Z",
    } as ShareView;
    const network = (address: string, pages: number) => ({
      network: address,
      pages,
      downloads: 0,
      passwordFailed: 0,
      firstSeen: "2026-10-18T10:00:00.000Z",
      lastSeen: "2026-10-19T10:00:00.000Z",
    });
    const first: ShareAccessCounts = {
      from: "2026-09-21",
      to: "2026-10-20",
      timeline: { items: [], next: null },
      pageNetworks: null,
      pages: 214,
      downloads: 61,
      passwordFailed: 0,
      networks: {
        known: 5,
        overflow: false,
        incomplete: false,
        rolledUp: false,
        next: "198.51.100.0/24",
        items: [network("2001:db8:4f2::/48", 9), network("192.0.2.0/24", 3), network("198.18.0.0/24", 1), network("198.51.100.0/24", 22)],
      },
    };
    const retryPage = deferred<ShareAccessCounts>();
    const requests: ShareAccessRequest[] = [];
    const period = { from: "2026-09-21", to: "2026-10-20" };
    const load = async (request: ShareAccessRequest) => {
      requests.push(request);
      if (requests.length === 1) throw new Error("Offline");
      return retryPage.promise;
    };
    const last = { ...first, networks: { ...first.networks, next: null, items: [network("203.0.113.0/24", 148)] } };
    const dom = await mount(() => {
      const links = createShareAccess({
        shares: () => [{ share, creatorName: "Mia Schulz" }],
        period: () => period,
        initial: { [share.id]: first },
        load,
      });
      return (
        <ShareHistory
          env={env}
          shares={links()}
          period={period}
          load={load}
          onRevoke={async () => {
            throw new Error("Der Link konnte nicht widerrufen werden.");
          }}
        />
      );
    });
    await flush();
    const text = () => dom.root.textContent ?? "";
    expect(requests).toEqual([]);
    expect(text()).toContain("von Mia Schulz · gültig bis 31.10.");
    expect(text()).toContain("214");
    expect(text()).toContain("Downloads freigegeben");
    expect(text()).toContain("Letzte 30 Tage. Netze sind gekürzt und keine Personen.");
    expect(text()).toContain("2001:db8:4f2::");
    expect(text()).toContain("192.0.2.x");
    expect(text()).not.toContain("/24");
    expect(dom.root.querySelectorAll(".filesv2-share-facts__networks li")).toHaveLength(3);
    buttonNamed(dom.root, "2 weitere Netze")!.click();
    await flush();
    expect(dom.root.querySelectorAll(".filesv2-share-facts__networks li")).toHaveLength(4);
    buttonNamed(dom.root, "Weitere Netze laden")!.click();
    await flush();
    const retry = buttonNamed(dom.root, "Erneut versuchen")!;
    const alert = dom.root.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    retry.click();
    await flush();
    expect(retry.disabled).toBe(true);
    expect(retry.textContent?.trim()).toBe("Erneut versuchen");
    expect(dom.root.querySelector('[role="alert"]')).toBe(alert);
    retryPage.resolve(last);
    await flush();
    expect(requests).toEqual(Array(2).fill({ shareId: share.id, networkAfter: "198.51.100.0/24" }));
    expect(text()).toContain("203.0.113.x");
    expect(text()).toContain("seit 18.10. · 9-mal");
    expect(text()).toContain("148-mal");
    expect(buttonNamed(dom.root, "Weitere Netze laden")).toBeUndefined();
    buttonNamed(dom.root, "Link widerrufen")!.click();
    await flush();
    const dialog = dom.document.querySelector("dialog")!;
    buttonNamed(dialog, "Widerrufen")!.click();
    await flush();
    expect(dom.root.querySelector("[role='alert']")?.textContent).toBe("Der Link konnte nicht widerrufen werden.");
  });
  test("rows use the approved avatar sizes, a finding without a Cloud entry reads as a warning, and link figures stay flat", async () => {
    const { HistoryAvatar } = await import("../src/frontend/history-rows");
    const { default: ShareHistory, createShareAccess } = await import("../src/frontend/ShareHistory");
    const share = {
      id: "22222222-2222-4222-8222-222222222222",
      kind: "download",
      title: "Druckdaten für Hoffmann",
      state: "active",
      expiresAt: null,
    } as ShareView;
    const counts: ShareAccessCounts = {
      from: "2026-09-21",
      to: "2026-10-20",
      timeline: { items: [], next: null },
      pageNetworks: null,
      pages: 214,
      downloads: 61,
      passwordFailed: 0,
      networks: { known: 37, overflow: false, incomplete: false, rolledUp: false, next: null, items: [] },
    };
    const dom = await mount(() => (
      <>
        <HistoryAvatar actor={{ kind: "person", label: "Mia Schulz", person: null, agent: null, icon: null }} size="sm" />
        <HistoryAvatar actor={{ kind: "observed", label: "ohne Eintrag", person: null, agent: null, icon: "ti ti-server" }} size="xs" />
        {(() => {
          const period = { from: "2026-09-21", to: "2026-10-20" };
          const links = createShareAccess({
            shares: () => [{ share, creatorName: null }],
            period: () => period,
            initial: { [share.id]: counts },
            load: async () => counts,
          });
          return <ShareHistory env={env} shares={links()} period={period} load={async () => counts} />;
        })()}
      </>
    ));
    await flush();
    const [person, observed] = [...dom.root.querySelectorAll<HTMLElement>(".k2b-avatar")];
    expect([person!.style.width, person!.style.height]).toEqual(["30px", "30px"]);
    expect([observed!.style.width, observed!.style.height]).toEqual(["26px", "26px"]);
    expect(observed!.style.background).toContain("--k2b-warning-surface");
    expect(person!.style.background).toBe("");
    // Figures are a plain description list: value under its label's semantics, no stat cards.
    const figures = dom.root.querySelector("dl.filesv2-share-facts__stats")!;
    expect([...figures.querySelectorAll("dt")].map((term) => term.textContent)).toEqual([
      "Seitenaufrufe",
      "Downloads freigegeben",
      "Netze",
    ]);
    expect([...figures.querySelectorAll("dd")].map((value) => value.textContent)).toEqual(["214", "61", "37"]);
    expect(dom.root.querySelector(".k2b-stat-grid, .k2b-stat-cell")).toBeNull();
  });

  test("an empty item history page with more pages never claims no history", async () => {
    const { default: ItemHistory } = await import("../src/frontend/ItemHistory");
    const loads: (string | null)[] = [];
    const dom = await mount(() => (
      <ItemHistory
        env={env}
        directory={false}
        source="item"
        initial={{ source: "item", page: page([], "cursor-2") }}
        load={async (cursor) => {
          loads.push(cursor);
          return page([]);
        }}
      />
    ));
    await flush();
    const text = () => dom.root.textContent ?? "";
    expect(text()).not.toContain("Noch keine Einträge");
    expect(text()).toContain("Bisher nichts Passendes");
    buttonNamed(dom.root, "Ältere anzeigen")!.click();
    await flush();
    expect(loads).toEqual(["cursor-2"]);
    expect(text()).toContain("Noch keine Einträge");
  });
  const accessShare = (id: string, title: string) => ({ id, kind: "download", title, state: "active", expiresAt: null }) as ShareView;
  const accessPeriod = (date: string, patch: Partial<ShareAccessPeriod> = {}): ShareAccessPeriod => ({
    date,
    granularity: "hour",
    pages: 0,
    downloads: 0,
    passwordFailed: 0,
    knownNetworks: null,
    pageNetworks: null,
    overflow: false,
    ...patch,
  });
  const accessCounts = (items: ShareAccessPeriod[], next: string | null = null): ShareAccessCounts => ({
    from: "2026-09-21",
    to: "2026-10-20",
    timeline: { items, next },
    pageNetworks: null,
    pages: 99,
    downloads: 2,
    passwordFailed: 0,
    networks: { known: 21, overflow: false, incomplete: true, rolledUp: false, next: null, items: [] },
  });
  const rowTimes = (root: ParentNode) =>
    [...root.querySelectorAll(".filesv2-history-rows > li time")].map((time) => time.getAttribute("datetime"));

  test("item source changes hide old rows and counts through failure, retry from the first page, and retain same-source pages", async () => {
    const { default: ItemHistory } = await import("../src/frontend/ItemHistory");
    const { Show } = await import("solid-js");
    const old = entry({ action: "file.upload", after: current("vertrieb/Alt.pdf", { directory: false }) });
    const fresh = entry({
      action: "file.upload",
      time: "2026-10-19T08:00:00.000Z",
      after: current("vertrieb/Neu.pdf", { directory: false }),
    });
    const older = entry({
      action: "file.create",
      time: "2026-10-18T08:00:00.000Z",
      after: current("vertrieb/Neu.pdf", { directory: false }),
    });
    const [source, setSource] = createSignal("old");
    const [shown, setShown] = createSignal(true);
    const calls: { source: string; cursor: string | null; signal: AbortSignal; reply: ReturnType<typeof deferred<ActivityPage>> }[] = [];
    // The component's source contract holds independently of the parent's selection/remount strategy.
    const dom = await mount(() => (
      <Show when={shown()}>
        <ItemHistory
          env={env}
          directory={false}
          source={source()}
          initial={{ source: "old", page: page([old]) }}
          load={(cursor, signal) => {
            const reply = deferred<ActivityPage>();
            calls.push({ source: source(), cursor, signal, reply });
            return reply.promise;
          }}
        />
      </Show>
    ));
    await flush();
    const chips = () => [...dom.root.querySelectorAll(".k2b-count-chip")].map((chip) => chip.textContent);
    expect(calls).toHaveLength(0);
    expect(rowTimes(dom.root)).toEqual([old.time]);
    expect(chips()).toEqual(["1"]);

    setSource("new");
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ source: "new", cursor: null });
    expect(rowTimes(dom.root)).toEqual([]);
    expect(chips()).toEqual([]);
    expect(dom.root.querySelector(".filesv2-item-history")?.getAttribute("aria-busy")).toBe("true");
    expect(dom.root.querySelectorAll(".filesv2-history-row--skeleton")).toHaveLength(4);
    calls[0]!.reply.reject(new Error("offline"));
    await flush();
    expect(dom.root.querySelector("[role='alert']")?.textContent).toContain("Verlauf nicht geladen.");
    expect(dom.root.querySelector(".filesv2-item-history")?.getAttribute("aria-busy")).toBe("false");
    expect(rowTimes(dom.root)).toEqual([]);
    expect(chips()).toEqual([]);
    expect(dom.root.textContent).not.toContain("Noch keine Einträge");

    buttonNamed(dom.root, "Erneut versuchen")!.click();
    await flush();
    expect(calls[1]).toMatchObject({ source: "new", cursor: null });
    expect(rowTimes(dom.root)).toEqual([]);
    calls[1]!.reply.resolve(page([fresh], "new-older"));
    await flush();
    expect(rowTimes(dom.root)).toEqual([fresh.time]);
    expect(dom.root.textContent).not.toContain("Alt.pdf");
    expect(chips()).toEqual([]);
    buttonNamed(dom.root, "Ältere anzeigen")!.click();
    await flush();
    expect(calls[2]).toMatchObject({ source: "new", cursor: "new-older" });
    calls[2]!.reply.reject(new Error("offline"));
    await flush();
    // A failed older page belongs to the same source: keep its good first page and retry its cursor.
    expect(rowTimes(dom.root)).toEqual([fresh.time]);
    expect(dom.root.querySelector("[role='alert']")?.textContent).toContain("Ältere Einträge konnten nicht geladen werden.");
    buttonNamed(dom.root, "Erneut versuchen")!.click();
    await flush();
    expect(calls[3]).toMatchObject({ source: "new", cursor: "new-older" });
    calls[3]!.reply.resolve(page([older]));
    await flush();
    expect(rowTimes(dom.root)).toEqual([fresh.time, older.time]);
    expect(chips()).toEqual(["2"]);
    expect(dom.root.querySelector("[role='alert']")).toBeNull();

    setSource("pending");
    await flush();
    setSource("last");
    await flush();
    expect(calls[4]!.signal.aborted).toBe(true);
    calls[4]!.reply.resolve(page([old]));
    await flush();
    expect(rowTimes(dom.root)).toEqual([]);
    setShown(false);
    await flush();
    expect(calls[5]!.signal.aborted).toBe(true);
    calls[5]!.reply.resolve(page([old]));
    await flush();
    expect(dom.root.textContent).toBe("");
  });

  test("a new access window hides old facts, rows and cursor through failure, while same-window refresh keeps good pages", async () => {
    const { default: ItemHistory } = await import("../src/frontend/ItemHistory");
    const { default: ShareHistory, createShareAccess } = await import("../src/frontend/ShareHistory");
    const { Show } = await import("solid-js");
    const share = accessShare("88888888-8888-4888-8888-888888888888", "Druckdaten");
    const old = accessCounts([accessPeriod("2026-10-18T08:00:00.000Z", { pages: 99 })], "old-window-cursor");
    const nextWindow = { from: "2026-10-01", to: "2026-10-20" };
    const fresh = {
      ...accessCounts([accessPeriod("2026-10-19T08:00:00.000Z", { pages: 7 })]),
      ...nextWindow,
      pages: 7,
    };
    const [period, setPeriod] = createSignal({ from: old.from, to: old.to });
    const [shown, setShown] = createSignal(true);
    const calls: {
      request: ShareAccessRequest;
      period: { from: string; to: string };
      signal: AbortSignal;
      reply: ReturnType<typeof deferred<ShareAccessCounts>>;
    }[] = [];
    const load = (request: ShareAccessRequest, signal: AbortSignal) => {
      const reply = deferred<ShareAccessCounts>();
      calls.push({ request, period: period(), signal, reply });
      return reply.promise;
    };
    let links!: ReturnType<typeof createShareAccess>;
    const dom = await mount(() => (
      <Show when={shown()}>
        {(() => {
          links = createShareAccess({ shares: () => [{ share, creatorName: null }], period, initial: { [share.id]: old }, load });
          return (
            <>
              <ShareHistory env={env} shares={links()} period={period()} load={load} />
              <ItemHistory
                env={env}
                directory
                source="druckdaten"
                initial={{ source: "druckdaten", page: page([]) }}
                load={async () => page([])}
                links={{ items: links(), state: "complete" }}
              />
            </>
          );
        })()}
      </Show>
    ));
    await flush();
    const access = () => links()[0]!.access;
    const facts = () => [...dom.root.querySelectorAll(".filesv2-share-facts__stats dd")].map((value) => value.textContent);
    const history = () => dom.root.querySelector(".filesv2-item-history")!;
    const chips = () => [...dom.root.querySelectorAll(".k2b-count-chip")].map((chip) => chip.textContent);
    expect(calls).toHaveLength(0);
    expect(facts()).toEqual(["99", "2", "21"]);
    expect(rowTimes(dom.root)).toEqual(["2026-10-18T08:00:00.000Z"]);
    expect(access().hasMore()).toBe(true);

    setPeriod(nextWindow);
    await flush();
    expect(calls[0]).toMatchObject({ request: { shareId: share.id }, period: nextWindow });
    expect(access().pages()).toEqual([]);
    expect(access().hasMore()).toBe(false);
    expect(facts()).toEqual([]);
    expect(rowTimes(dom.root)).toEqual([]);
    expect(history().getAttribute("aria-busy")).toBe("true");
    expect(dom.root.querySelector(".filesv2-share-facts__skeleton")).not.toBeNull();
    expect(chips()).toEqual(["1"]); // Only the known link count, never the old history count.
    calls[0]!.reply.reject(new Error("offline"));
    await flush();
    expect(history().getAttribute("aria-busy")).toBe("false");
    expect(history().querySelector("[role='alert']")?.textContent).toContain("Zugriffe nicht geladen.");
    expect(facts()).toEqual([]);
    expect(rowTimes(dom.root)).toEqual([]);
    expect(access().hasMore()).toBe(false);
    expect(dom.root.textContent).not.toContain("Noch keine Einträge");

    buttonNamed(history(), "Erneut versuchen")!.click();
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ request: { shareId: share.id }, period: nextWindow });
    expect(calls[1]!.request.timelineAfter).toBeUndefined();
    calls[1]!.reply.resolve(fresh);
    await flush();
    expect(access().pages()).toEqual([fresh]);
    expect(facts()).toEqual(["7", "2", "21"]);
    expect(rowTimes(dom.root)).toEqual(["2026-10-19T08:00:00.000Z"]);
    expect(chips()).toEqual(["1", "1"]);

    const refreshed = access().refresh();
    await flush();
    expect(facts()).toEqual(["7", "2", "21"]);
    expect(rowTimes(dom.root)).toEqual(["2026-10-19T08:00:00.000Z"]);
    calls[2]!.reply.reject(new Error("offline"));
    await refreshed;
    await flush();
    expect(access().pages()).toEqual([fresh]);
    expect(facts()).toEqual(["7", "2", "21"]);
    expect(rowTimes(dom.root)).toEqual(["2026-10-19T08:00:00.000Z"]);
    expect(history().querySelector("[role='alert']")?.textContent).toContain("Zugriffe nicht geladen.");
    expect(chips()).toEqual(["1"]);
    buttonNamed(history(), "Erneut versuchen")!.click();
    await flush();
    expect(calls[3]).toMatchObject({ request: { shareId: share.id }, period: nextWindow });
    calls[3]!.reply.resolve({ ...fresh, pages: 8 });
    await flush();
    expect(facts()).toEqual(["8", "2", "21"]);
    expect(history().querySelector("[role='alert']")).toBeNull();
    expect(chips()).toEqual(["1", "1"]);

    setPeriod({ from: "2026-10-02", to: "2026-10-20" });
    await flush();
    setPeriod({ from: "2026-10-03", to: "2026-10-20" });
    await flush();
    expect(calls[4]!.signal.aborted).toBe(true);
    calls[4]!.reply.resolve(old);
    await flush();
    expect(facts()).toEqual([]);
    expect(rowTimes(dom.root)).toEqual([]);
    setShown(false);
    await flush();
    expect(calls[5]!.signal.aborted).toBe(true);
    calls[5]!.reply.resolve(old);
    await flush();
    expect(dom.root.textContent).toBe("");
  });

  test("link access joins the item history newest first, keeps four rows, and loads older access by cursor with one request per link", async () => {
    const { default: ItemHistory } = await import("../src/frontend/ItemHistory");
    const { default: ShareHistory, createShareAccess } = await import("../src/frontend/ShareHistory");
    const share = accessShare("55555555-5555-4555-8555-555555555555", "Druckdaten für Hoffmann");
    const folder = current("vertrieb/Druckdaten");
    const items = [
      entry({
        action: "file.upload",
        time: "2026-10-16T12:20:00.000Z",
        after: current("vertrieb/Druckdaten/Proof.pdf", { directory: false }),
      }),
      entry({ action: "share.create", time: "2026-10-01T07:12:00.000Z", after: folder }),
      entry({ action: "folder.create", time: "2026-09-30T14:45:00.000Z", after: folder }),
    ];
    const requests: ShareAccessRequest[] = [];
    const load = async (request: ShareAccessRequest) => {
      requests.push(request);
      return request.timelineAfter
        ? accessCounts([
            accessPeriod("2026-10-15T00:00:00.000Z"),
            accessPeriod("2026-09-01T00:00:00.000Z", { granularity: "day", pages: 5 }),
          ])
        : accessCounts(
            [
              accessPeriod("2026-10-18T20:00:00.000Z", { pages: 96, pageNetworks: 1, knownNetworks: 21, downloads: 3 }),
              accessPeriod("2026-10-17T08:00:00.000Z", { downloads: 2 }),
              accessPeriod("2026-10-15T08:00:00.000Z", { pages: 3 }),
            ],
            "2026-10-15T08:00:00.000Z",
          );
    };
    const period = { from: "2026-09-21", to: "2026-10-20" };
    const dom = await mount(() => {
      const links = createShareAccess({ shares: () => [{ share, creatorName: "Mia Schulz" }], period: () => period, load });
      return (
        <>
          <ShareHistory env={env} shares={links()} period={period} load={load} />
          <ItemHistory
            env={env}
            directory
            source="druckdaten"
            initial={{ source: "druckdaten", page: page(items) }}
            load={async () => page(items)}
            links={{ items: links(), state: "complete" }}
          />
        </>
      );
    });
    await flush();
    const text = () => dom.root.textContent ?? "";
    const chips = () => [...dom.root.querySelectorAll(".k2b-count-chip")].map((chip) => chip.textContent);
    // Facts and history read one query: one first-page request for the link, none for the SSR activity page.
    expect(requests).toEqual([{ shareId: share.id }]);
    // The access timeline may still hold rows newer than the older changes, so those wait; the history does not count.
    expect(rowTimes(dom.root)).toEqual([
      "2026-10-18T20:00:00.000Z",
      "2026-10-17T08:00:00.000Z",
      "2026-10-16T12:20:00.000Z",
      "2026-10-15T08:00:00.000Z",
    ]);
    expect(chips()).toEqual(["1"]);
    expect(dom.root.querySelectorAll("[data-kind='link-access']")).toHaveLength(3);
    expect(dom.root.querySelectorAll("[data-kind='link-access'] .k2b-avatar")).toHaveLength(3);
    expect(dom.root.querySelector("[data-kind='link-access'] button")).toBeNull();
    expect(text()).toContain("Die Seite des Links wurde 96-mal aus einem Netz aufgerufen");
    expect(text()).toContain("18.10., 22:00 bis 23:00");
    expect(text()).toContain("Link „Druckdaten für Hoffmann“");
    expect(text()).toContain("3 Downloads freigegeben");
    expect(text()).toContain("Über den Link wurden 2 Downloads freigegeben");
    expect(text()).toContain("Die Seite des Links wurde 3-mal aufgerufen");
    // Facts keep their place: figures, networks and no timeline of their own.
    expect(dom.root.querySelector(".filesv2-share-facts__periods")).toBeNull();
    expect(text()).not.toContain("Zugriffe nach Zeit");
    expect(buttonNamed(dom.root, "2 ältere anzeigen")).toBeUndefined();
    buttonNamed(dom.root, "Ältere anzeigen")!.click();
    await flush();
    expect(requests).toEqual([{ shareId: share.id }, { shareId: share.id, timelineAfter: "2026-10-15T08:00:00.000Z" }]);
    // Empty buckets stay out; a rolled-up day names the whole day; everything loaded now counts.
    expect(rowTimes(dom.root)).toEqual([
      "2026-10-18T20:00:00.000Z",
      "2026-10-17T08:00:00.000Z",
      "2026-10-16T12:20:00.000Z",
      "2026-10-15T08:00:00.000Z",
      "2026-10-01T07:12:00.000Z",
      "2026-09-30T14:45:00.000Z",
      "2026-09-01T00:00:00.000Z",
    ]);
    expect(text()).toContain("01.09., ganzer Tag");
    expect(chips()).toEqual(["1", "7"]);
    expect(buttonNamed(dom.root, "Ältere anzeigen")).toBeUndefined();
    buttonNamed(dom.root, "Weniger anzeigen")!.click();
    await flush();
    expect(rowTimes(dom.root)).toHaveLength(4);
    expect(buttonNamed(dom.root, "3 ältere anzeigen")).toBeDefined();
  });

  test("failed or pending link access never reads as an empty or complete history, recovers in place, and aborts when the link leaves", async () => {
    const { default: ItemHistory } = await import("../src/frontend/ItemHistory");
    const { createShareAccess } = await import("../src/frontend/ShareHistory");
    const first = accessShare("66666666-6666-4666-8666-666666666666", "Druckdaten");
    const second = accessShare("77777777-7777-4777-8777-777777777777", "Angebote");
    const upload = entry({
      action: "file.upload",
      time: "2026-10-16T12:20:00.000Z",
      after: current("vertrieb/Druckdaten/Proof.pdf", { directory: false }),
    });
    const calls: { request: ShareAccessRequest; signal: AbortSignal; reply: ReturnType<typeof deferred<ShareAccessCounts>> }[] = [];
    const [shares, setShares] = createSignal<{ share: ShareView; creatorName: string | null }[]>([{ share: first, creatorName: null }]);
    const [state, setState] = createSignal<"loading" | "partial" | "complete">("loading");
    const dom = await mount(() => {
      const links = createShareAccess({
        shares,
        period: () => ({ from: "2026-09-21", to: "2026-10-20" }),
        load: (request, signal) => {
          const reply = deferred<ShareAccessCounts>();
          calls.push({ request, signal, reply });
          return reply.promise;
        },
      });
      return (
        <ItemHistory
          env={env}
          directory
          source="druckdaten"
          initial={{ source: "druckdaten", page: page([upload]) }}
          load={async () => page([upload])}
          links={{ items: links(), state: state() }}
        />
      );
    });
    await flush();
    const text = () => dom.root.textContent ?? "";
    const chips = () => [...dom.root.querySelectorAll(".k2b-count-chip")].map((chip) => chip.textContent);
    // Known changes show at once; pending links keep the history uncounted and busy, never "no entries".
    expect(rowTimes(dom.root)).toEqual(["2026-10-16T12:20:00.000Z"]);
    expect(chips()).toEqual([]);
    expect(dom.root.querySelector(".filesv2-item-history")?.getAttribute("aria-busy")).toBe("true");
    setState("complete");
    calls[0]!.reply.reject(new Error("forbidden"));
    await flush();
    expect(dom.root.querySelector("[role='alert']")?.textContent).toContain("Zugriffe nicht geladen.");
    expect(rowTimes(dom.root)).toEqual(["2026-10-16T12:20:00.000Z"]);
    expect(chips()).toEqual([]);
    expect(text()).not.toContain("Noch keine Einträge");
    buttonNamed(dom.root, "Erneut versuchen")!.click();
    await flush();
    expect(calls).toHaveLength(2);
    calls[1]!.reply.resolve(accessCounts([accessPeriod("2026-10-18T20:00:00.000Z", { pages: 4 })]));
    await flush();
    expect(rowTimes(dom.root)).toEqual(["2026-10-18T20:00:00.000Z", "2026-10-16T12:20:00.000Z"]);
    expect(chips()).toEqual(["2"]);
    expect(dom.root.querySelector("[role='alert']")).toBeNull();
    // Further link pages unloaded: rows stay, the count goes.
    setState("partial");
    await flush();
    expect(chips()).toEqual([]);
    setState("complete");
    // A link that leaves the loaded list aborts its request, and its late answer never appears.
    setShares([{ share: second, creatorName: null }]);
    await flush();
    expect(calls).toHaveLength(3);
    expect(calls[2]!.request).toEqual({ shareId: second.id });
    expect(rowTimes(dom.root)).toEqual(["2026-10-16T12:20:00.000Z"]);
    setShares([]);
    await flush();
    expect(calls[2]!.signal.aborted).toBe(true);
    calls[2]!.reply.resolve(accessCounts([accessPeriod("2026-10-19T08:00:00.000Z", { pages: 7 })]));
    await flush();
    expect(rowTimes(dom.root)).toEqual(["2026-10-16T12:20:00.000Z"]);
    expect(chips()).toEqual(["1"]);
  });
});
