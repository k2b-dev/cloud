import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { useLocale } from "@k2b/ui";
import {
  Bar,
  Button,
  Chip,
  Empty,
  Facts,
  FilterBar,
  Icon,
  type NavProps,
  Notice,
  Pane,
  Section,
  StatusRow,
  Table,
  Tabs,
  Text,
} from "@k2b/ui/v2";
import type { LookupItem } from "@k2b/ui/v2/list-query";
import { createMemo, For, Show } from "solid-js";
import { type KeyCell, KeyCells } from "../../_components/KeyCells";
import type { ExecutionDetailModel } from "../detail";
import { capabilityOpsMessages } from "../ops-messages";
import { type CapabilitiesState, type CapabilityTab, capabilitiesHref, capabilitiesQuery } from "../query";

/** One call in the list, worded by the server. */
export type ExecutionRow = {
  id: string;
  requestId: string;
  app: { id: string; label: string; icon: string };
  capability: string;
  origin: { label: string; icon: string };
  status: "succeeded" | "failed" | "denied" | "invalid_input" | "timed_out" | "rejected";
  statusLabel: string;
  destructive: boolean;
  kind: string;
  duration: string;
  /** Slower than worth ignoring even when it worked. */
  slow: boolean;
  started: string;
  user: { id: string; label: string } | null;
};

/** One app or capability of the window with its calls. */
export type GroupRow = { id: string; label: string; icon: string; executions: string; failed: number; denied: number; destructive: number };

export type CapabilitiesScreenProps = {
  nav: NavProps;
  state: CapabilitiesState;
  tab: CapabilityTab;
  /** The apps and capabilities called in the window, which the filter offers. */
  scope: { apps: string[]; capabilities: string[] };
  names?: { user?: LookupItem[] };
  /** The one statement of the window, such as "1.234 Aufrufe". */
  lead: string;
  ignored: string | null;
  failure: string | null;
  cells: KeyCell[];
  rows: ExecutionRow[];
  groups: { apps: GroupRow[]; capabilities: GroupRow[] };
  cursor: string | null;
  nextCursor: string | null;
  request: string | null;
  detail: ExecutionDetailModel | null;
  /** The person the address filters by, with a way to their AI usage. */
  user: { label: string; aiUsageHref: string } | null;
};

const STATUS_CHIP: Partial<Record<ExecutionRow["status"], "ok" | "warn" | "bad">> = {
  succeeded: "ok",
  failed: "bad",
  timed_out: "bad",
  invalid_input: "warn",
  denied: "warn",
};

/**
 * Capabilities on v2: every capability call the platform dispatched – the assistant, MCP, HTTP and app-to-app mandates
 * – with the window's figures, the busiest apps and capabilities, and one request's calls beside the list. Read only:
 * the dispatcher owns every row. Everything comes with the first HTML; a filter is a new address.
 */
