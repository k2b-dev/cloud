import { formatDateTime, formatRelative } from "@k2b/cloud/shared";
import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { Bar, Button, Cells, Empty, Inline, Notice, Pane, Progress, Section, StatusRow, Table, Text, useLocale } from "@k2b/ui/v2";
import { type JSX, Show } from "solid-js";
import type { CodeAdminSummary } from "../../../code/admin";
import type { UnusedCodeDatabase } from "../../../code/database-retention";
import type { CodeCleanupJob } from "../../../code/lifecycle-contracts";
import type { CodeRunnerMetrics } from "../../../code/scheduling-contracts";
import AreaFrame from "../_area/AreaFrame";
import { type RecentChange, recentSide } from "../_area/RecentChanges";
import RegistryForm, { type RegistryFormSection } from "../_area/RegistryForm";
import StateWord from "../_area/StateWord";
import type { SettingFieldDef } from "../settings/_components/setting-field";
import { codeAreaHref } from "./area";
import { CODE_COLOR, type CodeScreenBase, type Loaded, ok } from "./data";
import { createDatabaseDelete, databaseExportHref } from "./database";
import { CodeHead, Lead, LoadFailed, useCodeText } from "./parts";

export type OperationsScreenProps = CodeScreenBase & {
  section: "cleanup" | "databases" | "limits" | "runners";
  summary: Loaded<CodeAdminSummary>;
  cleanup: Loaded<{ items: CodeCleanupJob[]; nextCursor: string | null }>;
  databases?: Loaded<{ items: UnusedCodeDatabase[]; nextCursor: string | null }>;
  runners: Loaded<CodeRunnerMetrics>;
  limits: Loaded<SettingFieldDef[]>;
  /** The groups of the limit settings, in the order the page shows them. */
  limitSections: RegistryFormSection[];
  /** The latest stored changes of the limits by a person, worded by the server. */
  recent?: RecentChange[];
};

/** Export and "Delete now" of one unused database, as text buttons at the end of its row. */
function DatabaseActions(props: { row: UnusedCodeDatabase }) {
  const t = useCodeText();
  const remove = createDatabaseDelete(props.row.codeId, { namespace: props.row.namespace, since: props.row.since });
  return (
    <Inline>
      <Button variant="text" icon="download" label={t().databaseExport} href={databaseExportHref(props.row.codeId)} />
      <Button variant="text" icon={remove.action().icon} disabled={remove.action().disabled} onClick={() => remove.action().onClick?.()}>
        {remove.action().label}
      </Button>
    </Inline>
  );
}

/**
 * The operations of Code on v2: pending cleanup, unused databases, the limits of every run as settings, and the runners
 * with their places, queue and waiting time.
 */
