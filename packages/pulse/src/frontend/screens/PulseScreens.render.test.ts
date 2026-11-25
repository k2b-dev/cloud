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
const { default: OverviewScreen } = await import("./OverviewScreen");
const { default: SourcesScreen } = await import("./SourcesScreen");
const { default: SqlScreen } = await import("./SqlScreen");
const { default: QueriesScreen } = await import("./QueriesScreen");
const { default: SettingsScreen } = await import("./SettingsScreen");
const { default: AdminScreen } = await import("../admin/AdminScreen");
const { fixtureAdminBases, fixtureAdminNav, fixturePolicy, fixtureTargets } = await import("../admin/admin-fixtures");
const { fixtureBases, fixtureDeletingBases, fixtureQueries, sourcesProps, worstBases } = await import("./fixtures");
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
  return { text: body.textContent?.replace(/\s+/g, " ") ?? "", loading };
};
const baseId = fixtureBases[0]!.id;
const frame = { bases: fixtureBases, baseId, sourceCount: 4 };

describe("Pulse pages on the server", () => {
  test("the base list shows every base, its store and the deletions, without a loading state", () => {
    const page = render(() =>
      createComponent(OverviewScreen, { bases: fixtureBases, deletingBases: fixtureDeletingBases, initialQuery: "" }),
    );
    expect(page.text).toContain("4 Basen");
    expect(page.text).toContain("Betrieb Werkstatt Nord");
    expect(page.text).toContain("Schreiben gesperrt");
    expect(page.text).toContain("Wird gelöscht");
    expect(page.loading).toBe(0);
  });

  test("a search from the address filters the first picture already", () => {
    const page = render(() =>
      createComponent(OverviewScreen, { bases: [...worstBases, ...fixtureBases], deletingBases: [], initialQuery: "webshop" }),
    );
    expect(page.text).toContain("1 von 8");
    expect(page.text).not.toContain("Archiv 2025");
  });

  test("sources show alerts, the table and the open source with its facts", () => {
    const page = render(() => createComponent(SourcesScreen, sourcesProps({ open: "s7Ee8Ff9" })));
    expect(page.text).toContain("4 Quellen");
    expect(page.text).toContain("Braucht Aufmerksamkeit");
    expect(page.text).toContain("Alarm „CPU Werkstatt“ ausgelöst");
    expect(page.text).toContain("Drucker Halle 2");
    expect(page.text).toContain("http://10.0.0.12:9100/metrics");
    expect(page.text).toContain("Letzte Abrufe");
    expect(page.loading).toBe(0);
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
        dateConfig: { timeZone: "Europe/Berlin", locale: "de" },
      }),
    );
    expect(page.text).toContain("63 Abfragen");
    expect(page.text).toContain("SELECT toStartOfMinute(ts) AS time, host, avg(value) AS cpu");
    expect(page.text).toContain("Nächste Seite");
    expect(page.loading).toBe(0);
  });

  test("settings render every tab on the server; a member reads who administers the base", () => {
    for (const tab of ["general", "members", "retention", "usage", "danger"] as const) {
      const page = render(() =>
        createComponent(SettingsScreen, {
          bases: fixtureBases,
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
