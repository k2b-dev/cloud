import { LocaleProvider } from "@k2b/ui";
import { opsCharts } from "../../_components/ops-chart";
import { fixtureArea, LONG } from "../../_components/services-fixture-area";
import BrowserScreen from "../browser/BrowserScreen";
import { browserQuery, telemetryQuery } from "../query";
import TelemetryScreen, { type TelemetryRouteView } from "./TelemetryScreen";

const apps = [
  { id: "mail", label: "mail" },
  { id: "spaces", label: "spaces" },
];
const HOUR = 3_600_000;
const START = Date.UTC(2026, 10, 25, 6);

const route = (path: string, extra: Partial<TelemetryRouteView> = {}): TelemetryRouteView => ({
  key: `mail ${path}`,
  app: "mail",
  route: path,
  requests: "12.204",
  errorRate: "0,4 %",
  problem: false,
  errors: "49",
  slow: "—",
  hasSlow: false,
  duration: "42 ms / 1,2 s",
  slowMax: false,
  ...extra,
});

const charts = (locale: string) =>
  opsCharts(
    [
      {
        kind: "line",
        title: "Anfragen",
        series: [{ label: "Anfragen", data: [0, 1, 2, 3, 4].map((i) => ({ x: START + i * HOUR, y: 400 + i * 60 })) }],
      },
      {
        kind: "line",
        title: "Fehlerquote",
        unit: "percent",
        series: [{ label: "Fehlerquote", data: [0, 1, 2, 3, 4].map((i) => ({ x: START + i * HOUR, y: i === 3 ? 6 : 0.4 })) }],
      },
    ],
    locale,
  );

/** Server telemetry from invented traffic; `route` opens one route, `worst` adds the longest route and problems. */
export const TelemetryScreenFixture = (props: { search?: string; worst?: boolean; route?: boolean; locale?: string }) => {
  const locale = props.locale ?? "de";
  const state = telemetryQuery(locale, apps).parse(new URLSearchParams(props.search ?? "")).state;
  return (
    <LocaleProvider locale={locale}>
      <TelemetryScreen
        area={fixtureArea}
        apps={apps}
        state={state}
        ignored={null}
        browserHref="/admin/observability/telemetry?view=browser"
        cells={[
          { icon: "arrows-exchange", label: "Anfragen", value: "41.204", meta: "24h" },
          {
            icon: "alert-circle",
            label: "Serverfehler",
            value: props.worst ? "1.204" : "0",
            meta: "5xx",
            tone: props.worst ? "bad" : undefined,
          },
          { icon: "hand-stop", label: "Clientfehler", value: "312", meta: "Ratenbegrenzt (429): 4", tone: "warn" },
          { icon: "clock-exclamation", label: "Langsam", value: "12", meta: ">= 1000ms", tone: "warn" },
        ]}
        charts={charts(locale)}
        slo={props.worst ? [{ icon: "alert-circle", label: "1h", value: "98,1 %", meta: "1.204 Anfragen", tone: "bad" }] : []}
        routes={[
          route("/app/mail/api/messages"),
          route(props.worst ? `/app/mail/api/${LONG}` : "/app/mail/api/send", {
            problem: true,
            errorRate: "6,2 %",
            hasSlow: true,
            slow: "12",
            slowMax: true,
          }),
        ]}
        route={
          props.route
            ? {
                name: "/app/mail/api/send",
                app: "mail",
                summary: "Letzte 100 Anfragen im Zeitraum",
                closeHref: "/admin/observability/telemetry",
                events: [
                  {
                    key: "1",
                    time: "25.11.2026, 10:41",
                    method: "POST",
                    status: "502",
                    tone: "bad",
                    error: "upstream_timeout",
                    duration: "30 s",
                    slow: true,
                  },
                  {
                    key: "2",
                    time: "25.11.2026, 10:40",
                    method: "POST",
                    status: "200",
                    tone: null,
                    error: null,
                    duration: "84 ms",
                    slow: false,
                  },
                ],
              }
            : null
        }
      />
    </LocaleProvider>
  );
};

/** Browser telemetry from invented vitals; `failed` stands for measurements that could not be read. */
export const BrowserScreenFixture = (props: { search?: string; failed?: boolean; locale?: string }) => {
  const locale = props.locale ?? "de";
  const state = { ...browserQuery(locale, apps).parse(new URLSearchParams(props.search ?? "")).state, view: "browser" };
  return (
    <LocaleProvider locale={locale}>
      <BrowserScreen
        area={fixtureArea}
        apps={apps}
        state={state}
        serverHref="/admin/observability/telemetry"
        enabled={true}
        data={
          props.failed
            ? null
            : {
                cells: [
                  { icon: "photo", label: "LCP · p75", value: "1.204 ms", meta: "312 Messungen" },
                  { icon: "hand-click", label: "INP · p75", value: "88 ms", meta: "204 Messungen" },
                  { icon: "layout-distribute-vertical", label: "CLS · p75", value: "0,02", meta: "312 Messungen" },
                ],
                charts: charts(locale).slice(0, 1),
                routes: [
                  {
                    key: "a",
                    app: "mail",
                    route: "/app/mail",
                    lcp: "1.204 ms / 120",
                    inp: "88 ms / 80",
                    cls: "0,02 / 120",
                    href: "?view=browser&route=/app/mail",
                  },
                ],
                total: "1",
                previousHref: null,
                nextHref: null,
              }
        }
      />
    </LocaleProvider>
  );
};

export default () => <TelemetryScreenFixture route search="only=errors" />;
