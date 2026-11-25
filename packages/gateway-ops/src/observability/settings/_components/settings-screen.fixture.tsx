import { LocaleProvider } from "@k2b/ui";
import type { HealthApp, HealthWebhook } from "../../../frontend/health-webhook-queries";
import { fixtureNav, LONG } from "../../_components/services-fixture-area";
import SettingsScreen from "./SettingsScreen.island";

export const BEREITSCHAFT = "hw_bereitschaft";

const webhook = (id: string, extra: Partial<HealthWebhook> = {}): HealthWebhook => ({
  id,
  name: "Bereitschaft",
  url: "https://alerts.internal/hooks/cloud",
  method: "POST",
  enabled: true,
  scopeKind: "all",
  scopeAppIds: [],
  sendOn: ["error", "recovery"],
  minStatus: "error",
  repeatIntervalMs: 1_800_000,
  timeoutMs: 5000,
  lastStatus: "ok",
  lastSentAt: "2026-11-25T09:12:00.000Z",
  lastError: null,
  ...extra,
});

const apps: HealthApp[] = [
  { id: "mail", name: "Mail", icon: "ti ti-mail", status: "ok", online: true, signals: [] },
  { id: "spaces", name: "Spaces", icon: "ti ti-layout", status: "warn", online: true, signals: ["stale"] },
];

/**
 * Settings from invented values. `area` picks the tab; for alerts `open` names the open alert ("new" for a new one) and
 * `state` "empty" or "loadfail" the list's other states; "unreadable" marks stored values as unreadable.
 */
export const SettingsScreenFixture = (props: {
  area?: "alerts" | "health" | "retention";
  open?: string | null;
  state?: "normal" | "empty" | "loadfail" | "unreadable";
  worst?: boolean;
  locale?: string;
}) => {
  const locale = props.locale ?? "de";
  const area = props.area ?? "alerts";
  const unreadable = props.state === "unreadable";
  const webhooks =
    props.state === "loadfail"
      ? null
      : props.state === "empty"
        ? []
        : [
            webhook(BEREITSCHAFT),
            webhook("hw_status", {
              name: props.worst ? LONG : "Statusseite",
              method: "GET",
              lastStatus: "warn",
              lastError: "HTTP 502 von alerts.internal",
            }),
            webhook("hw_alt", { name: "Alter Kanal", enabled: false, lastStatus: null, lastSentAt: null }),
          ];
  return (
    <LocaleProvider locale={locale}>
      {area === "alerts" ? (
        <SettingsScreen nav={fixtureNav} timeZone="Europe/Berlin" area="alerts" webhooks={webhooks} apps={apps} open={props.open ?? null} />
      ) : area === "health" ? (
        <SettingsScreen
          nav={fixtureNav}
          timeZone="Europe/Berlin"
          area="health"
          values={{ schedule: "*/5 * * * *", targets: ["alerts.internal", "10.20.0.0/16"] }}
          unreadable={{ schedule: unreadable }}
        />
      ) : (
        <SettingsScreen
          nav={fixtureNav}
          timeZone="Europe/Berlin"
          area="retention"
          values={{ logs: 14, events: 14, rollups: 90 }}
          unreadable={{ events: unreadable }}
        />
      )}
    </LocaleProvider>
  );
};

export default () => <SettingsScreenFixture open={BEREITSCHAFT} />;
