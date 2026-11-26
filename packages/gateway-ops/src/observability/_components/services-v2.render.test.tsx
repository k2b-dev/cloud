import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../../ui/test/ssr-test-plugin";

const root = mkdtempSync(resolve(tmpdir(), "gateway-ops-services-v2-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const [
  { NatsScreenFixture },
  { SyncScreenFixture },
  { ValkeyScreenFixture },
  { PostgresScreenFixture },
  { MetricsScreenFixture },
  telemetry,
  { WorkflowsScreenFixture },
] = await Promise.all([
  import("../nats/_components/nats-screen.fixture"),
  import("../sync/_components/sync-screen.fixture"),
  import("../redis/_components/valkey-screen.fixture"),
  import("../postgres/_components/postgres-screen.fixture"),
  import("../metrics/_components/metrics-screen.fixture"),
  import("../telemetry/_components/telemetry-screen.fixture"),
  import("../workflows/_components/workflows-screen.fixture"),
]);
const { InfrastructureScreenFixture } = await import("../infrastructure/_components/infrastructure-screen.fixture");
const { SettingsScreenFixture, BEREITSCHAFT } = await import("../settings/_components/settings-screen.fixture");

/**
 * The server HTML and the text a person reads. The text is taken from the markup itself: happy-dom stops parsing after
 * an inline chart SVG that holds <style> and <title> (a real browser does not), so a parsed document would lose the
 * rest of the page.
 */
const render = (screen: () => JSX.Element) => {
  const html = renderToString(screen);
  const text = html
    .replace(/<svg[\s\S]*?<\/svg>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
  return { html, text, loaders: html.match(/data-k2-part="Loading"/g)?.length ?? 0 };
};

const screens = {
  infrastructure: () => createComponent(InfrastructureScreenFixture, {}),
  alerts: () => createComponent(SettingsScreenFixture, { open: BEREITSCHAFT }),
  health: () => createComponent(SettingsScreenFixture, { area: "health" }),
  retention: () => createComponent(SettingsScreenFixture, { area: "retention" }),
  nats: () => createComponent(NatsScreenFixture, { search: "state=problems&stream=MAIL_DLQ" }),
  sync: () => createComponent(SyncScreenFixture, { entry: true }),
  valkey: () => createComponent(ValkeyScreenFixture, { search: "depth=2" }),
  postgres: () => createComponent(PostgresScreenFixture, { search: "schema=mail&sort=rows.desc" }),
  metrics: () => createComponent(MetricsScreenFixture, { search: "type=gauge" }),
  telemetry: () => createComponent(telemetry.TelemetryScreenFixture, { route: true, search: "only=errors" }),
  browser: () => createComponent(telemetry.BrowserScreenFixture, {}),
  workflows: () => createComponent(WorkflowsScreenFixture, { run: true }),
};

describe("the service pages of Observability on the server", () => {
  test("every page renders its first view with data and without a loading state", () => {
    for (const [name, screen] of Object.entries(screens)) {
      const { loaders, text } = render(screen);
      expect({ name, loaders }).toEqual({ name, loaders: 0 });
      expect(text).toContain("Observability");
    }
  });

  test("the worst case of each page renders: longest names, huge numbers, failures", () => {
    const worst = [
      () => createComponent(NatsScreenFixture, { worst: true, search: "stream=MAIL_DLQ" }),
      () => createComponent(SyncScreenFixture, { worst: true, entry: true }),
      () => createComponent(ValkeyScreenFixture, { worst: true }),
      () => createComponent(PostgresScreenFixture, { worst: true }),
      () => createComponent(MetricsScreenFixture, { worst: true }),
      () => createComponent(telemetry.TelemetryScreenFixture, { worst: true }),
      () => createComponent(WorkflowsScreenFixture, { worst: true }),
    ];
    for (const screen of worst) expect(render(screen).text).toContain("kv_spaces_presence_cursor_shadow_workspace");
  });

  test("filters stand as statements and the open entry stands beside its list", () => {
    const nats = render(screens.nats).text;
    expect(nats).toContain("Zustand ist Braucht Aufmerksamkeit");
    expect(nats).toContain("mail-sender");
    expect(render(screens.postgres).text).toContain("Schema ist mail");
    expect(render(screens.metrics).text).toContain("Typ ist Gauge");
    expect(render(screens.valkey).text).toContain("Präfixtiefe ist Tiefe 2");
    const sync = render(screens.sync).text;
    expect(sync).toContain("SMTP 451: greylisted");
    expect(sync).toContain("Zwei Ebenen der Fehlerbehandlung");
    const workflows = render(screens.workflows).text;
    expect(workflows).toContain("„send_invoice“ braucht eine Entscheidung");
    expect(workflows).toContain("Läufe im Zeitverlauf");
  });

  test("charts arrive as drawings in the first HTML", () => {
    for (const name of ["valkey", "postgres", "telemetry", "browser"] as const) {
      expect({ name, drawn: render(screens[name]).html.includes("data-chart-kind") }).toEqual({ name, drawn: true });
    }
  });

  test("a slow backend loads in its own section; a failed one offers a retry there", () => {
    const slow = render(() => createComponent(InfrastructureScreenFixture, { state: "slow" }));
    expect(slow.loaders).toBe(1);
    expect(slow.text).toContain("Speicher 2,1 GB");
    const failed = render(() => createComponent(InfrastructureScreenFixture, { state: "failed" })).text;
    expect(failed).toContain("ECONNREFUSED");
    expect(failed).toContain("Erneut versuchen");
  });

  test("settings: alerts beside their list, an empty or failed list shows a way on, unreadable values ask first", () => {
    expect(render(screens.alerts).text).toContain("HTTP 502 von alerts.internal");
    expect(render(() => createComponent(SettingsScreenFixture, { open: "new" })).text).toContain("Alarm anlegen");
    expect(render(() => createComponent(SettingsScreenFixture, { state: "empty" })).text).toContain("Alarm anlegen");
    expect(render(() => createComponent(SettingsScreenFixture, { state: "loadfail" })).text).toContain("Erneut versuchen");
    const health = render(() => createComponent(SettingsScreenFixture, { area: "health", state: "unreadable" })).text;
    expect(health).toContain("Gespeicherten Wert ersetzen: Prüfplan");
    expect(render(screens.retention).text).toContain("Aufbewahrung");
  });

  test("a browser read that failed keeps the switch and offers a retry in place of the data", () => {
    const { text } = render(() => createComponent(telemetry.BrowserScreenFixture, { failed: true }));
    expect(text).toContain("Web-Vitals erfassen");
    expect(text).toContain("Browser-Messungen konnten nicht geladen werden");
  });
});
