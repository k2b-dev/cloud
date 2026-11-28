import { LocaleProvider } from "@k2b/ui";
import type { NavProps } from "@k2b/ui/v2";
import CapabilitiesScreen, { type ExecutionRow } from "../capabilities/_components/CapabilitiesScreen";
import { executionDetail } from "../capabilities/detail";
import { capabilitiesQuery, parseCapabilitiesAddress } from "../capabilities/query";
import RoutesScreen, { type RouteRow } from "../gateway/_components/RoutesScreen";
import { routesQuery } from "../gateway/query";
import NotificationsScreen, { type DefinitionRow, type LegacyRow } from "../notifications/_components/NotificationsScreen";
import { legacyQuery, registryQuery } from "../notifications/query";

// Invented operations for the browser test of the gateway routes, notifications and capabilities screens: fixed times,
// no production data. `worst` carries the longest names, the biggest numbers and the empty cases each column meets.

export type PagesFixtureScreen = "routes" | "registry" | "legacy" | "capabilities";
export type PagesFixtureData = "normal" | "worst";

const nav: NavProps = {
  title: "Administration",
  icon: "settings",
  groups: [{ items: [{ label: "Betrieb", icon: "dashboard", href: "/admin/observability", current: true }] }],
};
const APPS = [
  { id: "mail", label: "Mail", icon: "mail", color: "#2563eb" },
  { id: "files", label: "Dateien", icon: "folder", color: "#d97706" },
  { id: "notebooks", label: "Notizbücher", icon: "notebook", color: "#7c3aed" },
  { id: "werkstatt", label: "Kunden & Aufträge (Werkstatt Nord)", icon: "tool", color: "#475569" },
];
const LONG = "/api/werkstatt/kunden/:kundeId/auftraege/:auftragId/positionen/:positionId/anhaenge/:anhangId/vorschau";

const routes = (worst: boolean): RouteRow[] => [
  ...(worst ? [{ prefix: LONG, app: { ...APPS[3]! }, requests: "12.345.678.901", errors: "123.456", failing: true }] : []),
  ...["/api/mail", "/api/mail/send", "/api/files", "/api/files/upload", "/api/notebooks", "/api/notebooks/search"].map((prefix, index) => ({
    prefix,
    app: { ...APPS[index >> 1]! },
    requests: (48_213 - index * 7_001).toLocaleString("de"),
    errors: String(index === 1 ? 41 : 0),
    failing: index === 1,
  })),
];

const definitions = (worst: boolean): DefinitionRow[] =>
  Array.from({ length: worst ? 3 : 12 }, (_, index) => ({
    id: `def-${index}`,
    label:
      worst && index === 0
        ? "Erinnerung an überfällige Rechnungen mit Mahnstufe und Zahlungsziel für Rahmenverträge"
        : `Benachrichtigung ${index + 1}`,
    description: index % 2 ? "Ungelesene Nachrichten des Tages" : "",
    kind: `mail.kind-${index}`,
    app: { ...APPS[index % 4]! },
    recipientKind: "user",
    recommended: index % 3 ? ["email", "browser"] : [],
    required: index % 4 === 0 ? ["email"] : [],
    events: worst ? "1.234.567" : String(index * 17),
    failures: index === 2 ? 3 : 0,
    lastSeen: index === 5 ? "—" : "24.11., 09:44",
    active: index !== 7,
  }));

const earlier = (worst: boolean): LegacyRow[] =>
  Array.from({ length: worst ? 3 : 14 }, (_, index) => ({
    id: `n-${index}`,
    status: index % 5 === 0 ? "error" : index % 3 === 0 ? "pending" : "sent",
    recipient:
      worst && index === 0
        ? "sehr.lange.adresse.fuer.die.buchhaltung.werkstatt-nord@kunden-und-auftraege.example.test"
        : `person${index}@example.test`,
    subject:
      worst && index === 1
        ? "Ihre Zugangsdaten für das Kundenportal der Werkstatt Nord – bitte innerhalb von 48 Stunden bestätigen"
        : `Willkommen ${index}`,
    sentBy: index % 2 ? "Ada Admin" : null,
    created: "24.11., 09:44",
    error: index % 5 === 0 ? "SMTP 550 mailbox unavailable" : null,
  }));

const executions = (worst: boolean): ExecutionRow[] =>
  Array.from({ length: worst ? 3 : 20 }, (_, index) => ({
    id: `e-${index}`,
    requestId: `request-${index}`,
    app: { ...APPS[index % 4]! },
    capability:
      worst && index === 0
        ? "werkstatt.auftraege.positionen.anhaenge.vorschau-erzeugen-und-versenden"
        : `mail.${["send", "search", "label"][index % 3]}`,
    origin: { label: ["Assistent", "MCP", "HTTP"][index % 3]!, icon: ["sparkles", "plug-connected", "world"][index % 3]! },
    status: index % 6 === 0 ? "failed" : index % 7 === 0 ? "denied" : "succeeded",
    statusLabel: index % 6 === 0 ? "Fehlgeschlagen" : index % 7 === 0 ? "Abgelehnt" : "Erfolgreich",
    destructive: index % 9 === 0,
    kind: index % 2 ? "Aktion" : "Abfrage",
    duration: index % 6 === 0 ? "6,2 Sek." : "120 ms",
    slow: index % 6 === 0,
    started: "26.11., 09:00:00",
    user: index % 4 ? { id: `u-${index}`, label: worst ? "Maximiliane Sophie von Hohenberg-Schwarzenfels" : "Ada Admin" } : null,
  }));

