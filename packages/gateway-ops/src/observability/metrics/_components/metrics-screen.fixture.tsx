import { LocaleProvider } from "@k2b/ui";
import { fixtureNav, LONG } from "../../_components/services-fixture-area";
import { metricsQuery } from "../query";
import MetricsScreen, { type MetricRow } from "./MetricsScreen";

const sources = [
  { id: "gateway", label: "Gateway" },
  { id: "postgres", label: "Postgres" },
];

/** Metrics from invented collectors; `worst` adds a failed collector, the longest names and no tokens. */
export const MetricsScreenFixture = (props: { search?: string; worst?: boolean; locale?: string }) => {
  const locale = props.locale ?? "de";
  const state = metricsQuery(locale, sources).parse(new URLSearchParams(props.search ?? "")).state;
  const metrics: MetricRow[] = [
    {
      name: "cloud_gateway_requests_total",
      source: "Gateway",
      type: "counter",
      series: "1.204",
      status: "ok",
      error: null,
      description: "Requests by route and status",
    },
    {
      name: "cloud_postgres_connections",
      source: "Postgres",
      type: "gauge",
      series: "3",
      status: props.worst ? "error" : "ok",
      error: null,
      description: props.worst ? LONG : "Open connections",
    },
    ...(props.worst
      ? [
          {
            name: LONG,
            source: "Postgres",
            type: "gauge",
            series: "9.999.999",
            status: "degraded" as const,
            error: "timeout",
            description: LONG,
          },
        ]
      : []),
  ];
  return (
    <LocaleProvider locale={locale}>
      <MetricsScreen
        nav={fixtureNav}
        sources={sources}
        state={state}
        ignored={null}
        cells={[
          { icon: "plug", label: "Scrape-Endpunkt", value: "/api/gateway/metrics", meta: "1.207 Reihen, Token nötig" },
          { icon: "check", label: "Collector", value: props.worst ? "1/2" : "2/2", meta: "Gesund", tone: props.worst ? "warn" : undefined },
          { icon: "chart-dots", label: "Reihen", value: "1.207", meta: "letzte Antwort" },
          { icon: "key", label: "Token", value: props.worst ? "0" : "1", meta: "aktiv" },
        ]}
        generatedAt="Erzeugt am 25.11.2026, 10:42"
        unhealthy={props.worst ? [{ name: "Postgres", error: "connect ECONNREFUSED 10.0.0.4:5432" }] : []}
        tokens={
          props.worst ? [] : [{ id: "t1", name: "Monitoring", line: "metrics_7f3a · metrics:read · Läuft ab: 15.09.2027 · Zuletzt: —" }]
        }
        metrics={metrics}
        metricsTotal="3"
      />
    </LocaleProvider>
  );
};

export default () => <MetricsScreenFixture search="type=gauge" />;
