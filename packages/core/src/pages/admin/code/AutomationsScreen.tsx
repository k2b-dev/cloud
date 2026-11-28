import { formatDateTime, formatRelative } from "@k2b/cloud/shared";
import { codeRunName } from "@k2b/cloud/ssr/code-page/targets";
import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import {
  type Action,
  Avatar,
  Bar,
  Button,
  Canvas,
  Dialog,
  Empty,
  Facts,
  FilterBar,
  Inline,
  Notice,
  Pane,
  Progress,
  Row,
  Section,
  StatusRow,
  Table,
  Text,
  type TwoActions,
  useLocale,
  useToast,
} from "@k2b/ui/v2";
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { z } from "zod";
import type { CodeAdminCode, CodeAdminCodeDetail, CodeAdminSummary } from "../../../code/admin";
import type { CodePageReport, CodePageReportPage } from "../../../code/page-report-contracts";
import { CodePageReportPageSchema } from "../../../code/page-report-contracts";
import StateWord from "../_area/StateWord";
import { codeAreaHref } from "./area";
import { CodeAdminRequestError, postCodeAdmin, reloadCodeArea } from "./client";
import { type CodeScreenBase, type Loaded, ok, ownerAppId, ownerLabel, statusText } from "./data";
import { createDatabaseDelete, databaseExportHref } from "./database";
import { codeListHref, codeListQuery } from "./list-query";
import { CodeHead, CodeStatus, LoadFailed, Missing, useCodeText } from "./parts";
import { CodeRefusal } from "./refusal";
import { codePageReportMessages } from "./report-messages";

export type AutomationsScreenProps = CodeScreenBase & {
  summary: Loaded<CodeAdminSummary>;
  codes: Loaded<{ items: CodeAdminCode[]; total: number; owners: number; nextCursor: string | null }>;
  code: Loaded<CodeAdminCodeDetail>;
  reports?: Loaded<CodePageReportPage>;
};

const mb = (bytes: number, locale: string) =>
  new Intl.NumberFormat(locale, { minimumFractionDigits: 0, maximumFractionDigits: 1 }).format(bytes / 1048576);

/** Pause or resume one automation: Cloud admins may pause any; resuming rechecks the active version's approval. */
function createPause(code: { id: string; title: string; paused: boolean }) {
  const t = useCodeText();
  const [busy, setBusy] = createSignal(false);
  const [failure, setFailure] = createSignal<string | null>(null);
  const change = async () => {
    const paused = !code.paused;
    const confirmed = await Dialog.confirm({
      title: paused ? t().pauseTitle({ title: code.title }) : t().resumeTitle({ title: code.title }),
      description: paused ? t().pauseBody : t().resumeBody,
      confirm: paused ? t().pause : t().resume,
      cancel: t().cancel,
    });
    if (!confirmed) return;
    setBusy(true);
    setFailure(null);
    try {
      await postCodeAdmin("pause", { codeId: code.id, paused }, z.object({ state: z.enum(["paused", "active"]) }));
      reloadCodeArea();
    } catch (error) {
      setBusy(false);
      setFailure(
        !(error instanceof CodeAdminRequestError) || error.status < 400 || error.status >= 500
          ? `${t().unknownTitle} ${t().reload}`
          : error.status === 409 && !paused
            ? error.code === "code_policy_never" || error.code === "code_sends_not_yet"
              ? t().resumeForbidden
              : error.code === "code_approval_required" || error.code === "code_approval_revoked" || error.code === "code_hash_mismatch"
                ? t().resumeRefused
                : t().pauseFailed
            : t().pauseFailed,
      );
    }
  };
  return { busy, failure, change };
}