const cells = (worst: boolean) => [
  { icon: "plug", label: "Aufrufe", value: worst ? "12.345.678" : "1.284", meta: "Ø 820 ms" },
  { icon: "alert-circle", label: "Fehlgeschlagen", value: "7", meta: "inkl. Zeitlimits", tone: "bad" as const },
  { icon: "ban", label: "Abgelehnt", value: "2", meta: "Destruktiv: 1", tone: "warn" as const },
  { icon: "hourglass", label: "95. Perzentil", value: "6,4 Sek.", meta: "Im gewählten Zeitraum", tone: "warn" as const },
];

/** One of the three screens for an address and data set, as its page renders it. */
export const PagesFixture = (props: { screen: PagesFixtureScreen; search: string; data: PagesFixtureData }) => {
  const worst = props.data === "worst";
  const params = new URLSearchParams(props.search);
  const screen = () => {
    if (props.screen === "routes") {
      const query = routesQuery("de", APPS);
      return (
        <RoutesScreen
          nav={nav}
          apps={APPS.map((app) => ({ id: app.id, label: app.label }))}
          state={query.parse(params).state}
          cells={cells(worst).map((cell, index) => ({ ...cell, label: ["Anfragen", "Routen", "Capabilities", "Laufzeit"][index]! }))}
          warnings={worst ? [`${LONG} · werkstatt: shadowed (a longer prefix of another app answers first)`] : []}
          rows={routes(worst)}
          total={routes(worst).length}
          trafficError={null}
          byApp={APPS.map((app, index) => ({ ...app, requests: worst ? 12_345_678_901 / (index + 1) : 14_210 - index * 3_100 }))}
        />
      );
    }
    if (props.screen === "capabilities") {
      const address = parseCapabilitiesAddress(
        capabilitiesQuery("de", { apps: APPS.map((app) => app.id), capabilities: ["mail.send"] }),
        params,
      );
      return (
        <CapabilitiesScreen
          nav={nav}
          state={address.state}
          tab={address.tab}
          scope={{ apps: APPS.map((app) => app.id), capabilities: ["mail.send"] }}
          lead={worst ? "12.345.678 Aufrufe" : "1.284 Aufrufe"}
          ignored={null}
          failure={null}
          cells={cells(worst)}
          rows={executions(worst)}
          groups={{
            apps: APPS.map((app, index) => ({ ...app, executions: String(1_000 - index * 100), failed: index, denied: 0, destructive: 0 })),
            capabilities: [{ id: "mail.send", label: "mail.send", icon: "plug", executions: "900", failed: 7, denied: 2, destructive: 1 }],
          }}
          cursor={null}
          nextCursor="cursor-2"
          request={address.request}
          detail={
            address.request
              ? executionDetail(
                  [
                    {
                      id: "e-0",
                      requestId: address.request,
                      origin: "assistant",
                      appId: "mail",
                      capability: "mail.send",
                      kind: "action",
                      destructive: true,
                      actorKind: "user",
                      actorId: "11111111-1111-4111-8111-111111111111",
                      userId: "11111111-1111-4111-8111-111111111111",
                      accessSubjectType: "user",
                      accessSubjectId: "11111111-1111-4111-8111-111111111111",
                      status: "failed",
                      errorCode: "smtp_refused",
                      inputMeta: { type: "object", keys: ["to", "subject", "body"], omittedKeys: 2 },
                      outputMeta: null,
                      idempotencyKey: "send-7f3a9c",
                      replayed: false,
                      startedAt: "2026-11-26T09:00:00.000Z",
                      completedAt: "2026-11-26T09:00:06.000Z",
                      durationMs: 6_200,
                    },
                  ],
                  "de",
                )
              : null
          }
          user={null}
        />
      );
    }
    const page = Number(params.get("page") ?? 1);
    return (
      <NotificationsScreen
        nav={nav}
        view={props.screen === "legacy" ? "legacy" : "registry"}
        open={params.get("notification")}
        opened={(() => {
          const row = earlier(worst).find((candidate) => candidate.id === params.get("notification"));
          return row ? { ...row, content: "<p>Hallo</p>" } : null;
        })()}
        apps={APPS.map((app) => ({ id: app.id, label: app.label }))}
        page={page}
        registry={
          props.screen === "registry"
            ? {
                state: registryQuery("de", APPS).parse(params).state,
                rows: definitions(worst),
                total: worst ? 12_345 : 12,
                cells: cells(worst).map((cell, index) => ({ ...cell, label: ["Definitionen", "Aktiv", "Apps", "Pflicht"][index]! })),
              }
            : null
        }
        legacy={
          props.screen === "legacy"
            ? {
                state: legacyQuery("de").parse(params).state,
                rows: earlier(worst),
                total: worst ? 3 : 14,
                cells: cells(worst).slice(0, 3),
                pendingSystem: worst ? 1_234 : 2,
                searchFacts: params.get("q") ? ["12.345 Treffer", "1.234 Fehler", "56 ausstehend"] : [],
              }
            : null
        }
      />
    );
  };
  return <LocaleProvider locale="de">{screen()}</LocaleProvider>;
};
