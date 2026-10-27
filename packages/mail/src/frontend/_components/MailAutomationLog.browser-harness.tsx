import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import MailAutomationLog, { type MailAutomationLogApi, UndoNotPossible } from "./MailAutomationLog";
import { logFixtureDetail, logFixtureItems, logFixturePage } from "./mail-automation-log-fixtures";
import type { AutomationLogPage } from "./mail-automation-log-model";

export type LogHarnessOptions = {
  locale: "en" | "de";
  /** `empty` starts without entries; `failing` makes the next load fail; `notPossible` makes Undo meet a person's change. */
  scenario: "normal" | "empty" | "failing" | "notPossible";
};

declare global {
  interface Window {
    mountAutomationLog: (options: LogHarnessOptions) => void;
    /** Holds every load until released, so a test can see the loading rows. */
    holdLoads: () => void;
    releaseLoads: () => void;
    logCalls: string[];
  }
}

window.mountAutomationLog = (options) => {
  const host = document.getElementById("root");
  if (!host) throw new Error("Missing harness root");
  document.documentElement.lang = options.locale;
  window.logCalls = [];
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
  const items = options.scenario === "empty" ? [] : logFixtureItems;
  const api: MailAutomationLogApi = {
    load: async ({ filter, q }) => {
      window.logCalls.push(`load:${filter}:${q}`);
      if (held) await held;
      if (failNext) {
        failNext = false;
        throw new Error("unavailable");
      }
      const filtered =
        filter === "uncertain"
          ? items.filter((item) => item.outcome === "uncertain")
          : filter === "skipped"
            ? items.filter((item) => item.outcome === "skipped")
            : filter === "manual"
              ? items.filter((item) => item.outcome === "manual_change")
              : filter === "assignments"
                ? items.filter((item) => item.effects.some((effect) => effect.kind === "assign"))
                : items;
      const page: AutomationLogPage = logFixturePage(
        filtered.filter((item) => item.conversation.subject.toLowerCase().includes(q.toLowerCase())),
      );
      return options.scenario === "empty" ? { ...page, counts: { all: 0, assignments: 0, uncertain: 0, skipped: 0, manual: 0 } } : page;
    },
    detail: async (id) => {
      window.logCalls.push(`detail:${id}`);
      return logFixtureDetail(items.find((item) => item.id === id));
    },
    undo: async (id) => {
      window.logCalls.push(`undo:${id}`);
      const item = items.find((candidate) => candidate.id === id)!;
      if (options.scenario === "notPossible")
        throw new UndoNotPossible({
          ...item,
          undo: {
            state: "not_possible",
            reason: "changed_by_person",
            by: { userId: "Usr009", name: "Ida Lorenz" },
            at: "2026-10-26T09:10:00.000Z",
          },
        });
      return {
        ...item,
        undo: { state: "done", reason: null, by: { userId: "Usr002", name: "Lisa Brandt" }, at: "2026-10-26T09:15:00.000Z" },
      };
    },
    redo: async (id) => {
      window.logCalls.push(`redo:${id}`);
      return items.find((item) => item.id === id)!;
    },
  };
  const initial = logFixturePage(items);
  render(
    () => (
      <LocaleProvider locale={options.locale}>
        <main class="flex min-w-0 flex-1 overflow-auto p-4">
          <MailAutomationLog
            mailboxName="Vertrieb"
            timeZone="UTC"
            initial={
              options.scenario === "empty"
                ? { ...initial, counts: { all: 0, assignments: 0, uncertain: 0, skipped: 0, manual: 0 } }
                : initial
            }
            canUndo
            api={api}
          />
        </main>
      </LocaleProvider>
    ),
    host,
  );
};
