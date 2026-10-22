import type { Dashboard, DashboardPanel } from "../../dashboard-contracts";
import type { DashboardPanelResult, DashboardSnapshot } from "./dashboard-client";

const traefikSection = {
  sectionIcon: "ti ti-router",
  sectionColor: "#14b8a6",
  sectionDescription: "Quelle Traefik · Raster 5 Min.",
};
const serverSection = {
  sectionIcon: "ti ti-server-2",
  sectionColor: "#8b5cf6",
  sectionDescription: "2 Quellen · Raster 5 Min.",
};
export const dashboardTestNow = "2026-10-20T14:32:00.000Z";
const panel = (id: string, title: string, overrides: Partial<DashboardPanel> = {}): DashboardPanel => ({
  id,
  title,
  section: "Traefik",
  description: "pro Sekunde",
  kind: "line",
  width: "third",
  sql: "SELECT time, value FROM fictional_readings WHERE time >= :from AND time < :to",
  params: { host: "fictional-private-host" },
  columns: ["time", "value"],
  x: "time",
  unit: "/s",
  ...overrides,
});
export const dashboardTestDashboard: Dashboard = {
  id: "Dash01",
  baseId: "Lad001",
  name: "Server & Traefik",
  revision: 3,
  published: false,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: dashboardTestNow,
  definition: {
    panels: [
      panel("requests-now", "Anfragen pro Sekunde", {
        kind: "number",
        section: "",
        columns: ["time", "value", "detail", "detailTone"],
        description: "im gewählten Zeitraum",
      }),
      panel("errors-now", "5xx-Anteil", {
        kind: "number",
        section: "",
        columns: ["time", "value", "detail", "detailTone"],
        unit: "%",
        description: "Anteil an allen Antworten",
      }),
      panel("latency-now", "Latenz p95", {
        kind: "number",
        section: "",
        columns: ["time", "value", "detail", "detailTone"],
        unit: "ms",
        description: "aus dem Traefik-Histogramm",
      }),
      panel("hosts-now", "Platte demo-db", {
        kind: "number",
        section: "",
        columns: ["time", "value", "detail", "detailTone"],
        unit: "%",
        description: "belegt in Prozent",
      }),
      panel("req", "Anfragen je Dienst", { ...traefikSection, columns: ["time", "service", "value"], series: "service" }),
      panel("e5", "5xx-Anteil je Dienst", {
        ...traefikSection,
        threshold: 2,
        unit: "%",
        description: "Anteil an allen Antworten je Raster",
      }),
      panel("p95", "Latenz p95 je Dienst", {
        ...traefikSection,
        unit: "ms",
        threshold: 1000,
        description: "aus dem Traefik-Histogramm, je Raster",
      }),
      panel("cpu", "CPU je Host", {
        columns: ["time", "host", "value"],
        series: "host",
        section: "Server",
        ...serverSection,
        unit: "%",
        description: "Auslastung in Prozent",
      }),
      panel("disk", "Platte je Host", {
        columns: ["time", "host", "value"],
        series: "host",
        section: "Server",
        ...serverSection,
        unit: "%",
        threshold: 90,
        description: "belegt in Prozent",
      }),
      panel("hosts", "Hosts jetzt", {
        section: "Server",
        ...serverSection,
        kind: "table",
        columns: ["Host", "CPU", "Speicher", "Platte"],
        x: undefined,
        unit: "",
        description: "Stand 14:32",
      }),
    ],
  },
};
export const dashboardTestKinds: Dashboard = {
  ...dashboardTestDashboard,
  id: "Dash02",
  name: "Website",
  definition: {
    panels: [
      panel("visits", "Besuche pro Tag", {
        section: "Besuche und Anfragen",
        width: "half",
        unit: "",
        description: "Website · Europe/Berlin",
      }),
      panel("pages", "Top-Seiten", {
        section: "Besuche und Anfragen",
        kind: "bar",
        width: "half",
        columns: ["Seite", "Besuche"],
        x: "Seite",
        unit: "",
        description: "Seitenaufrufe",
      }),
      panel("funnel", "Vom Besuch zur Anfrage", {
        section: "Anfragen",
        kind: "funnel",
        width: "half",
        columns: ["Schritt", "Anzahl"],
        x: "Schritt",
        unit: "",
        description: "Schritte im gewählten Zeitraum",
      }),
      panel("table", "Seiten im Detail", {
        section: "Anfragen",
        kind: "table",
        width: "half",
        columns: ["Seite", "Besuche", "Anfragen"],
        x: undefined,
        unit: "",
        description: "Vollständige Zahlen",
      }),
    ],
  },
};
export const dashboardTestSnapshot: DashboardSnapshot = {
  items: [dashboardTestDashboard, dashboardTestKinds],
  total: 2,
  nextOffset: null,
  selected: dashboardTestDashboard,
  error: null,
};
export const dashboardTestPanelResult = (panel: DashboardPanel): DashboardPanelResult => ({
  panelId: panel.id,
  status: "ready",
  error: null,
  nextRefreshAt: "2026-10-20T14:33:00.000Z",
  lastGood: {
    at: dashboardTestNow,
    slot: "2026-10-20T14:32:00.000Z",
    from: "2026-10-19T14:32:00.000Z",
    to: dashboardTestNow,
    data: {
      columns: panel.columns.map((name) => ({
        name,
        type:
          name === "time"
            ? "DateTime('UTC')"
            : ["Host", "Seite", "Schritt", "detail", "detailTone", "service", "host"].includes(name)
              ? "String"
              : "Float64",
      })),
      rows:
        panel.kind === "number"
          ? Array.from({ length: 24 }, (_, index) => [
              new Date(Date.UTC(2026, 9, 19, 15) + index * 3600000).toISOString(),
              panel.id === "hosts-now"
                ? 91
                : panel.id === "latency-now"
                  ? 128 + (index % 3) * 12
                  : panel.id === "errors-now"
                    ? 0.3 + (index % 2) * 0.1
                    : 2.41 + (index % 4) * 0.12,
              panel.id === "hosts-now"
                ? "über 90 % seit 09:40"
                : panel.id === "requests-now"
                  ? "↑ 4 % vs. letzte Woche"
                  : "vs. letzte Woche",
              panel.id === "hosts-now" ? "danger" : panel.id === "requests-now" ? "success" : "neutral",
            ])
          : panel.kind === "line"
            ? Array.from({ length: 24 }, (_, index) => {
                const labels =
                  panel.series === "service"
                    ? ["demo-site", "demo-shop", "demo-cloud"]
                    : panel.series === "host"
                      ? ["demo-web", "demo-db"]
                      : ["value"];
                return labels.map((label, series) => {
                  const value =
                    panel.id === "disk"
                      ? series === 1
                        ? index < 18
                          ? 71
                          : 91
                        : 43 + Math.sin(index / 4)
                      : panel.id === "p95"
                        ? 236 + Math.sin(index / 2) * 42 + (index === 20 ? 500 : 0)
                        : panel.id === "e5"
                          ? 0.3 + Math.cos(index / 2) * 0.04 + (index === 18 ? 1.5 : 0)
                          : panel.id === "cpu"
                            ? 10 + series * 7 + Math.sin(index / 2) * 5 + (index === 19 && series === 1 ? 45 : 0)
                            : (series + 1) * (0.6 + Math.sin(index / 2) * 0.3);
                  const time = new Date(Date.UTC(2026, 9, 19, 15) + index * 3600000).toISOString();
                  return panel.series ? [time, label, value] : [time, value];
                });
              }).flat()
            : panel.kind === "funnel"
              ? [
                  ["Besuch", 1200],
                  ["Kontaktseite", 310],
                  ["Anfrage", 28],
                ]
              : panel.kind === "bar"
                ? [
                    ["/", 1200],
                    ["/leistungen", 640],
                    ["/kontakt", 310],
                  ]
                : panel.columns[0] === "Host"
                  ? [
                      ["demo-web", 15, 59, 43],
                      ["demo-db", 8, 71, 91],
                    ]
                  : [
                      ["/", 1200, 14],
                      ["/leistungen", 640, 10],
                      ["/kontakt", 310, 28],
                    ],
    },
  },
});
