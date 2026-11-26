import { LocaleProvider } from "@k2b/ui";
import type { NavProps } from "@k2b/ui/v2";
import ProxyAuthScreen, { type ClientRow } from "./ProxyAuthScreen";

// Invented clients for render and browser tests: fixed dates, no production data. `worst` carries long names and
// descriptions, many groups, a client without groups, and none at all.

export type ProxyAuthFixtureData = "normal" | "worst" | "empty";

const nav: NavProps = {
  title: "Administration",
  icon: "settings",
  groups: [{ items: [{ label: "Proxy-Authentifizierung", icon: "shield-half", href: "/admin/proxy-auth", current: true }] }],
};

const NORMAL: ClientRow[] = [
  ["Grafana", "Dashboards der Werkstatt", ["Betrieb", "Leitung"]],
  ["Paperless", "Belegablage", ["Buchhaltung"]],
  ["Home Assistant", null, ["Haustechnik"]],
  ["Uptime Kuma", "Erreichbarkeit der Dienste", []],
].map(([name, description, groups], index) => ({
  id: `00000000-0000-4000-8000-00000000000${index}`,
  clientId: `pa_${String(name).toLowerCase().replace(/\s+/g, "-")}`,
  name: String(name),
  description: description === null ? null : String(description),
  groups: (groups as string[]).map((label, group) => ({ id: `group-${index}-${group}`, label })),
  created: `${10 + index}.11.2026`,
}));

const WORST: ClientRow[] = [
  {
    id: "00000000-0000-4000-8000-00000000000a",
    clientId: "pa_kunden-und-auftraege-werkstatt-nord-interne-zeiterfassung-und-materialbestellung",
    name: "Kunden & Aufträge (Werkstatt Nord) – interne Zeiterfassung und Materialbestellung",
    description:
      "Schützt die interne Zeiterfassung, die Materialbestellung und das Auftragsarchiv der Werkstatt Nord vor Zugriffen von außen",
    groups: Array.from({ length: 9 }, (_, index) => ({ id: `w-${index}`, label: `Werkstatt Nord · Schicht ${index + 1}` })),
    created: "01.01.2020",
  },
  { id: "00000000-0000-4000-8000-00000000000b", clientId: "pa_x", name: "X", description: null, groups: [], created: "26.11.2026" },
];

export const ProxyAuthFixture = (props: { search: string; data?: ProxyAuthFixtureData }) => {
  const clients = props.data === "worst" ? WORST : props.data === "empty" ? [] : NORMAL;
  return (
    <LocaleProvider locale="de">
      <ProxyAuthScreen
        nav={nav}
        baseUrl="https://cloud.example.test"
        clients={clients}
        open={new URLSearchParams(props.search).get("client")}
        tab={new URLSearchParams(props.search).get("tab") === "setup" ? "setup" : "clients"}
        figures={{
          groups: clients.reduce((sum, client) => sum + client.groups.length, 0),
          withoutGroups: clients.filter((client) => client.groups.length === 0).length,
        }}
      />
    </LocaleProvider>
  );
};
