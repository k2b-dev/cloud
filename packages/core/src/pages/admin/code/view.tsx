import { formatDateTime, formatRelative } from "@k2b/cloud/shared";
import type { DateContext } from "@k2b/stdlib";
import {
  AppWorkspace,
  ButtonLink,
  DataTable,
  IconButton,
  IconButtonLink,
  NoticeCard,
  Placeholder,
  StatCell,
  StatGrid,
  StatusBadge,
  type StatusTone,
  ViewTabs,
} from "@k2b/ui";
import { For, type JSX, Show } from "solid-js";
import type {
  CodeAdminApproval,
  CodeAdminApprovalDetail,
  CodeAdminCode,
  CodeAdminCodeDetail,
  CodeAdminCodeStatus,
  CodeAdminDecided,
  CodeAdminEffective,
  CodeAdminPolicy,
  CodeAdminPolicyChange,
  CodeAdminSummary,
} from "../../../code/admin";
import type { CodeOwner } from "../../../code/contracts";
import type { CodeCleanupJob } from "../../../code/lifecycle-contracts";
import type { CodeRunnerMetrics } from "../../../code/scheduling-contracts";
import CoreSettingsForm, { type SettingFieldDef } from "../settings/_components/CoreSettingsForm.island";
import { CODE_POLICY_ROW_GROUPS, type CodeAreaQuery, type CodeAreaSection, codeAreaHref, codeAreaLevel, isWideCodeSection } from "./area";
import CodeApprovalReview, { type CodeApprovalReviewProps } from "./CodeApprovalReview.island";
import CodeListFilters from "./CodeListFilters.island";
import CodePauseAction from "./CodePauseAction.island";
import CodePolicyEditor from "./CodePolicyEditor.island";
import CodePolicyPicker from "./CodePolicyPicker.island";
import type { CodeAdminMessages } from "./messages";

/** A part of the page: its data, a failed load, a selection that no longer exists, or not needed for this URL. */
export type Loaded<T> = T | "failed" | "missing" | null;
export type CodeAreaData = {
  summary: Loaded<CodeAdminSummary>;
  approvals: Loaded<{ items: CodeAdminApproval[]; nextCursor: string | null }>;
  decided: Loaded<CodeAdminDecided[]>;
  approval: Loaded<CodeAdminApprovalDetail>;
  codes: Loaded<{ items: CodeAdminCode[]; total: number; owners: number; nextCursor: string | null }>;
  code: Loaded<CodeAdminCodeDetail>;
  policy: Loaded<CodeAdminPolicy>;
  effective: Loaded<CodeAdminEffective>;
  history: Loaded<CodeAdminPolicyChange[]>;
  cleanup: Loaded<{ items: CodeCleanupJob[]; nextCursor: string | null }>;
  runners: Loaded<CodeRunnerMetrics>;
  limits: Loaded<SettingFieldDef[]>;
};
type Props = {
  t: CodeAdminMessages;
  locale: string;
  dateConfig: DateContext;
  query: CodeAreaQuery;
  data: CodeAreaData | null;
  noPermission: boolean;
  retryHref: string;
  appNames: Record<string, string>;
  documentationBase?: string;
};

const ok = <T,>(value: Loaded<T>): value is T => value !== null && value !== "failed" && value !== "missing";

const STATUS_TONE: Record<CodeAdminCodeStatus, StatusTone> = {
  active: "ok",
  waiting: "info",
  paused: "warning",
  draft: "neutral",
  deleting: "neutral",
};

const sectionIcon: Record<CodeAreaSection, string> = {
  approvals: "ti ti-inbox",
  code: "ti ti-code",
  policy: "ti ti-table-options",
  groups: "ti ti-users-group",
  effective: "ti ti-user-search",
  history: "ti ti-history",
  cleanup: "ti ti-recycle",
  limits: "ti ti-gauge",
  runners: "ti ti-server-2",
};

const ownerIcon = (owner: CodeOwner) => (owner.kind === "person" ? "ti ti-user" : owner.kind === "app" ? "ti ti-apps" : "ti ti-box");

export function ownerLabel(t: CodeAdminMessages, owner: CodeOwner, ownerName: string | null, appNames: Record<string, string>): string {
  if (owner.kind === "person") return t.ownerPerson({ who: ownerName ?? t.unknownAuthor });
  if (owner.kind === "app") return t.ownerApp({ app: appNames[owner.appId] ?? owner.appId });
  const appId = owner.ref.type.split(".")[0] ?? "";
  return `${appNames[appId] ?? appId} · ${owner.ref.id}`;
}

const statusText = (t: CodeAdminMessages, code: Pick<CodeAdminCode, "status" | "pauseReason">) =>
  code.status === "paused" && code.pauseReason === "policy_changed"
    ? t.pausedPolicy
    : code.status === "paused" && code.pauseReason === "owner_not_found"
      ? t.pausedOwner
      : t.statusLabel({ s: code.status });

/** Approval list text: line totals, the whole first version, or the file count when the summary budget ran out. */
export function approvalStat(t: CodeAdminMessages, item: CodeAdminApproval): string {
  if (item.stat.first) return t.linesNew({ n: item.stat.lines });
  if (item.stat.added === null || item.stat.removed === null) return t.filesChanged({ n: item.stat.files });
  return t.linesChanged({ add: item.stat.added, del: item.stat.removed });
}

