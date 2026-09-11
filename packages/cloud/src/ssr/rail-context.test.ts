import { expect, test } from "bun:test";
import { defaultRailPreferences } from "../contracts/rail-preferences";
import { publishRailPreferences, RAIL_PREFERENCES_EVENT, readRailContext } from "./rail-context";

test("saving and resetting personal preferences preserves managed shortcuts in the shared launcher snapshot", () => {
  const managedShortcuts = [{ id: "global", kind: "link" as const, title: "Global <link>", href: "/global", icon: "ti ti-link" }];
  const script = { textContent: JSON.stringify({ apps: [], settings: { ...defaultRailPreferences(), managedShortcuts } }) };
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const events = new EventTarget();
  let notifications = 0;
  events.addEventListener(RAIL_PREFERENCES_EVENT, () => notifications++);
  Object.defineProperty(globalThis, "document", { configurable: true, value: { getElementById: () => script } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: events });
  try {
    publishRailPreferences({ ...defaultRailPreferences(), revision: 1, visibility: { mail: false } });
    expect(readRailContext()?.settings).toEqual({
      ...defaultRailPreferences(),
      revision: 1,
      visibility: { mail: false },
      managedShortcuts,
    });
    publishRailPreferences({ ...defaultRailPreferences(), revision: 2 });
    expect(readRailContext()?.settings).toEqual({ ...defaultRailPreferences(), revision: 2, managedShortcuts });
    expect(notifications).toBe(2);
    expect(script.textContent).not.toContain("<link>");
  } finally {
    if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument);
    else Reflect.deleteProperty(globalThis, "document");
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
