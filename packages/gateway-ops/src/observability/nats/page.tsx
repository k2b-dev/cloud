import { type AuthContext, getDateConfig, getLocale } from "@k2b/cloud/server";
import { formatBytes, formatDateTime, formatNumber } from "@k2b/cloud/shared";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import { areaText, observabilityGroups, readAttention } from "../_components/ObservabilityArea";
import ObservabilityNavigation from "../_components/ObservabilityNavigation.island";
import { legacySyncNatsHref, natsQuery, selectedFacets } from "../_components/sync-nats-query";
import NatsScreen, { type NatsNotice, type NatsStreamRow, type Worded } from "./_components/NatsScreen.island";
import { NatsQuerySchema, readNatsDiagnostics } from "./diagnostics";
import { natsMessages } from "./messages";
import { nodeReplicaStatus, replicaStatus, replicaTone } from "./replica-status";

const PATH = "/admin/observability/nats";
const toneStatus = { ok: "ok", warning: "warn", error: "bad", neutral: null } as const;

/** NATS diagnostics on v2. The address holds the filters, the stream page and the open stream. */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const dateConfig = getDateConfig(c);
  const { t } = natsMessages.resolve([locale]);
  const url = new URL(c.req.url);
  const legacy = legacySyncNatsHref(PATH, url.searchParams);
  if (legacy) return c.redirect(legacy);

  // The filters' values come from the snapshot; read it with the filters the address names, then declare the list.
  const raw = selectedFacets(url.searchParams);
  const first = natsQuery(locale, { apps: [], namespaces: [] }, raw).parse(url.searchParams).state;
  const parsed = NatsQuerySchema.safeParse({
    app: first.filters.app,
    namespace: first.filters.namespace,
    resource: first.search,
    problems: first.filters.state === "problems" ? "true" : undefined,
    offset: url.searchParams.get("offset") ?? undefined,
    consumerOffset: url.searchParams.get("consumerOffset") ?? undefined,
    stream: url.searchParams.get("stream") || undefined,
  });
  const nats = parsed.success ? parsed.data : NatsQuerySchema.parse({});
  const [diagnostics, attention] = await Promise.all([readNatsDiagnostics(nats), readAttention()]);
  const { cluster, inventory } = diagnostics;
  const query = natsQuery(locale, inventory.facets, raw);
  const address = query.parse(url.searchParams);

  const bytes = (value: number | null) => (value === null ? t.unknown : formatBytes(value, { locale }));
  const count = (value: number | null) => (value === null ? t.unknown : formatNumber(value, { locale }));
  const storage = (used: number | null, limit: number | null) => {
    const capacity = limit === null ? t.unknown : limit <= 0 ? t.unlimited : bytes(limit);
    if (used === null || limit === null || limit <= 0) return `${bytes(used)} / ${capacity}`;
    const percent = (used / limit) * 100;
    const percentLabel =
      percent > 0 && percent < 0.01 ? `< ${formatNumber(0.01, { locale, decimals: 2 })}` : formatNumber(percent, { locale, decimals: 2 });
    return `${bytes(used)} / ${capacity} (${percentLabel} %)`;
  };
  const replica = (value: Parameters<typeof replicaStatus>[0], expected: number | null): Worded | null => {
    const status = replicaStatus(value, expected);
    return status === null ? null : { label: t[status], status: toneStatus[replicaTone(status)] };
  };
  // Pages and the open stream keep the filters; a new filter drops them (see `listHref`).
  const href = (changes: Record<string, string | number | null>) => {
    const params = new URLSearchParams(url.searchParams);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) params.delete(key);
      else params.set(key, String(value));
    }
    return `${PATH}${params.size ? `?${params}` : ""}`;
  };
  const known = (value: number | null) => (inventory.accountTotal === null ? null : value);

  const streams: NatsStreamRow[] = inventory.streams.map((row) => ({
    name: row.name,
    kind: row.kind,
    owner: row.sync
      ? {
          label: `${row.sync.namespace} / ${row.sync.owner} / ${row.sync.id}`,
          href: `/admin/observability/nats/sync?q=${encodeURIComponent(row.sync.id)}`,
        }
      : null,
    messages: count(row.messages),
    deadLetters: row.deadLetter
      ? { label: `${count(row.messages)} ${t.deadLetters}`, status: row.messages > 0 ? ("warn" as const) : null }
      : null,
    storage: storage(row.bytes, row.maxBytes),
    retention: row.maxAgeMs === null ? t.unknown : row.maxAgeMs === 0 ? t.unlimited : `${count(row.maxAgeMs / 1_000)} s`,
    replicas: String(row.replicas),
    replicaState: replica(row.cluster, row.replicas),
    consumers: count(row.consumers),
    problem: row.deadLetter && row.messages > 0,
    href: href({ stream: row.name, consumerOffset: null }),
  }));

  const clusterNotice: NatsNotice | null =
    cluster.status === "not_configured"
      ? { tone: "note", title: t.cluster, text: cluster.accessRequired ? t.accessEndpointHelp : t.notConfigured }
      : cluster.status !== "available"
        ? { tone: "warn", title: cluster.status === "partial" ? t.partial : t.unavailable, text: t.clusterIssue }
        : null;
  const inventoryNotice: NatsNotice | null =
    inventory.status !== "available"
      ? {
          tone: "warn",
          title: inventory.status === "partial" ? t.partial : t.unavailable,
          text: inventory.status === "not_configured" ? t.inventoryMissing : t.inventoryIssue,
        }
      : null;
  const issues = [...address.issues, ...(parsed.success ? [] : [{ param: "", value: parsed.error.issues[0]?.path.join(".") ?? "" }])];
  const ignored =
    issues.length > 0 ? issues.map((issue) => (issue.param ? `${issue.param}=${issue.value}` : issue.value)).join(", ") : null;
  const stream = nats.stream ?? null;
  const area = areaText(locale);
  const groups = observabilityGroups(c, locale, attention);

  return () => (
    <Layout
      c={c}
      fullWidth
      ui="v2"
      title={[{ title: t.start, href: "/" }, { title: area.area, href: "/admin/observability" }, { title: area.nats }]}
    >
      <ObservabilityNavigation label={area.area} current="nats" groups={groups} />
      <NatsScreen
        area={{ title: area.area, groups, markLabel: area.needsAttention }}
        facets={inventory.facets}
        state={address.state}
        ignored={ignored}
        sampledAt={formatDateTime(diagnostics.sampledAt, dateConfig)}
        refreshHref={href({})}
        clusterNotice={clusterNotice}
        nodes={cluster.nodes.map((row) => {
          const status = nodeReplicaStatus(row, cluster.nodes);
          return {
            id: row.id,
            name: row.name,
            version: row.version,
            state: { label: t[status], status: toneStatus[replicaTone(status)] },
            leader: row.meta?.leader ?? t.unknown,
            storage: storage(row.storage, row.maxStorage),
            memory: bytes(row.processMemory),
            streams: count(row.streams),
          };
        })}
        inventoryNotice={inventoryNotice}
        streams={streams}
        streamsTotal={`${count(known(inventory.total))}${inventory.accountTotal !== null && inventory.matchedTotal === null ? "+" : ""}`}
        facts={{
          problems: count(known(inventory.summary.problemStreams)),
          deadLetters: count(known(inventory.summary.deadLetterStreams)),
          replication: count(known(inventory.summary.replicationProblems)),
          partial: inventory.matchedTotal === null,
        }}
        previousHref={inventory.offset > 0 ? href({ offset: Math.max(0, inventory.offset - inventory.limit) || null }) : null}
        nextHref={inventory.nextOffset !== null ? href({ offset: inventory.nextOffset }) : null}
        stream={
          stream
            ? {
                name: stream,
                row: streams.find((row) => row.name === stream) ?? null,
                consumers: inventory.consumers.map((row) => ({
                  name: row.name,
                  numbers: t.consumerNumbers({
                    pending: count(row.pending),
                    ack: count(row.ackPending),
                    redelivered: count(row.redelivered),
                  }),
                  leader: row.cluster?.leader ?? "",
                  replicas: replica(row.cluster, null),
                })),
                firstHref: inventory.consumerOffset > 0 ? href({ consumerOffset: null }) : null,
                nextHref: inventory.consumerNextOffset !== null ? href({ consumerOffset: inventory.consumerNextOffset }) : null,
                closeHref: href({ stream: null, consumerOffset: null }),
              }
            : null
        }
      />
    </Layout>
  );
});
