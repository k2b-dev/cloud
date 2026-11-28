import { ApprovalFrame, type ApprovalFrameProps } from "@k2b/cloud/approvals/ui";
import type { CodeVersionReadModel } from "@k2b/cloud/contracts";
import { formatRelative } from "@k2b/cloud/shared";
import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import type { CodeDiffLocation } from "@k2b/ui/code-diff";
import {
  Band,
  Button,
  Canvas,
  Choice,
  Dialog,
  Field,
  Input,
  type MenuEntry,
  Notice,
  Row,
  Section,
  type Tab,
  Text,
  useLocale,
  useToast,
} from "@k2b/ui/v2";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { z } from "zod";
import {
  CODE_REVIEW_COMMENT_LENGTH,
  type CodeReviewComment,
  CodeReviewCommentSchema,
  codeReviewCommentContracts,
} from "../../../code/review-contracts";
import { type CodeVersionBinding, type CodeVersionDiffFile, codeVersionContracts } from "../../../code/version-contracts";
import StateWord from "../_area/StateWord";
import { codeAreaHref } from "./area";
import { CodeAdminRequestError, postCodeAdmin, reloadCodeArea } from "./client";
import { codeAdminMessages } from "./messages";
import { ReviewCode, type ReviewThread } from "./review-code";
import { type CodeReviewMessages, codeReviewMessages } from "./review-messages";

export type CodeReviewTab = "overview" | "code" | "diff";
export type CodeReviewOutcome = "approved" | "changes_requested" | "rejected";

/** One version under review, as the server read it. */
export type CodeReviewProps = {
  codeId: string;
  versionId: string;
  number: number;
  title: string;
  /** The reading admin; only an author deletes a comment, and their own entries read "You". */
  viewerId: string;
  dateConfig: DateContext;
  tab: CodeReviewTab;
  /** Self-approval recovery signs out only the version's author, never a newer browser account. */
  authorUserId: string | null;
  /** Who submitted the version; they get the notification. */
  recipient: string;
  /** Who submitted it, when, how, and whose it is, in one quiet line. */
  byline: string;
  /** How the person continues after "Request changes". */
  next: "chat" | "button" | "cli";
  binding: CodeVersionBinding;
  status: import("../../../code/version-contracts").CodeVersionSubmission["status"];
  canApprove: boolean;
  own: boolean;
  soleAdminNotice: string | null;
  staleComparison: boolean;
  newer: { number: number; author: string; href: string } | null;
  /** The reason in words, from the policy rows that need an admin. */
  reason: string;
  readModel: CodeVersionReadModel | null;
  /** The stored explanation; null asks once by itself while the approval is open. */
  explanation: string | null;
  activeVersion: number | null;
  comparison: number | null;
  /** Rows of every file between the compared version and this one; null when the code could not be read. */
  files: CodeVersionDiffFile[] | null;
  decision: { outcome: CodeReviewOutcome; comment: string | null; by: string; byId: string | null; at: string } | null;
  /** The message and comments of this admin on the version right before, after "Request changes". */
  previous: { number: number; message: string; comments: CodeReviewComment[] } | null;
  comments: CodeReviewComment[];
  commentsNext: string | null;
  commentsTotal: number;
  listHref: string;
  nextHref: string | null;
  /** The page of the open list the review was opened from. */
  after?: string;
};

