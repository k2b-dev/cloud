import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { LocaleProvider } from "@k2b/ui";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import { registerSsrTestPlugin } from "../../../../ui/test/ssr-test-plugin";

const root = mkdtempSync(resolve(tmpdir(), "pulse-screens-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: StartScreen } = await import("./StartScreen");
const { default: DeletingScreen } = await import("./DeletingScreen");
const { default: SourcesScreen } = await import("./SourcesScreen");
const { default: SqlScreen } = await import("./SqlScreen");
const { default: QueriesScreen } = await import("./QueriesScreen");
const { default: SettingsScreen } = await import("./SettingsScreen");
const { default: AdminScreen } = await import("../admin/AdminScreen");
const { fixtureAdminBases, fixtureAdminNav, fixturePolicy, fixtureTargets } = await import("../admin/admin-fixtures");
const { fixtureAuthors, fixtureBases, fixtureNav, fixtureQueries, sourcesProps } = await import("./fixtures");
const { sqlTestLimits } = await import("../workspace/sql-test-fixtures");

const dom = createDomTestHarness();
dom.cleanup();
const parser = new dom.window.DOMParser();

/** The server's first picture: its text as a person reads it, and how many loading states it shows. */
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
  const loading = body.querySelectorAll('[data-k2-part="Loading"]').length;
  for (const element of body.querySelectorAll("*")) element.after(" ");
  // the fields by their names, which are no text of the page
  const fields = [...body.querySelectorAll("input")].map((input) => input.getAttribute("aria-label") ?? input.getAttribute("placeholder"));
  return { text: body.textContent?.replace(/\s+/g, " ") ?? "", loading, fields };
};
const baseId = fixtureBases[0]!.id;
const frame = { nav: fixtureNav(), baseId, baseName: fixtureBases[0]!.name, sourceCount: 4 };

describe("Pulse pages on the server", () => {
  test("the start before the first base offers Neue Basis and names the deletions its admin follows", () => {
    const first = render(() => createComponent(StartScreen, { deleting: [] }));
    expect(first.text).toContain("Leg deine erste Basis an");
    expect(first.text).toContain("Neue Basis");
    expect(first.text).not.toContain("Testbasis Herbst");
    expect(first.loading).toBe(0);
    const admin = render(() => createComponent(StartScreen, { deleting: fixtureNav().deleting }));
    expect(admin.text).toContain("Wird gelöscht");
    expect(admin.text).toContain("Testbasis Herbst");
    // the stopped deletion has its word and its retry from the first picture on
    expect(admin.text).toContain("Fehlgeschlagen");
    expect(admin.text).toContain("Erneut versuchen");
  });

  test("the sidebar of a base lists the bases with their search and the deletions under Wird gelöscht", () => {
    const page = render(() => createComponent(SourcesScreen, sourcesProps()));
    expect(page.fields).toContain("Basen durchsuchen…");
    expect(page.text).toContain("Wird gelöscht");
    expect(page.text).toContain("Altes Lager");
    expect(page.text).not.toContain("Alle Basen");
  });

  test("a base in deletion renders its page in the frame, with its state and the way to resume", () => {
    const nav = fixtureNav();
    const page = render(() => createComponent(DeletingScreen, { nav, base: nav.deleting[1]! }));
    expect(page.text).toContain("Altes Lager");
    expect(page.text).toContain("Die Basis konnte nicht gelöscht werden.");
    expect(page.text).toContain("Erneut versuchen");
    expect(page.text).toContain("Webshop");
    expect(page.loading).toBe(0);
  });

  test("sources lead with the hero and its exceptions, the table and the open source with its cause and hour", () => {
    const page = render(() => createComponent(SourcesScreen, sourcesProps({ open: "s7Ee8Ff9" })));
    expect(page.text).toContain("2.193.522");
    expect(page.text).toContain("Werte heute");
    // the alerts stand as one exception in the hero, not as a block above the list
    expect(page.text).toContain("Alarme");
    expect(page.text).not.toContain("Braucht Aufmerksamkeit");
    expect(page.text).toContain("Liefert seit 10:40 keine Werte");
    expect(page.text).toContain("Werte je Minute");
    // the address stands in the open source, breakable at its slashes
    expect(page.text).toContain("10.0.0.12:9100");
    expect(page.text).toContain("Letzte Abrufe");
    expect(page.text).toContain("Zeitüberschreitung");
    expect(page.loading).toBe(0);
  });

  test("the alerts open from the hero's exception as their list with its deeds", () => {
    const props = sourcesProps();
    const page = render(() =>
      createComponent(SourcesScreen, {
        ...props,
        initialRouteState: { ...props.initialRouteState, alertId: props.initialAttention!.alerts[0]!.reference },
      }),
    );
    expect(page.text).toContain("Braucht Aufmerksamkeit");
    expect(page.text).toContain("Alarm „CPU Werkstatt“ ausgelöst");
  });

  test("a store that does not answer says so above the sources", () => {
    const page = render(() => createComponent(SourcesScreen, sourcesProps({ storeDown: true, alerts: [] })));
    expect(page.text).toContain("Datenspeicher nicht erreichbar");
    expect(page.text).not.toContain("Braucht Aufmerksamkeit");
  });

  test("the SQL console renders the draft from the address with its parameter", () => {
    const route = { view: "sql" as const, sourceId: "", sql: "SELECT :host", params: { host: "srv-01" } };
    const page = render(() =>
      createComponent(SqlScreen, { ...frame, route, snapshot: { limits: sqlTestLimits, query: null, error: null }, canWrite: true }),
    );
    expect(page.text).toContain("Neue Abfrage");
    expect(page.text).toContain(":host");
    expect(page.text).toContain("Ausführen");
    expect(page.loading).toBe(0);
  });

  test("saved queries list their SELECT line and page through the address", () => {
    const page = render(() =>
      createComponent(QueriesScreen, {
        ...frame,
        page: { items: fixtureQueries, total: 63, nextOffset: 50 },
        offset: 0,
        authors: fixtureAuthors,
        dateConfig: { timeZone: "Europe/Berlin", locale: "de" },
      }),
    );
    expect(page.text).toContain("/ 63");
    expect(page.text).toContain("SELECT toStartOfMinute(ts) AS time, host, avg(value) AS cpu");
    expect(page.text).toContain("Nächste Seite");
    expect(page.loading).toBe(0);
  });

  test("settings render every tab on the server; a member reads who administers the base", () => {
    for (const tab of ["general", "members", "retention", "usage", "danger"] as const) {
      const page = render(() =>
        createComponent(SettingsScreen, {
          nav: fixtureNav(),
          base: fixtureBases[0]!,
          tab,
          canAdmin: tab !== "usage",
          admins: ["Jana Petersen"],
          maxRawRetentionDays: 365,
          access: [],
          limits: sqlTestLimits,
        }),
      );
      expect(page.loading).toBe(0);
      if (tab === "usage") expect(page.text).toContain("Jana Petersen");
      if (tab === "general") expect(page.text).toContain("b7Kq2mX9");
      // the form's deeds stand in the head from the server's first picture on, so nothing moves when the island starts
      if (tab === "general" || tab === "retention") expect(page.text).toContain("Speichern");
      if (tab === "danger") expect(page.text).toContain("Basis löschen");
    }
  });

  test("the administration renders its sections; ClickHouse-backed parts load after the page", () => {
    const store = render(() =>
      createComponent(AdminScreen, {
        nav: fixtureAdminNav("store"),
        view: "store",
        store: { configured: true, url: "http://clickhouse:8123", user: "pulse", passwordSet: true },
        policy: null,
        bases: null,
        targets: null,
      }),
    );
    expect(store.text).toContain("http://clickhouse:8123");
    const bases = render(() =>
      createComponent(AdminScreen, {
        nav: fixtureAdminNav("bases"),
        view: "bases",
        store: null,
        policy: fixturePolicy,
        bases: fixtureAdminBases,
        targets: null,
      }),
    );
    expect(bases.text).toContain("Altes Lager");
    // the orphaned databases come from ClickHouse: one loading state in their own section, by design
    expect(bases.loading).toBe(1);
    const targets = render(() =>
      createComponent(AdminScreen, {
        nav: fixtureAdminNav("targets"),
        view: "targets",
        store: null,
        policy: null,
        bases: null,
        targets: fixtureTargets,
      }),
    );
    expect(targets.text).toContain("10.20.0.0/24");
    expect(targets.loading).toBe(0);
  });
});
