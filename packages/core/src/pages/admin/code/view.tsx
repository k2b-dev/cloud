import { CloudAvatar } from "@k2b/cloud/account/ui";
import { FeatCodeMark } from "@k2b/cloud/code/ui";
import { formatDateTime, formatRelative } from "@k2b/cloud/shared";
import { codeRunName } from "@k2b/cloud/ssr/code-page/targets";
import type { DateContext } from "@k2b/stdlib";
import {
  AppWorkspace,
  ButtonLink,
  ChangeList,
  DataTable,
  DotStrip,
  type DotStripTone,
  IconButton,
  IconButtonLink,
  NoticeCard,
  Placeholder,
  Section,
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
import type { UnusedCodeDatabase } from "../../../code/database-retention";
import type { CodeCleanupJob } from "../../../code/lifecycle-contracts";
import type { CodeRunnerMetrics } from "../../../code/scheduling-contracts";
import CoreSettingsForm, { type SettingFieldDef } from "../settings/_components/CoreSettingsForm.island";
import { CODE_POLICY_ROW_GROUPS, type CodeAreaQuery, type CodeAreaSection, codeAreaHref, codeAreaLevel, isWideCodeSection } from "./area";
import CodeAccountHandle from "./CodeAccountHandle.island";
import CodeApprovalReview, { type CodeApprovalReviewProps, type CodeReviewTab } from "./CodeApprovalReview.island";
import CodeDatabaseControls from "./CodeDatabaseControls.island";
import CodeListFilters from "./CodeListFilters.island";
import CodePauseAction from "./CodePauseAction.island";
import CodePolicyEditor from "./CodePolicyEditor.island";
import CodePolicyPicker from "./CodePolicyPicker.island";
import CodeRefusal from "./CodeRefusal.island";
import CodeUnusedDatabases from "./CodeUnusedDatabases.island";
import type { CodeAdminMessages } from "./messages";
import { type CodeReviewMessages, codeReviewMessages } from "./review-messages";

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
  databases?: Loaded<{ items: UnusedCodeDatabase[]; nextCursor: string | null }>;
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
  /** The reading admin, for "You" and for deleting own comments. */
  viewerId?: string;
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
  databases: "ti ti-database",
  limits: "ti ti-gauge",
  runners: "ti ti-server-2",
};

/** The sign of the policy row that asks for an admin, beside its name in the list. */
const reasonIcon = (row: string): string =>
  row === "silent_shared"
    ? "ti ti-eye"
    : row === "internet"
      ? "ti ti-world"
      : row === "ai"
        ? "ti ti-sparkles"
        : row === "public_routes"
          ? "ti ti-world-www"
          : row === "silent_draft"
            ? "ti ti-pencil"
            : row === "silent_you"
              ? "ti ti-user"
              : row === "read"
                ? "ti ti-book"
                : "ti ti-lock";

const ownerIcon = (owner: CodeOwner) => (owner.kind === "person" ? "ti ti-user" : owner.kind === "app" ? "ti ti-apps" : "ti ti-box");

export function ownerLabel(t: CodeAdminMessages, owner: CodeOwner, ownerName: string | null, appNames: Record<string, string>): string {
  if (owner.kind === "person") return t.ownerPerson({ who: ownerName ?? t.unknownAuthor });
  if (owner.kind === "app") return t.ownerApp({ app: appNames[owner.appId] ?? owner.appId });
  const appId = owner.ref.type.split(".")[0] ?? "";
  // The place's own name when its reader let this admin read it; otherwise only its kind, never its identifier.
  return ownerName ?? t.ownerHidden({ app: appNames[appId] ?? t.ownerUnknown });
}

const statusText = (t: CodeAdminMessages, code: Pick<CodeAdminCode, "status" | "pauseReason">) =>
  code.status === "paused" && code.pauseReason === "policy_changed"
    ? t.pausedPolicy
    : code.status === "paused" && code.pauseReason === "owner_not_found"
      ? t.pausedOwner
      : t.statusLabel({ s: code.status });

/** Why an admin is asked, in words: what the strictest rows let it do, and which policy says so. */
export function approvalReason(r: CodeReviewMessages, detail: CodeAdminApprovalDetail): string {
  if (!detail.why.length) return r.reasonNone;
  const rows = [...new Set(detail.why.map((row) => r.rowReason({ row: row.row })))].join(" ");
  const groups = [...new Set(detail.why.flatMap((row) => (row.source === "default" ? [] : row.groups)))];
  return r.reason({ rows, policy: groups.length ? r.policyGroups({ groups: groups.join(", ") }) : r.policyDefault });
}