/** Survives the reload after a decision: what the page tells about it once (the decision, a conflict, a withdrawal). */
const DECIDED_KEY = "k2b-code-decided";
type Arrival = { versionId: string; kind: "decided" | "conflict" | "withdrawn" | "unknown"; outcome?: CodeReviewOutcome; text?: string };
const readArrival = (versionId: string): Arrival | null => {
  try {
    const raw = sessionStorage.getItem(DECIDED_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<Arrival> | null;
    if (!value || value.versionId !== versionId) return null;
    sessionStorage.removeItem(DECIDED_KEY);
    return value as Arrival;
  } catch {
    return null;
  }
};
const writeArrival = (arrival: Arrival) => {
  try {
    sessionStorage.setItem(DECIDED_KEY, JSON.stringify(arrival));
  } catch {
    // Without storage the reloaded page still shows the server's state; only its one-time note is lost.
  }
};

/** The worded sentences mark the version and the automation with [[…]]; the approval card reads them as plain text. */
const plain = (sentence: string) => sentence.replace(/\[\[|\]\]/g, "");

/** Comments as threads at their lines: entries of one line in time order, a reply under its line even without its root. */
const threadsOf = (comments: readonly CodeReviewComment[]): ReviewThread[] => {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const lines = new Map<string, ReviewThread>();
  for (const comment of [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
    const root = comment.parentId ? (byId.get(comment.parentId) ?? comment) : comment;
    const path = comment.path ?? root.path;
    const line = comment.line ?? root.line;
    if (!path || !line) continue;
    const key = `${path}\u0000${line}`;
    const thread = lines.get(key);
    if (thread) thread.entries.push(comment);
    else lines.set(key, { key, path, line, entries: [comment], rootId: comment.parentId ?? comment.id });
  }
  return [...lines.values()].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
};

/**
 * The state of one review: the tab in the address, the decision with its recovery, the explanation, and the comments.
 * The review decides through Cloud's one approval card in its pane; deciding sends the unchanged binding and the server
 * rechecks everything.
 */
export function createCodeReview(props: CodeReviewProps) {
  const locale = useLocale();
  const t = (): CodeReviewMessages => codeReviewMessages.resolve([locale()]).t;
  const ta = () => codeAdminMessages.resolve([locale()]).t;
  const toast = useToast();

  const first = () => props.comparison === null;
  const [tab, setTab] = createSignal<CodeReviewTab>(first() && props.tab === "diff" ? "code" : props.tab);
  // The tab is part of the address, so reload and back return to it; the views are already on the page.
  const tabHref = (next: CodeReviewTab) =>
    codeAreaHref({ sec: "approvals", id: props.versionId, tab: next === "overview" ? undefined : next, after: props.after });

  // ---------- Decision ----------
  const [arrival, setArrival] = createSignal<Arrival | null>(null);
  const [unknown, setUnknown] = createSignal<{ outcome: CodeReviewOutcome; text: string | null } | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [failure, setFailure] = createSignal<{ code?: string; text: string } | null>(null);
  const [signingOut, setSigningOut] = createSignal(false);
  const [signOutFailed, setSignOutFailed] = createSignal(false);
  const [dialog, showDialog] = createSignal(false);
  const drafts: Record<"changes" | "reject", string> = { changes: "", reject: "" };
  // The approval waits for the dialog it opened, as for any answer: its approve stays off until the dialog closes.
  let asked: (() => void) | undefined;
  const setDialog = (open: boolean) => {
    showDialog(open);
    if (open) return;
    asked?.();
    asked = undefined;
  };
  const ask = () => {
    if (busy() || unknown()) return Promise.resolve();
    setFailure(null);
    setDialog(true);
    return new Promise<void>((resolve) => {
      asked = resolve;
    });
  };

  const pending = () => props.status === "pending";
  const closed = () => !pending() || unknown() !== null;
  const blocked = () => (props.newer ? ta().outdated({ n: props.number }) : props.files ? null : ta().notLoaded);
  const mayDecide = () => pending() && props.canApprove && !props.staleComparison && !unknown() && !blocked();
  /** Why approving is not possible now, in one sentence; null when it is. */
  const unavailable = () =>
    mayDecide() ? null : (blocked() ?? (props.staleComparison ? ta().staleTitle : props.own ? ta().ownSub : ta().decideForbidden));
  const keep = () => (props.activeVersion ? t().keepOn({ n: props.activeVersion }) : t().keepOff);

  const signInHref = (admin = false) => {
    const target = new URL(window.location.href);
    target.searchParams.delete("reauthenticate");
    if (!admin) target.searchParams.set("reauthenticate", "1");
    const query = new URLSearchParams({ redirectTo: `${target.pathname}${target.search}` });
    if (admin) query.set("method", "admin");
    return `/auth/login?${query}`;
  };
  const signInAdmin = async () => {
    if (signingOut() || !props.authorUserId) return;
    setSigningOut(true);
    setSignOutFailed(false);
    try {
      const { signOutBrowserSession } = await import("@k2b/cloud/browser/session");
      await signOutBrowserSession(props.authorUserId, ta().signOutFailed);
      window.location.assign(signInHref(true));
    } catch {
      setSignOutFailed(true);
      setSigningOut(false);
    }
  };

  /** A refusal's sentence, or null for a lost answer: only a refusal proves nothing changed. */
  const refusal = (error: unknown): { code?: string; text: string } | null => {
    if (!(error instanceof CodeAdminRequestError) || error.status < 400 || error.status >= 500) return null;
    const code = error.code;
    const text =
      code === "SELF_APPROVAL"
        ? ta().decideSelfApproval
        : code === "REAUTHENTICATE"
          ? ta().decideReauthenticate
          : code === "REJECT_ONLY"
            ? ta().decideRejectOnly
            : code === "NOT_FOUND"
              ? ta().decideNotFound
              : code === "BUSY"
                ? ta().decideBusy
                : code === "UNAVAILABLE"
                  ? ta().decideUnavailable
                  : error.status === 403
                    ? ta().decideForbidden
                    : t().dialogFailed;
    return { code, text };
  };

  /** Sends one decision. Saved, conflicting, withdrawn, and lost answers reload into the server's state. */
  const send = async (outcome: CodeReviewOutcome, comment?: string) => {
    // One decision at a time: a second one waits for the first to be refused, and none follows a saved or lost one.
    if (busy() || unknown()) return;
    setBusy(true);
    try {
      await postCodeAdmin(
        "decide",
        { binding: props.binding, approved: outcome === "approved", outcome, ...(comment ? { comment } : {}) },
        codeVersionContracts.decide.data,
      );
      writeArrival({ versionId: props.versionId, kind: "decided", outcome });
      reloadCodeArea();
    } catch (error) {
      const refused = refusal(error);
      const status = error instanceof CodeAdminRequestError ? error.status : 0;
      if (!refused) {
        // The answer was lost: the decision may be saved. Only "Check state" stays until the page reads it.
        setUnknown({ outcome, text: comment ?? null });
        setDialog(false);
        writeArrival({ versionId: props.versionId, kind: "unknown", outcome, text: comment });
        return;
      }
      // Withdrawn meanwhile, or another admin decided first: the reloaded page shows the saved state and says why.
      const code = refused.code ?? "";
      if (status === 409 && !["BUSY", "UNAVAILABLE", "REJECT_ONLY", "SELF_APPROVAL", "REAUTHENTICATE"].includes(code)) {
        writeArrival({ versionId: props.versionId, kind: code === "code_approval_revoked" ? "withdrawn" : "conflict" });
        reloadCodeArea();
        return;
      }
      setBusy(false);
      throw Object.assign(new Error(refused.text), { code: refused.code });
    }
  };

  const approve = async () => {
    if (busy() || unknown() || !mayDecide()) return;
    setFailure(null);
    setSignOutFailed(false);
    try {
      await send("approved");
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code ?? "") : undefined;
      const text = error instanceof Error ? error.message : t().dialogFailed;
      // Busy is a moment, not a problem to fix: a toast with the way to try again; every other refusal stays as a notice.
      if (code === "BUSY") toast(text, { status: "bad", retry: () => void approve() });
      else setFailure({ code, text });
    }
  };

  // ---------- Explanation ----------
  const [explanation, setExplanation] = createSignal(props.readModel?.description.text ?? props.explanation);
  // The first picture never waits: the explanation is asked for once the page runs, with the button busy meanwhile.
  const [explaining, setExplaining] = createSignal(false);
  const [explainFailed, setExplainFailed] = createSignal(false);
  const explainAbort = new AbortController();
  onCleanup(() => explainAbort.abort());
  const explain = async () => {
    setExplaining(true);
    setExplainFailed(false);
    try {
      const result = await postCodeAdmin("explain", { versionId: props.versionId }, z.object({ text: z.string() }), explainAbort.signal);
      setExplanation(result.text);
    } catch {
      if (!explainAbort.signal.aborted) setExplainFailed(true);
    } finally {
      setExplaining(false);
    }
  };

  onMount(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has("reauthenticate")) {
      url.searchParams.delete("reauthenticate");
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    }
    if (props.readModel?.description.state !== "restricted" && explanation() === null && pending()) void explain();
    const arrived = readArrival(props.versionId);
    if (!arrived) return;
    if (arrived.kind === "unknown" && pending()) setUnknown({ outcome: arrived.outcome ?? "approved", text: arrived.text ?? null });
    else if (arrived.kind === "decided" && props.decision)
      toast(
        props.decision.outcome === "approved"
          ? t().toastApproved({ n: props.number })
          : props.decision.outcome === "changes_requested"
            ? t().toastChanges({ n: props.number })
            : t().toastRejected({ n: props.number }),
        { status: "ok" },
      );
    else setArrival(arrived);
  });

  // ---------- Comments ----------
  const [comments, setComments] = createSignal<CodeReviewComment[]>(props.comments);
  const [olderCursor, setOlderCursor] = createSignal(props.commentsNext);
  const [total, setTotal] = createSignal(props.commentsTotal);
  const [opened, setOpened] = createSignal<CodeDiffLocation | null>(null);
  const [deleteFailed, setDeleteFailed] = createSignal<string | null>(null);
  const [loadingOlder, setLoadingOlder] = createSignal(false);
  const threads = createMemo(() => threadsOf(comments()));
  const [file, setFile] = createSignal<string>();

  const loadOlder = async () => {
    const before = olderCursor();
    if (!before || loadingOlder()) return;
    setLoadingOlder(true);
    try {
      const page = await postCodeAdmin(
        "comments/list",
        { codeId: props.codeId, versionId: props.versionId, before },
        codeReviewCommentContracts.list.data,
      );
      const known = new Set(comments().map((comment) => comment.id));
      setComments([...comments(), ...page.items.filter((comment) => !known.has(comment.id))]);
      setOlderCursor(page.nextBefore);
      setTotal(page.total);
    } catch {
      toast(t().olderFailed, { status: "bad", retry: () => void loadOlder() });
    } finally {
      setLoadingOlder(false);
    }
  };

  const post = async (path: string, line: number, body: string, parentId?: string) => {
    try {
      const created = await postCodeAdmin(
        "comments/create",
        { codeId: props.codeId, versionId: props.versionId, path, line, body, ...(parentId ? { parentId } : {}) },
        CodeReviewCommentSchema,
      );
      setComments([...comments(), created]);
      setTotal(total() + 1);
      return true;
    } catch (error) {
      const status = error instanceof CodeAdminRequestError ? error.status : 0;
      throw new Error(status === 409 ? t().commentClosed : status === 413 || status === 422 ? t().commentTooMany : t().commentFailed);
    }
  };

  const remove = async (comment: CodeReviewComment) => {
    setDeleteFailed(null);
    try {
      await postCodeAdmin("comments/delete", { codeId: props.codeId, versionId: props.versionId, id: comment.id }, z.unknown());
      // The server keeps replies of a deleted comment as their own thread at the same line; so does the page.
      setComments(
        comments()
          .filter((entry) => entry.id !== comment.id)
          .map((entry) => (entry.parentId === comment.id ? { ...entry, parentId: null } : entry)),
      );
      setTotal(Math.max(0, total() - 1));
    } catch {
      setDeleteFailed(comment.id);
    }
  };

  const stat = createMemo(() => {
    let add = 0;
    let del = 0;
    for (const entry of props.files ?? [])
      for (const line of entry.lines) {
        if (line.kind === "add") add++;
        else if (line.kind === "del") del++;
      }
    return { add, del };
  });

  /** The views of the review: overview, the code, and the changes against the compared version (none for a first one). */
  const tabs = (): Tab[] => [
    {
      label: t().tabOverview,
      href: tabHref("overview"),
      current: tab() === "overview",
      onNavigate: (event) => {
        setTab("overview");
        event.replaceWith(undefined, { scroll: "preserve" });
      },
    },
    {
      label: t().tabCode,
      count: total() || undefined,
      href: tabHref("code"),
      current: tab() === "code",
      onNavigate: (event) => {
        setTab("code");
        event.replaceWith(undefined, { scroll: "preserve" });
      },
    },
    ...(first()
      ? []
      : [
          {
            label: t().tabDiff,
            count: `+${stat().add} −${stat().del}`,
            href: tabHref("diff"),
            current: tab() === "diff",
            onNavigate: (event: LinkNavigateEvent) => {
              setTab("diff");
              event.replaceWith(undefined, { scroll: "preserve" });
            },
          },
        ]),
  ];

  return {
    props,
    locale,
    t,
    ta,
    tab,
    setTab,
    tabs,
    pending,
    closed,
    mayDecide,
    unavailable,
    keep,
    busy,
    unknown,
    arrival,
    failure,
    signingOut,
    signOutFailed,
    signInHref,
    signInAdmin,
    approve,
    ask,
    send,
    dialog,
    setDialog,
    drafts,
    explanation,
    explaining,
    explainFailed,
    explain,
    comments,
    olderCursor,
    loadingOlder,
    loadOlder,
    total,
    threads,
    opened,
    setOpened,
    post,
    remove,
    deleteFailed,
    file,
    setFile,
  };
}
export type CodeReview = ReturnType<typeof createCodeReview>;

