import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import type { AutomationLogItem, AutomationLogPage } from "../../contracts";
import MailAutomationLog, { type MailAutomationLogApi, UndoNotPossible } from "./MailAutomationLog";
import { logFixtureDetail, logFixtureId, logFixtureItems, logFixturePage } from "./mail-automation-log-fixtures";
import type { AutomationLogFilter } from "./mail-automation-log-model";

export type LogHarnessOptions = {
  locale: "en" | "de";
  /** `empty` starts without entries; `failing` makes the next load fail; `notPossible` makes Undo meet a person's change. */
  scenario: "normal" | "empty" | "failing" | "notPossible";
};

declare global {
  interface Window {
    mountAutomationLog: (options: LogHarnessOptions) => void;
    /** Holds every load until released, so a test can see the loading rows or let an older page finish late. */
    holdLoads: () => void;
    releaseLoads: () => void;
    logCalls: string[];
    viewChanges: Array<{ filter: string; q: string; entry: string | null }>;
  }
}

/** Older entries of the same day, behind the first page's cursor. */
const olderItems: AutomationLogItem[] = logFixtureItems.slice(0, 2).map((item, index) => ({
  ...item,
  id: logFixtureId(900 + index),
  at: `2026-10-26T05:0${index}:00.000Z`,
  conversation: { ...item.conversation, subject: `Ältere Anfrage ${index + 1}` },
}));

const matches = (item: AutomationLogItem, filter: AutomationLogFilter) =>
  filter === "uncertain"
    ? item.outcome === "uncertain"
    : filter === "skipped"
      ? item.outcome === "skipped"
      : filter === "manual"
        ? item.outcome === "manual_change"
        : filter === "assignments"
          ? item.effects.some((effect) => effect.kind === "assign")
          : true;

window.mountAutomationLog = (options) => {
  const host = document.getElementById("root");
  if (!host) throw new Error("Missing harness root");
  document.documentElement.lang = options.locale;
  window.logCalls = [];
  window.viewChanges = [];
  let failNext = options.scenario === "failing";
  let held: Promise<void> | null = null;
  let release: () => void = () => {};
  window.holdLoads = () => {
    held = new Promise<void>((done) => {
      release = done;
    });
  };
  window.releaseLoads = () => {
    release();
    held = null;
  };
  // The server's state: Undo and Redo change it, later loads and details read it.
  const state = new Map<string, AutomationLogItem>(
    (options.scenario === "empty" ? [] : [...logFixtureItems, ...olderItems]).map((item) => [item.id, structuredClone(item)]),
  );
  const firstPage = () => [...state.values()].filter((item) => !olderItems.some((older) => older.id === item.id));
  const page = (items: AutomationLogItem[], cursor: string | null): AutomationLogPage => {
    const base = logFixturePage(items);
    return {
      ...base,
      nextCursor: cursor,
      counts:
        options.scenario === "empty"
          ? { all: 0, assignments: 0, uncertain: 0, skipped: 0, manual: 0 }
          : { ...base.counts, all: logFixtureItems.length + olderItems.length },
    };
  };
  const api: MailAutomationLogApi = {
    load: async ({ filter, q, before }) => {
      window.logCalls.push(`load:${filter}:${q}:${before ?? ""}`);
      if (held) await held;
      if (failNext) {
        failNext = false;
        throw new Error("unavailable");
      }
      const visible = (items: AutomationLogItem[]) =>
        items.filter((item) => matches(item, filter) && item.conversation.subject.toLowerCase().includes(q.toLowerCase()));
      if (before === "older") return page(visible(olderItems.map((item) => state.get(item.id) ?? item)), null);
      return page(visible(firstPage()), filter === "all" && !q ? "older" : null);
    },
    detail: async (id) => {
      window.logCalls.push(`detail:${id}`);
      const item = state.get(id);
      if (!item) throw new Error("gone");
      return logFixtureDetail(item);
    },
    undo: async (id) => {
      window.logCalls.push(`undo:${id}`);
      const item = state.get(id);
      if (!item) throw new Error("gone");
      if (options.scenario === "notPossible") {
        const refused: AutomationLogItem = {
          ...item,
          undo: {
            state: "not_possible",
            reason: "changed_by_person",
            by: { userId: "Usr009", name: "Ida Lorenz" },
            at: "2026-10-26T09:10:00.000Z",
          },
        };
        state.set(id, refused);
        throw new UndoNotPossible(refused);
      }
      const undone: AutomationLogItem = {
        ...item,
        undo: { state: "done", reason: null, by: { userId: "Usr002", name: "Lisa Brandt" }, at: "2026-10-26T09:15:00.000Z" },
      };
      state.set(id, undone);
      return undone;
    },
    redo: async (id) => {
      window.logCalls.push(`redo:${id}`);
      const item = state.get(id);
      if (!item) throw new Error("gone");
      const restored: AutomationLogItem = { ...item, undo: { state: "available", reason: null, by: null, at: null } };
      state.set(id, restored);
      return restored;
    },
  };
  const initial = page(firstPage(), options.scenario === "empty" ? null : "older");
  render(
    () => (
      <LocaleProvider locale={options.locale}>
        <main class="flex min-w-0 flex-1 overflow-auto p-4">
          <MailAutomationLog
            mailboxName="Vertrieb"
            timeZone="UTC"
            initial={initial}
            canUndo
            api={api}
            onViewChange={(view) => window.viewChanges.push(view)}
          />
        </main>
      </LocaleProvider>
    ),
    host,
  );
};
