import type { ProxyAuthClient } from "@/contracts";

// Invented clients for render and browser tests and pictures, as the service returns them: fixed dates, no production
// data. `normal` is a workshop's set of 15 internal tools, one still without a group; `worst` carries long names and
// descriptions, nine groups, a client without groups and a whole list.

export type ProxyAuthFixtureData = "normal" | "worst" | "empty";

const group = (name: string) => ({
  id: `00000000-0000-4000-8000-${[...name]
    .reduce((sum, char) => sum + char.charCodeAt(0), 0)
    .toString()
    .padStart(12, "0")}`,
  name,
  provider: "local" as const,
});

const client = (index: number, name: string, description: string | null, groups: string[]): ProxyAuthClient => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  clientId: `pa_${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60)}`,
  name,
  description,
  allowedGroups: groups.map(group),
  createdAt: `2026-${String(1 + (index % 11)).padStart(2, "0")}-${String(3 + ((index * 7) % 25)).padStart(2, "0")}T08:00:00.000Z`,
});

const NORMAL: ProxyAuthClient[] = [
  client(1, "Grafana", "Dashboards der Werkstatt", ["betrieb", "leitung"]),
  client(2, "Paperless", "Belegablage der Buchhaltung", ["buchhaltung"]),
  client(3, "Home Assistant", "Licht, Heizung und Tore", ["haustechnik"]),
  client(4, "Uptime Kuma", "Erreichbarkeit der Dienste", []),
  client(5, "Gitea", "Quellcode der Steuerungen", ["entwicklung"]),
  client(6, "Jenkins", "Bauen und Ausrollen", ["entwicklung", "betrieb"]),
  client(7, "Kibana", "Protokolle durchsuchen", ["betrieb"]),
  client(8, "Vaultwarden", "Gemeinsame Zugänge", ["alle-mitarbeitenden"]),
  client(9, "BookStack", "Handbuch und Anleitungen", ["alle-mitarbeitenden"]),
  client(10, "Portainer", "Container im Rechenraum", ["betrieb"]),
  client(11, "Node-RED", "Abläufe der Maschinen", ["haustechnik", "entwicklung"]),
  client(12, "Prometheus", null, ["betrieb"]),
  client(13, "Mailpit", "Testpostfach", ["entwicklung"]),
  client(14, "Wiki.js", "Wissen für Gäste und Team", ["alle-mitarbeitenden", "gaeste"]),
  client(15, "Druckserver", "Aufträge an Plotter und Drucker", ["verwaltung"]),
];

const WORST: ProxyAuthClient[] = [
  client(
    100,
    "Kunden & Aufträge (Werkstatt Nord) – interne Zeiterfassung und Materialbestellung",
    "Schützt die interne Zeiterfassung, die Materialbestellung und das Auftragsarchiv der Werkstatt Nord vor Zugriffen von außen",
    Array.from({ length: 9 }, (_, index) => `werkstatt-nord-schicht-${index + 1}`),
  ),
  client(101, "X", null, []),
  ...Array.from({ length: 38 }, (_, index) =>
    client(102 + index, `Standort ${String(index + 1).padStart(3, "0")} · Kasse`, index % 3 ? `Kasse am Standort ${index + 1}` : null, [
      `standort-${index + 1}`,
    ]),
  ),
];

export const fixtureClients = (data: ProxyAuthFixtureData): ProxyAuthClient[] =>
  data === "worst" ? WORST : data === "empty" ? [] : NORMAL;