/** The way to the other waiting approvals, behind "…" in the head. */
export const reviewMenu = (
  t: CodeReviewMessages,
  position: { index: number; total: number; previous: string | null; next: string | null } | null,
): MenuEntry[] =>
  position
    ? [
        { label: t.previous, icon: "chevron-up", href: position.previous ?? undefined, disabled: !position.previous },
        {
          label: t.next,
          icon: "chevron-down",
          href: position.next ?? undefined,
          disabled: !position.next,
          meta: t.position({ i: position.index + 1, n: position.total }),
        },
      ]
    : [];

/**
 * The approval of the review: Cloud's one approval card, the same as in chat, the side panel and Freigaben, so a person
 * always recognises it. Open, it asks with its two decisions; closed, it says what happened and offers the way on.
 */
function ReviewApproval(props: { review: CodeReview }) {
  const review = props.review;
  const t = review.t;
  const p = review.props;
  const decision = p.decision;
  const mine = decision?.byId === p.viewerId;
  const sentence = (): string => {
    const lost = review.unknown();
    if (lost) return t().unknownSentence({ n: p.number });
    if (decision) {
      const who = decision.by;
      if (decision.outcome === "approved") return mine ? t().youApproved({ n: p.number }) : t().otherApproved({ who, n: p.number });
      if (decision.outcome === "changes_requested") return mine ? t().youChanges({ n: p.number }) : t().otherChanges({ who, n: p.number });
      return mine ? t().youRejected({ n: p.number }) : t().otherRejected({ who, n: p.number });
    }
    if (p.status === "withdrawn") return t().withdrawnSentence({ who: p.recipient, n: p.number });
    return t().closedSentence({ n: p.number });
  };
  const why = (): string => {
    if (review.unknown()) return t().unknownWhy;
    // The author reading their own decided version is addressed directly, not told about a notification to themselves.
    if (decision?.outcome === "approved") return p.own ? t().afterApprovedSelf : t().afterApproved({ who: p.recipient });
    if (decision?.outcome === "changes_requested")
      return p.own ? t().afterChangesSelf({ keep: review.keep() }) : t().afterChanges({ who: p.recipient, keep: review.keep() });
    if (decision?.outcome === "rejected")
      return p.own
        ? t().afterRejectedSelf({ n: p.number, keep: review.keep() })
        : t().afterRejected({ who: p.recipient, n: p.number, keep: review.keep() });
    return p.status === "withdrawn" ? review.keep() : t().closedWhy;
  };
  /** For assistive technology only: the visible sentence already says the state once. */
  const status = (): NonNullable<ApprovalFrameProps["status"]> => {
    if (review.unknown()) return { tone: "warning", label: t().statusUnknown };
    if (decision?.outcome === "approved") return { tone: "done", label: t().statusApproved };
    if (decision?.outcome === "changes_requested") return { tone: "warning", label: t().statusChanges };
    if (decision?.outcome === "rejected") return { tone: "error", label: t().statusRejected };
    if (p.status === "withdrawn") return { tone: "off", label: t().statusWithdrawn };
    if (p.status === "superseded" || p.status === "cancelled") return { tone: "off", label: t().statusSuperseded };
    return { tone: "expired", label: t().statusExpired };
  };
  const message = () => {
    const lost = review.unknown();
    if (lost?.text) return { label: t().unconfirmedMessage, text: lost.text, who: t().youCap, at: null as string | null };
    if (!decision?.comment) return null;
    const label = mine ? (decision.outcome === "rejected" ? t().yourReason : t().yourMessage) : t().theirMessage({ who: decision.by });
    return { label, text: decision.comment, who: mine ? t().youCap : decision.by, at: decision.at };
  };
  const source = () => ({ name: t().source, icon: "ti ti-code" });
  return (
    <>
      <Band label={t().source}>
        {/* k2b-ui gap: Cloud's one approval card (ApprovalFrame of @k2b/cloud) is v1; it stands in a Canvas with the look
            it has in chat, the side panel and Freigaben */}
        <Canvas label={t().source}>
          <Show
            when={!review.closed()}
            fallback={
              <ApprovalFrame
                locale={review.locale()}
                state="decided"
                source={source()}
                status={status()}
                reason={{ text: why() }}
                resultAnchor
                sentence={plain(sentence())}
                confirm={
                  review.unknown()
                    ? { label: t().checkState, filled: false, onSelect: () => reloadCodeArea() }
                    : { label: p.nextHref ? t().nextApproval : t().backToList, href: p.nextHref ?? p.listHref, filled: false }
                }
              />
            }
          >
            <ApprovalFrame
              locale={review.locale()}
              state="open"
              source={source()}
              sentence={plain(t().question({ n: p.number, title: p.title }))}
              reason={{ text: p.reason, icon: "ti ti-eye" }}
              secondary={{ label: t().rejectOrChange, shortLabel: t().rejectOrChangeShort, onSelect: review.ask }}
              confirm={{ label: t().approve({ n: p.number }), icon: "ti ti-check", onSelect: review.approve }}
              unavailable={review.unavailable() ? { text: review.unavailable(), icon: "ti ti-lock" } : undefined}
            />
          </Show>
        </Canvas>
        <Text type="meta" muted>
          {p.byline}
        </Text>
      </Band>
      <Show when={review.closed() && message()}>
        {(note) => (
          <Section icon="message-2" title={note().label}>
            <Row
              avatar={{ name: note().who }}
              lines={[note().text, note().at ? `${note().who} · ${formatRelative(note().at!, p.dateConfig)}` : note().who]}
            />
          </Section>
        )}
      </Show>
    </>
  );
}

