import { formatRelative } from "@k2b/cloud/shared";
import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { Avatar, Bar, Button, Chip, Icon, Inline, Menu, Pane, StatusRow, Table, Tabs, Text, useLocale } from "@k2b/ui/v2";
import { type JSX, Show } from "solid-js";
import type { CodeAdminApproval, CodeAdminApprovalDetail, CodeAdminDecided, CodeAdminSummary } from "../../../code/admin";
import StateWord from "../_area/StateWord";
import { codeAreaHref } from "./area";
import { approvalReason, type CodeScreenBase, type Loaded, ok, ownerLabel } from "./data";
import { LoadFailed, Missing, useCodeText } from "./parts";
import {
  type CodeReviewProps,
  type CodeReviewTab,
  createCodeReview,
  ReviewBody,
  ReviewDialog,
  reviewHeadActions,
  reviewMenu,
} from "./review";
import { type CodeReviewMessages, codeReviewMessages } from "./review-messages";

export type ApprovalsScreenProps = CodeScreenBase & {
  summary: Loaded<CodeAdminSummary>;
  approvals: Loaded<{ items: CodeAdminApproval[]; nextCursor: string | null }>;
  decided: Loaded<CodeAdminDecided[]>;
  approval: Loaded<CodeAdminApprovalDetail>;
};

/** The sign of the policy row that asks for an admin, before its name. */
const reasonIcon = (row: string): string =>
  ({
    silent_shared: "eye",
    internet: "world",
    ai: "sparkles",
    public_routes: "world-www",
    owner_data: "users",
    silent_draft: "pencil",
    silent_you: "user",
    read: "book",
  })[row] ?? "lock";

/** The review of one version, from the server's read model and the list it was opened from. */
export function reviewProps(
  base: Pick<CodeScreenBase, "apps" | "viewerId" | "dateConfig" | "query">,
  r: CodeReviewMessages,
  detail: CodeAdminApprovalDetail,
  list: readonly { versionId: string }[],
  unknownAuthor: string,
  owner: string,
): CodeReviewProps {
  const index = list.findIndex((item) => item.versionId === detail.version.id);
  const others = list.filter((item) => item.versionId !== detail.version.id);
  const next = (index >= 0 ? list.slice(index + 1).concat(list.slice(0, index)) : others)[0];
  const origin = detail.origin;
  const tab: CodeReviewTab = base.query.tab === "code" || base.query.tab === "diff" ? base.query.tab : "overview";
  const author = detail.version.author.name ?? unknownAuthor;
  const when = formatRelative(detail.version.submittedAt, base.dateConfig);
  const owned = detail.code.owner.kind === "person" ? r.ownerPersonal({ who: owner }) : owner;
  return {
    codeId: detail.code.id,
    versionId: detail.version.id,
    number: detail.version.number,
    title: detail.code.title,
    viewerId: base.viewerId,
    dateConfig: base.dateConfig,
    tab,
    authorUserId: detail.version.author.id,
    recipient: author,
    byline:
      origin?.kind === "ai_chat" ? r.headSubChat({ who: author, when, owner: owned }) : r.headSubCli({ who: author, when, owner: owned }),
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
          author: detail.newer.author ?? unknownAuthor,
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
          by: detail.decision.decidedByName ?? unknownAuthor,
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
    after: base.query.after,
  };
}

/**
 * Freigaben on v2, the hero of Code: how many versions wait, the waiting ones as a dense table (what, who, whose, what
 * it asks for, since when), and the open review beside it in the address with its views Overview, Code and Changes.
 * Decided versions are the second tab of the head.
 */
