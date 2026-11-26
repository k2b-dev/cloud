import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { Chart, useLocale } from "@k2b/ui";
import {
  Bar,
  Button,
  Canvas,
  Chip,
  type Column,
  Empty,
  Facts,
  FilterBar,
  Inline,
  List,
  type NavProps,
  Notice,
  Pane,
  Prose,
  Row,
  Section,
  StatusRow,
  Table,
  Tabs,
  Text,
} from "@k2b/ui/v2";
import { createMemo, For, type JSX, Show } from "solid-js";
import { gatewayOpsMessages } from "../../../messages";
import { type KeyCell, KeyCells } from "../../_components/KeyCells";
import type { WorkflowView } from "../filters";
import { type FindingsState, findingsQuery, type RunsState, runsQuery, workflowsHref } from "../query";
import RunActions, { type RunActionsProps } from "./RunActions";

export type Worded = { label: string; status: "ok" | "warn" | "bad" | null };
export type FamilyView = {
  key: string;
  name: string;
  meta: string;
  latest: Worded;
  runs: string;
  failed: string;
  failedBad: boolean;
  runtime: string;
  backlog: string;
  backlogWarn: boolean;
  activity: string;
  href: string;
};
export type EffectView = {
  key: string;
  workflow: string;
  app: string;
  step: string;
  action: string;
  state: Worded;
  age: string;
  href: string;
};
export type EventView = {
  key: string;
  type: string;
  app: string;
  scope: string;
  state: Worded;
  attempts: string;
  occurred: string;
  error: string;
};
export type StepView = {
  key: string;
  step: string;
  action: string;
  state: Worded;
  effect: Worded | null;
  detail: string;
  attempts: string;
  duration: string;
};
export type TimelineView = {
  rows: {
    label: string;
    href: string;
    tooltip: string;
    intervals: { from: number; to: number; state: string; label: string; href: string; tooltip: string }[];
  }[];
  domain: [number, number];
  states: { state: string; label: string; color: string }[];
  sample: string | null;
};
export type RunDetailView = {
  title: string;
  state: Worded;
  meta: string;
  outcome: { tone: "warn" | "bad"; title: string; text: string } | null;
  facts: { label: string; value: string; href?: string }[];
  children: { label: string; status: Worded["status"]; href: string }[];
  steps: StepView[];
  payloads: { title: string; json: string }[];
  technical: { title: string; json: string }[];
  actions: RunActionsProps;
  closeHref: string;
};

export type WorkflowsScreenProps = {
  nav: NavProps;
  apps: string[];
  view: WorkflowView;
  runsState: RunsState;
  findingsState: FindingsState;
  /** The address's own parameters, for links that keep it. */
  search: string;
  ignored: string | null;
  tabs: { runs: string; effects: string; events: string; effectsCount: string; eventsCount: string };
  cells: KeyCell[];
  findings: { tone: "warn"; title: string; text: string; action: { label: string; href: string } }[];
  timeline: TimelineView | null;
  list: {
    title: string;
    count: string;
    summary: string;
    actions: { label: string; href: string }[];
    empty: string;
    filtered: boolean;
    families?: FamilyView[];
    effects?: EffectView[];
    events?: EventView[];
  } | null;
  /** A run or workflow the address names that does not exist. */
  missing: { title: string; action: { label: string; href: string } } | null;
  previousHref: string | null;
  nextHref: string | null;
  detail: RunDetailView | null;
};

/** A section shows at most two actions in its head. */
const twoActions = (actions: { label: string; href: string }[]) => {
  const [first, second] = actions;
  return first ? (second ? ([first, second] as const) : ([first] as const)) : undefined;
};
const worded = (value: Worded) => (value.status ? <Chip status={value.status}>{value.label}</Chip> : <Chip>{value.label}</Chip>);
const toned = (text: string, tone: "warn" | "bad" | false): JSX.Element => (tone ? <Text tone={tone}>{text}</Text> : text);