/** What the page tells about the review: an arrival after a reload, a newer version, why deciding is locked, a refusal. */
function ReviewNotices(props: { review: CodeReview }) {
  const review = props.review;
  const t = review.t;
  const ta = review.ta;
  const p = review.props;
  const failure = review.failure;
  return (
    <>
      <Show when={review.arrival()?.kind === "conflict"}>
        <Notice tone="bad" icon="users" title={t().conflictTitle({ who: p.decision?.by ?? t().unknownAuthor, n: p.number })}>
          {t().conflictSub}
        </Notice>
      </Show>
      <Show when={review.arrival()?.kind === "withdrawn"}>
        <Notice tone="bad" title={t().withdrawnTitle({ n: p.number })}>
          {t().withdrawnSub({ keep: review.keep() })}
        </Notice>
      </Show>
      <Show when={p.previous}>
        {(previous) => (
          <Notice tone="note" icon="message-2" title={t().previousTitle({ n: previous().number })}>
            {[
              previous().message,
              ...previous().comments.map(
                (comment) =>
                  `${comment.author.id === p.viewerId ? t().youCap : (comment.author.name ?? t().unknownAuthor)}: ${comment.body}`,
              ),
            ].join(" · ")}
          </Notice>
        )}
      </Show>
      <Show when={review.pending() && p.newer}>
        {(newer) => (
          <Notice
            tone="warn"
            icon="git-branch"
            title={ta().newerTitle({ who: newer().author, n: newer().number })}
            actions={[{ label: ta().reviewNewer({ n: newer().number }), href: newer().href }]}
          >
            {ta().newerSub({ n: p.number })}
          </Notice>
        )}
      </Show>
      <Show when={review.pending() && !p.newer && p.staleComparison}>
        <Notice tone="warn" title={ta().staleTitle}>
          {ta().staleSub}
        </Notice>
      </Show>
      <Show when={review.pending() && p.own && !p.soleAdminNotice}>
        <Notice tone="note" icon="user-x" title={ta().ownTitle}>
          {ta().ownSub}
        </Notice>
      </Show>
      <Show when={review.pending() && p.soleAdminNotice}>
        <Notice tone="note" icon="user-shield">
          {ta().soleTitle}
        </Notice>
      </Show>
      <For each={p.readModel?.notices.items ?? []}>
        {(notice) => (
          <Notice
            tone={notice.severity === "block" ? "bad" : "warn"}
            icon={notice.severity === "block" ? "ban" : undefined}
            title={notice.text}
          >
            {notice.consequence}
          </Notice>
        )}
      </For>
      <Show when={failure()}>
        {(refused) => (
          <Show
            when={refused().code === "REAUTHENTICATE"}
            fallback={
              <Notice
                tone="bad"
                actions={
                  refused().code === "NOT_FOUND"
                    ? [
                        { label: t().backToList, href: p.listHref },
                        { label: ta().reload, icon: "refresh", onClick: () => reloadCodeArea() },
                      ]
                    : [{ label: ta().reload, icon: "refresh", onClick: () => reloadCodeArea() }]
                }
              >
                {refused().text}
              </Notice>
            }
          >
            <Notice
              tone="bad"
              actions={[
                review.signOutFailed()
                  ? { label: ta().reload, icon: "refresh", onClick: () => reloadCodeArea() }
                  : { label: ta().signInAgain, href: review.signInHref() },
                {
                  label: ta().signInAdmin,
                  onClick: () => void review.signInAdmin(),
                  disabled: !p.authorUserId || review.signingOut(),
                },
              ]}
            >
              {review.signOutFailed() ? `${refused().text} ${ta().signOutFailed}` : refused().text}
            </Notice>
          </Show>
        )}
      </Show>
    </>
  );
}

