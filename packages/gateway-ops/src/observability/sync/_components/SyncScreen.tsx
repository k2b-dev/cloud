import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { useLocale } from "@k2b/ui";
import {
  Bar,
  Button,
  Chip,
  type Column,
  Facts,
  FilterBar,
  Input,
  type NavProps,
  Notice,
  Pane,
  Prose,
  Section,
  StatusRow,
  Table,
  Text,
  useToast,
} from "@k2b/ui/v2";
import { createMemo, createSignal, For, Show } from "solid-js";
import { gatewayOpsMessages } from "../../../messages";
import { listHref, type SyncListState, type SyncNatsFacets, syncQuery } from "../../_components/sync-nats-query";
import { syncOpsMessages } from "../ops-messages";
import { canRetry, type DeadLetterTarget, deleteDeadLetter, retryDeadLetter } from "./dead-letter-actions";
import RunNow from "./RunNow";

const PATH = "/admin/observability/nats/sync";

export type Worded = { label: string; status: "ok" | "warn" | "bad" | null };

export type SyncAppView = {
  id: string;
  name: string;
  state: Worded;
  error: string | null;
  connection: string;
  workers: string;
  drifted: string;
  dropped: string;
};
export type SyncDeadLetterView = DeadLetterTarget & {
  key: string;
  appName: string;
  attempts: string;
  failedAt: string;
  reason: string;
  preview: string;
  /** The list with this store open, and with this entry open. */
  storeHref: string;
  href: string;
};
export type SyncResourceView = {
  key: string;
  appName: string;
  kind: string;
  id: string;
  natsHref: string | null;
  state: Worded;
  messages: string;
  deadLetters: string;
  deadLettersBad: boolean;
  error: string;
};
export type SyncScheduleView = {
  key: string;
  appId: string;
  appName: string;
  schedulerId: string;
  id: string;
  cron: string;
  nextRun: string;
  handler: Worded;
  lastCompleted: string;
  runs: string;
  failures: string;
  failing: boolean;
  lastError: string;
  lastRunId: string | null;
};
export type SyncEntryView = {
  title: string;
  failedAt: string;
  facts: { label: string; value: string; mono?: boolean }[];
  error: string | null;
  preview: string;
  previewBounded: string;
  target: DeadLetterTarget;
  closeHref: string;
};

export type SyncScreenProps = {
  nav: NavProps;
  facets: SyncNatsFacets;
  state: SyncListState;
  ignored: string | null;
  sampledAt: string;
  refreshHref: string;
  facts: { reachable: string; apps: string; deadLetters: string; attention: string; failingSchedules: string };
  unavailable: { name: string; error: string }[];
  apps: SyncAppView[];
  deadLetters: SyncDeadLetterView[];
  /** The store whose retained failures are open, with its paging and the way back to the sample. */
  store: { label: string; clearHref: string; firstHref: string; nextHref: string | null; error: string | null } | null;
  resources: SyncResourceView[];
  schedules: SyncScheduleView[];
  /** The dead letter open beside the list, or why it could not be read. */
  entry: { view: SyncEntryView | null; error: string | null; closeHref: string } | null;
};

const worded = (value: Worded) => (value.status ? <Chip status={value.status}>{value.label}</Chip> : <Chip>{value.label}</Chip>);

