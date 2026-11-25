import { LocaleProvider } from "@k2b/ui";
import RequestsScreen, { type RequestRow } from "../requests/RequestsScreen";
import type { RequestStatusView } from "../requests/requests-url";
import OverviewScreen, { type OverviewAdmin, type OverviewScreenProps } from "./OverviewScreen";
import { REQUESTS } from "./overview-requests.fixture-data";

// Frozen, invented sample data for the overview and the request list: dates are text as the server formats them.

const LOGS: OverviewAdmin["logs"] = [
  { href: "/admin/observability/logs?source=auth:ipa:sync", label: "syncLogs" },
  { href: "/admin/observability/logs?source=auth:reminder:daily", label: "reminderRuns" },
  { href: "/app/accounts/activity?kind=deleted", label: "deletedAccounts" },
  { href: "/app/accounts/activity?kind=reminders", label: "reminderHistory" },
];

export const overviewAdmin: OverviewAdmin = {
  accounts: { total: 53, freeIpa: 41, local: 12 },
  groups: { total: 17, freeIpa: 9, local: 8 },
  openRequests: 2,
  expiring: 4,
  lastSync: "vor 2 Stunden",
  health: [
    { run: "ipaSync", runs: 10, failed: 1 },
    { run: "ipaDemotion", runs: 10, failed: 0 },
    { run: "reminders", runs: 10, failed: 0 },
  ],
  window: 10,
  activity: [
    { id: "1", level: "info", source: "auth:ipa:sync", message: "Sync complete", time: "25.11.2026, 07:00" },
    { id: "2", level: "error", source: "auth:ipa:sync", message: "Sync step failed", time: "24.11.2026, 22:00" },
    { id: "3", level: "warn", source: "auth:reminder:daily", message: "Reminder run complete", time: "24.11.2026, 06:00" },
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

const groups: OverviewScreenProps["groups"] = {
  managed: { count: 2, href: "/app/accounts/groups?scope=managed" },
  member: { count: 5, href: "/app/accounts/groups?scope=member" },
  all: { count: 17, href: "/app/accounts/groups?scope=all" },
};

/** The worst case the overview meets: a very long name and UID, an expired account, many figures, a long log line. */
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
  expiring: 9999,
  lastSync: null,
  health: [{ run: "reminders", runs: 0, failed: 0 }],
  activity: [
    {
      id: "9",
      level: "error",
      source: "auth:local-user:backfill:with-a-very-long-source-name",
      message:
        "Backfill step failed for account maximiliane.theodora.von.hohenstein-wartenberg-schoenfeld@sehr-lange-domain-ohne-umbruch.example: timeout after 30000 ms",
      time: "24.11.2026, 23:59",
    },
  ],
};

export const OverviewFixture = (props: { admin?: boolean; worst?: boolean; empty?: boolean }) => (
  <LocaleProvider locale="de">
    <OverviewScreen
      me={props.worst ? worstMe : me}
      groups={groups}
      isAdmin={Boolean(props.admin)}
      admin={props.admin ? (props.worst ? worstAdmin : props.empty ? { ...overviewAdmin, activity: [] } : overviewAdmin) : null}
      pendingRequests={props.admin ? 2 : 0}
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
        pendingRequests={2}
      />
    </LocaleProvider>
  );
};
