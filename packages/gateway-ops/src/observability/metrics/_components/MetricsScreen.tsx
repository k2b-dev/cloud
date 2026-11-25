import { useLocale } from "@k2b/ui";
import {
  Bar,
  Button,
  Chip,
  Choice,
  confirm,
  Dialog,
  Empty,
  Facts,
  Field,
  FilterBar,
  Input,
  List,
  Notice,
  Pane,
  Row,
  Section,
  StatusRow,
  Table,
  Text,
  useToast,
  Workspace,
} from "@k2b/ui/v2";
import { createMemo, createSignal, For, Show } from "solid-js";
import { gatewayOpsMessages } from "../../../messages";
import { type KeyCell, KeyCells } from "../../_components/KeyCells";
import { type ObservabilityAreaNav, ObservabilityNav } from "../../_components/ObservabilityNav";
import { type MetricsState, metricsHref, metricsQuery } from "../query";

export type MetricRow = {
  name: string;
  source: string;
  type: string;
  series: string;
  status: "ok" | "degraded" | "error";
  error: string | null;
  description: string;
};
export type MetricsTokenRow = { id: string; name: string; line: string };

export type MetricsScreenProps = {
  area: ObservabilityAreaNav;
  sources: { id: string; label: string }[];
  state: MetricsState;
  ignored: string | null;
  cells: KeyCell[];
  generatedAt: string;
  unhealthy: { name: string; error: string }[];
  tokens: MetricsTokenRow[];
  metrics: MetricRow[];
  metricsTotal: string;
};

/** Days a new token lives; "never" keeps it until it is revoked. */
const EXPIRY = ["30", "90", "365", "never"] as const;

/** Metrics on v2: the scrape endpoint, its bearer tokens and the catalogue of metrics with its filters. */
export default function MetricsScreen(props: MetricsScreenProps) {
  const locale = useLocale();
  const t = () => gatewayOpsMessages.resolve([locale()]).t;
  const toast = useToast();
  const query = createMemo(() => metricsQuery(locale(), props.sources, props.state.filters.source));
  const go = (next: MetricsState, replace = false) => {
    const href = metricsHref(query(), next);
    if (replace) location.replace(href);
    else location.assign(href);
  };
  const search = (text: string) => go({ ...props.state, search: text.trim() || undefined });
  const filtered = () => query().serialize(props.state).size > 0;
  const [creating, setCreating] = createSignal(false);
  const [revoked, setRevoked] = createSignal<ReadonlySet<string>>(new Set());
  const tokens = () => props.tokens.filter((token) => !revoked().has(token.id));
  const create = { label: t().newToken, icon: "plus", onClick: () => setCreating(true) };

  const revoke = async (token: MetricsTokenRow) => {
    if (!(await confirm({ title: t().revokeMetricsToken, description: t().revokeTokenConfirm({ name: token.name }), confirm: t().revoke })))
      return;
    try {
      const response = await fetch(`/api/gateway/metrics/tokens/${encodeURIComponent(token.id)}`, { method: "DELETE" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? t().revokeMetricsTokenFailed);
      }
      setRevoked(new Set([...revoked(), token.id]));
      toast(t().metricsTokenRevoked, { status: "ok" });
    } catch (error) {
      toast(error instanceof Error ? error.message : t().revokeMetricsTokenFailed, { status: "bad" });
    }
  };

  return (
    <Workspace
      sidebar={<ObservabilityNav area={props.area} current="metrics" />}
      primary={create}
      head={
        <Bar
          start={<Text type="body">{t().metrics}</Text>}
          end={
            <>
              <Input
                type="search"
                icon="search"
                label={t().searchMetricsLabel}
                placeholder={t().searchMetrics}
                value={props.state.search ?? ""}
                onKeyDown={(event) => {
                  if (event.isComposing) return;
                  const input = event.currentTarget as HTMLInputElement;
                  if (event.key === "Enter") search(input.value);
                  if (event.key === "Escape" && input.value) search("");
                }}
              />
              <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
                {t().newToken}
              </Button>
            </>
          }
        />
      }
    >
      <Pane
        label={t().metrics}
        scrollKey="gateway-ops-metrics"
        status={
          <>
            <FilterBar
              query={query()}
              state={props.state}
              onChange={(next) => go({ ...props.state, filters: next.filters, search: next.search }, true)}
              icons={{ source: "database", type: "chart-dots" }}
            />
            <StatusRow
              lead={t().metricsCount({ count: String(props.metrics.length), total: props.metricsTotal })}
              facts={[{ value: props.generatedAt }]}
            />
          </>
        }
      >
        <Show when={props.ignored}>
          {(text) => (
            <Notice tone="warn" title={t().ignoredParts}>
              {text()}
            </Notice>
          )}
        </Show>
        <KeyCells cells={props.cells} />
        <For each={props.unhealthy}>
          {(collector) => (
            <Notice tone="warn" title={collector.name}>
              {collector.error}
            </Notice>
          )}
        </For>
        <Section icon="key" title={t().bearerTokens} count={tokens().length} summary={t().bearerTokensDescription}>
          <Show when={tokens().length > 0} fallback={<Empty icon="key" text={t().noMetricsTokens} action={create} />}>
            <List label={t().bearerTokens}>
              <For each={tokens()}>
                {(token) => (
                  <Row
                    icon="key"
                    lines={[token.name, token.line]}
                    end={
                      <Button
                        variant="ghost"
                        icon="key-off"
                        label={t().revokeNamedToken({ name: token.name })}
                        title={t().revokeMetricsToken}
                        onClick={() => void revoke(token)}
                      />
                    }
                  />
                )}
              </For>
            </List>
          </Show>
        </Section>
        <Table
          label={t().metrics}
          rows={props.metrics}
          rowKey={(row) => row.name}
          empty={
            filtered()
              ? {
                  icon: "filter-off",
                  text: t().noMatchingMetrics,
                  action: { label: t().clear, icon: "filter-off", href: "/admin/observability/metrics" },
                }
              : { icon: "chart-bar-off", text: t().noMatchingMetrics }
          }
          phone={(row) => ({ lines: [row.name, `${row.source} · ${row.type} · ${row.series}`] })}
          columns={[
            { title: t().metric, width: { min: 200, default: 320 }, cell: (row) => row.name },
            { title: t().source, width: { min: 100, default: 140 }, cell: (row) => row.source, drop: true },
            { title: t().type, width: { min: 80, default: 100 }, cell: (row) => row.type, drop: true },
            { title: t().series, width: { min: 70, default: 90 }, align: "end", cell: (row) => row.series, drop: true },
            {
              title: t().status,
              width: { min: 110, default: 130 },
              // Degraded: the collector ran, but its source is unreachable, so the series exist with zeroed values.
              cell: (row) =>
                row.status === "ok" ? (
                  <Chip status="ok">OK</Chip>
                ) : (
                  <Chip status={row.status === "degraded" ? "warn" : "bad"}>{row.status === "degraded" ? t().degraded : t().error}</Chip>
                ),
              drop: true,
            },
            { title: t().description, wrap: true, cell: (row) => row.description, drop: true },
          ]}
        />
      </Pane>
      <CreateTokenDialog open={creating()} onOpenChange={setCreating} />
    </Workspace>
  );
}