/** Build the island props for one version under review. */
export function approvalReviewProps(
  t: CodeAdminMessages,
  detail: CodeAdminApprovalDetail,
  list: readonly CodeAdminApproval[],
  when: (iso: string) => string,
): CodeApprovalReviewProps {
  const who = detail.code.owner.kind === "person" ? (detail.ownerName ?? t.unknownAuthor) : (detail.version.author.name ?? t.unknownAuthor);
  const others = list.filter((item) => item.versionId !== detail.version.id);
  const index = list.findIndex((item) => item.versionId === detail.version.id);
  const next = (index >= 0 ? list.slice(index + 1).concat(list.slice(0, index)) : others)[0];
  return {
    number: detail.version.number,
    binding: detail.binding,
    status: detail.status,
    canApprove: detail.canApprove,
    own: detail.own,
    soleAdminNotice: detail.soleAdminNotice,
    staleComparison: detail.staleComparison,
    newer: detail.newer
      ? {
          number: detail.newer.number,
          author: detail.newer.author ?? t.unknownAuthor,
          href: codeAreaHref({ sec: "approvals", id: detail.newer.versionId }),
        }
      : null,
    why: detail.why.map((row) =>
      t.whyRow({
        label: t.rowLabel({ row: row.row }),
        who,
        source: row.source === "group" ? t.fromGroups({ groups: row.groups.join(", ") }) : t.fromDefault,
      }),
    ),
    rights: detail.permissions.map((permission) => {
      const typeTitle = permission.target ? (detail.titles.types[permission.target.type] ?? permission.target.type) : "";
      return {
        icon: permission.operation.includes(".") && detail.titles.operations[permission.operation] ? "ti ti-plug" : "ti ti-code",
        label: detail.titles.operations[permission.operation] ?? permission.operation,
        sub: [
          permission.operation,
          permission.target
            ? permission.target.id
              ? t.atTarget({ type: typeTitle, id: permission.target.id })
              : t.atDynamic({ type: typeTitle })
            : t.appWide,
        ].join(" · "),
        change: permission.change,
        file: permission.file,
        line: permission.line,
      };
    }),
    diffHeader: detail.comparison
      ? t.diffFrom({
          a: detail.comparison.number,
          b: detail.version.number,
          by: detail.comparison.decidedBy,
          when: detail.comparison.decidedAt ? when(detail.comparison.decidedAt) : null,
        })
      : t.diffFirst({ n: detail.version.number }),
    files: detail.files,
    decision: detail.decision
      ? {
          approved: detail.decision.approved,
          soleAdmin: detail.decision.soleAdmin,
          by: detail.decision.decidedByName ?? t.unknownAuthor,
          when: when(detail.decision.decidedAt),
        }
      : null,
    nextHref: next ? codeAreaHref({ sec: "approvals", id: next.versionId }) : null,
    internet: detail.internet,
    secrets: detail.secrets,
    codeHref: codeAreaHref({ sec: "code", id: detail.code.id }),
    listHref: codeAreaHref({ sec: "approvals" }),
  };
}

