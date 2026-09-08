import { ButtonLink, DataTable, type DataTableColumn, NoticeCard, StatusBadge } from "@k2b/ui";
import { type AuthContext, getLocale } from "@valentinkolb/cloud/server";
import { formatBytes, formatNumber } from "@valentinkolb/cloud/shared";
import { AdminLayout } from "@valentinkolb/cloud/ssr";
import { ssr } from "../../config";
import { natsMessages } from "./messages";
import { nodeReplicaStatus, replicaStatus, replicaTone } from "./replica-status";
import { getNatsDiagnostics, type NatsConsumer, type NatsNode, type NatsStream } from "./service";

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = natsMessages.resolve([locale]);
  const url = new URL(c.req.url);
  const offset = (key: string) => {
    const value = Number(url.searchParams.get(key) ?? 0);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  };
  const selected = url.searchParams.get("stream") ?? "";
  const consumerStream = /^[A-Za-z0-9_-]+$/.test(selected) ? selected : undefined;
  const diagnostics = await getNatsDiagnostics({
    streamOffset: offset("offset"),
    consumerStream,
    consumerOffset: offset("consumerOffset"),
  });
  const { cluster, inventory } = diagnostics;
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
  const replicaState = (value: Parameters<typeof replicaStatus>[0], expected: number | null) => {
    const status = replicaStatus(value, expected);
    return status === null ? "—" : <StatusBadge tone={replicaTone(status)} label={t[status]} variant="dot" />;
  };
  const href = (changes: Record<string, string | number | null>) => {
    const params = new URLSearchParams(url.searchParams);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) params.delete(key);
      else params.set(key, String(value));
    }
    return `/admin/observability/nats?${params}`;
  };
  const nodeColumns: DataTableColumn<NatsNode>[] = [
    { id: "name", header: t.name, value: (row) => row.name },
    { id: "version", header: t.version, value: (row) => row.version },
    {
      id: "state",
      header: t.jetstreamStatus,
      value: (row) => t[nodeReplicaStatus(row, cluster.nodes)],
    },
    { id: "leader", header: t.leader, value: (row) => row.meta?.leader ?? t.unknown },
    { id: "storage", header: t.storage, value: (row) => storage(row.storage, row.maxStorage) },
    { id: "memory", header: t.memory, value: (row) => bytes(row.processMemory) },
    { id: "streams", header: t.streams, value: (row) => count(row.streams) },
  ];
  const streamColumns: DataTableColumn<NatsStream>[] = [
    { id: "name", header: t.name, value: (row) => row.name },
    { id: "kind", header: t.kind, value: (row) => row.kind },
    { id: "owner", header: t.owner, value: (row) => (row.sync ? `${row.sync.namespace} / ${row.sync.owner} / ${row.sync.id}` : "—") },
    { id: "messages", header: t.messages, value: (row) => count(row.messages) },
    { id: "bytes", header: t.storage, value: (row) => storage(row.bytes, row.maxBytes) },
    {
      id: "retention",
      header: t.retention,
      value: (row) => (row.maxAgeMs === null ? t.unknown : row.maxAgeMs === 0 ? t.unlimited : `${count(row.maxAgeMs / 1_000)} s`),
    },
    {
      id: "replicas",
      header: t.replicas,
      value: (row) => row.replicas,
    },
    { id: "consumers", header: t.consumers, value: (row) => count(row.consumers) },
  ];
  const consumerColumns: DataTableColumn<NatsConsumer>[] = [
    { id: "name", header: t.name, value: (row) => row.name },
    { id: "pending", header: t.pending, value: (row) => count(row.pending) },
    { id: "ack", header: t.ackPending, value: (row) => count(row.ackPending) },
    { id: "redelivered", header: t.redelivered, value: (row) => count(row.redelivered) },
    { id: "leader", header: t.leader, value: (row) => row.cluster?.leader ?? "—" },
    {
      id: "replicas",
      header: t.replicas,
      value: (row) => {
        const status = replicaStatus(row.cluster, null);
        return status === null ? "—" : t[status];
      },
    },
  ];
  return () => (
    <AdminLayout c={c} title="NATS">
      <div class="app-rows">
        <div>
          <h1 class="text-base font-semibold text-primary">NATS</h1>
          <p class="mt-1 text-xs text-dimmed">{t.description}</p>
        </div>
        <div>
          <ButtonLink href="/admin/observability/sync" variant="secondary" size="sm">
            {t.sync}
          </ButtonLink>
        </div>
        {cluster.status === "not_configured" ? (
          <NoticeCard tone="info" title={t.cluster} detail={t.notConfigured} />
        ) : cluster.status !== "available" ? (
          <NoticeCard tone="warning" title={cluster.status === "partial" ? t.partial : t.unavailable} detail={t.clusterIssue} />
        ) : null}
        <section class="paper overflow-hidden">
          <div class="px-3 py-2">
            <h2 class="text-xs font-semibold">{t.cluster}</h2>
            <p class="text-[10px] text-dimmed">{t.nodeScope}</p>
          </div>
          <DataTable
            renderCell={({ row, col, value, render }) => {
              if (col.id !== "state") return render(value);
              const status = nodeReplicaStatus(row, cluster.nodes);
              return <StatusBadge tone={replicaTone(status)} label={t[status]} variant="dot" />;
            }}
            rows={cluster.nodes}
            columns={nodeColumns}
            getRowId={(row) => row.id}
            surface="plain"
            density="compact"
            empty={t.empty}
          />
        </section>
        {inventory.status !== "available" ? (
          <NoticeCard
            tone="warning"
            title={inventory.status === "partial" ? t.partial : t.unavailable}
            detail={inventory.status === "not_configured" ? t.inventoryMissing : t.inventoryIssue}
          />
        ) : null}
        <section class="paper overflow-hidden">
          <div class="px-3 py-2">
            <h2 class="text-xs font-semibold">
              {t.streams} · {count(inventory.total)}
            </h2>
            <p class="text-[10px] text-dimmed">{t.accountScope}</p>
          </div>
          <DataTable
            rows={inventory.streams}
            columns={streamColumns}
            getRowId={(row) => row.name}
            surface="plain"
            density="compact"
            empty={t.empty}
            renderCell={({ row, col, value, render }) =>
              col.id === "name" ? (
                <a class="link font-mono text-xs" href={href({ stream: row.name, consumerOffset: null })}>
                  {row.name}
                </a>
              ) : col.id === "replicas" ? (
                <span class="inline-flex items-center gap-2">
                  {row.replicas} · {replicaState(row.cluster, row.replicas)}
                </span>
              ) : col.id === "owner" && row.sync ? (
                <a class="link" href={`/admin/observability/sync?resource=${encodeURIComponent(row.sync.id)}`}>
                  {render(value)}
                </a>
              ) : (
                render(value)
              )
            }
          />
          <div class="flex gap-2 px-3 py-2">
            {inventory.offset > 0 ? (
              <ButtonLink href={href({ offset: null })} variant="secondary" size="xs">
                {t.first}
              </ButtonLink>
            ) : null}
            {inventory.nextOffset !== null ? (
              <ButtonLink href={href({ offset: inventory.nextOffset })} variant="secondary" size="xs">
                {t.next}
              </ButtonLink>
            ) : null}
          </div>
        </section>
        <section class="paper overflow-hidden">
          <div class="px-3 py-2">
            <h2 class="text-xs font-semibold">
              {t.consumers}
              {consumerStream ? ` · ${consumerStream}` : ""}
            </h2>
            <p class="text-[10px] text-dimmed">{t.consumerScope}</p>
          </div>
          <DataTable
            renderCell={({ row, col, value, render }) => (col.id === "replicas" ? replicaState(row.cluster, null) : render(value))}
            rows={inventory.consumers}
            columns={consumerColumns}
            getRowId={(row) => row.name}
            surface="plain"
            density="compact"
            empty={t.empty}
          />
          <div class="flex gap-2 px-3 py-2">
            {inventory.consumerOffset > 0 ? (
              <ButtonLink href={href({ consumerOffset: null })} variant="secondary" size="xs">
                {t.first}
              </ButtonLink>
            ) : null}
            {inventory.consumerNextOffset !== null ? (
              <ButtonLink href={href({ consumerOffset: inventory.consumerNextOffset })} variant="secondary" size="xs">
                {t.next}
              </ButtonLink>
            ) : null}
          </div>
        </section>
      </div>
    </AdminLayout>
  );
});
