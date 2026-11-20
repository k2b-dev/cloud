import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../ui/test/dom";
import { appAccentStyle } from "./app-appearance";
import type { RailApp } from "./rail-navigation";

// One app declares an accent and a different icon colour; the other declares only an icon colour.
const apps: RailApp[] = [
  {
    id: "stock",
    label: "Stock",
    href: "/app/stock",
    match: "/app/stock",
    iconClass: "ti ti-box",
    defaultVisible: true,
    accent: "#0284c7",
    iconColor: "#c2410c",
  },
  {
    id: "notes",
    label: "Notes",
    href: "/app/notes",
    match: "/app/notes",
    iconClass: "ti ti-notes",
    defaultVisible: true,
    iconColor: "#4d7c0f",
  },
];
const settings = { revision: 0, visibility: {}, shortcuts: [], showNames: true };

let dom: DomTestHarness;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
beforeEach(() => {
  dom = createDomTestHarness();
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    // The rail reads approval counts; none are open.
    Object.assign(async () => Response.json({ total: 0, apps: {} }), { preconnect: globalThis.fetch.preconnect }),
  );
});
afterEach(() => {
  fetchSpy.mockRestore();
  dom.cleanup();
});

/** One custom property of an element's inline style, as the browser reads it. */
const property = (selector: string, name: string) =>
  dom.root.querySelector<HTMLElement>(selector)?.style.getPropertyValue(name).trim() ?? "";
/** Each declaration of a style string, as `[name, value]`. */
const declarations = (style: string | undefined) =>
  (style ?? "").split(";").map((declaration) => {
    const [name = "", value = ""] = declaration.split(":").map((part) => part.trim());
    return [name, value] as const;
  });

test("the app bar paints each icon in its icon colour while the selected entry keeps the app's accent", async () => {
  const { default: RailApps } = await import("./RailApps");
  const dispose = render(() => createComponent(RailApps, { apps, settings, currentPath: "/app/stock" }), dom.root);
  try {
    const stock = 'a[href="/app/stock"]';
    // The selection colours are the accent's, exactly as without an icon colour.
    for (const [name, value] of declarations(appAccentStyle("#0284c7"))) expect(property(stock, name)).toBe(value);
    expect(property(stock, "--app-bar-icon-light")).toBe("#c2410c");
    const notes = 'a[href="/app/notes"]';
    expect(property(notes, "--app-accent")).toBe("");
    expect(property(notes, "--app-bar-icon-light")).toBe("#4d7c0f");
  } finally {
    dispose();
  }
});

test("the app grid tiles take the icon colour, not the accent", async () => {
  const { AppLaunchpadPanel } = await import("./AppLaunchpadPanel");
  const dispose = render(() => createComponent(AppLaunchpadPanel, { apps, legalLinks: [], close: () => {} }), dom.root);
  try {
    expect(property('a[href="/app/stock"] .app-icon', "--app-icon-color")).toBe("#c2410c");
    expect(property('a[href="/app/notes"] .app-icon', "--app-icon-color")).toBe("#4d7c0f");
  } finally {
    dispose();
  }
});
