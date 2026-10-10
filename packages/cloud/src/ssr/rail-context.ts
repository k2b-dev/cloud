import type { RailPreferences, RailSnapshot } from "../contracts/rail-preferences";
import type { RailApp } from "./rail-navigation";

export type RailContext = { apps: RailApp[]; settings: RailSnapshot };
export const RAIL_PREFERENCES_EVENT = "cloud:rail-preferences";

export const readRailContext = (): RailContext | undefined => {
  if (typeof document === "undefined") return undefined;
  const text = document.getElementById("cloud-rail-data")?.textContent;
  if (!text) return undefined;
  // Framework-generated, escaped SSR data; never loaded from localStorage. The server validates the snapshot when
  // it reads it, so the shell does not load the schemas on every page.
  const value: RailContext = JSON.parse(text);
  return { apps: value.apps, settings: value.settings };
};

export const publishRailPreferences = (settings: RailPreferences) => {
  const context = readRailContext();
  const element = document.getElementById("cloud-rail-data");
  if (context && element)
    element.textContent = JSON.stringify({
      ...context,
      settings: { ...settings, managedShortcuts: context.settings.managedShortcuts },
    }).replace(/</g, "\\u003c");
  window.dispatchEvent(new CustomEvent(RAIL_PREFERENCES_EVENT));
};
