import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import { registerSsrTestPlugin } from "../../../../ui/test/ssr-test-plugin";

// The v2 admin screens as the server renders them: the first picture holds the data, the admin bar with the open
// entry, and no loading placeholder.
const root = mkdtempSync(resolve(tmpdir(), "core-admin-v2-render-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { LocaleProvider } = await import("@k2b/ui");
const { adminNavFixture } = await import("./admin-v2.fixture");
const { default: OverviewScreen } = await import("./OverviewScreen");
const { default: BaseScreen } = await import("./base/BaseScreen");
const { generalSections } = await import("./base/sections");
const { fixtureEntries } = await import("./base/BaseArea.browser-fixture");

const dom = createDomTestHarness();
dom.cleanup();
const parser = new dom.window.DOMParser();

const render = (screen: () => JSX.Element) => {
  const html = renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return screen();
      },
    }),
  );
  const body = parser.parseFromString(html, "text/html").body;
  for (const element of body.querySelectorAll("*")) element.after(" ");
  return { body, text: body.textContent?.replace(/\s+/g, " ") ?? "" };
};
const loaders = (body: { querySelectorAll(selector: string): { length: number } }) =>
  body.querySelectorAll('[data-k2-part="Loading"], [aria-busy="true"]').length;

describe("v2 admin screens on the server", () => {
  test("the overview names the services and leads to every place in sections of rows", () => {
    const { body, text } = render(() =>
      createComponent(OverviewScreen, {
        nav: adminNavFixture("/admin"),
        title: "Administration",
        lead: "12 registrierte Dienste",
        facts: ["3 App-Verwaltungsbereiche"],
        sections: [
          {
            title: "Hier starten",
            summary: "Wähle, was du erledigen willst.",
            tasks: [{ href: "/admin/observability", title: "System untersuchen", description: "Signale zuerst.", icon: "stethoscope" }],
          },
          {
            title: "Plattform",
            summary: "Einstellungen.",
            tasks: [{ href: "/admin/storage", title: "Speicher", description: "Garage.", icon: "database" }],
          },
          { title: "App-Verwaltung", summary: "Von Apps.", tasks: [] },
        ],
      }),
    );
    expect(text).toContain("12 registrierte Dienste");
    expect(text).toContain("System untersuchen");
    // a section without places leaves no empty head behind
    expect([...body.querySelectorAll('[data-k2-part="Section"] h3')].map((head) => head.textContent)).toEqual([
      "Hier starten",
      "Plattform",
    ]);
    expect(
      body.querySelector('a[href="/admin/storage"][data-k2-part="Row"], [data-k2-part="Row"] a[href="/admin/storage"]'),
    ).not.toBeNull();
    expect(body.querySelector('[data-k2-part="Nav.Item"][aria-current="page"]')?.textContent).toContain("Übersicht");
    expect(loaders(body)).toBe(0);
  });

  test("a Base section shows its fields, values and sources, the footer save and the legacy list from the server", () => {
    const { body, text } = render(() =>
      createComponent(BaseScreen, {
        nav: adminNavFixture("/admin/base", [
          { label: "Allgemein", icon: "adjustments", href: "/admin/base", nested: true, current: true },
        ]),
        section: "general",
        groups: ["app"],
        sections: generalSections("de"),
        entries: fixtureEntries("normal").filter((entry) => entry.group === "app"),
        legacy: [{ key: "mail.old_relay_host", updatedAt: null, decryptable: true, updated: "02.03.2025, 09:00" }],
      }),
    );
    expect(text).toContain("Grundeinstellungen");
    expect(text).toContain("Name und Zeichen");
    expect(body.querySelector('input[value="Beispiel Cloud"]')).not.toBeNull();
    expect(text).toContain("Eigener Wert");
    expect(text).toContain("Speichern");
    expect(text).toContain("mail.old_relay_host");
    expect(text).toContain("Einstellungen-Cache");
    expect(body.querySelector('[data-k2-part="Nav.Item"][aria-current="page"]')?.textContent).toContain("Allgemein");
    expect(loaders(body)).toBe(0);
  });
});
