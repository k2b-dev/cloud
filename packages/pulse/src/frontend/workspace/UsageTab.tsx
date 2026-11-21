import type { ResourceApiKey } from "@k2b/cloud/access/ui";
import type { AccessEntry } from "@k2b/cloud/contracts";
import { query } from "@k2b/stdlib/solid";
import { Button, DataTable, type DataTableColumn, Placeholder, RowGroup, StatusRow } from "@k2b/ui";
import { type JSX, Show } from "solid-js";
import type { PulseSource } from "../../contracts";
import { jsonFetch } from "../http";
import { usePulseMessages } from "../use-messages";
import type { PulseDateContext } from "./helpers";
import { ago } from "./SourcesTab";

type UsageRow = { id: string; icon: string; name: string; kind: string; permission: string; last: string | null };

/**
 * The Usage tab. Which Code pages and automations read this base comes with a platform query in the next release;
 * until then one quiet row says so. The API group lists the accounts and source keys that reach the base, from the
 * base's own members and keys, which only people who manage the base can read.
 */
export default function UsageTab(props: {
  baseId: string;
  sources: PulseSource[];
  canManage: boolean;
  dateContext: PulseDateContext;
  buildPage: () => void;
  buildPending: boolean;
  manageMembers: () => void;
}) {
  const t = usePulseMessages();
  const permission = (level: string) =>
    level === "admin" ? t().usagePermAdmin : level === "write" ? t().usagePermWrite : t().usagePermRead;
  const usage = query.create({
    enabled: () => props.canManage,
    source: () => ({
      baseId: props.baseId,
      sources: props.sources.filter((source) => source.kind === "http_ingest").map((source) => source.id),
    }),
    isSameSource: (a, b) => a.baseId === b.baseId && a.sources.join() === b.sources.join(),
    load: async ({ baseId, sources }, { abortSignal }): Promise<UsageRow[]> => {
      // One read per ingest source: a base has few, and each key belongs to exactly one source.
      const [access, keys] = await Promise.all([
        jsonFetch<AccessEntry[]>(`/api/pulse/bases/${baseId}/access`, { signal: abortSignal }),
        Promise.all(
          sources.map((sourceId) =>
            jsonFetch<ResourceApiKey[]>(`/api/pulse/bases/${baseId}/sources/${sourceId}/api-keys`, { signal: abortSignal }).then((list) =>
              list.map((key) => ({ key, sourceId })),
            ),
          ),
        ),
      ]);
      const accounts = access
        .filter((entry) => entry.principal.type === "service_account")
        .map((entry) => ({
          id: entry.id,
          icon: entry.serviceAccountKind === "agent" ? "ti ti-robot" : "ti ti-plug-connected",
          name: entry.displayName ?? entry.serviceAccountHandle ?? "—",
          kind: entry.serviceAccountKind === "agent" ? t().usageAgent : t().usageServiceAccount,
          permission: permission(entry.permission),
          last: null,
        }));
      const sourceKeys = keys.flat().map(({ key, sourceId }) => ({
        id: key.id,
        icon: "ti ti-key",
        name: `${props.sources.find((source) => source.id === sourceId)?.name ?? "—"} · ${key.name}`,
        kind: t().usageSourceKey,
        permission: t().usagePermSend,
        last: key.lastUsedAt,
      }));
      return [...accounts, ...sourceKeys];
    },
  });
  const columns = (): DataTableColumn<UsageRow>[] => [
    { id: "name", header: t().usageName, value: "name", primary: true, list: "title" },
    { id: "kind", header: t().usageKind, value: "kind", list: "meta", priority: 2 },
    { id: "permission", header: t().usagePermission, value: "permission", nowrap: true, priority: 3 },
    { id: "last", header: t().usageLast, list: "end", nowrap: true },
  ];
  const renderCell = (row: UsageRow, col: DataTableColumn<UsageRow>, render: (value: unknown) => JSX.Element): JSX.Element => {
    if (col.id === "name")
      return (
        <span class="pulse-usage-name">
          <i class={row.icon} aria-hidden="true" />
          {row.name}
        </span>
      );
    if (col.id === "last") return <span class="pulse-quiet">{row.last ? ago(row.last, props.dateContext) : t().usageNever}</span>;
    return render(row[col.id as keyof UsageRow]);
  };
  return (
    <section class="pulse-tab" aria-label={t().tabUsage}>
      <StatusRow
        lead={props.canManage && usage.data() ? t().usageLead({ count: usage.data()!.length }) : t().tabUsage}
        facts={(() => {
          const last = usage
            .data()
            ?.reduce<string | null>((newest, row) => (row.last && (!newest || row.last > newest) ? row.last : newest), null);
          return last ? [{ value: ago(last, props.dateContext), label: t().usageLast.toLowerCase() }] : [];
        })()}
      />
      <RowGroup title={t().usagePagesTitle} level={3}>
        <p class="pulse-line pulse-line--row">
          <span>{t().usagePagesLater}</span>
          <Button variant="secondary" size="sm" loading={props.buildPending} onClick={props.buildPage}>
            <i class="ti ti-sparkles pulse-ai-icon" aria-hidden="true" />
            {t().usageBuildPage}
          </Button>
        </p>
      </RowGroup>
      <RowGroup
        title={t().usageApiTitle}
        count={usage.data()?.length}
        level={3}
        action={
          <Show when={props.canManage}>
            <Button variant="text" size="sm" onClick={props.manageMembers}>
              {t().manageMembers}
            </Button>
          </Show>
        }
      >
        <Show when={props.canManage} fallback={<p class="pulse-line pulse-line--quiet">{t().usageAdminOnly}</p>}>
          <Show
            when={!usage.error()}
            fallback={
              <Placeholder
                state="error"
                title={t().usageLoadFailed}
                description={usage.error()?.message}
                onRetry={() => void usage.refresh()}
              />
            }
          >
            <DataTable
              rows={usage.data() ?? []}
              loading={!usage.data()}
              loadingRows={2}
              columns={columns()}
              getRowId={(row) => row.id}
              ariaLabel={t().usageApiTitle}
              empty={t().usageNone}
              renderCell={({ row, col, render }) => renderCell(row, col, render)}
            />
          </Show>
        </Show>
      </RowGroup>
    </section>
  );
}
