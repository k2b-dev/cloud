import { navigateTo } from "@k2b/ssr/nav";
import { buildPulseWorkspaceHref, PULSE_SETTINGS_TABS, type PulseSettingsTab, type WorkspaceHrefOptions } from "./routes";

export const navigatePulseWorkspace = (options: WorkspaceHrefOptions): void => {
  const href = buildPulseWorkspaceHref(options);
  if (typeof window !== "undefined" && href === `${window.location.pathname}${window.location.search}`) return;
  navigateTo(href);
};

export type PulseSettingsHistory = {
  currentHref: () => string;
  push: (href: string) => void;
  replace: (href: string) => void;
  back: () => void;
  /** The view subscribes once and disposes with its Solid owner. */
  subscribe?: (changed: () => void) => () => void;
};

/** One history entry for the modal; changing tabs replaces that entry. */
export const createPulseSettingsNavigation = (history: PulseSettingsHistory) => {
  let opened = false;
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
      const href = `${url.pathname}${url.search}${url.hash}`;
      if (alreadyOpen) history.replace(href);
      else {
        history.push(href);
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