/** Open reports on the pages of one automation, newest first; "Mark done" tells the person who filed it. */
function Reports(props: { codeId: string; page: CodePageReportPage; dateConfig: CodeScreenBase["dateConfig"] }) {
  const locale = useLocale();
  const t = () => codePageReportMessages.resolve([locale()]).t;
  const toast = useToast();
  const [items, setItems] = createSignal<CodePageReport[]>(props.page.items);
  const [cursor, setCursor] = createSignal(props.page.nextCursor);
  const [busy, setBusy] = createSignal<string | null>(null);
  const resolve = async (report: CodePageReport) => {
    setBusy(report.id);
    try {
      await postCodeAdmin(
        "reports/resolve",
        { codeId: props.codeId, reportId: report.id },
        z.object({ state: z.literal("resolved"), resolvedAt: z.string() }),
      );
      // The canonical read counts and lists again, the admin bar included.
      reloadCodeArea();
    } catch {
      setBusy(null);
      toast(t().resolveFailed, { status: "bad" });
    }
  };
  const more = async () => {
    const after = cursor();
    if (!after) return;
    try {
      const page = await postCodeAdmin("reports/list", { codeId: props.codeId, state: "open", cursor: after }, CodePageReportPageSchema);
      setItems((current) => [...current, ...page.items.filter((item) => !current.some((known) => known.id === item.id))]);
      setCursor(page.nextCursor);
    } catch {
      toast(t().moreFailed, { status: "bad", retry: () => void more() });
    }
  };
  return (
    <Section
      title={t().title}
      count={cursor() ? t().openMore({ n: items().length }) : items().length}
      summary={t().description}
      more={cursor() ? { label: t().more, onClick: () => void more() } : undefined}
    >
      <For each={items()}>
        {(report) => (
          <Row
            icon="flag"
            lines={[report.reason ? t().reason({ reason: report.reason }) : t().noReason, report.text]}
            meta={report.path}
            href={`/code/${encodeURIComponent(props.codeId)}${report.path}`}
            time={t().by({ name: report.reporter.name, when: formatDateTime(report.createdAt, props.dateConfig) })}
            action={{ label: t().resolve, icon: "check", onClick: () => void resolve(report), disabled: busy() === report.id }}
          />
        )}
      </For>
    </Section>
  );
}

/** The database of the open automation: what it holds against its limit, export, and deletion when it lies unused. */
function Database(props: {
  codeId: string;
  database: NonNullable<CodeAdminCodeDetail["database"]>;
  dateConfig: CodeScreenBase["dateConfig"];
}) {
  const t = useCodeText();
  const locale = useLocale();
  const database = props.database;
  const remove = database.unused ? createDatabaseDelete(props.codeId, database.unused) : null;
  const exported: Action = { label: t().databaseExport, icon: "download", href: databaseExportHref(props.codeId) };
  const actions = (): TwoActions => (remove ? [exported, remove.action()] : [exported]);
  return (
    <Section title={t().database} actions={actions()}>
      <Facts
        items={[
          {
            label: t().databaseSize,
            value:
              database.bytes === null ? (
                <Text tone="warn">{t().databaseUnavailable}</Text>
              ) : (
                <Progress
                  value={database.bytes}
                  of={database.limit}
                  label={t().mbOf({ used: mb(database.bytes, locale()), limit: mb(database.limit, locale()) })}
                />
              ),
          },
          ...(database.owner
            ? [
                {
                  label: t().ownerCapacity,
                  value: t().mbOf({ used: mb(database.owner.reserved, locale()), limit: mb(database.owner.limit, locale()) }),
                },
              ]
            : []),
          ...(database.unused
            ? [
                { label: t().unusedSince, value: formatDateTime(database.unused.since, props.dateConfig) },
                {
                  label: t().deleteAt,
                  value: database.unused.deleteAt
                    ? new Intl.DateTimeFormat(locale(), { dateStyle: "long", timeZone: "UTC" }).format(new Date(database.unused.deleteAt))
                    : t().deletionOff,
                },
              ]
            : []),
        ]}
      />
    </Section>
  );
}

/**
 * All automations on v2: filter statements for state, app and search in the address (`status`, `app`, `q` as before),
 * one row per automation with its owner, state and last run, and the open one beside it with its facts, pause,
 * reports, database, versions and runs.
 */
