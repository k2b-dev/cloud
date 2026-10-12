import type { RailPreferences, RailSnapshot } from "../contracts/rail-preferences";
import type { RailApp } from "./rail-navigation";
import { readShellData } from "./shell-data";

export type RailContext = { apps: RailApp[]; settings: RailSnapshot };
export const RAIL_PREFERENCES_EVENT = "cloud:rail-preferences";

export const readRailContext = (): RailContext | undefined => {
  const data = readShellData();
  return data?.rail ? { apps: data.apps, settings: data.rail } : undefined;
};

export const publishRailPreferences = (settings: RailPreferences) => {
  const data = readShellData();
  const element = document.getElementById("cloud-shell-data");
  if (data?.rail && element)
    element.textContent = JSON.stringify({
      ...data,
      rail: { ...settings, managedShortcuts: data.rail.managedShortcuts },
    }).replace(/</g, "\\u003c");
  window.dispatchEvent(new CustomEvent(RAIL_PREFERENCES_EVENT));
};
