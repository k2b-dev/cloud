import { LocaleProvider } from "@k2b/ui";
import { fixtureArea, LONG } from "../../_components/services-fixture-area";
import { natsQuery } from "../../_components/sync-nats-query";
import NatsScreen, { type NatsScreenProps, type NatsStreamRow } from "./NatsScreen";

const facets = { apps: ["mail", "spaces", "notebooks"], namespaces: ["cloud", "cloud-demo"] };

const stream = (name: string, extra: Partial<NatsStreamRow> = {}): NatsStreamRow => ({
  name,
  kind: "stream",
  owner: { label: `cloud / mail / ${name.toLowerCase()}`, href: `/admin/observability/nats/sync?q=${name}` },
  messages: "1.204",
  deadLetters: null,
  storage: "18,4 MB / 1 GB (1,80 %)",
  retention: "604.800 s",
  replicas: "3",
  replicaState: { label: "Synchronisiert", status: "ok" },
  consumers: "2",
  problem: false,
  href: `/admin/observability/nats?stream=${name}`,
  ...extra,
});

/** The NATS screen for one address, from invented diagnostics; `worst` fills every cell with its worst case. */
export const NatsScreenFixture = (props: { search?: string; worst?: boolean; locale?: string }) => {
  const locale = props.locale ?? "de";
  const params = new URLSearchParams(props.search ?? "");
  const state = natsQuery(locale, facets).parse(params).state;
  const open = params.get("stream");
  const streams = props.worst
    ? [
        stream(LONG, {
          deadLetters: { label: "9.999.999 Dead Letters", status: "warn" },
          replicaState: { label: "Replikat im Rückstand", status: "warn" },
          storage: "1023,9 GB / Unbegrenzt",
          owner: { label: `cloud-demo / ${LONG} / ${LONG}`, href: "#" },
        }),
        stream("MAIL_DLQ", { deadLetters: { label: "0 Dead Letters", status: null }, replicaState: null, replicas: "1" }),
      ]
    : [
        stream("MAIL_OUTBOX"),
        stream("MAIL_DLQ", { deadLetters: { label: "12 Dead Letters", status: "warn" }, problem: true }),
        stream("KV_spaces_presence", { kind: "kv", owner: null, replicaState: { label: "Leader fehlt", status: "bad" } }),
      ];
  const props_: NatsScreenProps = {
    area: fixtureArea,
    facets,
    state,
    ignored: null,
    sampledAt: "25.11.2026, 10:42",
    refreshHref: "/admin/observability/nats",
    clusterNotice: props.worst
      ? { tone: "warn", title: "Unvollständiger Stand", text: "Einige Cluster-Nodes konnten nicht geprüft werden." }
      : null,
    nodes: [
      {
        id: "n1",
        name: props.worst ? LONG : "nats-1",
        version: "2.11.4",
        state: { label: "Synchronisiert", status: "ok" },
        leader: "nats-1",
        storage: "2,1 GB / 50 GB (4,20 %)",
        memory: "312 MB",
        streams: "41",
      },
      {
        id: "n2",
        name: "nats-2",
        version: "2.11.4",
        state: { label: "Replikat offline", status: "bad" },
        leader: "nats-1",
        storage: "Unbekannt / Unbekannt",
        memory: "Unbekannt",
        streams: "Unbekannt",
      },
    ],
    inventoryNotice: null,
    streams,
    streamsTotal: props.worst ? "1.000+" : "3",
    facts: { problems: props.worst ? "999" : "2", deadLetters: "1", replication: "1", partial: Boolean(props.worst) },
    previousHref: null,
    nextHref: props.worst ? "/admin/observability/nats?offset=50" : null,
    stream: open
      ? {
          name: open,
          row: streams.find((row) => row.name === open) ?? null,
          consumers: [
            {
              name: "mail-sender",
              numbers: "12 ausstehend · 3 warten auf Bestätigung · 1 erneut zugestellt",
              leader: "nats-1",
              replicas: { label: "Synchronisiert", status: "ok" },
            },
            {
              name: props.worst ? LONG : "mail-audit",
              numbers: "0 ausstehend · 0 warten auf Bestätigung · 0 erneut zugestellt",
              leader: "",
              replicas: null,
            },
          ],
          firstHref: null,
          nextHref: null,
          closeHref: "/admin/observability/nats",
        }
      : null,
  };
  return (
    <LocaleProvider locale={locale}>
      <NatsScreen {...props_} />
    </LocaleProvider>
  );
};

export default () => <NatsScreenFixture search="state=problems&stream=MAIL_DLQ" />;