export default function AutomationsScreen(props: AutomationsScreenProps) {
  const t = useCodeText();
  const locale = useLocale();
  const query = props.query;
  const appList = () =>
    [
      ...Object.entries(props.apps).map(([id, app]) => ({ id, name: app.name })),
      ...(query.app && query.app !== "person" && !props.apps[query.app] ? [{ id: query.app, name: query.app }] : []),
    ].sort((a, b) => a.name.localeCompare(b.name));
  const listQuery = createMemo(() => codeListQuery(locale(), appList()));
  const initial = codeListQuery(locale(), appList()).parse(
    new URLSearchParams(
      Object.entries({ status: query.status, app: query.app, q: query.q }).flatMap(([key, value]) => (value ? [[key, value]] : [])),
    ),
  ).state;
  const [state, setState] = createSignal(initial);
  const summary = ok(props.summary) ? props.summary : null;
  const codes = ok(props.codes) ? props.codes : null;
  const detail = ok(props.code) ? props.code : null;
  const open = Boolean(query.id);
  const filtered = Boolean(query.status || query.app || query.q);
  const ago = (iso: string) => formatRelative(iso, props.dateConfig);
  const when = (iso: string) => formatDateTime(iso, props.dateConfig);
  const listHref = codeAreaHref({ sec: "code", status: query.status, app: query.app, q: query.q, after: query.after });
  const owner = (code: CodeAdminCode) => ownerLabel(t(), code.owner, code.ownerName, props.apps);
  const lastRun = (code: CodeAdminCode): JSX.Element =>
    code.lastRun ? (
      code.lastRun.state === "failed" ? (
        <Text tone="bad">{t().lastRunFailed({ when: ago(code.lastRun.at) })}</Text>
      ) : (
        ago(code.lastRun.at)
      )
    ) : (
      <Text muted>{t().neverRun}</Text>
    );
  const pause =
    detail && detail.code.activeVersionNumber !== null && (detail.code.state === "active" || detail.code.state === "paused")
      ? createPause({ id: detail.code.id, title: detail.code.title, paused: detail.code.state === "paused" })
      : null;

  const table = () => (
    <Table
      label={t().sectionLabel({ s: "code" })}
      rows={codes?.items ?? []}
      rowKey={(code) => code.id}
      current={query.id}
      open={(code) => ({
        href: codeAreaHref({ sec: "code", id: code.id, status: query.status, app: query.app, q: query.q, after: query.after }),
      })}
      empty={
        filtered
          ? { icon: "filter-off", text: t().emptyFilter, action: { label: t().resetFilters, href: codeAreaHref({ sec: "code" }) } }
          : {
              icon: "code",
              text: t().emptyCodeSub,
              action: { label: t().viewPolicy, icon: "table-options", href: codeAreaHref({ sec: "policy" }) },
            }
      }
      phone={(code) => ({
        // slot for #4208/#4223 (DP): the automation's mark leads the phone row
        // a problem state leads the meta line in its words (identity B, phone); a good one stays quiet
        lines: [code.title, `${owner(code)} · ${statusText(t(), code)} · ${code.lastRun ? ago(code.lastRun.at) : t().neverRun}`],
      })}
      columns={[
        {
          title: t().automation,
          width: { min: 160, default: open ? 200 : 240 },
          // slot for #4208/#4223 (DP): Column mark, the Code sign "code" in the colour of the app it belongs to (else CODE_COLOR)
          cell: (code) => code.title,
        },
        ...(open
          ? []
          : [
              {
                title: t().owner,
                width: { min: 140, default: 190 },
                drop: true,
                // slot for #4208/#4223 (DP): Column avatar of the owner (it replaces the Avatar in the cell)
                cell: (code: CodeAdminCode) => (
                  <Inline>
                    <Avatar
                      name={owner(code)}
                      color={code.owner.kind !== "person" ? props.apps[ownerAppId(code.owner) ?? ""]?.color : undefined}
                      decorative
                    />
                    {owner(code)}
                  </Inline>
                ),
              },
            ]),
        { title: t().status, width: { min: 140, default: 160 }, drop: true, cell: (code) => <CodeStatus code={code} /> },
        { title: t().lastRunTitle, drop: true, cell: lastRun },
      ]}
    />
  );

  const detailPane = (): JSX.Element => {
    if (!query.id) return undefined;
    const back = { label: t().sectionLabel({ s: "code" }), href: listHref };
    if (!detail)
      return (
        <Pane
          detail
          label={t().sectionLabel({ s: "code" })}
          back={back}
          head={<Bar end={<Button variant="ghost" icon="x" label={t().close} href={listHref} />} />}
        >
          <Show when={props.code === "missing"} fallback={<LoadFailed />}>
            <Missing text={t().codeMissing} back={{ sec: "code" }} />
          </Show>
        </Pane>
      );
    const code = detail.code;
    // Code of an app runs as its service account; this detail is its Code page (concept 14 W13).
    const account = code.owner.kind === "app" ? t().accountName({ app: props.apps[code.owner.appId]?.name ?? code.owner.appId }) : null;
    // Runs read as their automations do on the Code page; the own place by the name this admin may read, else type and ID.
    const ownerTitle = code.owner.kind === "resource" ? (code.ownerName ?? "") : "";
    const reports = props.reports;
    return (
      <Pane
        detail
        label={code.title}
        back={back}
        scrollKey="admin-code-detail"
        head={
          <Bar
            start={
              // slot for #4208/#4223 (DP): the tinted object head (ObjectHead, #4360) with the automation's mark; the name stands in
              <Text type="body" weight="strong">
                {code.title}
              </Text>
            }
            end={
              <>
                <Show when={pause}>
                  {(current) => (
                    <Button
                      icon={code.state === "paused" ? "player-play" : "player-pause"}
                      keep
                      busy={current().busy()}
                      onClick={() => void current().change()}
                    >
                      {code.state === "paused" ? t().resume : t().pause}
                    </Button>
                  )}
                </Show>
                <Button variant="ghost" icon="x" label={t().close} href={listHref} />
              </>
            }
          />
        }
      >
        <Show when={pause?.failure()}>{(message) => <Notice tone="bad">{message()}</Notice>}</Show>
        <Show when={query.version}>
          {(versionId) => (
            <Notice
              tone="note"
              icon="arrow-forward-up"
              actions={[{ label: t().openReview, href: codeAreaHref({ sec: "approvals", id: versionId(), tab: "code" }) }]}
            >
              {t().sourceMoved}
            </Notice>
          )}
        </Show>
        <Show when={detail.pendingVersionId}>
          {(versionId) => (
            <Notice
              tone="warn"
              icon="hourglass"
              actions={[{ label: t().openApproval, href: codeAreaHref({ sec: "approvals", id: versionId() }) }]}
            >
              {t().waitsForApproval}
            </Notice>
          )}
        </Show>
        <Section title={t().facts}>
          <Facts
            items={[
              { label: t().owner, value: owner(code) },
              { label: t().status, value: <CodeStatus code={code} /> },
              { label: t().activeVersion, value: code.activeVersionNumber ? t().versionRow({ n: code.activeVersionNumber }) : t().none },
              { label: t().createdAt, value: when(code.createdAt) },
              ...(account
                ? [
                    { label: t().runsAs, value: account },
                    ...(code.serviceAccountHandle
                      ? [{ label: t().handle, value: code.serviceAccountHandle, mono: true, copy: code.serviceAccountHandle }]
                      : []),
                  ]
                : []),
            ]}
          />
        </Section>
        <Show when={account ? detail.refusal : null}>
          {(shown) => {
            const run = detail.runs.find((entry) => entry.id === shown().refusal.runId);
            return (
              <Section title={t().lastRunTitle} count={run ? when(run.createdAt) : undefined}>
                <Canvas label={t().lastRunTitle}>
                  <CodeRefusal refusal={shown().refusal} account={account!} handle={code.serviceAccountHandle} editor={shown().editor} />
                </Canvas>
              </Section>
            );
          }}
        </Show>
        <Show when={reports === "failed"}>
          <Notice tone="bad" icon="flag">
            {codePageReportMessages.resolve([locale()]).t.failed}
          </Notice>
        </Show>
        <Show when={ok(reports) && reports.items.length ? reports : null}>
          {(page) => <Reports codeId={code.id} page={page()} dateConfig={props.dateConfig} />}
        </Show>
        <Show when={detail.database}>
          {(database) => <Database codeId={code.id} database={database()} dateConfig={props.dateConfig} />}
        </Show>
        <Section title={t().versions} count={detail.versions.length || undefined}>
          <Show when={detail.versions.length} fallback={<Row icon="circle-off" lines={[t().noVersions]} />}>
            <For each={detail.versions}>
              {(entry) => (
                <Row
                  icon="git-commit"
                  lines={[
                    t().versionRow({ n: entry.version.number }),
                    `${entry.decision?.soleAdmin ? t().selfApproved : t().versionStatus({ s: entry.status })} · ${when(entry.decision?.decidedAt ?? entry.version.createdAt)}`,
                  ]}
                  href={entry.status !== "submitted" ? codeAreaHref({ sec: "approvals", id: entry.version.id }) : undefined}
                />
              )}
            </For>
          </Show>
        </Section>
        <Section title={t().runs} count={detail.runs.length || undefined}>
          <Show when={detail.runs.length} fallback={<Row icon="circle-off" lines={[t().noRuns]} />}>
            <For each={detail.runs}>
              {(run) => (
                <Row
                  icon={run.state === "failed" ? "circle-x" : run.state === "succeeded" ? "circle-check" : "clock"}
                  // the state in words beside how it started, as the Code page reads a run; a failure in its colour
                  lines={[
                    codeRunName(run, run.automation ? [run.automation] : null, ownerTitle, locale()),
                    run.state === "failed" ? (
                      <>
                        <Text tone="bad">{t().runState({ s: run.state })}</Text> · {t().trigger({ t: run.trigger })}
                      </>
                    ) : (
                      `${t().runState({ s: run.state })} · ${t().trigger({ t: run.trigger })}`
                    ),
                  ]}
                  time={when(run.createdAt)}
                />
              )}
            </For>
          </Show>
        </Section>
        <Show when={detail.cleanup.length}>
          <Section title={t().cleanup} count={detail.cleanup.length}>
            <For each={detail.cleanup}>
              {(job) => (
                <Row
                  icon="recycle"
                  lines={[
                    job.kind === "database.delete" ? t().jobDeleteDatabase : t().jobDelete,
                    `${t().attempts({ n: job.attempts })} · ${t().nextAttempt({ when: when(job.nextAttemptAt) })}`,
                  ]}
                  end={<StateWord muted={job.state !== "running"}>{t().jobState({ s: job.state })}</StateWord>}
                />
              )}
            </For>
          </Section>
        </Show>
      </Pane>
    );
  };

  /** The list: the whole width while nothing is open, beside the open automation at its own width (rule 5). */
  const listPane = () => (
    <Pane
      label={t().sectionLabel({ s: "code" })}
      width={open ? { min: 360, default: 520 } : undefined}
      scrollKey="admin-code-list"
      status={
        <>
          <FilterBar
            query={listQuery()}
            state={state()}
            // the bar wrote the address; the server reads the list for it, so the page loads that address
            onChange={(next) => {
              setState(next);
              window.location.replace(codeListHref(next, query.id));
            }}
            icons={{ status: "circle-dot", app: "apps" }}
            results={codes ? t().codeCount({ n: codes.total }) : undefined}
          />
          {/* k2b-ui gap: Hero figure (#4360); the count of automations and owners is the statement */}
          <StatusRow
            lead={codes ? (codes.total ? t().allSub({ n: codes.total, p: codes.owners }) : t().noneYet) : t().sectionLabel({ s: "code" })}
            facts={summary?.reports ? [{ value: summary.reports, after: t().openReports({ n: summary.reports }) }] : undefined}
          />
        </>
      }
    >
      <Show when={codes} fallback={<LoadFailed />}>
        <Show
          when={codes!.items.length || filtered || query.after}
          fallback={
            <Empty
              icon="code"
              text={t().emptyCodeSub}
              action={{ label: t().viewPolicy, icon: "table-options", href: codeAreaHref({ sec: "policy" }) }}
            />
          }
        >
          {table()}
        </Show>
        <Show when={codes!.nextCursor}>
          {(after) => (
            <Bar
              end={
                <Button href={codeAreaHref({ sec: "code", status: query.status, app: query.app, q: query.q, after: after() })}>
                  {t().loadMore}
                </Button>
              }
            />
          )}
        </Show>
      </Show>
    </Pane>
  );

  return (
    <AdminWorkspace
      nav={props.nav}
      // a detail column only while an automation is open: no empty half (identity rule 5)
      detail={open ? 440 : undefined}
      detailEmpty={{ icon: "code", text: t().chooseCode }}
      head={<CodeHead section="code" />}
    >
      {open ? (
        <Pane.Split>
          {listPane()}
          {detailPane()}
        </Pane.Split>
      ) : (
        listPane()
      )}
    </AdminWorkspace>
  );
}
