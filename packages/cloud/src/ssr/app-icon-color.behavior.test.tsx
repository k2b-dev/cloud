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

const style = (element: Element | null | undefined) => element?.getAttribute("style") ?? "";

test("the app bar paints each icon in its icon colour while the selected entry keeps the app's accent", async () => {
  const { default: RailApps } = await import("./RailApps");
  const dispose = render(() => createComponent(RailApps, { apps, settings, currentPath: "/app/stock" }), dom.root);
  try {
    const stock = style(dom.root.querySelector('a[href="/app/stock"]'));
    // The selection colour is the accent's, exactly as without an icon colour.
    expect(stock).toStartWith(`${appAccentStyle("#0284c7")};`);
    expect(stock).toContain("--app-bar-icon-light:#c2410c");
    const notes = style(dom.root.querySelector('a[href="/app/notes"]'));
    expect(notes).not.toContain("--app-accent:");
    expect(notes).toContain("--app-bar-icon-light:#4d7c0f");
  } finally {
    dispose();
  }
});

test("the app grid tiles take the icon colour, not the accent", async () => {
  const { AppLaunchpadPanel } = await import("./AppLaunchpadPanel");
  const dispose = render(() => createComponent(AppLaunchpadPanel, { apps, legalLinks: [], close: () => {} }), dom.root);
  try {
    const icon = (href: string) => style(dom.root.querySelector(`a[href="${href}"] .app-icon`));
    expect(icon("/app/stock")).toBe("--app-icon-color:#c2410c");
    expect(icon("/app/notes")).toBe("--app-icon-color:#4d7c0f");
  } finally {
    dispose();
  }
});
