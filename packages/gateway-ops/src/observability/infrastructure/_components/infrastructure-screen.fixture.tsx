import { LocaleProvider } from "@k2b/ui";
import { fixtureNav, LONG } from "../../_components/services-fixture-area";
import type { InfraSectionResult } from "../sections";
import InfrastructureScreen from "./InfrastructureScreen.island";

const postgres: InfraSectionResult = {
  state: "ready",
  section: {
    status: "warn",
    cells: [
      { icon: "database", label: "Speicher", value: "2,1 GB", meta: "214 Tabellen" },
      { icon: "plug-connected", label: "Verbindungen", value: "82/100", meta: "12 aktiv", tone: "warn" },
      { icon: "lock", label: "Wartende Sperren", value: "0", meta: "Keine" },
      { icon: "alert-triangle", label: "Warnungen", value: "1", meta: "Prüfen", tone: "warn" },
    ],
    notices: [{ tone: "warn", title: "Verbindungen fast ausgeschöpft", text: "82 von 100 Verbindungen sind belegt." }],
  },
};
const valkey: InfraSectionResult = {
  state: "ready",
  section: {
    status: "ok",
    cells: [
      { icon: "key", label: "Schlüssel", value: "32.447", meta: "1.204 laufen ab" },
      { icon: "cpu", label: "Speicher", value: "412 MB", meta: "von 1 GB" },
      { icon: "trash-x", label: "Verdrängt", value: "0", meta: "allkeys-lru" },
      { icon: "target-arrow", label: "Trefferquote", value: "97,2 %", meta: "41 Clients" },
    ],
    notices: [],
  },
};
const nats: InfraSectionResult = {
  state: "ready",
  section: {
    status: "bad",
    cells: [
      { icon: "server", label: "Cluster-Nodes", value: "3", meta: "Verfügbar" },
      { icon: "database", label: "Streams und Buckets", value: "41" },
      { icon: "alert-triangle", label: "Streams mit Prüfbedarf", value: "2", tone: "warn" },
      { icon: "mail-x", label: "Streams mit Dead Letters", value: "1", tone: "warn" },
    ],
    notices: [
      { tone: "bad", title: "Replikat offline", text: "nats-2 antwortet nicht." },
      { tone: "warn", title: "Unvollständiger Stand", text: "Einige Cluster-Nodes konnten nicht geprüft werden." },
      { tone: "warn", title: "Dead Letters", text: "MAIL_DLQ hält 12 Nachrichten." },
    ],
  },
};

/** The overview from invented backends: `state` "slow" leaves NATS loading, "failed" lets Valkey fail; `worst` adds long texts. */
export const InfrastructureScreenFixture = (props: { state?: "normal" | "slow" | "failed"; worst?: boolean; locale?: string }) => {
  const worstPostgres: InfraSectionResult =
    props.worst && postgres.state === "ready"
      ? { state: "ready", section: { ...postgres.section, notices: [{ tone: "warn", title: LONG, text: `${LONG} ${LONG}` }] } }
      : postgres;
  return (
    <LocaleProvider locale={props.locale ?? "de"}>
      <InfrastructureScreen
        nav={fixtureNav}
        sections={{
          postgres: worstPostgres,
          valkey: props.state === "failed" ? { state: "failed", message: "connect ECONNREFUSED 10.0.0.5:6379" } : valkey,
          nats: props.state === "slow" ? { state: "pending" } : nats,
        }}
      />
    </LocaleProvider>
  );
};

export default () => <InfrastructureScreenFixture />;