/** Sync on v2: reachable apps, retained dead letters with their deeds, declared resources and schedules. */
export default function SyncScreen(props: SyncScreenProps) {
  const locale = useLocale();
  const t = () => gatewayOpsMessages.resolve([locale()]).t;
  const o = () => syncOpsMessages.resolve([locale()]).t;
  const toast = useToast();
  const query = createMemo(() => syncQuery(locale(), props.facets, { app: props.state.filters.app }));
  const change = (next: SyncListState) => location.replace(listHref(PATH, query().serialize(next)));
  const search = (text: string) => location.assign(listHref(PATH, query().serialize({ ...props.state, search: text.trim() || undefined })));
  // A dead letter that was requeued or deleted leaves the list at once; the next snapshot no longer has it.
  const [gone, setGone] = createSignal<ReadonlySet<string>>(new Set());
  const deadLetters = () => props.deadLetters.filter((row) => !gone().has(row.key));
  const keyOf = (target: DeadLetterTarget) => `${target.appId}/${target.kind}/${target.store}/${target.messageId}`;

  const act = async (target: DeadLetterTarget, deed: "retry" | "delete") => {
    const topic = target.kind === "topic";
    try {
      const done = deed === "retry" ? await retryDeadLetter(target, locale()) : await deleteDeadLetter(target, locale());
      if (!done) return;
      toast(deed === "delete" ? t().syncDeadLetterDeleted : topic ? t().syncReplayed : t().syncRequeued, { status: "ok" });
      setGone(new Set([...gone(), keyOf(target)]));
      // the open entry is gone too: back to the list
      if (props.entry?.view && keyOf(props.entry.view.target) === keyOf(target)) location.assign(props.entry.closeHref);
    } catch (error) {
      toast(error instanceof Error ? error.message : t().syncDeleteFailed, { status: "bad" });
    }
  };

  return (
    <AdminWorkspace
      nav={props.nav}
      detail={props.entry ? 440 : undefined}
      head={
        <Bar
          start={<Text type="body">Sync</Text>}
          end={
            <>
              <Input
                type="search"
                icon="search"
                label={o().resource}
                placeholder={o().resource}
                value={props.state.search ?? ""}
                onKeyDown={(event) => {
                  if (event.isComposing) return;
                  const input = event.currentTarget as HTMLInputElement;
                  if (event.key === "Enter") search(input.value);
                  if (event.key === "Escape" && input.value) search("");
                }}
              />
              <Button variant="ghost" icon="refresh" label={o().refresh} title={o().refresh} href={props.refreshHref} />
            </>
          }
        />
      }
    >
      <Pane.Split>
        <Pane
          label="Sync"
          scrollKey="gateway-ops-sync"
          status={
            <>
              <FilterBar
                query={query()}
                state={props.state}
                onChange={(next) => change({ ...props.state, filters: next.filters, search: next.search })}
                icons={{ app: "apps", state: "alert-triangle" }}
              />
              <StatusRow
                lead={t().syncReachableOf({ count: props.facts.reachable, total: props.facts.apps })}
                facts={[
                  { value: props.facts.deadLetters, after: t().syncDeadLetters },
                  { value: props.facts.attention, after: t().syncResourcesAttention },
                  { value: props.facts.failingSchedules, after: t().syncSchedulesFailingShort },
                  { before: o().sampledAt, value: props.sampledAt },
                ]}
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
          <For each={props.unavailable}>
            {(app) => (
              <Notice tone="bad" title={t().syncAppUnavailable({ app: app.name })}>
                {app.error}
              </Notice>
            )}
          </For>
          <Notice tone="note" title={t().syncLayersTitle}>
            {t().syncLayersNotice}
          </Notice>
          <Section
            icon="mail-x"
            title={t().syncDeadLetters}
            count={deadLetters().length}
            summary={props.store ? `${props.store.label} · ${o().oldest}` : o().overviewLimit}
            actions={props.store ? [{ label: o().clear, href: props.store.clearHref }] : undefined}
          >
            <Show when={props.store?.error}>
              {(error) => (
                <Notice tone="bad" title={o().pageError}>
                  {error()}
                </Notice>
              )}
            </Show>
            <Table
              label={t().syncDeadLetters}
              rows={deadLetters()}
              rowKey={(row) => row.key}
              current={props.entry?.view ? keyOf(props.entry.view.target) : undefined}
              open={(row) => ({ href: row.href })}
              empty={{ icon: "mail-check", text: t().syncNoDeadLetters }}
              phone={(row) => ({ lines: [row.reason, `${row.appName} · ${row.store} · ${row.failedAt}`] })}
              columns={[
                {
                  title: t().syncReason,
                  width: { min: 200, default: 280 },
                  cell: (row) => ({ lines: [row.reason, `${row.appName} · ${row.store} · ${row.kind}`] }),
                },
                { title: t().syncFailedAt, width: { min: 120, default: 150 }, cell: (row) => row.failedAt },
                ...(props.entry
                  ? []
                  : [
                      {
                        title: t().syncAttempts,
                        width: { min: 70, default: 80 },
                        align: "end" as const,
                        cell: (row: SyncDeadLetterView) => row.attempts,
                        drop: true,
                      },
                      {
                        title: t().syncPayload,
                        width: { min: 140, default: 180 },
                        cell: (row: SyncDeadLetterView) => row.preview,
                        drop: true,
                      },
                    ]),
              ]}
            />
          </Section>
          <Show when={props.store && (props.store.nextHref || !props.store.error)}>
            <Bar
              end={
                <>
                  <Button href={props.store?.firstHref}>{o().first}</Button>
                  <Button href={props.store?.nextHref ?? undefined} disabled={!props.store?.nextHref} forward>
                    {o().next}
                  </Button>
                </>
              }
            />
          </Show>
          <Section icon="apps" title={t().apps} count={props.apps.length} summary={t().syncAppsHint}>
            <Table
              label={t().apps}
              rows={props.apps}
              rowKey={(row) => row.id}
              empty={{ icon: "apps-off", text: t().syncNoApps }}
              phone={(row) => ({ lines: [row.name, row.connection], marks: worded(row.state) })}
              columns={(
                [
                  { title: t().app, width: { min: 120, default: 160 }, cell: (row) => row.name },
                  { title: t().status, width: { min: 150, default: 170 }, cell: (row) => worded(row.state) },
                  { title: t().syncConnection, width: { min: 110, default: 130 }, cell: (row) => row.connection, drop: true },
                  { title: t().syncWorkers, width: { min: 70, default: 90 }, align: "end", cell: (row) => row.workers, drop: true },
                  { title: t().syncDrifted, width: { min: 70, default: 90 }, align: "end", cell: (row) => row.drifted, drop: true },
                  { title: t().syncDroppedEvents, width: { min: 90, default: 120 }, align: "end", cell: (row) => row.dropped, drop: true },
                ] satisfies Column<SyncAppView>[]
              ).filter((_, index) => !props.entry || index < 2)}
            />
          </Section>
          <Section icon="stack-2" title={t().syncResources} count={props.resources.length} summary={t().syncResourcesHint}>
            <Table
              label={t().syncResources}
              rows={props.resources}
              rowKey={(row) => row.key}
              empty={{ icon: "stack-2", text: t().syncNoResources }}
              phone={(row) => ({ lines: [row.id, `${row.appName} · ${row.kind}`], marks: worded(row.state) })}
              columns={(
                [
                  {
                    title: t().syncResourceId,
                    width: { min: 180, default: 260 },
                    cell: (row) => ({ lines: [row.id, `${row.appName} · ${row.kind}`] }),
                  },
                  { title: t().syncState, width: { min: 170, default: 200 }, cell: (row) => worded(row.state) },
                  { title: t().syncMessages, width: { min: 80, default: 90 }, align: "end", cell: (row) => row.messages, drop: true },
                  {
                    title: t().syncDeadLetters,
                    width: { min: 90, default: 100 },
                    align: "end",
                    cell: (row) =>
                      row.deadLettersBad ? (
                        <Text tone="bad" weight="medium">
                          {row.deadLetters}
                        </Text>
                      ) : (
                        row.deadLetters
                      ),
                    drop: true,
                  },
                  { title: t().error, cell: (row) => (row.error ? <Text tone="bad">{row.error}</Text> : "—"), drop: true },
                ] satisfies Column<SyncResourceView>[]
              ).filter((_, index) => !props.entry || index < 2)}
            />
          </Section>
          <Section icon="clock-play" title={t().syncSchedules} count={props.schedules.length} summary={t().syncSchedulesHint}>
            <Table
              label={t().syncSchedules}
              rows={props.schedules}
              rowKey={(row) => row.key}
              empty={{ icon: "clock-off", text: t().syncNoSchedules }}
              phone={(row) => ({ lines: [row.id, `${row.appName} · ${row.cron} · ${row.nextRun}`], marks: worded(row.handler) })}
              columns={(
                [
                  {
                    title: t().syncSchedule,
                    width: { min: 180, default: 240 },
                    cell: (row) => ({ lines: [row.id, row.lastError || `${row.appName} · ${row.schedulerId}`] }),
                  },
                  {
                    title: t().syncNextRun,
                    width: { min: 150, default: 190 },
                    cell: (row) => ({ lines: [row.nextRun, row.cron] }),
                    drop: true,
                  },
                  { title: o().handler, width: { min: 110, default: 130 }, cell: (row) => worded(row.handler), drop: true },
                  {
                    title: t().syncFailures,
                    width: { min: 70, default: 80 },
                    align: "end",
                    cell: (row) =>
                      row.failing ? (
                        <Text tone="warn" weight="medium">
                          {row.failures}
                        </Text>
                      ) : (
                        row.failures
                      ),
                    drop: true,
                  },
                  {
                    title: t().actions,
                    cell: (row) => <RunNow appId={row.appId} schedulerId={row.schedulerId} scheduleId={row.id} lastRunId={row.lastRunId} />,
                    drop: true,
                  },
                ] satisfies Column<SyncScheduleView>[]
              ).filter((_, index) => !props.entry || index < 2)}
            />
          </Section>
        </Pane>
        <Show when={props.entry}>
          {(entry) => (
            <Pane
              detail
              label={entry().view?.title ?? o().details}
              back={{ label: t().syncDeadLetters, href: entry().closeHref }}
              head={
                <Bar
                  start={<Text type="lead">{entry().view?.title ?? o().details}</Text>}
                  end={
                    <>
                      <Show when={entry().view}>
                        {(view) => (
                          <>
                            <Button icon="refresh" disabled={!canRetry(view().target)} onClick={() => void act(view().target, "retry")}>
                              {view().target.kind === "topic" ? t().syncReplay : t().syncRequeue}
                            </Button>
                            <Button
                              variant="ghost"
                              icon="trash"
                              label={t().syncDeleteDeadLetter}
                              onClick={() => void act(view().target, "delete")}
                            />
                          </>
                        )}
                      </Show>
                      <Button variant="ghost" icon="x" label={o().close} href={entry().closeHref} />
                    </>
                  }
                />
              }
            >
              <Show
                when={entry().view}
                fallback={
                  <Notice tone="bad" title={o().detailError}>
                    {entry().error ?? ""}
                  </Notice>
                }
              >
                {(view) => (
                  <>
                    <Section icon="info-circle" title={t().properties}>
                      <Facts items={view().facts} />
                    </Section>
                    <Show when={view().error}>
                      {(error) => (
                        <Section icon="alert-circle" title={t().error}>
                          <Prose markdown={`\`\`\`\n${error()}\n\`\`\``} />
                        </Section>
                      )}
                    </Show>
                    <Section icon="braces" title={o().preview} summary={view().previewBounded}>
                      <Prose markdown={`\`\`\`json\n${view().preview}\n\`\`\``} />
                    </Section>
                  </>
                )}
              </Show>
            </Pane>
          )}
        </Show>
      </Pane.Split>
    </AdminWorkspace>
  );
}