export default function CapabilitiesScreen(props: CapabilitiesScreenProps) {
  const locale = useLocale();
  const t = () => capabilityOpsMessages.resolve([locale()]).t;
  const query = createMemo(() =>
    capabilitiesQuery(locale(), props.scope, { app: props.state.filters.app, capability: props.state.filters.capability }),
  );
  const href = (state: CapabilitiesState, extra: { tab?: CapabilityTab; request?: string | null; cursor?: string | null } = {}) =>
    capabilitiesHref(query(), state, { tab: extra.tab ?? props.tab, ...extra });
  const only = (key: "app" | "capability" | "user", value: string) =>
    href({ ...props.state, filters: { ...props.state.filters, [key]: value } });
  const statusChip = (status: ExecutionRow["status"], label: string) => {
    const tone = STATUS_CHIP[status];
    return tone ? <Chip status={tone}>{label}</Chip> : <Chip icon="ban">{label}</Chip>;
  };
  const groupTable = (rows: GroupRow[], key: "app" | "capability", title: string) => (
    <Table
      label={title}
      rows={rows}
      rowKey={(row) => row.id}
      sticky
      open={(row) => ({ href: only(key, row.id) })}
      empty={{ icon: "plug", text: t().noGroups }}
      phone={(row) => ({
        lines: [row.label, row.executions],
        marks: row.failed > 0 ? <Chip status="bad">{String(row.failed)}</Chip> : undefined,
      })}
      columns={[
        {
          title,
          width: { min: 220, default: 360 },
          // k2b-ui gap: a table cell has no mark (object symbol in its colour) beside text that may be cut
          cell: (row) => (
            <>
              <Icon name={row.icon} /> {row.label}
            </>
          ),
        },
        { title: t().executions, width: { min: 110, default: 130 }, align: "end", cell: (row) => row.executions },
        {
          title: t().failed,
          width: { min: 110, default: 130 },
          align: "end",
          cell: (row) => (row.failed > 0 ? <Chip status="bad">{row.failed.toLocaleString(locale())}</Chip> : "—"),
        },
        {
          title: t().denied,
          width: { min: 110, default: 130 },
          align: "end",
          cell: (row) => (row.denied > 0 ? <Chip status="warn">{row.denied.toLocaleString(locale())}</Chip> : "—"),
          drop: true,
        },
        {
          title: t().destructive,
          width: { min: 110, default: 150 },
          align: "end",
          cell: (row) => (row.destructive > 0 ? row.destructive.toLocaleString(locale()) : "—"),
          drop: true,
        },
      ]}
    />
  );

  const list = () => (
    <Pane
      label={t().title}
      scrollKey={`gateway-ops-capabilities-${props.tab}`}
      status={
        <>
          <FilterBar
            query={query()}
            state={props.state}
            onChange={(next) => location.assign(href(next))}
            base={query().reset()}
            names={props.names}
            icons={{
              window: "clock",
              app: "apps",
              capability: "plug",
              origin: "arrow-big-right",
              status: "circle-dashed",
              destructive: "alert-triangle",
              user: "user",
            }}
          />
          <StatusRow lead={props.lead} />
        </>
      }
    >
      <Show when={props.ignored}>{(text) => <Notice tone="warn">{text()}</Notice>}</Show>
      <Show when={props.failure}>
        {(text) => (
          <Notice tone="bad" title={t().loadFailed}>
            {text()}
          </Notice>
        )}
      </Show>
      <Show when={props.user}>
        {(user) => (
          <Notice
            tone="note"
            title={`${t().user}: ${user().label}`}
            actions={[
              { label: t().aiUsage, href: user().aiUsageHref },
              { label: t().clearUser, href: href({ ...props.state, filters: { ...props.state.filters, user: undefined } }) },
            ]}
          >
            {t().executionsHint}
          </Notice>
        )}
      </Show>
      <KeyCells cells={props.cells} />
      <Show when={props.tab === "executions"}>
        <Table
          label={t().executions}
          rows={props.rows}
          rowKey={(row) => row.id}
          sticky
          current={props.request ?? undefined}
          open={(row) => ({ href: href(props.state, { request: row.requestId, cursor: props.cursor }) })}
          empty={{ icon: "plug", text: t().noExecutions }}
          phone={(row) => ({
            lines: [row.capability, `${row.app.label} · ${row.origin.label}`],
            time: row.started,
            marks: statusChip(row.status, row.statusLabel),
          })}
          columns={[
            {
              title: t().capability,
              width: { min: 220, default: 320 },
              cell: (row) => ({ lines: [row.capability, row.app.label] }),
            },
            { title: t().status, width: { min: 140, default: 160 }, cell: (row) => statusChip(row.status, row.statusLabel) },
            {
              title: t().origin,
              width: { min: 120, default: 140 },
              cell: (row) => (
                <>
                  <Icon name={row.origin.icon} /> {row.origin.label}
                </>
              ),
              drop: true,
            },
            {
              title: t().kind,
              // the chip keeps its whole word ("Destruktive Aktionen")
              width: { min: 190, default: 200 },
              cell: (row) => (row.destructive ? <Chip status="warn">{t().destructive}</Chip> : row.kind),
              drop: true,
            },
            { title: t().startedAt, width: { min: 130, default: 150 }, cell: (row) => row.started },
            {
              title: t().duration,
              width: { min: 100, default: 110 },
              align: "end",
              cell: (row) => (row.slow ? <Chip status="warn">{row.duration}</Chip> : row.duration),
              drop: true,
            },
            { title: t().user, width: { min: 120, default: 160 }, cell: (row) => row.user?.label ?? "—", drop: true },
          ]}
        />
        <Show when={props.cursor || props.nextCursor}>
          <Bar
            end={
              <>
                <Button icon="chevrons-left" href={href(props.state)} disabled={!props.cursor}>
                  {t().first}
                </Button>
                <Button
                  href={props.nextCursor ? href(props.state, { cursor: props.nextCursor }) : undefined}
                  disabled={!props.nextCursor}
                  forward
                >
                  {t().next}
                </Button>
              </>
            }
          />
        </Show>
      </Show>
      <Show when={props.tab === "apps"}>{groupTable(props.groups.apps, "app", t().app)}</Show>
      <Show when={props.tab === "capabilities"}>{groupTable(props.groups.capabilities, "capability", t().capability)}</Show>
    </Pane>
  );

  const record = (detail: ExecutionDetailModel) => (
    <Pane
      detail
      label={detail.title}
      back={{ label: t().executions, href: href(props.state, { cursor: props.cursor }) }}
      head={
        <Bar
          start={<Text type="lead">{detail.title}</Text>}
          end={<Button variant="ghost" icon="x" label={t().close} href={href(props.state, { cursor: props.cursor })} />}
        />
      }
    >
      <Text type="meta" muted>
        {t().detailHint}
      </Text>
      <For each={detail.sections}>
        {(section) => (
          <Section
            icon="plug"
            title={section.title}
            summary={
              <>
                {statusChip(section.status, section.statusLabel)}{" "}
                {section.destructive ? <Chip status="warn">{t().destructive}</Chip> : null}
              </>
            }
            more={section.aiUsageHref ? { label: t().aiUsage, href: section.aiUsageHref } : undefined}
          >
            <Facts items={section.facts.map((fact) => ({ label: fact.label, value: fact.value, mono: fact.mono }))} />
          </Section>
        )}
      </For>
      <Section icon="code" title={t().technicalDetails}>
        <Facts
          items={detail.technical.map((fact) => ({
            label: fact.label,
            value: fact.value,
            mono: fact.mono,
            copy: fact.mono ? fact.value : undefined,
          }))}
        />
      </Section>
    </Pane>
  );

  return (
    <AdminWorkspace
      nav={props.nav}
      detail={props.request && props.tab === "executions" ? 440 : undefined}
      head={
        <Bar
          start={
            <Tabs
              label={t().title}
              items={[
                {
                  label: t().executions,
                  icon: "list",
                  href: href(props.state, { tab: "executions" }),
                  current: props.tab === "executions",
                },
                { label: t().byApp, icon: "apps", href: href(props.state, { tab: "apps" }), current: props.tab === "apps" },
                {
                  label: t().byCapability,
                  icon: "plug",
                  href: href(props.state, { tab: "capabilities" }),
                  current: props.tab === "capabilities",
                },
              ]}
            />
          }
          end={
            <Button
              variant="ghost"
              icon="refresh"
              label={t().refresh}
              title={t().refresh}
              href={href(props.state, { cursor: props.cursor })}
            />
          }
        />
      }
    >
      <Pane.Split>
        {list()}
        <Show when={props.tab === "executions" && props.request}>
          <Show
            when={props.detail}
            fallback={
              <Pane detail label={t().detailTitle} back={{ label: t().executions, href: href(props.state, { cursor: props.cursor }) }}>
                <Empty
                  icon="file-off"
                  text={t().notFound}
                  action={{ label: t().backToList, href: href(props.state, { cursor: props.cursor }) }}
                />
              </Pane>
            }
          >
            {(detail) => record(detail())}
          </Show>
        </Show>
      </Pane.Split>
    </AdminWorkspace>
  );
}
