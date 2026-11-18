import { CloudAvatar } from "@k2b/cloud/account/ui";
import { ApprovalFrame, type ApprovalFrameProps } from "@k2b/cloud/approvals/ui";
import type { CodeVersionReadModel } from "@k2b/cloud/contracts";
import { formatRelative } from "@k2b/cloud/shared";
import type { DateContext } from "@k2b/stdlib";
import {
  Button,
  ButtonLink,
  ChangeList,
  type ChangeListItem,
  Discussion,
  IconButton,
  LoadMore,
  NoticeCard,
  Section,
  Skeleton,
  StatusBadge,
  Tabs,
  useLocale,
} from "@k2b/ui";
import { CodeDiff, type CodeDiffFile, type CodeDiffLocation } from "@k2b/ui/code-diff";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { z } from "zod";
import { type CodeReviewComment, CodeReviewCommentSchema, codeReviewCommentContracts } from "../../../code/review-contracts";
import { type CodeVersionBinding, type CodeVersionDiffFile, codeVersionContracts } from "../../../code/version-contracts";
import { CodeAdminRequestError, postCodeAdmin, reloadCodeArea } from "./client";
import { codeAdminMessages } from "./messages";
import { openCodeReviewDialog } from "./review-dialog";
import { type CodeReviewMessages, codeReviewMessages } from "./review-messages";

export type CodeReviewTab = "overview" | "code" | "diff";
export type CodeReviewOutcome = "approved" | "changes_requested" | "rejected";

export type CodeApprovalReviewProps = {
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
};

/** Survives the reload after a decision: what the page tells about it once (the decision, a conflict, a withdrawal). */
const DECIDED_KEY = "k2b-code-decided";
type Arrival = { versionId: string; kind: "decided" | "conflict" | "withdrawn" | "unknown"; outcome?: CodeReviewOutcome; text?: string };
const RESULT_ID = "code-review-result";
const FAILURE_ID = "code-review-failure";

/** The result in the visible tab, or a notice about it: every tab draws the approval, only one is shown. */
const focusResult = () => {
  const target = [...document.querySelectorAll<HTMLElement>(`#${RESULT_ID}, [data-review-result]`)].find(
    (element) => element.offsetParent !== null,
  );
  target?.focus({ preventScroll: false });
};
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

/** A worded sentence marks its grey chips, the version and the automation, with [[…]]. */
const chipParts = (sentence: string): string[] => sentence.split(/\[\[|\]\]/);
const sentenceOf = (sentence: string): ApprovalFrameProps["sentence"] =>
  chipParts(sentence)
    .map((text, index) =>
      index % 2 === 1 ? { kind: "chip" as const, chip: { kind: "object" as const, title: text } } : { kind: "text" as const, text },
    )
    .filter((part) => part.kind === "chip" || part.text !== "");

type Thread = { key: string; path: string; line: number; entries: CodeReviewComment[]; rootId: string };

