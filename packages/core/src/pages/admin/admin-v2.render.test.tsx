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
const { default: AnnouncementsScreen } = await import("./announcements/AnnouncementsScreen");

const announcement = {
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  version: 3,
  kind: "banner" as const,
  title: "Wartung am Samstag",
  body: "Am Samstag ist die Cloud von 8 bis 9 Uhr nicht erreichbar.",
  tone: "warning" as const,
  publishedAt: "2026-11-20T08:00:00.000Z",
  expiresAt: "2026-11-29T08:00:00.000Z",
  createdAt: "2026-11-20T08:00:00.000Z",
  updatedAt: "2026-11-20T08:00:00.000Z",
  createdBy: null,
  updatedBy: null,
  state: "active" as const,
  published: "20.11.2026, 09:00",
  expires: "29.11.2026, 09:00",
};

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
  test("announcements list their entries with state and times; the address opens one as a form beside the list", () => {
    const list = render(() =>
      createComponent(AnnouncementsScreen, { nav: adminNavFixture("/admin/announcements"), rows: [announcement], open: null }),
    );
    expect(list.text).toContain("Wartung am Samstag");
    expect(list.text).toContain("20.11.2026, 09:00");
    expect(list.text).toContain("Neue Ankündigung");
    expect(list.body.querySelector('[data-k2-part="Field"]')).toBeNull();
    expect(loaders(list.body)).toBe(0);
    const open = render(() =>
      createComponent(AnnouncementsScreen, { nav: adminNavFixture("/admin/announcements"), rows: [announcement], open: announcement.id }),
    );
    expect(open.body.querySelector('input[value="Wartung am Samstag"]')).not.toBeNull();
    expect(open.text).toContain("Löschen");
    const empty = render(() =>
      createComponent(AnnouncementsScreen, { nav: adminNavFixture("/admin/announcements"), rows: [], open: "new" }),
    );
    expect(empty.text).toContain("Noch keine Ankündigungen");
    expect(empty.text).toContain("Erstellen");
  });
});