/** What changes against the compared version; unchanged lines fold into one row. */
function ReviewChanges(props: { review: CodeReview }) {
  const review = props.review;
  const t = review.t;
  const p = review.props;
  const [showSame, setShowSame] = createSignal(false);
  return (
    <Show when={p.readModel?.changes}>
      {(changes) => {
        const rows = () => changes().rows.items;
        const same = () => rows().filter((row) => row.kind === "same");
        return (
          <Section
            icon="arrows-diff"
            title={p.comparison ? t().changesFrom({ n: p.comparison }) : t().detailsFirst}
            summary={changes().assurance}
          >
            <For each={rows().filter((row) => row.kind !== "same")}>
              {(row) => <Row icon={row.kind === "add" ? "plus" : "minus"} lines={row.note ? [row.text, row.note] : [row.text]} />}
            </For>
            <Show when={same().length}>
              <Show
                when={showSame()}
                fallback={
                  <Row
                    icon="equal"
                    lines={[t().sameMore({ n: same().length })]}
                    action={{ label: t().show, onClick: () => setShowSame(true) }}
                  />
                }
              >
                <For each={same()}>{(row) => <Row icon="equal" lines={row.note ? [row.text, row.note] : [row.text]} />}</For>
              </Show>
            </Show>
          </Section>
        );
      }}
    </Show>
  );
}

