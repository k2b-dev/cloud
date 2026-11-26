import { LocaleProvider } from "@k2b/ui";
import type { JSX } from "solid-js";
import { render } from "solid-js/web";
import { InfrastructureScreenFixture } from "../infrastructure/_components/infrastructure-screen.fixture";
import { MetricsScreenFixture } from "../metrics/_components/metrics-screen.fixture";
import NatsAccessScreen from "../nats/_components/NatsAccessScreen.island";
import { NatsScreenFixture } from "../nats/_components/nats-screen.fixture";
import { PostgresScreenFixture } from "../postgres/_components/postgres-screen.fixture";
import { ValkeyScreenFixture } from "../redis/_components/valkey-screen.fixture";
import { SettingsScreenFixture } from "../settings/_components/settings-screen.fixture";
import { SyncScreenFixture } from "../sync/_components/sync-screen.fixture";
import { BrowserScreenFixture, TelemetryScreenFixture } from "../telemetry/_components/telemetry-screen.fixture";
import { WorkflowsScreenFixture } from "../workflows/_components/workflows-screen.fixture";
import { fixtureNav } from "./services-fixture-area";

/** The service screens for a browser test: `data-screen` picks one, `data-worst` its worst case, the address the rest. */
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
const { screen, worst, locale = "de" } = document.documentElement.dataset;
const search = location.search;
const options = { search, worst: worst === "true", locale };
const params = new URLSearchParams(search);
const state = params.get("state");
const settingsState = state === "empty" || state === "loadfail" || state === "unreadable" ? state : "normal";
const screens: Record<string, () => JSX.Element> = {
  alerts: () => <SettingsScreenFixture {...options} open={params.get("webhook")} state={settingsState} />,
  health: () => <SettingsScreenFixture {...options} area="health" state={settingsState} />,
  retention: () => <SettingsScreenFixture {...options} area="retention" state={settingsState} />,
  infrastructure: () => (
    <InfrastructureScreenFixture {...options} state={params.has("slow") ? "slow" : params.has("failed") ? "failed" : "normal"} />
  ),
  nats: () => <NatsScreenFixture {...options} />,
  access: () => (
    <LocaleProvider locale={locale}>
      <NatsAccessScreen
        nav={fixtureNav}
        values={{ servers: ["tls://nats.example:4222"], kind: "creds", ca: "" }}
        unreadable={{ servers: false, kind: false, access: params.get("unreadable") === "1", ca: false }}
      />
    </LocaleProvider>
  ),
  sync: () => <SyncScreenFixture {...options} entry={params.has("message")} />,
  valkey: () => <ValkeyScreenFixture {...options} />,
  postgres: () => <PostgresScreenFixture {...options} />,
  metrics: () => <MetricsScreenFixture {...options} />,
  telemetry: () => <TelemetryScreenFixture {...options} route={params.has("route")} />,
  browser: () => <BrowserScreenFixture {...options} failed={params.has("failed")} />,
  workflows: () => <WorkflowsScreenFixture {...options} run={params.has("run")} />,
};
const chosen = screens[screen ?? ""];
if (!chosen) throw new Error(`Unknown screen ${screen}`);
render(chosen, host);
document.body.dataset.ready = "true";