export default function OperationsScreen(props: OperationsScreenProps) {
  const t = useCodeText();
  const locale = useLocale();
  const when = (iso: string) => formatDateTime(iso, props.dateConfig);
  const ago = (iso: string) => formatRelative(iso, props.dateConfig);
  const summary = ok(props.summary) ? props.summary : null;
  const size = (bytes: number | null) =>
    bytes === null ? "–" : `${new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(bytes / 1048576)} MB`;
  const num = (n: number) => new Intl.NumberFormat(locale()).format(n);
  const waitText = (ms: number) => (ms < 60_000 ? t().seconds({ n: Math.round(ms / 1000) }) : t().minutes({ n: Math.round(ms / 60_000) }));

  const cleanupPane = (): JSX.Element => {
    const page = props.cleanup;
    return (
      <Pane
        label={t().cleanup}
        scrollKey="admin-code-cleanup"
        status={
          // k2b-ui gap: Hero figure (#4360); the count of waiting jobs is the statement
          <StatusRow lead={summary ? (summary.cleanup ? t().cleanupSub({ n: summary.cleanup }) : t().emptyCleanup) : t().cleanup} />
        }
      >
        <Lead>{t().cleanupLead}</Lead>
        <Text type="meta" muted>
          {t().cleanupAccessNote}
        </Text>
        <Show when={ok(page) ? page : null} fallback={<LoadFailed />}>
          {(loaded) => (
            <>
              <Table
                label={t().cleanup}
                rows={loaded().items}
                rowKey={(job) => job.id}
                open={(job) => ({ href: codeAreaHref({ sec: "code", id: job.codeId }) })}
                empty={{ icon: "recycle", text: t().emptyCleanupSub }}
                phone={(job) => ({
                  mark: { icon: job.kind === "database.delete" ? "database-x" : "trash", color: CODE_COLOR },
                  lines: [
                    job.title,
                    `${job.kind === "database.delete" ? t().jobDeleteDatabase : t().jobDelete} · ${t().jobState({ s: job.state })}`,
                  ],
                })}
                columns={[
                  {
                    title: t().code,
                    width: { min: 180, default: 260 },
                    mark: (job) => ({ icon: job.kind === "database.delete" ? "database-x" : "trash", color: CODE_COLOR }),
                    cell: (job) => job.title,
                  },
                  {
                    title: t().job,
                    width: { min: 140, default: 200 },
                    drop: true,
                    cell: (job) => (job.kind === "database.delete" ? t().jobDeleteDatabase : t().jobDelete),
                  },
                  {
                    title: t().state,
                    width: { min: 130, default: 160 },
                    drop: true,
                    cell: (job) =>
                      job.lastError ? (
                        <Text tone="warn">{t().jobState({ s: job.state })}</Text>
                      ) : (
                        <StateWord muted={job.state !== "running"}>{t().jobState({ s: job.state })}</StateWord>
                      ),
                  },
                  {
                    title: t().retry,
                    drop: true,
                    cell: (job) =>
                      `${t().attempts({ n: job.attempts })} · ${t().nextAttempt({ when: when(job.nextAttemptAt) })}${job.lastError ? ` · ${t().lastErrorWorded}` : ""}`,
                  },
                ]}
              />
              <Show when={loaded().nextCursor}>
                {(after) => <Bar end={<Button href={codeAreaHref({ sec: "cleanup", after: after() })}>{t().loadMore}</Button>} />}
              </Show>
            </>
          )}
        </Show>
      </Pane>
    );
  };

  const databasesPane = (): JSX.Element => {
    const page = props.databases;
    return (
      <Pane
        label={t().unusedDatabases}
        scrollKey="admin-code-databases"
        status={
          ok(page) ? (
            <StatusRow
              lead={
                page.items.length ? t().databasesCount({ n: page.items.length, more: page.nextCursor !== null }) : t().noUnusedDatabases
              }
              facts={
                page.items.some((row) => row.bytes !== null)
                  ? [{ value: size(page.items.reduce((sum, row) => sum + (row.bytes ?? 0), 0)), after: t().databasesTotal }]
                  : undefined
              }
            />
          ) : undefined
        }
      >
        <Lead>{t().unusedDatabasesLead}</Lead>
        <Show when={ok(page) ? page : null} fallback={<LoadFailed />}>
          {(loaded) => (
            <>
              <Table
                label={t().unusedDatabases}
                rows={loaded().items}
                rowKey={(row) => row.codeId}
                empty={{ icon: "database", text: t().noUnusedDatabases }}
                phone={(row) => ({
                  mark: { icon: "database", color: CODE_COLOR },
                  lines: [row.title, `${row.owner} · ${size(row.bytes)} · ${row.deleteAt ? when(row.deleteAt) : t().deletionOff}`],
                })}
                open={(row) => ({ href: codeAreaHref({ sec: "code", id: row.codeId }) })}
                columns={[
                  {
                    title: t().code,
                    width: { min: 160, default: 220 },
                    mark: () => ({ icon: "database", color: CODE_COLOR }),
                    cell: (row) => row.title,
                  },
                  { title: t().owner, width: { min: 120, default: 160 }, drop: true, cell: (row) => row.owner },
                  { title: t().databaseSize, width: { min: 80, default: 96 }, align: "end", drop: true, cell: (row) => size(row.bytes) },
                  { title: t().unusedSince, width: { min: 130, default: 150 }, drop: true, cell: (row) => when(row.since) },
                  {
                    title: t().deleteAt,
                    width: { min: 130, default: 150 },
                    drop: true,
                    cell: (row) => (row.deleteAt ? when(row.deleteAt) : <Text muted>{t().deletionOff}</Text>),
                  },
                  {
                    title: t().lastAccess,
                    width: { min: 110, default: 130 },
                    drop: true,
                    cell: (row) => (row.lastAccess ? ago(row.lastAccess) : <Text muted>–</Text>),
                  },
                  { title: "", drop: true, cell: (row) => <DatabaseActions row={row} /> },
                ]}
              />
              <Show when={loaded().nextCursor}>
                {(after) => <Bar end={<Button href={codeAreaHref({ sec: "databases", after: after() })}>{t().loadMore}</Button>} />}
              </Show>
            </>
          )}
        </Show>
      </Pane>
    );
  };

  const runnersPane = (): JSX.Element => {
    const metrics = props.runners;
    return (
      <Pane label={t().runners} scrollKey="admin-code-runners">
        <Show when={ok(metrics) ? metrics : null} fallback={<LoadFailed text={t().runnersFailedSub} />}>
          {(current) => {
            const slots = current().slots ?? current().freeSlots;
            const none = current().instances === 0;
            // The queue grows when nothing is free and runs wait.
            const behind = !none && current().freeSlots === 0 && current().queued > 0;
            const short = (id: string) => id.replace(/-/g, "").slice(0, 4);
            return (
              <>
                <Show when={none}>
                  <Notice tone="bad" icon="plug-off" title={t().noRunners}>
                    {t().noRunnersSub}
                  </Notice>
                </Show>
                <Show when={behind}>
                  <Notice tone="warn" title={t().queueGrows}>
                    {t().queueGrowsSub({ wait: waitText(current().oldestWaitingMs) })}
                  </Notice>
                </Show>
                {/* k2b-ui gap: Hero figure (#4360) and a series of runner load over time; the runners report only now */}
                <Cells>
                  <Cells.Cell
                    icon="server-2"
                    color={CODE_COLOR}
                    label={t().instances}
                    value={none ? <Text tone="bad">0</Text> : num(current().instances)}
                    meta={t().runnerUnit({ n: current().instances })}
                  />
                  <Cells.Cell
                    icon="layout-grid"
                    label={t().freeSlots}
                    value={
                      behind ? (
                        <Text tone="warn">{t().slotsOf({ free: current().freeSlots, total: slots })}</Text>
                      ) : (
                        t().slotsOf({ free: current().freeSlots, total: slots })
                      )
                    }
                    meta={
                      <Progress
                        value={slots - current().freeSlots}
                        of={slots}
                        label={t().slotsBusyShort({ n: slots - current().freeSlots })}
                      />
                    }
                  />
                  <Cells.Cell
                    icon="clock-pause"
                    label={t().queue}
                    value={
                      current().queued > 0 && (behind || none) ? <Text tone="warn">{num(current().queued)}</Text> : num(current().queued)
                    }
                    meta={t().runsWaiting({ n: current().queued })}
                  />
                  <Cells.Cell
                    icon="hourglass"
                    label={t().waitTime}
                    value={
                      behind || none ? <Text tone="warn">{waitText(current().oldestWaitingMs)}</Text> : waitText(current().oldestWaitingMs)
                    }
                    meta={t().longestWait}
                  />
                </Cells>
                <Section icon="server-2" title={t().runners} count={current().runners.length}>
                  <Show when={current().runners.length} fallback={<Empty icon="plug-off" text={t().noRunnersList} />}>
                    <Table
                      label={t().runners}
                      rows={current().runners}
                      rowKey={(runner) => runner.instanceId}
                      phone={(runner) => ({
                        mark: { icon: "server-2", color: CODE_COLOR },
                        lines: [
                          t().runnerName({ n: current().runners.indexOf(runner) + 1 }),
                          `${t().slotsFreeOf({ free: runner.freeSlots, total: runner.freeSlots + (runner.busySlots ?? 0) })} · ${ago(runner.lastSeenAt)}`,
                        ],
                      })}
                      columns={[
                        {
                          title: t().runner,
                          width: { min: 120, default: 160 },
                          mark: () => ({ icon: "server-2", color: CODE_COLOR }),
                          cell: (runner) => t().runnerName({ n: current().runners.indexOf(runner) + 1 }),
                        },
                        // k2b-ui gap: a monospace table cell for identifiers; the short instance ID stands as quiet text
                        {
                          title: t().instance,
                          width: { min: 100, default: 120 },
                          drop: true,
                          cell: (runner) => <Text type="meta">{short(runner.instanceId)}</Text>,
                        },
                        {
                          title: t().places,
                          width: { min: 200, default: 280 },
                          drop: true,
                          // the places that are taken now, as a bar against all places of this runner
                          cell: (runner) => {
                            const busy = runner.busySlots ?? 0;
                            const total = busy + runner.freeSlots;
                            return <Progress value={busy} of={total} label={t().slotsBusy({ busy, total })} />;
                          },
                        },
                        {
                          title: t().state,
                          width: { min: 110, default: 130 },
                          drop: true,
                          cell: () => <StateWord>{t().connected}</StateWord>,
                        },
                        { title: t().lastSeen, drop: true, cell: (runner) => ago(runner.lastSeenAt) },
                      ]}
                    />
                  </Show>
                </Section>
              </>
            );
          }}
        </Show>
      </Pane>
    );
  };

  if (props.section === "limits")
    return (
      <AreaFrame
        nav={props.nav}
        area={{ label: t().area, href: codeAreaHref({}) }}
        title={t().sectionLabel({ s: "limits" })}
        description={t().limitsLead}
        documentationHref={props.documentationHref}
        side={recentSide(props.recent)}
      >
        <Show when={ok(props.limits) ? props.limits : null} fallback={<LoadFailed />}>
          {(entries) => <RegistryForm groups={["core"]} sections={props.limitSections} entries={entries()} />}
        </Show>
      </AreaFrame>
    );
  return (
    <AdminWorkspace nav={props.nav} head={<CodeHead section={props.section} />}>
      {props.section === "cleanup" ? cleanupPane() : props.section === "databases" ? databasesPane() : runnersPane()}
    </AdminWorkspace>
  );
}
