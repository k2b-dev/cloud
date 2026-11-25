import { useLocale } from "@k2b/ui";
import { Bar, Button, FilterBar, Input, Notice, Pane, StatusRow, Table, Text, Workspace } from "@k2b/ui/v2";
import { createMemo, For } from "solid-js";
import { gatewayOpsMessages } from "../../../messages";
import { type KeyCell, KeyCells } from "../../_components/KeyCells";
import { type ObservabilityAreaNav, ObservabilityNav } from "../../_components/ObservabilityNav";
import { OpsChartSection } from "../../_components/OpsChartSection";
import type { OpsChart } from "../../_components/ops-chart";
import { type ValkeyState, valkeyHref, valkeyQuery } from "../query";

/** `href` opens the next depth under this prefix; the deepest level has none. */
export type ValkeyPrefixRow = { key: string; prefix: string; depth: string; count: string; share: string; href: string | null };

export type ValkeyScreenProps = {
  area: ObservabilityAreaNav;
  state: ValkeyState;
  ignored: string | null;
  cells: KeyCell[];
  warnings: { tone: "warn" | "bad"; title: string; text: string }[];
  /** Why Valkey could not be read, when it could not. */
  error: string | null;
  chart: OpsChart;
  prefixes: ValkeyPrefixRow[];
  sampled: string;
};

/** Valkey on v2: key numbers, warnings, the prefix distribution and the sampled prefixes at one depth. */
export default function ValkeyScreen(props: ValkeyScreenProps) {
  const locale = useLocale();
  const t = () => gatewayOpsMessages.resolve([locale()]).t;
  const query = createMemo(() => valkeyQuery(locale()));
  const go = (next: ValkeyState) => location.assign(valkeyHref(query(), next));
  const search = (text: string) => go({ ...props.state, search: text.trim() || undefined });
  const changed = () => query().serialize(props.state).size > 0;
  return (
    <Workspace
      sidebar={<ObservabilityNav area={props.area} current="valkey" />}
      head={
        <Bar
          start={<Text type="body">Valkey</Text>}
          end={
            <>
              <Input
                type="search"
                icon="search"
                label={t().searchRedisPrefixesLabel}
                placeholder={t().searchRedisPrefixes}
                value={props.state.search ?? ""}
                onKeyDown={(event) => {
                  if (event.isComposing) return;
                  const input = event.currentTarget as HTMLInputElement;
                  if (event.key === "Enter") search(input.value);
                  if (event.key === "Escape" && input.value) search("");
                }}
              />
              <Button variant="ghost" icon="refresh" label={t().refresh} title={t().refresh} href={valkeyHref(query(), props.state)} />
            </>
          }
        />
      }
    >
      <Pane
        label="Valkey"
        scrollKey="gateway-ops-valkey"
        status={
          <>
            <FilterBar
              query={query()}
              state={props.state}
              onChange={(next) => location.replace(valkeyHref(query(), { ...props.state, filters: next.filters, search: next.search }))}
              icons={{ depth: "hierarchy" }}
            />
            <StatusRow lead={t().prefixesCount({ count: String(props.prefixes.length) })} facts={[{ value: props.sampled }]} />
          </>
        }
      >
        {props.ignored ? (
          <Notice tone="warn" title={t().ignoredParts}>
            {props.ignored}
          </Notice>
        ) : null}
        {props.error ? (
          <Notice tone="bad" title={t().unavailable}>
            {props.error}
          </Notice>
        ) : null}
        <KeyCells cells={props.cells} />
        <For each={props.warnings}>
          {(warning) => (
            <Notice tone={warning.tone} title={warning.title}>
              {warning.text}
            </Notice>
          )}
        </For>
        <OpsChartSection chart={props.chart} icon="chart-bar" height={320} empty={t().noMatchingRedisPrefixes} />
        <Table
          label={t().prefixes}
          rows={props.prefixes}
          rowKey={(row) => row.key}
          open={props.prefixes.some((row) => row.href) ? (row) => ({ href: row.href ?? "" }) : undefined}
          empty={
            changed()
              ? {
                  icon: "filter-off",
                  text: t().noMatchingRedisPrefixes,
                  action: { label: t().clear, icon: "filter-off", href: "/admin/observability/valkey" },
                }
              : { icon: "database-off", text: t().noMatchingRedisPrefixes }
          }
          phone={(row) => ({ lines: [row.prefix, `${row.count} · ${row.share}`] })}
          columns={[
            { title: t().prefix, width: { min: 200, default: 360 }, cell: (row) => row.prefix },
            { title: t().depth, width: { min: 60, default: 80 }, align: "end", cell: (row) => row.depth, drop: true },
            { title: t().sampleCount, width: { min: 100, default: 140 }, align: "end", cell: (row) => row.count },
            { title: t().sampleShare, align: "end", cell: (row) => row.share, drop: true },
          ]}
        />
      </Pane>
    </Workspace>
  );
}
