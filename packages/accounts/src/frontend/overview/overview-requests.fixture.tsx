import { LocaleProvider } from "@k2b/ui";
import RequestsScreen, { type RequestRow } from "../requests/RequestsScreen";
import type { RequestStatusView } from "../requests/requests-url";
import OverviewScreen, { type OverviewActivity, type OverviewAdmin, type OverviewGroup, type OverviewScreenProps } from "./OverviewScreen";
import { REQUESTS, REQUESTS_OLDEST, REQUESTS_OVERDUE } from "./overview-requests.fixture-data";

// Frozen, invented sample data for the overview and the request list: dates are text as the server formats them.

const LOGS: OverviewAdmin["logs"] = [
  { href: "/admin/observability/logs?source=auth:ipa:sync", label: "syncLogs" },
  { href: "/admin/observability/logs?source=auth:ipa:backfill", label: "ipaBackfill" },
  { href: "/admin/observability/logs?source=auth:reminder:daily", label: "reminderRuns" },
  { href: "/app/accounts/activity?kind=deleted", label: "deletedAccounts" },
  { href: "/app/accounts/activity?kind=reminders", label: "reminderHistory" },
];

/** One change of the audit log as the server words it; `null` as the actor is the system. */
const change = (
  id: number,
  day: string,
  time: string,
  actor: string | null,
  action: string,
  type: "user" | "group" | "service_account",
  target: string,
  outcome: "allowed" | "denied" | "failed" = "allowed",
): OverviewActivity => ({
  id: String(id),
  day,
  time,
  actor: { label: actor ?? "System", userId: actor ? `44444444-4444-4444-8444-${String(id).padStart(12, "0")}` : null, provider: "Lokal" },
  action: { label: action, code: "accounts.example" },
  target: {
    label: target,
    kind: type,
    type,
    href:
      type === "group"
        ? `/app/accounts/groups/33333333-3333-4333-8333-${String(id).padStart(12, "0")}`
        : type === "user"
          ? `/app/accounts/users/44444444-4444-4444-8444-${String(id + 100).padStart(12, "0")}`
          : null,
  },
  outcome,
  reason: outcome === "allowed" ? null : "FreeIPA nicht erreichbar",
});

export const overviewAdmin: OverviewAdmin = {
  accounts: { total: 192, freeIpa: 128, local: 64 },
  openRequests: 3,
  expiring: { freeIpa: 4, local: 1, guests: 6 },
  lastSync: "vor 18 Minuten",
  health: [
    { run: "ipaSync", runs: 10, failed: 1 },
    { run: "ipaDemotion", runs: 10, failed: 0 },
    { run: "reminders", runs: 10, failed: 0 },
  ],
  window: 10,
  activity: [
    change(1, "Heute", "09:42", "Ada Renz", "Mitglied hinzugefügt", "group", "Werkstatt"),
    change(2, "Heute", "09:31", "Felix Thal", "Benutzer angelegt", "user", "Jonas Weber"),
    change(3, "Heute", "08:57", "Ada Renz", "Ablauf gesetzt", "user", "guest-tom"),
    change(4, "Heute", "08:12", "Lena Hartwig", "Anfrage abgelehnt", "user", "Greta Lindqvist", "denied"),
    change(5, "Gestern", "17:05", "Jana Berger", "Verwalter hinzugefügt", "group", "Lager"),
    change(6, "Gestern", "16:40", null, "Benutzer gelöscht", "user", "guest-anna", "failed"),
    change(7, "Gestern", "14:02", "Sami Yilmaz", "API-Schlüssel erstellt", "service_account", "Wochenbericht"),
    change(8, "Gestern", "11:20", "Tom Oswald", "Gruppe angelegt", "group", "Fotografie"),
  ],
  logs: LOGS,
};

const me: OverviewScreenProps["me"] = {
  name: "Jana Berger",
  uid: "jana.berger",
  profile: "user",
  provider: "ipa",
  expires: "31. Dez. 2027",
  expired: false,
};

const groups: OverviewScreenProps["groups"] = { memberCount: 7, allHref: "/app/accounts/groups" };

const group = (id: number, name: string, description: string | null, provider: "ipa" | "local", managed = false): OverviewGroup => ({
  id: `33333333-3333-4333-8333-${String(id).padStart(12, "0")}`,
  name,
  description,
  provider,
  managed,
  href: `/app/accounts/groups/33333333-3333-4333-8333-${String(id).padStart(12, "0")}?list_scope=member`,
});

const myGroups: OverviewGroup[] = [
  group(1, "Werkstatt", "Monteure, Termine und Aufträge", "ipa", true),
  group(2, "Lager", "Wareneingang, Lagerorte und Versand", "local", true),
  group(3, "Verkauf", "Ankauf und Verkauf im Laden und online", "ipa"),
  group(4, "Büro", "Empfang, Post und Termine", "local"),
  group(5, "Alle Mitarbeitenden", null, "ipa"),
  group(6, "Fotografie", "Fotos für Katalog und Shop", "local"),
];