/** Build the island props for one version under review. */
export function approvalReviewProps(
  t: CodeAdminMessages,
  r: CodeReviewMessages,
  detail: CodeAdminApprovalDetail,
  list: readonly CodeAdminApproval[],
  options: { tab: CodeReviewTab; viewerId: string; dateConfig: DateContext },
): CodeApprovalReviewProps {
  const index = list.findIndex((item) => item.versionId === detail.version.id);
  const others = list.filter((item) => item.versionId !== detail.version.id);
  const next = (index >= 0 ? list.slice(index + 1).concat(list.slice(0, index)) : others)[0];
  const origin = detail.origin;
  return {
    codeId: detail.code.id,
    versionId: detail.version.id,
    number: detail.version.number,
    title: detail.code.title,
    viewerId: options.viewerId,
    dateConfig: options.dateConfig,
    tab: options.tab,
    authorUserId: detail.version.author.id,
    recipient: detail.version.author.name ?? t.unknownAuthor,
    next: origin?.kind === "ai_chat" ? (origin.automaticAfterReview ? "button" : "chat") : "cli",
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
    reason: approvalReason(r, detail),
    readModel: detail.readModel ?? null,
    explanation: detail.explanation,
    activeVersion: detail.activeVersion?.number ?? null,
    comparison: detail.comparison?.number ?? null,
    files: detail.files,
    decision: detail.decision
      ? {
          outcome: detail.decision.outcome,
          comment: detail.decision.comment ?? null,
          by: detail.decision.decidedByName ?? t.unknownAuthor,
          byId: detail.decision.decidedBy ?? null,
          at: detail.decision.decidedAt,
        }
      : null,
    previous: detail.previousChangesRequest
      ? {
          number: detail.previousChangesRequest.number,
          message: detail.previousChangesRequest.message,
          comments: detail.previousChangesRequest.comments,
        }
      : null,
    comments: detail.comments?.items ?? [],
    commentsNext: detail.comments?.nextBefore ?? null,
    commentsTotal: detail.comments?.total ?? 0,
    listHref: codeAreaHref(detail.status === "pending" ? { sec: "approvals" } : { sec: "approvals", tab: "decided" }),
    nextHref: next ? codeAreaHref({ sec: "approvals", id: next.versionId }) : null,
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
        <AppWorkspace.MainPane id="area" label={t.area} lead={<FeatCodeMark variant="glyph" decorative />}>
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
    <AppWorkspace.SidebarItem href={codeAreaHref({ sec: section })} active={query.sec === section} meta={extra.meta} title={extra.title}>
      {/* The list of all Code carries the feat/code sign; the other sections keep their own icons. */}
      {section === "code" ? (
        <AppWorkspace.SidebarItemIcon>
          <FeatCodeMark variant="glyph" tone="current" decorative />
        </AppWorkspace.SidebarItemIcon>
      ) : (
        <AppWorkspace.SidebarItemIcon icon={sectionIcon[section]} />
      )}
      <AppWorkspace.SidebarItemLabel>{label}</AppWorkspace.SidebarItemLabel>
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
        {item("databases", t.unusedDatabases)}
        {item("cleanup", t.cleanup, { meta: count(summary?.cleanup) })}
        {item("limits", t.limits)}
        {item("runners", t.runners)}
      </AppWorkspace.SidebarSection>
    </>
  );

  // ---------- Approvals ----------
  const r = codeReviewMessages.resolve([props.locale]).t;
  const approvalsTabs = () => (
    <ViewTabs
      label={t.approvals}
      current={query.tab === "decided" ? "decided" : "open"}
      items={[
        {
          id: "open",
          label: r.tabOpen,
          href: codeAreaHref({ sec: "approvals" }),
          count: summary?.approvals ?? 0,
          countReserve: "99",
        },
        { id: "decided", label: r.tabDecided, href: codeAreaHref({ sec: "approvals", tab: "decided" }) },
      ]}
    />
  );
  const personAvatar = (person: { id: string | null; name: string | null; avatarHash?: string | null }) => (
    <CloudAvatar username={person.name ?? t.unknownAuthor} userId={person.id} avatarHash={person.avatarHash ?? null} size="sm" />
  );
  /** One row of the list: what, who submitted it, whom it belongs to, the main change, why you are asked, when. */
  const approvalRow = (entry: {
    href: string;
    title: string;
    version: string;
    author: { id: string | null; name: string | null; avatarHash?: string | null };
    owner?: CodeOwner;
    ownerName?: string | null;
    change?: string;
    tag: JSX.Element;
    when: string;
  }) => (
    <li>
      <a class="core-code-approvals__row" href={entry.href}>
        {personAvatar(entry.author)}
        <span class="core-code-approvals__what">
          <span class="core-code-approvals__title">
            <strong>{entry.title}</strong>
            <span class="core-code-approvals__version">{entry.version}</span>
          </span>
          <span class="core-code-approvals__who">
            <span>{entry.author.name ?? t.unknownAuthor}</span>
            <Show when={entry.owner}>
              {(owner) => (
                <span class="core-code-approvals__owner">
                  <i class={ownerIcon(owner())} aria-hidden="true" />
                  <span class="k2b-truncate-fade">
                    {owner().kind === "person"
                      ? r.ownerPersonal({ who: ownerLabel(t, owner(), entry.ownerName ?? null, props.appNames) })
                      : ownerLabel(t, owner(), entry.ownerName ?? null, props.appNames)}
                  </span>
                </span>
              )}
            </Show>
          </span>
        </span>
        <span class="core-code-approvals__change">
          <Show when={entry.change}>
            {(change) => (
              <span class="core-code-approvals__main">
                <i class="ti ti-plus" aria-hidden="true" />
                <span>{change()}</span>
              </span>
            )}
          </Show>
          <span class="core-code-approvals__tag">{entry.tag}</span>
        </span>
        <span class="core-code-approvals__when">{entry.when}</span>
        <i class="ti ti-chevron-right core-code-approvals__go" aria-hidden="true" />
      </a>
    </li>
  );
  const approvalsList = (): JSX.Element => {
    if (query.tab === "decided") {
      const decided = data.decided;
      if (!ok(decided)) return failure;
      return (
        <div class="core-code-approvals">
          {approvalsTabs()}
          <Show when={decided.length} fallback={<Placeholder icon="ti ti-history" title={r.emptyDecided} />}>
            <Section frame="line" title={t.decided} class="core-code-approvals__frame">
              <ul class="core-code-approvals__list">
                <For each={decided}>
                  {(entry) => {
                    const who = entry.mine ? r.you : (entry.decidedBy ?? t.unknownAuthor);
                    return approvalRow({
                      href: codeAreaHref({ sec: "approvals", id: entry.versionId }),
                      title: entry.title,
                      version: r.version({ n: entry.number }),
                      author: entry.author,
                      owner: entry.owner,
                      ownerName: entry.ownerName,
                      tag:
                        entry.outcome === "approved" ? (
                          <StatusBadge tone="ok" variant="chip" icon="ti ti-check" label={r.approvedBy({ who })} />
                        ) : entry.outcome === "changes_requested" ? (
                          <StatusBadge tone="warning" variant="chip" icon="ti ti-message-2" label={r.changesBy({ who })} />
                        ) : (
                          <StatusBadge tone="neutral" variant="chip" icon="ti ti-x" label={r.rejectedBy({ who })} />
                        ),
                      when: when(entry.decidedAt),
                    });
                  }}
                </For>
              </ul>
            </Section>
          </Show>
        </div>
      );
    }
    const page = data.approvals;
    if (!ok(page)) return failure;
    const approvals = page.items;
    return (
      <div class="core-code-approvals">
        {approvalsTabs()}
        <Show
          when={approvals.length || query.after}
          fallback={
            <Placeholder
              icon="ti ti-mood-check"
              title={r.emptyTitle}
              description={r.emptySub}
              action={
                <ButtonLink variant="secondary" size="sm" href={codeAreaHref({ sec: "policy" })}>
                  <i class="ti ti-table-options" aria-hidden="true" />
                  {t.viewPolicy}
                </ButtonLink>
              }
            />
          }
        >
          <Section frame="line" title={r.tabOpen} class="core-code-approvals__frame">
            <ul class="core-code-approvals__list">
              <For each={approvals}>
                {(entry) =>
                  approvalRow({
                    href: codeAreaHref({ sec: "approvals", id: entry.versionId, after: query.after }),
                    title: entry.title,
                    version: entry.stat.first ? r.versionFirst({ n: entry.number }) : r.version({ n: entry.number }),
                    author: entry.author,
                    owner: entry.owner,
                    ownerName: entry.ownerName,
                    change: entry.mainChange,
                    tag: entry.reason ? (
                      <StatusBadge
                        tone="neutral"
                        variant="chip"
                        icon={reasonIcon(entry.reason.row)}
                        label={t.rowLabel({ row: entry.reason.row })}
                      />
                    ) : (
                      <span />
                    ),
                    when: ago(entry.submittedAt),
                  })
                }
              </For>
            </ul>
            {moreLink(page.nextCursor, (after) => codeAreaHref({ sec: "approvals", after }))}
          </Section>
        </Show>
      </div>
    );
  };
  const approvalDetail = (): JSX.Element => {
    const detail = data.approval;
    if (detail === "missing") return missing(t.closedTitle, { sec: "approvals" });
    if (detail === "failed" || detail === null) return failure;
    const list = ok(data.approvals) ? data.approvals.items : [];
    const tab: CodeReviewTab = query.tab === "code" || query.tab === "diff" ? query.tab : "overview";
    return (
      <CodeApprovalReview
        {...approvalReviewProps(t, r, detail, list, { tab, viewerId: props.viewerId ?? "", dateConfig: props.dateConfig })}
      />
    );
  };
  const approvalPosition = (): JSX.Element => {
    const list = ok(data.approvals) ? data.approvals.items : [];
    const index = list.findIndex((entry) => entry.versionId === query.id);
    const detail = ok(data.approval) ? data.approval : null;
    const close = (
      <IconButtonLink
        label={r.close}
        size="sm"
        href={codeAreaHref(detail && detail.status !== "pending" ? { sec: "approvals", tab: "decided" } : { sec: "approvals" })}
      >
        <i class="ti ti-x" aria-hidden="true" />
      </IconButtonLink>
    );
    if (index < 0) return close;
    const previous = list[index - 1];
    const next = list[index + 1];
    const step = (entry: CodeAdminApproval | undefined, label: string, icon: string) =>
      entry ? (
        <IconButtonLink label={label} size="sm" href={codeAreaHref({ sec: "approvals", id: entry.versionId, after: query.after })}>
          <i class={icon} aria-hidden="true" />
        </IconButtonLink>
      ) : (
        <IconButton label={label} size="sm" disabled>
          <i class={icon} aria-hidden="true" />
        </IconButton>
      );
    return (
      <span class="core-code-approvals__position">
        <span class="core-code-approvals__count">{r.position({ i: index + 1, n: Math.max(list.length, summary?.approvals ?? 0) })}</span>
        {step(previous, r.previous, "ti ti-chevron-up")}
        {step(next, r.next, "ti ti-chevron-down")}
        {close}
      </span>
    );
  };
  const approvalHeadTitle = (): string =>
    ok(data.approval) ? r.headTitle({ title: data.approval.code.title, n: data.approval.version.number }) : r.listTitle;
  const approvalHeadSub = (): string | undefined => {
    if (!query.id) {
      if (query.tab === "decided") return r.listDecidedSub;
      return summary?.approvals ? r.listOpenSub({ n: summary.approvals }) : r.listNothingSub;
    }
    if (!ok(data.approval)) return undefined;
    const detail = data.approval;
    const owner = ownerLabel(t, detail.code.owner, detail.ownerName, props.appNames);
    const owned = detail.code.owner.kind === "person" ? r.ownerPersonal({ who: owner }) : owner;
    const values = { who: detail.version.author.name ?? t.unknownAuthor, when: ago(detail.version.submittedAt), owner: owned };
    return detail.origin?.kind === "ai_chat" ? r.headSubChat(values) : r.headSubCli(values);
  };
  const approvalLead = (): JSX.Element =>
    ok(data.approval) ? (
      <CloudAvatar
        username={data.approval.version.author.name ?? t.unknownAuthor}
        userId={data.approval.version.author.id}
        avatarHash={data.approval.authorAvatarHash ?? null}
        size="md"
      />
    ) : undefined;

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
    // Code of an app runs as its service account; this detail is its Code page (concept 14 W13).
    const account = code.owner.kind === "app" ? t.accountName({ app: props.appNames[code.owner.appId] ?? code.owner.appId }) : null;
    // Runs read as their automations do on the Code page; the own place by the name this admin may read, else type and ID.
    const ownerTitle = code.owner.kind === "resource" ? (code.ownerName ?? "") : "";
    const lastRun = detail.refusal ? detail.runs.find((run) => run.id === detail.refusal!.refusal.runId) : undefined;
    return (
      <div class="grid content-start gap-6 px-2 pt-1 pb-6">
        <Show when={account}>
          {(name) => (
            <p class="cloud-code__lead">
              {t.runsAsAccount({ name: name() })}
              <Show when={code.serviceAccountHandle}>
                {(handle) => (
                  <>
                    {" "}
                    <CodeAccountHandle handle={handle()} />
                  </>
                )}
              </Show>
            </p>
          )}
        </Show>
        <Show when={account ? detail.refusal : null}>
          {(shown) => (
            <section class="grid gap-2" aria-labelledby="code-detail-last-run">
              <h3 id="code-detail-last-run" class="flex flex-wrap items-baseline gap-x-2 text-base font-semibold">
                {t.lastRunTitle}
                <Show when={lastRun}>
                  {(run) => <span class="text-sm font-normal text-(--k2b-text-muted)">{when(run().createdAt)}</span>}
                </Show>
              </h3>
              <CodeRefusal
                refusal={shown().refusal}
                account={account!}
                handle={code.serviceAccountHandle}
                editor={shown().editor}
                cloudAdmin={true}
              />
            </section>
          )}
        </Show>
        <Show when={query.version}>
          {(versionId) => (
            <NoticeCard
              tone="info"
              icon="ti ti-arrow-forward-up"
              title={t.sourceMoved}
              detail={
                <div class="mt-1">
                  <ButtonLink size="sm" variant="secondary" href={codeAreaHref({ sec: "approvals", id: versionId(), tab: "code" })}>
                    {t.openReview}
                  </ButtonLink>
                </div>
              }
            />
          )}
        </Show>
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
        </dl>
        <Show when={detail.database}>
          {(database) => (
            <div class="text-sm">
              <CodeDatabaseControls
                codeId={code.id}
                database={{
                  ...database(),
                  canExport: true,
                  ...(database().unused ? { unused: { ...database().unused!, canDelete: true } } : {}),
                }}
              />
            </div>
          )}
        </Show>
        <div class="flex flex-wrap items-center gap-2">
          <Show when={code.activeVersionNumber !== null && (code.state === "active" || code.state === "paused")}>
            <CodePauseAction codeId={code.id} title={code.title} paused={code.state === "paused"} />
          </Show>
        </div>
        <section class="grid gap-2" aria-labelledby="code-detail-versions">
          <h3 id="code-detail-versions" class="text-base font-semibold">
            {t.versions}
          </h3>
          <Show when={detail.versions.length} fallback={<p class="text-sm text-(--k2b-text-muted)">{t.noVersions}</p>}>
            <ul class="grid gap-1 text-sm">
              <For each={detail.versions}>
                {(entry) => (
                  <li class="flex flex-wrap items-baseline justify-between gap-x-3">
                    <Show
                      when={entry.status !== "submitted"}
                      fallback={<span class="font-medium">{t.versionRow({ n: entry.version.number })}</span>}
                    >
                      <a class="k2b-text-link font-medium" href={codeAreaHref({ sec: "approvals", id: entry.version.id })}>
                        {t.versionRow({ n: entry.version.number })}
                      </a>
                    </Show>
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
                      {t.runState({ s: run.state })} · {t.trigger({ t: run.trigger })}{" "}
                      <span>{codeRunName(run, run.automation ? [run.automation] : null, ownerTitle, props.locale)}</span>
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
    if (!ok(entries))
      return (
        <Placeholder
          state="error"
          icon="ti ti-alert-triangle"
          title={t.historyFailed}
          description={t.historyFailedSub}
          action={
            <ButtonLink variant="secondary" size="sm" href={props.retryHref}>
              <i class="ti ti-refresh" aria-hidden="true" />
              {t.retryLoad}
            </ButtonLink>
          }
        />
      );
    const value = (cell: CodeAdminPolicyChange["changes"][number]["before"]) => (cell ? t.value({ value: cell }) : t.unset);
    const presetLabel = (preset: string) =>
      ({ off: t.presetOff, admin: t.presetAdmin, open: t.presetOpen, custom: t.presetCustom })[preset] ?? preset;
    const change = (label: string, before: string, after: string) => (
      <>
        {label}: <s class="core-code-history__was">{before}</s> <i class="ti ti-arrow-right" aria-hidden="true" /> <strong>{after}</strong>
      </>
    );
    return (
      <div class="grid content-start gap-4 px-2 pt-1 pb-6">
        <Show
          when={entries.length}
          fallback={<Placeholder icon="ti ti-history-off" title={t.historyEmpty} description={t.historyEmptySub} />}
        >
          <Section frame="line" title={t.history}>
            <ol class="core-code-history">
              <For each={entries}>
                {(entry) => (
                  <li class="core-code-history__entry">
                    <CloudAvatar username={entry.by ?? t.unknownAuthor} size="sm" />
                    <div class="core-code-history__body">
                      <p class="core-code-history__head">
                        <strong>{entry.by ?? t.unknownAuthor}</strong>
                        <span> · {when(entry.at)}</span>
                      </p>
                      <ChangeList
                        label={t.historyChangesLabel}
                        items={[
                          ...(entry.preset
                            ? [
                                {
                                  tone: "change" as const,
                                  content: change(t.presets, presetLabel(entry.preset.before), presetLabel(entry.preset.after)),
                                },
                              ]
                            : []),
                          ...entry.changes.map((item) => ({
                            tone: "change" as const,
                            content: change(
                              t.historyRow({ row: t.rowLabel({ row: item.row }), group: item.group }),
                              value(item.before),
                              value(item.after),
                            ),
                          })),
                        ]}
                      />
                    </div>
                  </li>
                )}
              </For>
            </ol>
          </Section>
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
                <p class="text-sm font-medium">{row.kind === "database.delete" ? t.jobDeleteDatabase : t.jobDelete}</p>
              </div>
            );
          if (col.id === "code")
            return (
              <div class="min-w-0">
                <p class="text-sm">{row.title}</p>
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
              <Show when={row.lastError}>
                <p>{t.lastErrorWorded}</p>
              </Show>
            </div>
          );
        }}
      />
    );
  }
  const databasesSection = (): JSX.Element => {
    const page = data.databases;
    if (!page || !ok(page)) return failure;
    return (
      <div class="grid content-start gap-4 px-2 pt-1 pb-6">
        <p class="text-sm text-(--k2b-text-muted)">{t.unusedDatabasesLead}</p>
        <Show when={page.items.length || query.after} fallback={<Placeholder icon="ti ti-database" title={t.noUnusedDatabases} />}>
          <CodeUnusedDatabases rows={page.items} dateConfig={props.dateConfig} />
          {moreLink(page.nextCursor, (after) => codeAreaHref({ sec: "databases", after }))}
        </Show>
      </div>
    );
  };
  const cleanupSection = (): JSX.Element => {
    const page = data.cleanup;
    if (!ok(page)) return failure;
    const jobs = page.items;
    return (
      <div class="grid content-start gap-4 px-2 pt-1 pb-6">
        <p class="text-sm text-(--k2b-text-muted)">{t.cleanupLead}</p>
        <p class="text-sm text-(--k2b-text-muted)">{t.cleanupAccessNote}</p>
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
  /** A large number with its words, as one line of figures; a warning colours both when the fleet falls behind. */
  const figure = (value: string, label: string, tone?: "warning" | "danger") => (
    <span class="core-code-runners__figure" data-tone={tone}>
      <strong>{value}</strong>
      <span>{label}</span>
    </span>
  );
  const runnersSection = (): JSX.Element => {
    const metrics = data.runners;
    if (!ok(metrics))
      return (
        <Placeholder
          state="error"
          icon="ti ti-alert-triangle"
          title={t.runnersFailed}
          description={t.runnersFailedSub}
          action={
            <ButtonLink variant="secondary" size="sm" href={props.retryHref}>
              <i class="ti ti-refresh" aria-hidden="true" />
              {t.retryLoad}
            </ButtonLink>
          }
        />
      );
    const slots = metrics.runners.reduce((sum, runner) => sum + runner.freeSlots + (runner.busySlots ?? 0), 0);
    const none = metrics.instances === 0;
    // The queue grows when nothing is free and runs wait.
    const behind = !none && metrics.freeSlots === 0 && metrics.queued > 0;
    const short = (id: string) => id.replace(/-/g, "").slice(0, 4);
    return (
      <div class="grid content-start gap-4 px-2 pt-1 pb-6" data-section="code-runners">
        <Show when={none}>
          <NoticeCard tone="danger" icon="ti ti-plug-off" title={t.noRunners} detail={t.noRunnersSub} />
        </Show>
        <Show when={behind}>
          <NoticeCard
            tone="warning"
            icon="ti ti-alert-triangle"
            title={t.queueGrows}
            detail={t.queueGrowsSub({ wait: waitText(metrics.oldestWaitingMs) })}
          />
        </Show>
        <Section frame="line" title={t.runnersNow}>
          <p class="core-code-runners__figures">
            {figure(String(metrics.instances), t.runnerUnit({ n: metrics.instances }), none ? "danger" : undefined)}
            <Show when={!none}>
              {figure(t.slotsOf({ free: metrics.freeSlots, total: slots }), t.slotsFree, behind ? "warning" : undefined)}
            </Show>
            {figure(
              String(metrics.queued),
              t.runsWaiting({ n: metrics.queued }),
              metrics.queued > 0 && (behind || none) ? "warning" : undefined,
            )}
            {figure(waitText(metrics.oldestWaitingMs), t.longestWait, behind || none ? "warning" : undefined)}
          </p>
        </Section>
        <Section frame="line" title={t.runners} count={metrics.runners.length}>
          <Show when={metrics.runners.length} fallback={<p class="core-code-runners__empty">{t.noRunnersList}</p>}>
            <ul class="core-code-runners__list">
              <For each={metrics.runners}>
                {(runner, index) => {
                  const busy = runner.busySlots ?? 0;
                  const total = busy + runner.freeSlots;
                  return (
                    <li class="core-code-runners__row">
                      <span class="core-code-runners__icon k2b-icon-tile">
                        <i class="ti ti-server-2" aria-hidden="true" />
                      </span>
                      <span class="core-code-runners__what">
                        <span>
                          <strong>{t.runnerName({ n: index() + 1 })}</strong>
                          <span class="core-code-runners__id"> · {short(runner.instanceId)}</span>
                        </span>
                        <span class="core-code-runners__slots">
                          <DotStrip
                            variant="slot"
                            dots={Array.from({ length: busy }, (): DotStripTone => "accent")}
                            length={total}
                            label={t.slotsBusy({ busy, total })}
                          />
                          <span>{t.slotsFreeOf({ free: runner.freeSlots, total })}</span>
                        </span>
                      </span>
                      <StatusBadge tone="ok" variant="text" icon="ti ti-circle-check" label={t.connected} />
                    </li>
                  );
                }}
              </For>
            </ul>
          </Show>
        </Section>
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
        databases: t.unusedDatabases,
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
    section === "approvals"
      ? query.id
        ? approvalDetail()
        : approvalsList()
      : section === "databases"
        ? databasesSection()
        : section === "policy"
          ? policyStandard()
          : section === "history"
            ? historySection()
            : section === "cleanup"
              ? cleanupSection()
              : section === "runners"
                ? runnersSection()
                : limitsSection();
  const secondColumn = (): JSX.Element =>
    section === "code"
      ? codeList()
      : section === "groups"
        ? groupsList()
        : section === "effective"
          ? effectiveList()
          : hint("ti ti-code", t.areaSub);
  const detailColumn = (): JSX.Element =>
    section === "code"
      ? codeDetail()
      : section === "groups"
        ? groupDetail()
        : section === "effective"
          ? effectiveDetail()
          : hint("ti ti-code", t.areaSub);
  const detailLabel = (): string => {
    if (section === "code" && ok(data.code)) return data.code.code.title;
    if (section === "groups") return selectedGroupName() ?? t.groups;
    if (section === "effective" && ok(data.effective)) return data.effective.person.name;
    return sectionLabel;
  };
  const detailDescription = (): string | undefined => {
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
        lead={<FeatCodeMark variant="glyph" decorative />}
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
          label={section === "approvals" ? approvalHeadTitle() : sectionLabel}
          description={section === "approvals" ? approvalHeadSub() : sectionDescription()}
          lead={section === "approvals" && query.id ? approvalLead() : undefined}
          actions={
            section === "approvals" && query.id ? (
              approvalPosition()
            ) : section === "policy" ? (
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