/** "Neuer Token": a name and how long it lives, then the token once, to copy; closing reloads the list. */
function CreateTokenDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const locale = useLocale();
  const t = () => gatewayOpsMessages.resolve([locale()]).t;
  const [name, setName] = createSignal(t().defaultMetricsTokenName);
  const [expiry, setExpiry] = createSignal<(typeof EXPIRY)[number]>("90");
  const [busy, setBusy] = createSignal(false);
  const [failure, setFailure] = createSignal<string | null>(null);
  const [token, setToken] = createSignal<string | null>(null);
  const expiryLabel = (value: (typeof EXPIRY)[number]) => (value === "never" ? t().expiryNever : t().expiryDays({ days: Number(value) }));
  const submit = async () => {
    if (!name().trim()) return setFailure(t().required);
    setBusy(true);
    setFailure(null);
    try {
      const days = expiry() === "never" ? null : Number(expiry());
      const response = await fetch("/api/gateway/metrics/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name().trim(), expiresAt: days ? new Date(Date.now() + days * 86_400_000).toISOString() : null }),
      });
      const data = (await response.json().catch(() => null)) as { token?: string; message?: string } | null;
      if (!response.ok || !data?.token) throw new Error(data?.message ?? t().createMetricsTokenFailed);
      setToken(data.token);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : t().createMetricsTokenFailed);
    } finally {
      setBusy(false);
    }
  };
  const close = (open: boolean) => {
    props.onOpenChange(open);
    if (!open && token()) location.reload();
  };
  return (
    <Show
      when={!token()}
      fallback={
        <Dialog
          title={t().metricsTokenCreated}
          open={props.open}
          onOpenChange={close}
          dismissible={false}
          foot={<Button onClick={() => close(false)}>{t().close}</Button>}
        >
          <Text>{t().storeTokenNow}</Text>
          <Facts items={[{ label: t().tokens, value: token() ?? "", mono: true, copy: token() ?? "" }]} />
        </Dialog>
      }
    >
      <Dialog
        title={t().createMetricsToken}
        open={props.open}
        onOpenChange={close}
        foot={
          <>
            <Button onClick={() => close(false)}>{t().cancel}</Button>
            <Button icon="key" busy={busy()} onClick={() => void submit()}>
              {t().create}
            </Button>
          </>
        }
      >
        <Field label={t().tokenName} hint={t().tokenNameDescription} error={failure() ?? undefined}>
          <Input value={name()} onInput={setName} />
        </Field>
        <Field label={t().expiry}>
          <Choice
            name="expiry"
            options={EXPIRY.map((value) => ({ value, label: expiryLabel(value) }))}
            value={expiry()}
            onChange={(value) => {
              const next = EXPIRY.find((option) => option === value);
              if (next) setExpiry(next);
            }}
          />
        </Field>
      </Dialog>
    </Show>
  );
}