export default function ApprovalsScreen(props: ApprovalsScreenProps) {
  const t = useCodeText();
  const locale = useLocale();
  const rt = (): CodeReviewMessages => codeReviewMessages.resolve([locale()]).t;
  const query = props.query;
  const summary = ok(props.summary) ? props.summary : null;
  const ago = (iso: string) => formatRelative(iso, props.dateConfig);
  const detail = ok(props.approval) ? props.approval : null;
  // A decided review stands beside the decided list; an open one beside the waiting ones.
  const decidedList = query.tab === "decided" || (detail !== null && detail.status !== "pending");
  const waiting = ok(props.approvals) ? props.approvals.items : [];
  const decided = ok(props.decided) ? props.decided : [];
  const listOf = (): readonly { versionId: string }[] => (decidedList ? decided : waiting);
  const ownerOf = (entry: Pick<CodeAdminApproval, "owner" | "ownerName">) =>
    !entry.owner
      ? t().ownerUnknown
      : entry.owner.kind === "person"
        ? rt().ownerPersonal({ who: ownerLabel(t(), entry.owner, entry.ownerName ?? null, props.apps) })
        : ownerLabel(t(), entry.owner, entry.ownerName ?? null, props.apps);
  const review = detail
    ? createCodeReview(
        reviewProps(props, rt(), detail, listOf(), t().unknownAuthor, ownerLabel(t(), detail.code.owner, detail.ownerName, props.apps)),
      )
    : null;
  const listHref = () => codeAreaHref(decidedList ? { sec: "approvals", tab: "decided" } : { sec: "approvals", after: query.after });
  const open = Boolean(query.id);
  const position = () => {
    if (!detail) return null;
    const list = listOf();
    const index = list.findIndex((entry) => entry.versionId === detail.version.id);
    if (index < 0) return null;
    const at = (entry: { versionId: string } | undefined) =>
      entry ? codeAreaHref({ sec: "approvals", id: entry.versionId, after: query.after }) : null;
    return {
      index,
      total: decidedList ? list.length : Math.max(list.length, summary?.approvals ?? 0),
      previous: at(list[index - 1]),
      next: at(list[index + 1]),
    };
  };

  const waitingTable = () => (
    <Table
      label={t().approvals}
      rows={waiting}
      rowKey={(entry) => entry.versionId}
      current={query.id}
      open={(entry) => ({ href: codeAreaHref({ sec: "approvals", id: entry.versionId, after: query.after }) })}
      empty={{
        icon: "mood-check",
        text: rt().emptyTitle,
        action: { label: t().viewPolicy, icon: "table-options", href: codeAreaHref({ sec: "policy" }) },
      }}
      phone={(entry) => ({
        // slot for #4208/#4223 (DP): the automation's mark leads the phone row
        lines: [
          entry.title,
          [entry.author.name ?? t().unknownAuthor, entry.reason ? t().rowLabel({ row: entry.reason.row }) : null, ago(entry.submittedAt)]
            .filter(Boolean)
            .join(" · "),
        ],
      })}
      // the columns fit beside the admin bar at 1024; the last one takes what is left on a larger screen
      columns={[
        {
          title: t().automation,
          width: { min: 180, default: 260 },
          // slot for #4208/#4223 (DP): Column mark, the Code sign "code" in the colour of the app it belongs to (else CODE_COLOR)
          cell: (entry): JSX.Element => (
            <>
              {entry.title}{" "}
              <Text type="meta" muted>
                {entry.stat.first ? rt().versionFirst({ n: entry.number }) : rt().version({ n: entry.number })}
              </Text>
            </>
          ),
        },
        {
          title: t().submitter,
          width: { min: 120, default: 140 },
          drop: true,
          // slot for #4208/#4223 (DP): Column avatar of the submitter (it replaces the Avatar in the cell)
          cell: (entry) => (
            <Inline>
              <Avatar name={entry.author.name ?? t().unknownAuthor} decorative />
              {entry.author.name ?? t().unknownAuthor}
            </Inline>
          ),
        },
        ...(open
          ? []
          : [
              {
                title: t().belongsTo,
                width: { min: 120, default: 150 },
                drop: true,
                cell: (entry: CodeAdminApproval) => ownerOf(entry),
              },
            ]),
        {
          title: t().waitingSince,
          ...(open ? {} : { width: { min: 110, default: 130 } }),
          drop: true,
          cell: (entry: CodeAdminApproval) => ago(entry.submittedAt),
        },
        ...(open
          ? []
          : [
              {
                // what the version asks the admin for: the sign of its policy row and the change in words
                title: t().asksFor,
                drop: true,
                cell: (entry: CodeAdminApproval): JSX.Element => (
                  <Text>
                    <Icon
                      name={reasonIcon(entry.reason?.row ?? "")}
                      label={entry.reason ? t().rowLabel({ row: entry.reason.row }) : undefined}
                    />{" "}
                    {entry.mainChange ?? (entry.reason ? t().rowLabel({ row: entry.reason.row }) : "")}
                  </Text>
                ),
              },
            ]),
      ]}
    />
  );
  const outcome = (entry: CodeAdminDecided): JSX.Element => {
    const who = entry.mine ? rt().you : (entry.decidedBy ?? t().unknownAuthor);
    return entry.outcome === "approved" ? (
      <StateWord>{rt().approvedBy({ who })}</StateWord>
    ) : entry.outcome === "changes_requested" ? (
      <Chip status="warn">{rt().changesBy({ who })}</Chip>
    ) : (
      <StateWord muted>{rt().rejectedBy({ who })}</StateWord>
    );
  };
  const decidedTable = () => (
    <Table
      label={t().decided}
      rows={decided}
      rowKey={(entry) => entry.versionId}
      current={query.id}
      open={(entry) => ({ href: codeAreaHref({ sec: "approvals", id: entry.versionId }) })}
      empty={{ icon: "history", text: rt().emptyDecided }}
      phone={(entry) => ({
        // slot for #4208/#4223 (DP): the automation's mark leads the phone row
        lines: [entry.title, `${rt().version({ n: entry.number })} · ${ago(entry.decidedAt)}`],
        marks: entry.outcome === "changes_requested" ? <Chip status="warn">{rt().statusChanges}</Chip> : undefined,
      })}
      columns={[
        {
          title: t().automation,
          width: { min: 160, default: 200 },
          // slot for #4208/#4223 (DP): Column mark, the Code sign "code" in the colour of the app it belongs to (else CODE_COLOR)
          cell: (entry): JSX.Element => (
            <>
              {entry.title}{" "}
              <Text type="meta" muted>
                {rt().version({ n: entry.number })}
              </Text>
            </>
          ),
        },
        ...(open
          ? []
          : [
              {
                title: t().submitter,
                width: { min: 120, default: 140 },
                drop: true,
                // slot for #4208/#4223 (DP): Column avatar of the submitter (it replaces the Avatar in the cell)
                cell: (entry: CodeAdminDecided) => (
                  <Inline>
                    <Avatar name={entry.author.name ?? t().unknownAuthor} decorative />
                    {entry.author.name ?? t().unknownAuthor}
                  </Inline>
                ),
              },
            ]),
        { title: t().decision, width: { min: 180, default: 240 }, drop: true, cell: outcome },
        { title: t().decidedAt, drop: true, cell: (entry) => ago(entry.decidedAt) },
      ]}
    />
  );
  const oldest = () =>
    waiting.reduce<string | null>((first, entry) => (!first || entry.submittedAt < first ? entry.submittedAt : first), null);
  const lead = () => {
    if (decidedList) return t().decidedLead({ n: decided.length });
    const n = summary?.approvals ?? waiting.length;
    return n ? t().nWaiting({ n }) : t().nothingWaits;
  };
  const list = () => {
    const loaded = decidedList ? props.decided : props.approvals;
    if (!ok(loaded)) return <LoadFailed />;
    return decidedList ? decidedTable() : waitingTable();
  };
  const reviewPane = (): JSX.Element => {
    if (!query.id) return undefined;
    const back = { label: t().approvals, href: listHref() };
    if (!review)
      return (
        <Pane
          detail
          label={t().approvals}
          back={back}
          head={<Bar end={<Button variant="ghost" icon="x" label={rt().close} href={listHref()} />} />}
        >
          <Show when={props.approval === "missing"} fallback={<LoadFailed />}>
            <Missing text={t().closedTitle} back={{ sec: "approvals" }} />
          </Show>
        </Pane>
      );
    const p = review.props;
    return (
      <Pane
        detail
        label={rt().headTitle({ title: p.title, n: p.number })}
        back={back}
        scrollKey="admin-code-review"
        head={
          <Bar
            start={
              // slot for #4208/#4223 (DP): the tinted object head (ObjectHead, #4360) with the automation's mark; the name stands in
              <Text type="body" weight="strong">
                {p.title}
              </Text>
            }
            end={
              <>
                {reviewHeadActions(review)}
                <Show when={position()}>{(at) => <Menu label={rt().moreApprovals} items={reviewMenu(rt(), at())} />}</Show>
                <Button variant="ghost" icon="x" label={rt().close} href={p.listHref} />
              </>
            }
          />
        }
        // the views of the review as a bar of their own under the head, on the text edge
        status={<Bar start={<Tabs label={rt().tabsLabel} items={review.tabs()} />} />}
      >
        <ReviewBody review={review} />
      </Pane>
    );
  };
  /** The list: the whole width while nothing is open, beside the open review at its own width (rule 5). */
  const listPane = () => (
    <Pane
      label={decidedList ? t().decided : t().approvals}
      width={open ? { min: 360, default: 480 } : undefined}
      scrollKey="admin-code-approvals"
      status={
        // k2b-ui gap: Hero figure (#4360): "4 Freigaben warten" in type 30 in the Code colour; StatusRow now
        <StatusRow
          lead={lead()}
          facts={[
            ...(!decidedList && oldest() ? [{ before: t().oldestWaits, value: ago(oldest()!) }] : []),
            // the admin bar counts waiting approvals and open reports together; the reports are named here
            ...(summary?.reports ? [{ value: summary.reports, after: t().openReports({ n: summary.reports }) }] : []),
          ]}
        />
      }
    >
      {list()}
      <Show when={!decidedList && ok(props.approvals) && props.approvals.nextCursor}>
        {(cursor) => <Bar end={<Button href={codeAreaHref({ sec: "approvals", after: cursor() })}>{rt().loadMore}</Button>} />}
      </Show>
    </Pane>
  );

  return (
    <AdminWorkspace
      nav={props.nav}
      // a detail column only while a review is open: no empty half (identity rule 5); the code needs room
      detail={open ? 560 : undefined}
      detailEmpty={{ icon: "inbox", text: rt().chooseApproval }}
      primary={
        review && !review.closed() && review.mayDecide()
          ? { label: rt().approve({ n: review.props.number }), icon: "check", onClick: () => void review.approve() }
          : undefined
      }
      head={
        <Bar
          start={
            <Tabs
              label={t().approvals}
              items={[
                {
                  label: rt().tabOpen,
                  count: summary?.approvals || undefined,
                  href: codeAreaHref({ sec: "approvals" }),
                  current: !decidedList,
                },
                { label: rt().tabDecided, href: codeAreaHref({ sec: "approvals", tab: "decided" }), current: decidedList },
              ]}
            />
          }
          end={
            <Button variant="text" icon="table-options" href={codeAreaHref({ sec: "policy" })}>
              {t().viewPolicy}
            </Button>
          }
        />
      }
    >
      {open ? (
        <Pane.Split>
          {listPane()}
          {reviewPane()}
        </Pane.Split>
      ) : (
        listPane()
      )}
      <Show when={review}>{(current) => <ReviewDialog review={current()} />}</Show>
    </AdminWorkspace>
  );
}