/** The workflow console on v2: key numbers, findings, the run timeline, the queue of the view, and one run beside it. */
export default function WorkflowsScreen(props: WorkflowsScreenProps) {
  const locale = useLocale();
  const t = () => gatewayOpsMessages.resolve([locale()]).t;
  const runs = createMemo(() => runsQuery(locale(), props.apps, props.runsState.filters.app));
  const findings = createMemo(() => findingsQuery(locale(), props.apps, props.findingsState.filters.app));
  // A new filter starts the list again: the page and the open run are dropped, the workflow or parent stays.
  const keep = () => {
    const params = new URLSearchParams(props.search);
    return { workflow: params.get("workflow") ?? "", parent: params.get("parent") ?? "" };
  };
  const goRuns = (next: Pick<RunsState, "filters">) =>
    location.replace(workflowsHref(runs().serialize({ ...props.runsState, filters: next.filters }), keep()));
  const goFindings = (next: Pick<FindingsState, "filters">) =>
    location.replace(workflowsHref(findings().serialize({ ...props.findingsState, filters: next.filters })));
  const list = () => props.list;
  /** Times on the timeline's axis: days only when the window is longer than one. */
  const timelineFormat = (value: number) => {
    const domain = props.timeline?.domain ?? [0, 0];
    return new Intl.DateTimeFormat(locale(), {
      ...(domain[1] - domain[0] > 86_400_000 ? { day: "2-digit", month: "short" } : {}),
      hour: "2-digit",
      minute: "2-digit",
    }).format(value);
  };
  return (
    <AdminWorkspace
      nav={props.nav}
      detail={props.detail ? 480 : undefined}
      head={
        <Bar
          start={
            <Tabs
              label={t().workflowView}
              items={[
                { label: t().workflows, icon: "binary-tree", href: props.tabs.runs, current: props.view === "runs" },
                {
                  label: t().effects,
                  icon: "bolt",
                  count: props.tabs.effectsCount,
                  href: props.tabs.effects,
                  current: props.view === "effects",
                },
                {
                  label: t().workflowEvents,
                  icon: "mail-forward",
                  count: props.tabs.eventsCount,
                  href: props.tabs.events,
                  current: props.view === "events",
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
              href={workflowsHref(new URLSearchParams(props.search))}
            />
          }
        />
      }
    >
      <Pane.Split>
        <Pane
          label={t().workflows}
          scrollKey="gateway-ops-workflows"
          status={
            <>
              <Show
                when={props.view === "runs"}
                fallback={<FilterBar query={findings()} state={props.findingsState} onChange={goFindings} icons={{ app: "apps" }} />}
              >
                <FilterBar
                  query={runs()}
                  state={props.runsState}
                  onChange={goRuns}
                  icons={{ window: "clock", app: "apps", state: "activity", mode: "arrows-shuffle" }}
                />
              </Show>
              <StatusRow lead={list() ? `${list()?.count} · ${list()?.title}` : t().workflows} />
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
          <KeyCells cells={props.cells.slice(0, 3)} />
          <KeyCells cells={props.cells.slice(3)} />
          <For each={props.findings}>
            {(finding) => (
              <Notice tone={finding.tone} title={finding.title} actions={[finding.action]}>
                {finding.text}
              </Notice>
            )}
          </For>
          <Show when={props.timeline}>
            {(timeline) => (
              <Section icon="timeline" title={t().runTimeline} summary={timeline().sample ?? t().workflowTimelineDescription}>
                <Canvas label={t().runTimeline} height={Math.max(160, 96 + timeline().rows.length * 24)}>
                  <Show when={timeline().rows.length > 0} fallback={<Empty icon="timeline" text={t().noWorkflowRunsWindow} />}>
                    <Chart
                      kind="stateTimeline"
                      rows={timeline().rows}
                      states={timeline().states}
                      domain={timeline().domain}
                      xAxis={{ format: timelineFormat }}
                      legend
                      interactive
                      style={{ height: "100%" }}
                    />
                  </Show>
                </Canvas>
              </Section>
            )}
          </Show>
          <Show when={props.missing}>
            {(missing) => (
              <Notice tone="bad" title={missing().title} actions={[missing().action]}>
                {missing().action.label}
              </Notice>
            )}
          </Show>
          <Show when={list()}>
            {(current) => (
              <Section
                icon="list"
                title={current().title}
                count={current().count}
                summary={current().summary}
                actions={twoActions(current().actions)}
              >
                <Show when={current().families}>
                  {(rows) => <FamiliesTable rows={rows()} empty={current().empty} compact={Boolean(props.detail)} />}
                </Show>
                <Show when={current().effects}>{(rows) => <EffectsTable rows={rows()} empty={current().empty} />}</Show>
                <Show when={current().events}>{(rows) => <EventsTable rows={rows()} empty={current().empty} />}</Show>
              </Section>
            )}
          </Show>
          <Show when={props.previousHref || props.nextHref}>
            <Bar
              end={
                <>
                  <Button icon="chevron-left" href={props.previousHref ?? undefined} disabled={!props.previousHref}>
                    {t().previous}
                  </Button>
                  <Button href={props.nextHref ?? undefined} disabled={!props.nextHref} forward>
                    {t().next}
                  </Button>
                </>
              }
            />
          </Show>
        </Pane>
        <Show when={props.detail}>{(detail) => <RunPane detail={detail()} />}</Show>
      </Pane.Split>
    </AdminWorkspace>
  );
}

function FamiliesTable(props: { rows: FamilyView[]; empty: string; compact?: boolean }) {
  const locale = useLocale();
  const t = () => gatewayOpsMessages.resolve([locale()]).t;
  return (
    <Table
      label={t().workflowFamilies}
      rows={props.rows}
      rowKey={(row) => row.key}
      open={(row) => ({ href: row.href })}
      empty={{ icon: "binary-tree", text: props.empty }}
      phone={(row) => ({ lines: [row.name, `${row.runs} · ${row.failed}`], marks: worded(row.latest) })}
      columns={(
        [
          {
            title: t().workflowTrigger,
            width: { min: 200, default: 240 },
            cell: (row) => ({ lines: [row.name, `${row.meta} · ${row.activity}`] }),
          },
          { title: t().latest, width: { min: 170, default: 190 }, cell: (row) => worded(row.latest) },
          {
            title: t().runs,
            width: { min: 100, default: 120 },
            align: "end",
            cell: (row) => ({ lines: [row.runs, row.failed] }),
            drop: true,
          },
          { title: t().runtime, width: { min: 100, default: 110 }, align: "end", cell: (row) => row.runtime, drop: true },
          { title: t().backlog, align: "end", cell: (row) => toned(row.backlog, row.backlogWarn && "warn"), drop: true },
        ] satisfies Column<FamilyView>[]
      ).filter((_, index) => !props.compact || index < 2)}
    />
  );
}

function EffectsTable(props: { rows: EffectView[]; empty: string }) {
  const locale = useLocale();
  const t = () => gatewayOpsMessages.resolve([locale()]).t;
  return (
    <Table
      label={t().effectsRequiringEvidence}
      rows={props.rows}
      rowKey={(row) => row.key}
      open={(row) => ({ href: row.href })}
      empty={{ icon: "bolt", text: props.empty }}
      phone={(row) => ({ lines: [row.workflow, `${row.step} · ${row.age}`], marks: worded(row.state) })}
      columns={[
        { title: t().workflow, width: { min: 200, default: 260 }, cell: (row) => ({ lines: [row.workflow, `${row.app} · ${row.step}`] }) },
        { title: t().actionLabel, width: { min: 120, default: 160 }, cell: (row) => row.action, drop: true },
        { title: t().state, width: { min: 150, default: 170 }, cell: (row) => worded(row.state) },
        { title: t().unsettledFor, align: "end", cell: (row) => row.age, drop: true },
      ]}
    />
  );
}

function EventsTable(props: { rows: EventView[]; empty: string }) {
  const locale = useLocale();
  const t = () => gatewayOpsMessages.resolve([locale()]).t;
  return (
    <Table
      label={t().eventsWithoutRunTitle}
      rows={props.rows}
      rowKey={(row) => row.key}
      empty={{ icon: "mail-check", text: props.empty }}
      phone={(row) => ({ lines: [row.type, row.error || `${row.app} · ${row.occurred}`], marks: worded(row.state) })}
      columns={[
        { title: t().event, width: { min: 200, default: 260 }, cell: (row) => ({ lines: [row.type, `${row.app} · ${row.scope}`] }) },
        { title: t().state, width: { min: 150, default: 170 }, cell: (row) => worded(row.state) },
        { title: t().attempts, width: { min: 70, default: 80 }, align: "end", cell: (row) => row.attempts, drop: true },
        { title: t().occurred, width: { min: 100, default: 120 }, align: "end", cell: (row) => row.occurred, drop: true },
        { title: t().lastError, cell: (row) => row.error || "—", drop: true },
      ]}
    />
  );
}

/** One run beside the list: its outcome, facts, children, steps, data and its interventions. */
function RunPane(props: { detail: RunDetailView }) {
  const locale = useLocale();
  const t = () => gatewayOpsMessages.resolve([locale()]).t;
  return (
    <Pane
      detail
      label={props.detail.title}
      back={{ label: t().workflows, href: props.detail.closeHref }}
      head={
        <Bar
          start={<Text type="lead">{props.detail.title}</Text>}
          end={
            <>
              <RunActions {...props.detail.actions} />
              <Button variant="ghost" icon="x" label={t().close} href={props.detail.closeHref} />
            </>
          }
        />
      }
    >
      <Bar
        start={
          <Inline>
            {worded(props.detail.state)}
            <Text type="meta" muted>
              {props.detail.meta}
            </Text>
          </Inline>
        }
      />
      <Show when={props.detail.outcome}>
        {(outcome) => (
          <Notice tone={outcome().tone} title={outcome().title}>
            {outcome().text}
          </Notice>
        )}
      </Show>
      <Section icon="info-circle" title={t().runOverview}>
        <Facts
          items={props.detail.facts.map((fact) => ({
            label: fact.label,
            value: fact.href ? <Text href={fact.href}>{fact.value}</Text> : fact.value,
          }))}
        />
        <Show when={props.detail.children.length > 0}>
          <Inline>
            <For each={props.detail.children}>
              {(child) =>
                child.status ? (
                  <Chip status={child.status} href={child.href}>
                    {child.label}
                  </Chip>
                ) : (
                  <Chip href={child.href}>{child.label}</Chip>
                )
              }
            </For>
          </Inline>
        </Show>
      </Section>
      <Section icon="list-check" title={t().executionSteps} count={props.detail.steps.length}>
        <Show when={props.detail.steps.length > 0} fallback={<Empty icon="list-check" text={t().noRecordedStep} />}>
          <List label={t().executionSteps}>
            <For each={props.detail.steps}>
              {(step) => (
                <Row
                  lines={[`${step.step} · ${step.action}`, step.detail]}
                  meta={`${step.attempts} · ${step.duration}`}
                  end={step.effect ? worded(step.effect) : worded(step.state)}
                />
              )}
            </For>
          </List>
        </Show>
      </Section>
      <For each={props.detail.payloads}>
        {(payload) => (
          <Section icon="braces" title={payload.title}>
            <Prose markdown={`\`\`\`json\n${payload.json}\n\`\`\``} />
          </Section>
        )}
      </For>
      <For each={props.detail.technical}>
        {(part) => (
          <Section icon="code" title={part.title} summary={t().technicalDetails}>
            <Prose markdown={`\`\`\`json\n${part.json}\n\`\`\``} />
          </Section>
        )}
      </For>
    </Pane>
  );
}