/** The worst case the overview meets: a very long name and UID, an expired account, huge figures, a long log line. */
const worstMe: OverviewScreenProps["me"] = {
  name: "Maximiliane Theodora von Hohenstein-Wartenberg-Schönfeld",
  uid: "maximiliane.theodora.von.hohenstein-wartenberg-schoenfeld",
  profile: "guest",
  provider: "local",
  expires: "1. Okt. 2026",
  expired: true,
};
const worstAdmin: OverviewAdmin = {
  ...overviewAdmin,
  accounts: { total: 128_450, freeIpa: 120_000, local: 8450 },
  openRequests: 1204,
  expiring: { freeIpa: 9000, local: 999, guests: 12_345 },
  lastSync: null,
  health: [{ run: "reminders", runs: 0, failed: 0 }],
  activity: [
    change(
      9,
      "Heute",
      "23:59",
      "Maximiliane Theodora von Hohenstein-Wartenberg-Schönfeld",
      "Benutzer gelöscht",
      "user",
      "maximiliane.theodora.vonhohensteinwartenbergschoenfeld@sehr-lange-domain-ohne-umbruch.example",
      "failed",
    ),
  ],
};
const worstGroups: OverviewGroup[] = [
  group(
    9,
    "Arbeitsgruppe Digitalisierung der Lagerverwaltung und Bestandsführung Nord",
    "Eine sehr lange Beschreibung, die auf dem Telefon und neben der Seitenspalte gekürzt werden muss.",
    "ipa",
    true,
  ),
];

/** The overview is an administrator's page: every state is one an administrator sees. */
export const OverviewFixture = (props: { worst?: boolean; empty?: boolean }) => (
  <LocaleProvider locale="de">
    <OverviewScreen
      me={props.worst ? worstMe : me}
      groups={props.empty ? { ...groups, memberCount: 0 } : groups}
      myGroups={props.empty ? [] : props.worst ? worstGroups : myGroups}
      admin={props.worst ? worstAdmin : props.empty ? { ...overviewAdmin, activity: [] } : overviewAdmin}
      pendingRequests={3}
    />
  </LocaleProvider>
);

/** Long names, an address without a break, a long comment, and many requests over several pages. */
const WORST: RequestRow[] = Array.from({ length: 24 }, (_, index) => ({
  id: `bbbbbbbb-0000-4000-8000-${String(index).padStart(12, "0")}`,
  name: index === 0 ? "Maximiliane Theodora von Hohenstein-Wartenberg-Schönfeld" : `Person ${index + 1}`,
  firstName: index === 0 ? "Maximiliane" : "Person",
  email:
    index === 0 ? "maximiliane.theodora.vonhohensteinwartenbergschoenfeld@sehr-lange-domain-ohne-umbruch.example" : `p${index}@x.example`,
  status: "pending" as const,
  requested: "20. Nov. 2026",
  comment:
    index === 0
      ? "Bitte mit Zugriff auf Lager, Verkauf, Werkstatt, Büro und die Ablage der Geschäftsführung ab dem ersten Dezember."
      : null,
}));

/** A huge state: 1,000 pending requests on one screen (the page shows 100 per page; this proves the list scales). */
const HUGE: RequestRow[] = Array.from({ length: 1000 }, (_, index) => ({
  id: `cccccccc-0000-4000-8000-${String(index).padStart(12, "0")}`,
  name: `Anfrage ${index + 1}`,
  firstName: "Anfrage",
  email: `anfrage${index + 1}@solberg-kramer.example`,
  status: "pending" as const,
  requested: "20. Nov. 2026",
  comment: index % 3 === 0 ? "Neu im Lager" : null,
}));

export const RequestsFixture = (props: {
  status?: RequestStatusView;
  worst?: boolean;
  huge?: boolean;
  full?: boolean;
  empty?: boolean;
  freeIpa?: boolean;
}) => {
  const status = props.status ?? "pending";
  const rows = props.empty
    ? []
    : props.huge
      ? HUGE
      : props.full
        ? HUGE.slice(0, 100)
        : props.worst
          ? WORST
          : REQUESTS.filter((row) => status === "all" || row.status === status);
  return (
    <LocaleProvider locale="de">
      <RequestsScreen
        status={status}
        requests={rows}
        total={props.worst ? 1204 : rows.length}
        page={1}
        pages={props.worst ? 13 : 1}
        freeIpaEnabled={props.freeIpa ?? true}
        pendingRequests={props.empty ? 0 : props.worst ? 1204 : 8}
        oldest={(status === "pending" || status === "all") && !props.empty ? (props.worst ? "3. Jan. 2025" : REQUESTS_OLDEST) : null}
        overdue={(status === "pending" || status === "all") && !props.empty ? (props.worst ? 1180 : REQUESTS_OVERDUE) : 0}
      />
    </LocaleProvider>
  );
};