/** The overview: what changes, what it does (AI), what it may do, its examples, and the comments on its code. */
function ReviewOverview(props: { review: CodeReview }) {
  const review = props.review;
  const t = review.t;
  const p = review.props;
  const model = () => p.readModel;
  const dedupe = (items: readonly { text: string; note?: string }[]) =>
    items.filter((row, index) => items.findIndex((other) => other.text === row.text && other.note === row.note) === index);
  const examples = () => {
    const value = model()?.examples;
    return value && value.state !== "unavailable" && value.state !== "none" ? value : null;
  };
  const when = (iso: string) => formatRelative(iso, p.dateConfig);
  return (
    <>
      <ReviewChanges review={review} />
      <Show
        when={review.explanation()}
        fallback={
          <Notice
            tone="ai"
            title={t().whatItDoes}
            meta={(model()?.description.modelLabel ?? t().aiMark).replace(/^\s*✦\s*/, "")}
            primary={{
              label: review.explaining() ? t().explaining : review.explainFailed() ? t().explainRetry : t().explain,
              icon: review.explainFailed() ? "refresh" : "sparkles",
              onClick: () => void review.explain(),
              disabled: review.explaining(),
            }}
          >
            {review.explainFailed() ? t().explainFailed : t().noDescription}
          </Notice>
        }
      >
        {(text) => (
          <Notice tone="ai" title={t().whatItDoes} meta={(model()?.description.modelLabel ?? t().aiMark).replace(/^\s*✦\s*/, "")}>
            {text()}
          </Notice>
        )}
      </Show>
      <Show when={model()}>
        {(readModel) => (
          <Section icon="list-check" title={t().mayDo({ n: p.number })}>
            <For each={dedupe(readModel().timing.items)}>
              {(row) => <Row icon="clock" lines={row.note ? [row.text, row.note] : [row.text]} />}
            </For>
            <Show when={readModel().mayDo.items.length} fallback={<Row icon="circle-off" lines={[t().mayNothing]} />}>
              <For each={dedupe(readModel().mayDo.items)}>
                {(row) => <Row icon="apps" lines={row.note ? [row.text, row.note] : [row.text]} />}
              </For>
            </Show>
            <Show when={readModel().mayDo.moreText}>{(more) => <Row icon="dots" lines={[more()]} />}</Show>
          </Section>
        )}
      </Show>
      <Show when={examples()}>
        {(value) => (
          <Section icon="test-pipe" title={t().examples} count={value().summary} summary={value().explanation}>
            <For each={value().items}>
              {(example) => (
                <Row
                  icon={example.state === "succeeded" ? "circle-check" : "circle-x"}
                  lines={[example.name, example.sentence]}
                  end={example.state === "succeeded" ? <StateWord>{example.status}</StateWord> : <Text tone="bad">{example.status}</Text>}
                />
              )}
            </For>
          </Section>
        )}
      </Show>
      <Show when={review.threads().length}>
        <Section
          icon="message-2"
          title={t().commentsTitle}
          count={review.total()}
          actions={[{ label: t().seeInCode, icon: "code", onClick: () => review.setTab("code") }]}
          summary={p.next === "cli" ? t().commentsFootCli({ who: p.recipient }) : t().commentsFoot({ who: p.recipient })}
          more={review.olderCursor() ? { label: t().olderComments, onClick: () => void review.loadOlder() } : undefined}
        >
          <For each={review.threads().flatMap((thread) => thread.entries.map((comment) => ({ thread, comment })))}>
            {(item) => (
              <Row
                avatar={{ name: item.comment.author.name ?? t().unknownAuthor }}
                lines={[
                  item.comment.body,
                  item.comment.author.id === p.viewerId ? t().youCap : (item.comment.author.name ?? t().unknownAuthor),
                ]}
                time={when(item.comment.createdAt)}
              />
            )}
          </For>
        </Section>
      </Show>
    </>
  );
}