/** Comments as threads at their lines: entries of one line in time order, a reply under its line even without its root. */
const threadsOf = (comments: readonly CodeReviewComment[]): Thread[] => {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const lines = new Map<string, Thread>();
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
 * One version under review: a head row of tabs "Overview | Code | Diff", the approval with three decisions on top of
 * each, and the code field where admins comment on lines. Both views come with the page; switching never loads.
 * Deciding sends the unchanged binding; the server rechecks everything.
 */
export default function CodeApprovalReview(props: CodeApprovalReviewProps) {
  const locale = useLocale();
  const t = (): CodeReviewMessages => codeReviewMessages.resolve([locale()]).t;
  const ta = () => codeAdminMessages.resolve([locale()]).t;

  const first = () => props.comparison === null;
  const [tab, setTab] = createSignal<CodeReviewTab>(first() && props.tab === "diff" ? "code" : props.tab);
  const chooseTab = (next: CodeReviewTab) => {
    setTab(next);
    // The tab is part of the URL, so reload and back return to it; the views are already on the page.
    const url = new URL(window.location.href);
    if (next === "overview") url.searchParams.delete("tab");
    else url.searchParams.set("tab", next);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  };

  // ---------- Decision state ----------
  const [arrival, setArrival] = createSignal<Arrival | null>(null);
  const [unknown, setUnknown] = createSignal<{ outcome: CodeReviewOutcome; text: string | null } | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [failure, setFailure] = createSignal<string | null>(null);
  const [failureCode, setFailureCode] = createSignal<string>();
  const [signingOut, setSigningOut] = createSignal(false);
  const [signOutFailed, setSignOutFailed] = createSignal(false);
  const drafts: Record<"changes" | "reject", string> = { changes: "", reject: "" };

  const pending = () => props.status === "pending";
  const closed = () => !pending() || unknown() !== null;
  const blocked = () => (props.newer ? ta().outdated({ n: props.number }) : props.files ? null : ta().notLoaded);
  const mayDecide = () => pending() && props.canApprove && !props.staleComparison && !unknown();
  const keep = () => (props.activeVersion ? t().keepOn({ n: props.activeVersion }) : t().keepOff);

  // ---------- Explanation ----------
  const [explanation, setExplanation] = createSignal(props.readModel?.description.text ?? props.explanation);
  const [explaining, setExplaining] = createSignal(
    props.readModel?.description.state !== "restricted" && explanation() === null && pending(),
  );
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
    if (explaining()) void explain();
    const arrived = readArrival(props.versionId);
    if (!arrived) return;
    if (arrived.kind === "unknown" && pending()) setUnknown({ outcome: arrived.outcome ?? "approved", text: arrived.text ?? null });
    else setArrival(arrived);
    queueMicrotask(focusResult);
  });

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
        writeArrival({ versionId: props.versionId, kind: "unknown", outcome, text: comment });
        queueMicrotask(focusResult);
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
    if (busy() || unknown()) return;
    setFailure(null);
    setFailureCode(undefined);
    setSignOutFailed(false);
    try {
      await send("approved");
    } catch (error) {
      // The button keeps its place; the reason shows above the approval with its way out.
      setFailureCode(error instanceof Error && "code" in error ? String(error.code ?? "") : undefined);
      setFailure(error instanceof Error ? error.message : t().dialogFailed);
      queueMicrotask(() => document.getElementById(FAILURE_ID)?.focus());
    }
  };

  const ask = async (kind: "changes" | "reject") => {
    if (busy() || unknown()) return;
    setFailure(null);
    await openCodeReviewDialog({
      kind,
      number: props.number,
      recipient: props.recipient,
      keep: keep(),
      comments: total(),
      next: props.next,
      draft: drafts[kind],
      t: t(),
      keepDraft: (text) => {
        drafts[kind] = text;
      },
      send: (comment) => send(kind === "changes" ? "changes_requested" : "rejected", comment),
    });
  };

  // ---------- Comments ----------
  const [comments, setComments] = createSignal<CodeReviewComment[]>(props.comments);
  const [olderCursor, setOlderCursor] = createSignal(props.commentsNext);
  const [total, setTotal] = createSignal(props.commentsTotal);
  const [opened, setOpened] = createSignal<CodeDiffLocation | null>(null);
  const [deleteFailed, setDeleteFailed] = createSignal<string | null>(null);
  const threads = createMemo(() => threadsOf(comments()));
  const threadAt = (path: string, line: number) => threads().find((thread) => thread.path === path && thread.line === line);

  const loadOlder = async () => {
    const before = olderCursor();
    if (!before) return false;
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
      return true;
    } catch {
      throw new Error(t().olderFailed);
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

  const when = (iso: string) => formatRelative(iso, props.dateConfig);
  const entry = (comment: CodeReviewComment, editable: boolean) => {
    const mine = comment.author.id === props.viewerId;
    const name = mine ? t().youCap : (comment.author.name ?? t().unknownAuthor);
    return (
      <Discussion.Item
        author={name}
        avatar={
          <CloudAvatar username={comment.author.name ?? name} userId={comment.author.id} avatarHash={comment.author.avatarHash} size="xs" />
        }
        meta={mine ? undefined : t().cloudAdmin}
        timestamp={<time dateTime={comment.createdAt}>{when(comment.createdAt)}</time>}
        actions={
          editable && mine ? (
            <IconButton label={t().deleteComment} size="sm" variant="ghost" onClick={() => void remove(comment)}>
              <i class="ti ti-trash" aria-hidden="true" />
            </IconButton>
          ) : undefined
        }
      >
        <p class="core-code-review__comment">{comment.body}</p>
        <Show when={deleteFailed() === comment.id}>
          <p class="core-code-review__comment-error" role="alert">
            {t().deleteFailed}
          </p>
        </Show>
      </Discussion.Item>
    );
  };

  /** The thread directly under a line: comments flush, "Reply …" as its last line, writing in place. */
  const LineThread = (line: { path: string; line: number }) => {
    const thread = createMemo(() => threadAt(line.path, line.line));
    const writingHere = () => {
      const open = opened();
      return open?.path === line.path && open.line === line.line;
    };
    const editable = () => !closed();
    let box: HTMLDivElement | undefined;
    return (
      <div class="core-code-review__thread" ref={box}>
        <Discussion.Thread
          label={t().threadLabel({ path: line.path, n: line.line })}
          placeholder={thread() ? t().replyPlaceholder : t().commentPlaceholder({ n: line.line })}
          hint={t().visibleWithDecision}
          submitLabel={t().commentSubmit}
          cancelLabel={t().commentCancel}
          writing={writingHere() ? true : undefined}
          onWritingChange={(writing) => {
            if (writing) return;
            // Sent or cancelled: the focus goes back to the "+" of this line, also when a new thread closes with it.
            const code = box?.closest('[role="region"]');
            if (writingHere()) setOpened(null);
            setTimeout(() => code?.querySelector<HTMLElement>(`[data-action-line="${line.line}"]`)?.focus());
          }}
          onSubmit={editable() ? (message) => post(line.path, line.line, message, thread()?.rootId) : undefined}
        >
          <For each={thread()?.entries ?? []}>{(comment) => entry(comment, editable())}</For>
        </Discussion.Thread>
      </div>
    );
  };
  /** Lines that carry a thread now, plus the line whose new thread is open; CodeDiff keeps one element per line. */
  const slotLines = createMemo<CodeDiffLocation[]>(() => {
    const lines = threads().map((thread) => ({ path: thread.path, line: thread.line, side: "new" as const }));
    const open = opened();
    if (open && !lines.some((line) => line.path === open.path && line.line === open.line))
      lines.push({ path: open.path, line: open.line, side: "new" });
    return lines;
  });

  // ---------- Code field ----------
  const codeFiles = createMemo<CodeDiffFile[]>(() =>
    (props.files ?? [])
      .map((file) => ({
        path: file.path,
        lines: file.lines.filter((line) => line.kind !== "del").map((line) => ({ kind: "add" as const, text: line.text })),
      }))
      .filter((file) => file.lines.length > 0),
  );
  const diffFiles = createMemo<CodeDiffFile[]>(() => (props.files ?? []).map((file) => ({ path: file.path, lines: file.lines })));
  const stat = createMemo(() => {
    let add = 0;
    let del = 0;
    for (const file of props.files ?? [])
      for (const line of file.lines) {
        if (line.kind === "add") add++;
        else if (line.kind === "del") del++;
      }
    return { add, del };
  });
  const [file, setFile] = createSignal<string>();

  const codeField = (view: "code" | "diff") => (
    <Section frame="line" title={t().codeLabel} class="core-code-review__field" data-code-source-region="admin-approval">
      <CodeDiff
        files={view === "code" ? codeFiles() : diffFiles()}
        file={file()}
        onFileChange={setFile}
        status={props.files ? undefined : "error"}
        errorDescription={t().codeFailed}
        onRetry={() => reloadCodeArea()}
        label={t().codeLabel}
        toolbarStart={<i class="ti ti-file-code core-code-review__files-icon" aria-hidden="true" />}
        lineAction={
          closed()
            ? undefined
            : {
                label: (location) => t().commentOnLine({ n: location.line }),
                onSelect: (location) => {
                  if (threadAt(location.path, location.line)) setOpened({ ...location });
                  else setOpened({ path: location.path, line: location.line, side: "new" });
                },
              }
        }
        slotLines={slotLines()}
        lineSlot={(location) => <LineThread path={location.path} line={location.line} />}
      />
      <p class="core-code-review__foot">
        <i class="ti ti-lock" aria-hidden="true" />
        <span>{closed() ? t().footDecided : t().footOpen}</span>
        <Show when={!closed()}>
          <span class="core-code-review__keys">{t().keysHint}</span>
        </Show>
      </p>
    </Section>
  );

  // ---------- Approval ----------
  const changesDetails = (): ApprovalFrameProps["details"] => {
    const changes = props.readModel?.changes;
    if (!changes) return undefined;
    const rows = changes.rows.items;
    const same = rows.filter((row) => row.kind === "same");
    const [showSame, setShowSame] = createSignal(false);
    const items = (): ChangeListItem[] => [
      ...rows
        .filter((row) => row.kind !== "same")
        .map((row) => ({ tone: row.kind === "add" ? ("add" as const) : ("remove" as const), content: row.text, detail: row.note })),
      ...(same.length
        ? showSame()
          ? same.map((row) => ({ tone: "neutral" as const, icon: "ti ti-equal", content: row.text, detail: row.note }))
          : [
              {
                tone: "neutral" as const,
                icon: "ti ti-equal",
                content: (
                  <>
                    {t().sameMore({ n: same.length })}{" "}
                    <button type="button" class="k2b-text-link" onClick={() => setShowSame(true)}>
                      {t().show}
                    </button>
                  </>
                ),
              },
            ]
        : []),
    ];
    return {
      label: props.comparison ? t().detailsFrom({ n: props.comparison }) : t().detailsFirst,
      content: () => <ChangeList label={t().detailsFirst} items={items()} />,
      note: { text: changes.assurance, icon: "ti ti-info-circle" },
    };
  };
  const examplesFact = (): NonNullable<ApprovalFrameProps["meta"]>[number] | null => {
    const examples = props.readModel?.examples;
    if (!examples || examples.state === "unavailable") return null;
    return {
      text: examples.summary,
      icon: examples.state === "passed" ? "ti ti-circle-check" : "ti ti-alert-triangle",
      tone: examples.state === "passed" ? "success" : "warning",
    };
  };
  const answers = (): Pick<ApprovalFrameProps, "confirm" | "decline" | "more" | "unavailable"> => ({
    more: [{ label: t().reject, onSelect: () => ask("reject") }],
    decline: { label: t().requestChanges, onSelect: () => ask("changes") },
    confirm: { label: t().approve({ n: props.number }), icon: "ti ti-check", onSelect: approve },
    unavailable:
      !mayDecide() || blocked()
        ? {
            text: blocked() ?? (props.staleComparison ? ta().staleTitle : props.own ? ta().ownSub : ta().decideForbidden),
            icon: "ti ti-lock",
          }
        : undefined,
  });
  const openFrame = (short: boolean) => (
    <ApprovalFrame
      locale={locale()}
      state="open"
      source={{ name: t().source, icon: "ti ti-code" }}
      sentence={sentenceOf(t().question({ n: props.number, title: props.title }))}
      reason={{ text: props.reason, icon: "ti ti-eye" }}
      details={short ? undefined : changesDetails()}
      meta={
        short
          ? [{ text: t().commentsGo({ n: total() }), icon: "ti ti-message-2" }]
          : [...(examplesFact() ? [examplesFact()!] : []), { text: t().boundTo({ n: props.number }), icon: "ti ti-lock" }]
      }
      more={answers().more}
      decline={answers().decline}
      confirm={answers().confirm}
      unavailable={answers().unavailable}
    />
  );

  /** A closed approval: the same frame with its state, what happened, the message, and the way on. */
  const closedFrame = () => {
    const decision = props.decision;
    const pendingUnknown = unknown();
    const mine = decision?.byId === props.viewerId;
    const status = (): NonNullable<ApprovalFrameProps["status"]> => {
      if (pendingUnknown) return { tone: "warning", label: t().statusUnknown };
      if (decision?.outcome === "approved") return { tone: "done", label: t().statusApproved };
      if (decision?.outcome === "changes_requested") return { tone: "warning", label: t().statusChanges };
      if (decision?.outcome === "rejected") return { tone: "error", label: t().statusRejected };
      if (props.status === "withdrawn") return { tone: "off", label: t().statusWithdrawn };
      if (props.status === "superseded" || props.status === "cancelled") return { tone: "off", label: t().statusSuperseded };
      return { tone: "expired", label: t().statusExpired };
    };
    const sentence = (): string => {
      if (pendingUnknown) return t().unknownSentence({ n: props.number });
      if (decision) {
        const who = decision.by;
        if (decision.outcome === "approved")
          return mine ? t().youApproved({ n: props.number }) : t().otherApproved({ who, n: props.number });
        if (decision.outcome === "changes_requested")
          return mine ? t().youChanges({ n: props.number }) : t().otherChanges({ who, n: props.number });
        return mine ? t().youRejected({ n: props.number }) : t().otherRejected({ who, n: props.number });
      }
      if (props.status === "withdrawn") return t().withdrawnSentence({ who: props.recipient, n: props.number });
      return t().closedSentence({ n: props.number });
    };
    const why = (): { text: string; icon: string } => {
      if (pendingUnknown) return { text: t().unknownWhy, icon: "ti ti-alert-triangle" };
      // The author reading their own decided version is addressed directly, not told about a notification to themselves.
      const self = props.own;
      if (decision?.outcome === "approved")
        return self
          ? { text: t().afterApprovedSelf, icon: "ti ti-info-circle" }
          : { text: t().afterApproved({ who: props.recipient }), icon: "ti ti-bell" };
      if (decision?.outcome === "changes_requested")
        return self
          ? { text: t().afterChangesSelf({ keep: keep() }), icon: "ti ti-info-circle" }
          : { text: t().afterChanges({ who: props.recipient, keep: keep() }), icon: "ti ti-bell" };
      if (decision?.outcome === "rejected")
        return self
          ? { text: t().afterRejectedSelf({ n: props.number, keep: keep() }), icon: "ti ti-info-circle" }
          : { text: t().afterRejected({ who: props.recipient, n: props.number, keep: keep() }), icon: "ti ti-bell" };
      return { text: props.status === "withdrawn" ? keep() : t().closedWhy, icon: "ti ti-info-circle" };
    };
    const message = (): { label: string; text: string; who: string; avatar: string; avatarId: string | null; at: string | null } | null => {
      if (pendingUnknown?.text)
        return {
          label: t().unconfirmedMessage,
          text: pendingUnknown.text,
          who: t().youCap,
          avatar: t().youCap,
          avatarId: props.viewerId,
          at: null,
        };
      if (!decision?.comment) return null;
      const label = mine ? (decision.outcome === "rejected" ? t().yourReason : t().yourMessage) : t().theirMessage({ who: decision.by });
      return {
        label,
        text: decision.comment,
        who: mine ? t().youCap : decision.by,
        avatar: decision.by,
        avatarId: decision.byId,
        at: decision.at,
      };
    };
    return (
      <ApprovalFrame
        locale={locale()}
        state="decided"
        source={{ name: t().source, icon: "ti ti-code" }}
        status={status()}
        reason={{ text: why().text }}
        resultAnchor
        sentence={sentenceOf(sentence())}
        details={
          message()
            ? {
                label: message()!.label,
                content: () => (
                  <div class="core-code-review__message">
                    <CloudAvatar username={message()!.avatar} userId={message()!.avatarId} size="xs" />
                    <div>
                      <p class="core-code-review__message-head">
                        {message()!.who}
                        <Show when={message()!.at}>{(at) => <span> · {when(at())}</span>}</Show>
                      </p>
                      <p class="core-code-review__comment">{message()!.text}</p>
                    </div>
                  </div>
                ),
              }
            : undefined
        }
        confirm={
          pendingUnknown
            ? { label: t().checkState, filled: false, onSelect: () => reloadCodeArea() }
            : {
                label: props.nextHref ? t().nextApproval : t().backToList,
                href: props.nextHref ?? props.listHref,
                filled: false,
              }
        }
      />
    );
  };

  const frame = (short: boolean) => (closed() ? closedFrame() : openFrame(short));

  // ---------- Notices ----------
  const notices = () => (
    <>
      <Show when={arrival()?.kind === "conflict" && props.decision}>
        {(decision) => (
          <NoticeCard
            id={RESULT_ID}
            tabIndex={-1}
            tone="warning"
            icon="ti ti-users"
            title={t().conflictTitle({ who: props.decision?.by ?? t().unknownAuthor, n: props.number })}
            detail={t().conflictSub}
            data-decision={String(Boolean(decision()))}
          />
        )}
      </Show>
      <Show when={arrival()?.kind === "withdrawn"}>
        <NoticeCard
          id={RESULT_ID}
          tabIndex={-1}
          tone="danger"
          icon="ti ti-alert-circle"
          title={t().withdrawnTitle({ n: props.number })}
          detail={t().withdrawnSub({ keep: keep() })}
        />
      </Show>
      <Show when={props.previous}>
        {(previous) => (
          <NoticeCard
            tone="neutral"
            icon="ti ti-message-2"
            title={t().previousTitle({ n: previous().number })}
            detail={
              <div class="core-code-review__previous">
                <p>{previous().message}</p>
                <Show when={previous().comments.length}>
                  <p class="core-code-review__muted">{t().previousComments({ n: previous().comments.length })}</p>
                  <ul class="core-code-review__previous-list">
                    <For each={previous().comments}>
                      {(comment) => (
                        <li>
                          <strong>{comment.author.id === props.viewerId ? t().youCap : (comment.author.name ?? t().unknownAuthor)}</strong>
                          {" · "}
                          {comment.body}
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </div>
            }
          />
        )}
      </Show>
      <Show when={pending() && props.newer}>
        {(newer) => (
          <NoticeCard
            tone="warning"
            icon="ti ti-git-branch"
            title={ta().newerTitle({ who: newer().author, n: newer().number })}
            detail={
              <>
                <p>{ta().newerSub({ n: props.number })}</p>
                <div class="mt-2">
                  <ButtonLink size="sm" href={newer().href}>
                    {ta().reviewNewer({ n: newer().number })}
                  </ButtonLink>
                </div>
              </>
            }
          />
        )}
      </Show>
      <Show when={pending() && !props.newer && props.staleComparison}>
        <NoticeCard tone="warning" title={ta().staleTitle} detail={ta().staleSub} />
      </Show>
      <Show when={pending() && props.own && !props.soleAdminNotice}>
        <NoticeCard tone="neutral" icon="ti ti-user-x" title={ta().ownTitle} detail={ta().ownSub} />
      </Show>
      <Show when={pending() && props.soleAdminNotice}>
        <NoticeCard tone="neutral" icon="ti ti-user-shield" title={ta().soleTitle} />
      </Show>
      <For each={props.readModel?.notices.items ?? []}>
        {(notice) => (
          <NoticeCard
            tone={notice.severity === "block" ? "danger" : "warning"}
            icon={notice.severity === "block" ? "ti ti-ban" : "ti ti-alert-triangle"}
            title={notice.text}
            detail={notice.consequence}
          />
        )}
      </For>
      <Show when={failure()}>
        {(message) => (
          <NoticeCard
            id={FAILURE_ID}
            tabIndex={-1}
            tone="danger"
            title={message()}
            detail={signOutFailed() ? <span role="alert">{ta().signOutFailed}</span> : undefined}
            actions={
              <div class="flex flex-wrap gap-2">
                <Show when={failureCode() === "REAUTHENTICATE"}>
                  <Show
                    when={!signOutFailed()}
                    fallback={
                      <Button size="sm" variant="secondary" onClick={() => reloadCodeArea()}>
                        <i class="ti ti-refresh" aria-hidden="true" />
                        {ta().reload}
                      </Button>
                    }
                  >
                    <ButtonLink size="sm" href={signInHref()} navigation="document">
                      {ta().signInAgain}
                    </ButtonLink>
                  </Show>
                  <Button
                    size="sm"
                    variant="secondary"
                    wrap
                    loading={signingOut()}
                    disabled={!props.authorUserId}
                    onClick={() => void signInAdmin()}
                  >
                    {ta().signInAdmin}
                  </Button>
                </Show>
                <Show when={failureCode() === "NOT_FOUND"}>
                  <ButtonLink size="sm" variant="secondary" href={props.listHref}>
                    {t().backToList}
                  </ButtonLink>
                </Show>
                <Show when={failureCode() !== "REAUTHENTICATE"}>
                  <Button size="sm" variant="secondary" onClick={() => reloadCodeArea()}>
                    <i class="ti ti-refresh" aria-hidden="true" />
                    {ta().reload}
                  </Button>
                </Show>
              </div>
            }
          />
        )}
      </Show>
    </>
  );

  // ---------- Overview ----------
  const description = () => {
    const model = props.readModel?.description;
    return (
      <Section
        frame="line"
        title={t().whatItDoes}
        actions={
          <span class="core-code-review__ai-mark">
            <i class="ti ti-sparkles" aria-hidden="true" />
            {/* The read model's label may bring its own sign; the mark draws it once. */}
            {(model?.modelLabel ?? t().aiMark).replace(/^\s*✦\s*/, "")}
          </span>
        }
      >
        <Show
          when={explanation()}
          fallback={
            <Show
              when={!explaining()}
              fallback={
                <div class="grid gap-2 py-0.5" role="status" aria-label={t().whatItDoes}>
                  <Skeleton class="h-3 w-full" />
                  <Skeleton class="h-3 w-4/5" />
                </div>
              }
            >
              <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                {/* A decided version asks for no explanation by itself: its empty state is a line, next to the button. */}
                <Show when={explainFailed() || (closed() && props.decision)}>
                  <p class="core-code-review__muted">{explainFailed() ? t().explainFailed : t().noDescription}</p>
                </Show>
                <Button size="sm" variant="secondary" onClick={() => void explain()}>
                  <i class={`ti ${explainFailed() ? "ti-refresh" : "ti-sparkles"}`} aria-hidden="true" />
                  {explainFailed() ? t().explainRetry : t().explain}
                </Button>
              </div>
            </Show>
          }
        >
          {(text) => <p class="core-code-review__text">{text()}</p>}
        </Show>
      </Section>
    );
  };

  const commentsIsland = () => (
    <Show when={threads().length}>
      <Section
        frame="line"
        title={t().commentsTitle}
        count={total()}
        actions={
          <button type="button" class="k2b-text-link core-code-review__link" onClick={() => chooseTab("code")}>
            {t().seeInCode}
          </button>
        }
      >
        <div class="core-code-review__overview-threads">
          <Show when={olderCursor()}>
            <LoadMore hasMore auto={false} side="start" label={t().olderComments} onLoadMore={loadOlder} count={comments().length} />
          </Show>
          <For each={threads()}>
            {(thread) => (
              <Discussion.Thread label={t().threadLabel({ path: thread.path, n: thread.line })} placeholder="" submitLabel="">
                <For each={thread.entries}>{(comment) => entry(comment, false)}</For>
              </Discussion.Thread>
            )}
          </For>
          <p class="core-code-review__muted">
            {props.next === "cli" ? t().commentsFootCli({ who: props.recipient }) : t().commentsFoot({ who: props.recipient })}
          </p>
        </div>
      </Section>
    </Show>
  );

  const mayDo = () => {
    const model = props.readModel;
    if (!model) return null;
    // Two automations with the same wording (two pages for members, say) read as one line.
    const rows = (items: readonly { text: string; note?: string }[]) => (
      <For each={items.filter((row, index) => items.findIndex((other) => other.text === row.text && other.note === row.note) === index)}>
        {(row) => (
          <span class="core-code-review__may-row">
            {row.text}
            <Show when={row.note}>{(note) => <span class="core-code-review__muted"> · {note()}</span>}</Show>
          </span>
        )}
      </For>
    );
    return (
      <Section frame="line" title={t().mayDo({ n: props.number })}>
        <dl class="core-code-review__may">
          <Show when={model.timing.items.length}>
            <dt>{t().mayRuns}</dt>
            <dd>{rows(model.timing.items)}</dd>
          </Show>
          <dt>{t().mayApps}</dt>
          <dd>
            <Show when={model.mayDo.items.length} fallback={t().mayNothing}>
              {rows(model.mayDo.items)}
            </Show>
            <Show when={model.mayDo.moreText}>{(more) => <span class="core-code-review__muted">{more()}</span>}</Show>
          </dd>
        </dl>
      </Section>
    );
  };

  const examples = () => {
    const model = props.readModel?.examples;
    if (!model || model.state === "unavailable" || model.state === "none") return null;
    return (
      <Section frame="line" title={t().examples} meta={model.summary} description={model.explanation}>
        <ul class="core-code-review__examples">
          <For each={model.items}>
            {(example) => (
              <li class="core-code-review__example">
                <i
                  class={example.state === "succeeded" ? "ti ti-circle-check" : "ti ti-circle-x"}
                  data-tone={example.state === "succeeded" ? "success" : "danger"}
                  aria-hidden="true"
                />
                <span class="core-code-review__example-text">
                  <strong>{example.name}</strong>
                  <span class="core-code-review__muted">{example.sentence}</span>
                </span>
                <StatusBadge tone={example.state === "succeeded" ? "ok" : "error"} variant="text" icon={null} label={example.status} />
              </li>
            )}
          </For>
        </ul>
      </Section>
    );
  };

  const overview = () => (
    <div class="core-code-review__panel">
      {frame(false)}
      <div class="core-code-review__columns">
        <div class="core-code-review__column">
          {description()}
          {commentsIsland()}
        </div>
        <div class="core-code-review__column">
          {mayDo()}
          {examples()}
        </div>
      </div>
    </div>
  );

  const codeView = (view: "code" | "diff") => (
    <div class="core-code-review__panel">
      {frame(true)}
      {codeField(view)}
    </div>
  );

  // Built once: the tab options are read again whenever a count changes, and the views must keep their state.
  const overviewPanel = overview();
  const codePanel = codeView("code");
  const diffPanel = codeView("diff");
  const codeCount = (
    <span class="core-code-review__count">
      <i class="ti ti-message-2" aria-hidden="true" />
      {total()}
    </span>
  );
  const diffCount = (
    <span class="core-code-review__count">
      <span data-tone="add">+{stat().add}</span> <span data-tone="del">−{stat().del}</span>
    </span>
  );

  return (
    <div class="core-code-review">
      <div class="core-code-review__notices">{notices()}</div>
      <Tabs
        ariaLabel={t().tabsLabel}
        value={tab}
        onValueChange={(value) => chooseTab(value)}
        options={[
          { value: "overview", label: t().tabOverview, panel: overviewPanel },
          {
            value: "code",
            label: t().tabCode,
            count: codeCount,
            countReserve: "99",
            countLabel: t().commentCount({ n: total() }),
            panel: codePanel,
          },
          first()
            ? { value: "diff", label: t().tabDiff, disabled: true, panel: diffPanel }
            : {
                value: "diff",
                label: t().tabDiff,
                count: diffCount,
                countReserve: "+999 −999",
                countLabel: t().diffCount({ add: stat().add, del: stat().del }),
                panel: diffPanel,
              },
        ]}
      />
      <Show when={first()}>
        <span class="k2b-sr-only">{t().diffFirst}</span>
      </Show>
    </div>
  );
}
