import { type RailPreferences, RailPreferencesSchema } from "../contracts/rail-preferences";
import type { RailApp } from "./rail-navigation";

export type RailContext = { apps: RailApp[]; settings: RailPreferences };
export const RAIL_PREFERENCES_EVENT = "cloud:rail-preferences";

export const readRailContext = (): RailContext | undefined => {
  if (typeof document === "undefined") return undefined;
  const text = document.getElementById("cloud-rail-data")?.textContent;
  if (!text) return undefined;
  // Framework-generated, escaped SSR data; never loaded from localStorage.
  const value: RailContext = JSON.parse(text);
  return { apps: value.apps, settings: RailPreferencesSchema.parse(value.settings) };
};

export const publishRailPreferences = (settings: RailPreferences) => {
  const context = readRailContext();
  const element = document.getElementById("cloud-rail-data");
  if (context && element) element.textContent = JSON.stringify({ ...context, settings }).replace(/</g, "\\u003c");
  window.dispatchEvent(new CustomEvent(RAIL_PREFERENCES_EVENT));
};