/** The content of the review pane for the open tab. */
export function ReviewBody(props: { review: CodeReview }) {
  const review = props.review;
  const t = review.t;
  const p = review.props;
  const code = () => (
    <Section icon="file-code" title={t().codeLabel} summary={review.closed() ? t().footDecided : t().footOpen}>
      {/* k2b-ui gap: no v2 code view with line threads yet; the @k2b/ui code field stands inside a Canvas */}
      <Canvas label={t().codeLabel}>
        <ReviewCode
          view={review.tab() === "diff" ? "diff" : "code"}
          files={p.files}
          closed={review.closed}
          threads={review.threads}
          opened={review.opened}
          setOpened={review.setOpened}
          post={review.post}
          remove={(comment) => void review.remove(comment)}
          deleteFailed={review.deleteFailed}
          file={review.file}
          setFile={review.setFile}
          viewerId={p.viewerId}
          dateConfig={p.dateConfig}
          t={t}
        />
      </Canvas>
    </Section>
  );
  return (
    <>
      <ReviewApproval review={review} />
      <ReviewNotices review={review} />
      <Show when={review.tab() === "overview"}>
        <ReviewOverview review={review} />
      </Show>
      {/* one code field for Code and Changes: switching between them changes its rows and keeps the field in place */}
      <Show when={review.tab() !== "overview"}>{code()}</Show>
    </>
  );
}