/** Administration › Code: area, list and detail levels on the shared workspace. */
export function CodeAreaView(props: Props) {
  const t = props.t;
  const query = props.query;
  const when = (iso: string) => formatDateTime(iso, props.dateConfig);
  const ago = (iso: string) => formatRelative(iso, props.dateConfig);
  const failure = (
    <Placeholder
      state="error"
      icon="ti ti-alert-triangle"
      title={t.loadFailTitle}
      description={t.loadFailSub}
      action={
        <ButtonLink variant="secondary" size="sm" href={props.retryHref}>
          <i class="ti ti-refresh" aria-hidden="true" />
          {t.retryLoad}
        </ButtonLink>
      }
    />
  );
  const missing = (title: string, back: CodeAreaQuery) => (
    <Placeholder
      icon="ti ti-search-off"
      title={title}
      action={
        <ButtonLink variant="secondary" size="sm" href={codeAreaHref(back)}>
          {t.backToList}
        </ButtonLink>
      }
    />
  );
  const hint = (icon: string, text: string) => <Placeholder icon={icon} description={text} />;
  /** The next page of a list; its URL holds the cursor, so reload keeps the page. */
  const moreLink = (cursor: string | null, href: (after: string) => string): JSX.Element =>
    cursor ? (
      <div class="px-2 py-2">
        <ButtonLink variant="secondary" size="sm" href={href(cursor)}>
          {t.more}
        </ButtonLink>
      </div>
    ) : undefined;

  if (props.noPermission || !props.data)
    return (
      <AppWorkspace.Main level="area">
        <AppWorkspace.MainPane id="area" label={t.area}>
          <Placeholder
            state="no-access"
            icon="ti ti-lock"
            title={t.nopermTitle}
            description={t.nopermSub}
            action={
              <ButtonLink variant="secondary" size="sm" href="/">
                {t.toStart}
              </ButtonLink>
            }
          />
        </AppWorkspace.MainPane>
      </AppWorkspace.Main>
    );
  const data = props.data;
  const summary = ok(data.summary) ? data.summary : null;

  // ---------- Column 1: the area ----------
  const item = (section: CodeAreaSection, label: string, extra: { meta?: JSX.Element; title?: string } = {}) => (
    <AppWorkspace.SidebarItem
      href={codeAreaHref({ sec: section })}
      active={query.sec === section}
      icon={sectionIcon[section]}
      meta={extra.meta}
      title={extra.title}
    >
      {label}
    </AppWorkspace.SidebarItem>
  );
  const count = (n: number | undefined) => (n ? <span class="text-xs text-(--k2b-text-muted) tabular-nums">{n}</span> : undefined);
  const areaColumn = (
    <>
      <AppWorkspace.SidebarSection>
        {item("approvals", t.approvals, {
          meta: summary?.approvals ? (
            <span class="inline-flex items-center gap-1.5">
              {count(summary.approvals)}
              <StatusBadge tone="warning" variant="dot" label="" title={t.waitingDot({ n: summary.approvals })} />
            </span>
          ) : undefined,
          title: summary?.approvals ? t.waitingDot({ n: summary.approvals }) : undefined,
        })}
        {item("code", t.allCode, { meta: count(summary?.codes) })}
      </AppWorkspace.SidebarSection>
      <AppWorkspace.SidebarSection title={t.policies}>
        {item("policy", t.standard)}
        {item("groups", t.groups, { meta: count(summary?.groups) })}
        {item("effective", t.effective)}
        {item("history", t.history)}
      </AppWorkspace.SidebarSection>
      <AppWorkspace.SidebarSection title={t.operations}>
        {item("cleanup", t.cleanup, { meta: count(summary?.cleanup) })}
        {item("limits", t.limits)}
        {item("runners", t.runners)}
      </AppWorkspace.SidebarSection>
    </>
  );

  // ---------- Approvals ----------
  const approvalsTabs = () => (
    <div class="px-2 pb-2">
      <ViewTabs
        label={t.approvals}
        current={query.tab === "decided" ? "decided" : "open"}
        items={[
          { id: "open", label: t.open, href: codeAreaHref({ sec: "approvals" }), count: summary?.approvals || undefined },
          { id: "decided", label: t.decided, href: codeAreaHref({ sec: "approvals", tab: "decided" }) },
        ]}
      />
    </div>
  );
  const approvalsList = (): JSX.Element => {
    if (query.tab === "decided") {
      const decided = data.decided;
      if (!ok(decided)) return failure;
      return (
        <>
          {approvalsTabs()}
          <Show when={decided.length} fallback={<Placeholder icon="ti ti-history" title={t.emptyDecided} />}>
            <AppWorkspace.SidebarSection>
              <For each={decided}>
                {(entry) => (
                  <AppWorkspace.SidebarItem
                    variant="object"
                    href={codeAreaHref({ sec: "approvals", tab: "decided", id: entry.versionId })}
                    active={query.id === entry.versionId}
                    description={`${t.versionRow({ n: entry.number })} · ${t.decidedBy({ who: entry.decidedBy ?? t.unknownAuthor, when: when(entry.decidedAt) })}`}
                    note={entry.soleAdmin ? t.selfApproved : undefined}
                    meta={
                      <StatusBadge
                        tone={entry.approved ? "ok" : "neutral"}
                        variant="text"
                        icon={entry.approved ? "ti ti-check" : "ti ti-x"}
                        label={entry.approved ? t.approvedState : t.rejectedState}
                      />
                    }
                  >
                    {entry.title}
                  </AppWorkspace.SidebarItem>
                )}
              </For>
            </AppWorkspace.SidebarSection>
          </Show>
        </>
      );
    }
    const page = data.approvals;
    if (!ok(page)) return failure;
    const approvals = page.items;
    if (!approvals.length && !query.after)
      return (
        <>
          {approvalsTabs()}
          <Placeholder
            icon="ti ti-inbox"
            title={t.emptyApprovals}
            description={t.emptyApprovalsSub}
            action={
              <ButtonLink variant="secondary" size="sm" href={codeAreaHref({ sec: "policy" })}>
                <i class="ti ti-table-options" aria-hidden="true" />
                {t.viewPolicy}
              </ButtonLink>
            }
          />
        </>
      );
    return (
      <>
        {approvalsTabs()}
        <AppWorkspace.SidebarSection>
          <For each={approvals}>
            {(entry) => (
              <AppWorkspace.SidebarItem
                variant="object"
                href={codeAreaHref({ sec: "approvals", id: entry.versionId, after: query.after })}
                active={query.id === entry.versionId}
                description={
                  entry.stat.first
                    ? `${t.firstApproval({ n: entry.number })} · ${entry.author.name ?? t.unknownAuthor}`
                    : t.versionBy({ n: entry.number, who: entry.author.name ?? t.unknownAuthor })
                }
                note={<span class="font-mono">{approvalStat(t, entry)}</span>}
                meta={
                  entry.rows[0] ? (
                    <StatusBadge tone="neutral" variant="chip" icon={null} label={t.rowLabel({ row: entry.rows[0] })} />
                  ) : undefined
                }
              >
                {entry.title}
              </AppWorkspace.SidebarItem>
            )}
          </For>
        </AppWorkspace.SidebarSection>
        {moreLink(page.nextCursor, (after) => codeAreaHref({ sec: "approvals", after }))}
      </>
    );
  };
  const approvalDetail = (): JSX.Element => {
    const detail = data.approval;
    if (detail === null) return hint("ti ti-git-compare", t.chooseVersion);
    if (detail === "missing") return missing(t.closedTitle, { sec: "approvals" });
    if (detail === "failed") return failure;
    const list = ok(data.approvals) ? data.approvals.items : [];
    return <CodeApprovalReview {...approvalReviewProps(t, detail, list, when)} />;
  };
  const approvalPosition = (): JSX.Element => {
    const list = ok(data.approvals) ? data.approvals.items : [];
    const index = list.findIndex((entry) => entry.versionId === query.id);
    if (index < 0 || query.tab === "decided") return undefined;
    const previous = list[index - 1];
    const next = list[index + 1];
    return (
      <span class="flex items-center gap-1">
        <span class="text-xs text-(--k2b-text-muted) tabular-nums">
          {t.xOfY({ i: index + 1, n: Math.max(list.length, summary?.approvals ?? 0) })}
        </span>
        <Show
          when={previous}
          fallback={
            <IconButton label={t.previous} size="sm" disabled>
              <i class="ti ti-chevron-up" aria-hidden="true" />
            </IconButton>
          }
        >
          {(entry) => (
            <IconButtonLink
              label={t.previous}
              size="sm"
              href={codeAreaHref({ sec: "approvals", id: entry().versionId, after: query.after })}
            >
              <i class="ti ti-chevron-up" aria-hidden="true" />
            </IconButtonLink>
          )}
        </Show>
        <Show
          when={next}
          fallback={
            <IconButton label={t.next} size="sm" disabled>
              <i class="ti ti-chevron-down" aria-hidden="true" />
            </IconButton>
          }
        >
          {(entry) => (
            <IconButtonLink label={t.next} size="sm" href={codeAreaHref({ sec: "approvals", id: entry().versionId, after: query.after })}>
              <i class="ti ti-chevron-down" aria-hidden="true" />
            </IconButtonLink>
          )}
        </Show>
      </span>
    );
  };

  // ---------- All Code ----------
  const appFilterOptions = () =>
    Object.entries(props.appNames)
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  const filtered = Boolean(query.status || query.app || query.q);
  const codeList = (): JSX.Element => {
    const codes = data.codes;
    if (!ok(codes)) return failure;
    if (!codes.items.length && !filtered && !query.after)
      return (
        <Placeholder
          icon="ti ti-code"
          title={t.emptyCode}
          description={t.emptyCodeSub}
          action={
            <ButtonLink variant="secondary" size="sm" href={codeAreaHref({ sec: "policy" })}>
              <i class="ti ti-table-options" aria-hidden="true" />
              {t.viewPolicy}
            </ButtonLink>
          }
        />
      );
    return (
      <>
        <CodeListFilters status={query.status} app={query.app} q={query.q} apps={appFilterOptions()} />
        <Show
          when={codes.items.length}
          fallback={
            <Placeholder
              icon="ti ti-filter-off"
              title={t.emptyFilter}
              action={
                <ButtonLink variant="secondary" size="sm" href={codeAreaHref({ sec: "code" })}>
                  {t.resetFilters}
                </ButtonLink>
              }
            />
          }
        >
          <AppWorkspace.SidebarSection>
            <For each={codes.items}>
              {(code) => (
                <AppWorkspace.SidebarItem
                  variant="object"
                  href={codeAreaHref({ sec: "code", id: code.id, status: query.status, app: query.app, q: query.q, after: query.after })}
                  active={query.id === code.id}
                  description={
                    <span class="inline-flex items-center gap-1.5">
                      <StatusBadge tone={STATUS_TONE[code.status]} variant="dot" label="" class="shrink-0" />
                      {`${ownerLabel(t, code.owner, code.ownerName, props.appNames)} · ${statusText(t, code)}`}
                    </span>
                  }
                  note={code.lastRun ? t.lastRun({ when: ago(code.lastRun.at) }) : t.neverRun}
                >
                  <AppWorkspace.SidebarItemIcon icon={ownerIcon(code.owner)} />
                  <AppWorkspace.SidebarItemLabel>{code.title}</AppWorkspace.SidebarItemLabel>
                </AppWorkspace.SidebarItem>
              )}
            </For>
          </AppWorkspace.SidebarSection>
          {moreLink(codes.nextCursor, (after) => codeAreaHref({ sec: "code", status: query.status, app: query.app, q: query.q, after }))}
        </Show>
      </>
    );
  };
  const codeDetail = (): JSX.Element => {
    const detail = data.code;
    if (detail === null) return hint("ti ti-code", t.chooseCode);
    if (detail === "missing") return missing(t.codeMissing, { sec: "code" });
    if (detail === "failed") return failure;
    const code = detail.code;
    return (
      <div class="grid content-start gap-6 px-2 pt-1 pb-6">
        <Show when={detail.pendingVersionId}>
          {(versionId) => (
            <NoticeCard
              tone="info"
              icon="ti ti-hourglass"
              title={t.statusLabel({ s: "waiting" })}
              detail={
                <div class="mt-1">
                  <ButtonLink size="sm" variant="secondary" href={codeAreaHref({ sec: "approvals", id: versionId() })}>
                    {t.openApproval}
                  </ButtonLink>
                </div>
              }
            />
          )}
        </Show>
        <dl class="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm">
          <dt class="text-(--k2b-text-muted)">{t.owner}</dt>
          <dd>{ownerLabel(t, code.owner, code.ownerName, props.appNames)}</dd>
          <dt class="text-(--k2b-text-muted)">{t.status}</dt>
          <dd class="inline-flex items-center gap-1.5">
            <StatusBadge tone={STATUS_TONE[code.status]} variant="dot" label="" />
            {statusText(t, code)}
          </dd>
          <dt class="text-(--k2b-text-muted)">{t.activeVersion}</dt>
          <dd>{code.activeVersionNumber ? t.versionRow({ n: code.activeVersionNumber }) : t.none}</dd>
          <dt class="text-(--k2b-text-muted)">{t.createdAt}</dt>
          <dd>{when(code.createdAt)}</dd>
          <dt class="text-(--k2b-text-muted)">ID</dt>
          <dd class="font-mono text-xs">{code.id}</dd>
        </dl>
        <Show when={code.activeVersionNumber !== null && (code.state === "active" || code.state === "paused")}>
          <CodePauseAction codeId={code.id} title={code.title} paused={code.state === "paused"} />
        </Show>
        <section class="grid gap-2" aria-labelledby="code-detail-versions">
          <h3 id="code-detail-versions" class="text-base font-semibold">
            {t.versions}
          </h3>
          <Show when={detail.versions.length} fallback={<p class="text-sm text-(--k2b-text-muted)">{t.noVersions}</p>}>
            <ul class="grid gap-1 text-sm">
              <For each={detail.versions}>
                {(entry) => (
                  <li class="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span class="font-medium">{t.versionRow({ n: entry.version.number })}</span>
                    <span class="text-(--k2b-text-muted)">
                      {entry.decision?.soleAdmin ? t.selfApproved : t.versionStatus({ s: entry.status })}
                      {entry.decision ? ` · ${when(entry.decision.decidedAt)}` : ` · ${when(entry.version.createdAt)}`}
                    </span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>
        <section class="grid gap-2" aria-labelledby="code-detail-runs">
          <h3 id="code-detail-runs" class="text-base font-semibold">
            {t.runs}
          </h3>
          <Show when={detail.runs.length} fallback={<p class="text-sm text-(--k2b-text-muted)">{t.noRuns}</p>}>
            <ul class="grid gap-1 text-sm">
              <For each={detail.runs}>
                {(run) => (
                  <li class="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span>
                      {t.runState({ s: run.state })} · {t.trigger({ t: run.trigger })} <code class="text-xs">{run.entrypoint}</code>
                    </span>
                    <span class="text-(--k2b-text-muted)">{when(run.createdAt)}</span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>
        <Show when={detail.cleanup.length}>
          <section class="grid gap-2" aria-labelledby="code-detail-cleanup">
            <h3 id="code-detail-cleanup" class="text-base font-semibold">
              {t.cleanup}
            </h3>
            {cleanupTable(detail.cleanup)}
          </section>
        </Show>
      </div>
    );
  };

  // ---------- Policy, groups, effective ----------
  const policy = ok(data.policy) ? data.policy : null;
  const pausedHref = codeAreaHref({ sec: "code", status: "paused" });
  const policyHead = (): string => {
    if (!policy) return t.appliesToAll;
    const who = policy.updatedByName;
    return who ? `${t.appliesToAll} · ${t.lastChange({ who, when: when(policy.policy.updatedAt) })}` : t.appliesToAll;
  };
  const policyStandard = (): JSX.Element => {
    if (!policy) return failure;
    return (
      <div class="grid min-h-full grid-rows-[auto_1fr]">
        <p class="px-2 pb-2 text-sm text-(--k2b-text-muted)">{t.policyLead}</p>
        <CodePolicyEditor
          revision={policy.policy.revision}
          definition={policy.policy.definition}
          groupId={null}
          usage={policy.usage}
          pausedHref={pausedHref}
        />
      </div>
    );
  };
  const selectedGroupName = (): string | null => {
    if (!policy || !query.id) return null;
    return policy.groups.find((group) => group.id === query.id)?.name ?? null;
  };
  const groupsList = (): JSX.Element => {
    if (!policy) return failure;
    return (
      <>
        <div class="px-2 pb-2">
          <CodePolicyPicker kind="group" existing={policy.groups.map((group) => group.id)} />
        </div>
        <Show
          when={policy.groups.length}
          fallback={<Placeholder icon="ti ti-users-group" title={t.noGroups} description={t.noGroupsSub} />}
        >
          <AppWorkspace.SidebarSection>
            <For each={policy.groups}>
              {(group) => (
                <AppWorkspace.SidebarItem
                  variant="object"
                  href={codeAreaHref({ sec: "groups", id: group.id })}
                  active={query.id === group.id}
                  description={[
                    t.groupRules({ rules: group.rules, members: group.members }),
                    ...group.parents.map((p) => t.subgroupOf({ p })),
                  ].join(" · ")}
                >
                  <AppWorkspace.SidebarItemIcon icon="ti ti-users" />
                  <AppWorkspace.SidebarItemLabel>{group.name}</AppWorkspace.SidebarItemLabel>
                </AppWorkspace.SidebarItem>
              )}
            </For>
          </AppWorkspace.SidebarSection>
        </Show>
      </>
    );
  };
  const groupDetail = (): JSX.Element => {
    if (!policy) return failure;
    if (!query.id) return hint("ti ti-users-group", t.chooseGroup);
    return (
      <div class="grid min-h-full grid-rows-[auto_1fr]">
        <p class="px-2 pb-2 text-sm text-(--k2b-text-muted)">{t.groupLead}</p>
        <CodePolicyEditor
          revision={policy.policy.revision}
          definition={policy.policy.definition}
          groupId={query.id}
          usage={policy.usage}
          pausedHref={pausedHref}
        />
      </div>
    );
  };
  const effectiveList = (): JSX.Element => (
    <div class="grid gap-3 px-2 pb-2">
      <CodePolicyPicker kind="person" existing={query.id ? [query.id] : []} />
      <Show when={ok(data.effective) ? data.effective : null}>
        {(effective) => (
          <AppWorkspace.SidebarSection>
            <AppWorkspace.SidebarItem
              variant="object"
              href={codeAreaHref({ sec: "effective", id: effective().person.id })}
              active
              description={effective()
                .groups.map((group) => group.name)
                .join(", ")}
            >
              <AppWorkspace.SidebarItemIcon icon="ti ti-user" />
              <AppWorkspace.SidebarItemLabel>{effective().person.name}</AppWorkspace.SidebarItemLabel>
            </AppWorkspace.SidebarItem>
          </AppWorkspace.SidebarSection>
        )}
      </Show>
    </div>
  );
  const effectiveDetail = (): JSX.Element => {
    const effective = data.effective;
    if (effective === null) return hint("ti ti-user-search", t.choosePerson);
    if (effective === "missing") return missing(t.personMissing, { sec: "effective" });
    if (effective === "failed") return failure;
    const byRow = new Map(effective.rows.map((row) => [row.row, row]));
    return (
      <div class="grid content-start gap-3 px-2 pt-1 pb-6">
        <p class="text-sm text-(--k2b-text-muted)">{t.effectiveLead}</p>
        <For each={CODE_POLICY_ROW_GROUPS}>
          {(group) => (
            <div class="grid gap-1">
              <span class="px-3 pt-3 pb-1 text-xs font-semibold text-(--k2b-text-muted)">{t[group.key]}</span>
              <For each={group.rows}>
                {(rowId) => {
                  const row = byRow.get(rowId);
                  if (!row) return null;
                  const groups = row.groups.join(", ");
                  const source =
                    row.source === "veto" ? t.sourceVeto({ groups }) : row.source === "group" ? t.sourceGroup({ groups }) : t.sourceDefault;
                  return (
                    <div class="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 px-3 py-2" data-row={row.row}>
                      <span class="min-w-0">
                        <span class="block text-sm font-semibold">{t.rowLabel({ row: row.row })}</span>
                        <span class="block text-xs text-(--k2b-text-muted)">{t.rowExample({ row: row.row })}</span>
                        <span class="mt-1 block text-xs text-(--k2b-text-muted)">
                          <i class={row.source === "default" ? "ti ti-world" : "ti ti-users"} aria-hidden="true" /> {source}
                          {row.source === "default" && effective.groups.length ? ` · ${t.noGroupRule}` : ""}
                        </span>
                      </span>
                      <StatusBadge
                        tone={row.value === "automatic" ? "ok" : row.value === "never" ? "error" : "neutral"}
                        variant="text"
                        icon={row.value === "automatic" ? "ti ti-circle-check" : row.value === "never" ? "ti ti-ban" : "ti ti-user-shield"}
                        label={t.value({ value: row.value })}
                      />
                    </div>
                  );
                }}
              </For>
            </div>
          )}
        </For>
      </div>
    );
  };

  const historySection = (): JSX.Element => {
    const entries = data.history;
    if (!ok(entries)) return failure;
    const value = (cell: CodeAdminPolicyChange["changes"][number]["before"]) => (cell ? t.value({ value: cell }) : t.unset);
    const presetLabel = (preset: string) =>
      ({ off: t.presetOff, admin: t.presetAdmin, open: t.presetOpen, custom: t.presetCustom })[preset] ?? preset;
    return (
      <div class="grid content-start gap-4 px-2 pt-1 pb-6">
        <Show when={entries.length} fallback={<Placeholder icon="ti ti-history" title={t.historyEmpty} description={t.historyEmptySub} />}>
          <ol class="grid gap-4">
            <For each={entries}>
              {(entry) => (
                <li class="grid gap-1">
                  <p class="text-sm">
                    <span class="font-semibold">{entry.by ?? t.unknownAuthor}</span>
                    <span class="text-(--k2b-text-muted)"> · {when(entry.at)}</span>
                  </p>
                  <ul class="grid gap-0.5 text-sm">
                    <Show when={entry.preset}>
                      {(preset) => <li>{t.historyPreset({ before: presetLabel(preset().before), after: presetLabel(preset().after) })}</li>}
                    </Show>
                    <For each={entry.changes}>
                      {(change) => (
                        <li>
                          {t.historyRow({ row: t.rowLabel({ row: change.row }), group: change.group })}:{" "}
                          <span class="text-(--k2b-text-muted)">{value(change.before)}</span> → {value(change.after)}
                        </li>
                      )}
                    </For>
                  </ul>
                </li>
              )}
            </For>
          </ol>
        </Show>
      </div>
    );
  };

  // ---------- Operations ----------
  function cleanupTable(jobs: readonly CodeCleanupJob[]): JSX.Element {
    return (
      <DataTable
        ariaLabel={t.cleanup}
        rows={jobs}
        getRowId={(row) => row.id}
        hoverRows={false}
        columns={[
          { id: "job", header: t.job },
          { id: "code", header: t.code },
          { id: "state", header: t.state },
          { id: "retry", header: t.retry },
        ]}
        renderCell={({ row, col }) => {
          if (col.id === "job")
            return (
              <div class="min-w-0">
                <p class="text-sm font-medium">{row.kind === "code.access.rm" ? t.jobRemove : t.jobDelete}</p>
                <Show when={row.target}>
                  {(target) => (
                    <p class="text-xs text-(--k2b-text-muted)">{t.atTargetPlain({ target: `${target().type} ${target().id}` })}</p>
                  )}
                </Show>
              </div>
            );
          if (col.id === "code")
            return (
              <div class="min-w-0">
                <p class="text-sm">{row.title}</p>
                <p class="font-mono text-xs text-(--k2b-text-muted)">{row.codeId}</p>
              </div>
            );
          if (col.id === "state")
            return (
              <StatusBadge
                tone={row.state === "running" ? "running" : row.state === "waiting" ? "warning" : "neutral"}
                variant="text"
                label={t.jobState({ s: row.state })}
              />
            );
          return (
            <div class="text-xs text-(--k2b-text-muted)">
              <p>
                {t.attempts({ n: row.attempts })} · {t.nextAttempt({ when: when(row.nextAttemptAt) })}
              </p>
              <Show when={row.lastError}>{(code) => <p class="font-mono">{t.lastError({ code: code() })}</p>}</Show>
            </div>
          );
        }}
      />
    );
  }
  const cleanupSection = (): JSX.Element => {
    const page = data.cleanup;
    if (!ok(page)) return failure;
    const jobs = page.items;
    return (
      <div class="grid content-start gap-4 px-2 pt-1 pb-6">
        <p class="text-sm text-(--k2b-text-muted)">{t.cleanupLead}</p>
        <Show
          when={jobs.length || query.after}
          fallback={<Placeholder icon="ti ti-recycle" title={t.emptyCleanup} description={t.emptyCleanupSub} />}
        >
          {cleanupTable(jobs)}
          {moreLink(page.nextCursor, (after) => codeAreaHref({ sec: "cleanup", after }))}
        </Show>
      </div>
    );
  };
  const waitText = (ms: number) => (ms < 60_000 ? t.seconds({ n: Math.round(ms / 1000) }) : t.minutes({ n: Math.round(ms / 60_000) }));
  // Replaceable: the decision lane delivers a dedicated runner view later; this section only presents CodeRunnerMetrics.
  const runnersSection = (): JSX.Element => {
    const metrics = data.runners;
    if (!ok(metrics)) return failure;
    return (
      <div class="grid content-start gap-4 px-2 pt-1 pb-6" data-section="code-runners">
        <p class="text-sm text-(--k2b-text-muted)">{t.runnersLead}</p>
        <StatGrid columns={5} size="sm">
          <StatCell label={t.instances} value={metrics.instances} />
          <StatCell label={t.freeSlots} value={metrics.freeSlots} />
          <StatCell label={t.queue} value={metrics.queued} />
          <StatCell label={t.running} value={metrics.running} />
          <StatCell label={t.waitTime} value={waitText(metrics.oldestWaitingMs)} />
        </StatGrid>
        <Show
          when={metrics.runners.length}
          fallback={<Placeholder icon="ti ti-server-off" title={t.noRunners} description={t.noRunnersSub} />}
        >
          <DataTable
            ariaLabel={t.runners}
            rows={metrics.runners}
            getRowId={(row) => row.instanceId}
            hoverRows={false}
            columns={[
              { id: "instance", header: t.instance },
              { id: "slots", header: t.freeSlots, align: "right" },
              { id: "seen", header: t.lastSeen },
            ]}
            renderCell={({ row, col }) =>
              col.id === "instance" ? (
                <span class="font-mono text-xs">{row.instanceId}</span>
              ) : col.id === "slots" ? (
                <span class="tabular-nums">{row.freeSlots}</span>
              ) : (
                <span class="text-sm text-(--k2b-text-muted)">{ago(row.lastSeenAt)}</span>
              )
            }
          />
        </Show>
      </div>
    );
  };
  const limitsSection = (): JSX.Element => {
    const entries = data.limits;
    if (!ok(entries)) return failure;
    return (
      <div class="grid content-start gap-2 pt-1 pb-6">
        <p class="px-2 text-sm text-(--k2b-text-muted)">{t.limitsLead}</p>
        <CoreSettingsForm
          documentationBase={props.documentationBase}
          documentationTopic="code-limits"
          title={t.limits}
          subtitle=""
          icon="ti ti-gauge"
          entries={entries}
          embedded
        />
      </div>
    );
  };

  // ---------- Composition ----------
  const section = query.sec;
  const level = codeAreaLevel(query);
  const sectionLabel = section
    ? {
        approvals: t.approvals,
        code: t.allCode,
        policy: t.standard,
        groups: t.groups,
        effective: t.effective,
        history: t.history,
        cleanup: t.cleanup,
        limits: t.limits,
        runners: t.runners,
      }[section]
    : t.area;
  const sectionDescription = (): string | undefined => {
    if (section === "approvals") return summary?.approvals ? t.nWaiting({ n: summary.approvals }) : t.nothingOpen;
    if (section === "code")
      return ok(data.codes) ? (data.codes.total ? t.allSub({ n: data.codes.total, p: data.codes.owners }) : t.noneYet) : undefined;
    if (section === "policy") return policyHead();
    if (section === "groups") return policy ? t.groupsSub({ n: policy.groups.length }) : undefined;
    if (section === "effective") return t.effectiveSub;
    if (section === "history") return t.historySub;
    if (section === "cleanup") return summary ? t.cleanupSub({ n: summary.cleanup }) : undefined;
    if (section === "limits") return t.limitsSub;
    if (section === "runners") return t.runnersSub;
    return undefined;
  };
  const wideContent = (): JSX.Element =>
    section === "policy"
      ? policyStandard()
      : section === "history"
        ? historySection()
        : section === "cleanup"
          ? cleanupSection()
          : section === "runners"
            ? runnersSection()
            : limitsSection();
  const secondColumn = (): JSX.Element =>
    section === "approvals"
      ? approvalsList()
      : section === "code"
        ? codeList()
        : section === "groups"
          ? groupsList()
          : section === "effective"
            ? effectiveList()
            : hint("ti ti-code", t.areaSub);
  const detailColumn = (): JSX.Element =>
    section === "approvals"
      ? approvalDetail()
      : section === "code"
        ? codeDetail()
        : section === "groups"
          ? groupDetail()
          : section === "effective"
            ? effectiveDetail()
            : hint("ti ti-code", t.areaSub);
  const detailLabel = (): string => {
    if (section === "approvals" && ok(data.approval))
      return t.versionTitle({ title: data.approval.code.title, n: data.approval.version.number });
    if (section === "code" && ok(data.code)) return data.code.code.title;
    if (section === "groups") return selectedGroupName() ?? t.groups;
    if (section === "effective" && ok(data.effective)) return data.effective.person.name;
    return sectionLabel;
  };
  const detailDescription = (): string | undefined => {
    if (section === "approvals" && ok(data.approval)) {
      const detail = data.approval;
      const parts = [
        t.submittedBy({ who: detail.version.author.name ?? t.unknownAuthor, when: when(detail.version.submittedAt) }),
        ownerLabel(t, detail.code.owner, detail.ownerName, props.appNames),
      ];
      return detail.comparison ? parts.join(" · ") : `${parts.join(" · ")} · ${t.firstSub}`;
    }
    if (section === "code" && ok(data.code)) return ownerLabel(t, data.code.code.owner, data.code.code.ownerName, props.appNames);
    if (section === "groups" && query.id) return t.groupDeviates;
    if (section === "effective" && ok(data.effective))
      return data.effective.groups
        .map((group) => (group.parents.length ? `${group.name} (${t.subgroupOf({ p: group.parents.join(", ") })})` : group.name))
        .join(", ");
    return undefined;
  };

  return (
    <AppWorkspace.Main level={isWideCodeSection(section) ? (level === "area" ? "area" : "section") : level}>
      <AppWorkspace.MainPane
        id="area"
        label={t.area}
        description={t.areaSub}
        href={codeAreaHref({})}
        defaultSize={264}
        minSize={232}
        maxSize={360}
      >
        {ok(data.summary) || data.summary === null ? areaColumn : failure}
      </AppWorkspace.MainPane>
      {isWideCodeSection(section) ? (
        <AppWorkspace.MainPane
          id="section"
          label={sectionLabel}
          description={sectionDescription()}
          actions={
            section === "policy" ? (
              <ButtonLink variant="ghost" size="sm" href={codeAreaHref({ sec: "history" })}>
                <i class="ti ti-history" aria-hidden="true" />
                {t.history}
              </ButtonLink>
            ) : undefined
          }
        >
          {wideContent()}
        </AppWorkspace.MainPane>
      ) : (
        <>
          <AppWorkspace.MainPane
            id="section"
            label={sectionLabel}
            description={sectionDescription()}
            href={
              section ? codeAreaHref({ sec: section, tab: query.tab, status: query.status, app: query.app, q: query.q }) : codeAreaHref({})
            }
            defaultSize={320}
            minSize={280}
            maxSize={480}
          >
            {secondColumn()}
          </AppWorkspace.MainPane>
          <AppWorkspace.MainPane
            id="detail"
            label={detailLabel()}
            description={detailDescription()}
            actions={section === "approvals" ? approvalPosition() : undefined}
          >
            {detailColumn()}
          </AppWorkspace.MainPane>
        </>
      )}
    </AppWorkspace.Main>
  );
}
