import { navigateTo } from "@k2b/ssr/nav";
import {
  buildPulseWorkspaceHref,
  PULSE_SETTINGS_TABS,
  type PulseSettingsTab,
  readWorkspacePathState,
  type WorkspaceHrefOptions,
} from "./routes";

import { readSqlDraftHistory, sqlDraftHistoryState } from "./sql-draft-history";

export const navigatePulseWorkspace = (options: WorkspaceHrefOptions): void => {
  const href = buildPulseWorkspaceHref(options);
  if (typeof window !== "undefined" && href === `${window.location.pathname}${window.location.search}`) return;
  navigateTo(href);
};

export type PulseSettingsHistory = {
  baseId: string;
  currentState?: () => unknown;
  currentHref: () => string;
  push: (href: string, state?: unknown) => void;
  replace: (href: string, state?: unknown) => void;
  back: () => void;
  /** The view subscribes once and disposes with its Solid owner. */
  subscribe?: (changed: () => void) => () => void;
};

/** One history entry for the modal; changing tabs replaces that entry. */
export const createPulseSettingsNavigation = (history: PulseSettingsHistory) => {
  let opened = false;
  let settingsHref: string | undefined;
  let settingsState: unknown;
  const tab = (): PulseSettingsTab | undefined => {
    const value = new URL(history.currentHref(), "http://pulse.invalid").searchParams.get("settings");
    return PULSE_SETTINGS_TABS.find((tab) => tab === value);
  };
  return {
    tab,
    subscribe: (changed: (tab: PulseSettingsTab | undefined) => void) => history.subscribe?.(() => changed(tab())) ?? (() => {}),
    open: (tab: PulseSettingsTab = "general") => {
      const url = new URL(history.currentHref(), "http://pulse.invalid");
      const alreadyOpen = url.searchParams.has("settings");
      url.searchParams.set("settings", tab);
      const route = readWorkspacePathState(history.currentHref(), history.baseId);
      const draft = readSqlDraftHistory(history.currentState?.(), history.baseId, history.currentHref());
      const next = { ...route, ...draft, settings: tab };
      const href =
        route.view === "sql" ? buildPulseWorkspaceHref({ baseId: history.baseId, state: next }) : `${url.pathname}${url.search}${url.hash}`;
      settingsHref = href;
      settingsState =
        route.view === "sql" ? sqlDraftHistoryState(history.currentState?.(), history.baseId, next) : history.currentState?.();
      if (alreadyOpen) history.replace(href, settingsState);
      else {
        history.push(href, settingsState);
        opened = true;
      }
    },
    // Back has already moved history. Restore the modal entry before asking to
    // discard so Cancel or an in-flight write keeps URL and mounted dialog together.
    restore: () => {
      if (settingsHref) {
        history.push(settingsHref, settingsState);
        opened = true;
      }
    },
    close: () => {
      if (!tab()) {
        opened = false;
        return;
      }
      if (opened) {
        opened = false;
        history.back();
      } else {
        // Direct/reloaded settings links have no guaranteed predecessor in this app.
        const url = new URL(history.currentHref(), "http://pulse.invalid");
        url.searchParams.delete("settings");
        history.replace(`${url.pathname}${url.search}${url.hash}`);
      }
    },
  };
};