/**
 * "Request changes" and "Reject": the kind, a required text with its error in place, sending inside the dialog, so a
 * refusal keeps the text; Escape and a press outside wait while a decision is on its way.
 */
export function ReviewDialog(props: { review: CodeReview }) {
  const review = props.review;
  const t = review.t;
  const p = review.props;
  const [kind, setKind] = createSignal<"changes" | "reject">("changes");
  const [text, setText] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [sending, setSending] = createSignal(false);
  const changes = () => kind() === "changes";
  const lead = () => {
    const values = { who: p.recipient, keep: review.keep() };
    if (!changes()) return t().rejectText(values);
    if (p.next === "cli") return t().changesTextCli(values);
    if (p.next === "button") return t().changesTextButton(values);
    return t().changesTextChat(values);
  };
  const close = () => {
    if (sending()) return;
    review.drafts[kind()] = text();
    review.setDialog(false);
  };
  const submit = async () => {
    if (sending()) return;
    const comment = text().trim();
    if (!comment) {
      setError(changes() ? t().changesMissing : t().rejectMissing);
      return;
    }
    setSending(true);
    setError(null);
    try {
      await review.send(changes() ? "changes_requested" : "rejected", comment);
    } catch (failure) {
      setError(failure instanceof Error && failure.message ? failure.message : t().dialogFailed);
      setSending(false);
    }
  };
  return (
    <Dialog
      title={changes() ? t().changesTitle({ n: p.number }) : t().rejectTitle({ n: p.number })}
      open={review.dialog()}
      onOpenChange={(open) => (open ? review.setDialog(true) : close())}
      dismissible={!sending()}
      foot={
        <>
          <Button disabled={sending()} onClick={close}>
            {t().dialogCancel}
          </Button>
          {/* k2b-ui gap: a destructive confirm asks with a red button once #4275 lands (danger) */}
          <Button variant="primary" busy={sending()} onClick={() => void submit()}>
            {changes() ? t().changesConfirm : t().rejectConfirm({ n: p.number })}
          </Button>
        </>
      }
    >
      <Choice
        name="code-review-decision"
        label={t().decisionKind}
        options={[
          { value: "changes", label: t().requestChanges },
          { value: "reject", label: t().reject },
        ]}
        value={kind()}
        disabled={sending()}
        onChange={(next) => {
          review.drafts[kind()] = text();
          const chosen = next === "reject" ? "reject" : "changes";
          setKind(chosen);
          setText(review.drafts[chosen]);
          setError(null);
        }}
      />
      <Text>{lead()}</Text>
      <Field
        label={changes() ? t().changesLabel : t().rejectLabel}
        hint={review.total() > 0 ? t().commentsGoWith({ n: review.total() }) : t().visibleToWho({ who: p.recipient })}
        error={error() ?? undefined}
      >
        <Input
          multiline
          placeholder={changes() ? t().changesPlaceholder : t().rejectPlaceholder}
          maxLength={CODE_REVIEW_COMMENT_LENGTH}
          value={text()}
          disabled={sending()}
          onInput={(value) => {
            setText(value);
            review.drafts[kind()] = value;
            if (error() && value.trim()) setError(null);
          }}
        />
      </Field>
    </Dialog>
  );
}
