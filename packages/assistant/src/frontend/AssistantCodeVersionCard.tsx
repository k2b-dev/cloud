import { ApprovalFrame, type ApprovalFrameProps } from "@k2b/cloud/approvals/ui";
import type { CodeVersionReadModel } from "@k2b/cloud/contracts/code-read-model";
import { Avatar, Button, ChangeList, type ChangeListItem, Chat, type ChatOutcomeLine, Skeleton, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { loadCodeNextRun } from "../code-summary";
import { matchesAssistantInvalidation, useAssistantLive } from "./assistant-live";
import {
  type CodeVersionActivation,
  type CodeVersionPreview,
  type CodeVersionReview,
  codeVersionPageHref,
  loadCodeVersionPreview,
  loadCodeVersionReview,
  loadCodeVersionWords,
  pendingCodeVersionActivation,
  readCodeVersionActivation,
  requestCodeVersionAgain,
  startCodeVersionActivation,
  stopCodeReviewRevision,
  withdrawCodeVersion,
} from "./code-activation";
import { browserCodeInvoke, formatCodeTime } from "./code-client";
import { codeVersionCardMessages } from "./code-version-card-messages";

const POLLS = 90;
const POLL_MS = 1_000;
/** A version submitted this recently appears with its motion; anything older is history and stays still. */
const APPEAR_WINDOW_MS = 2 * 60_000;
/** A status that could not be read is read again by itself after this long, as the card says. */
const RECHECK_MS = 30_000;
/** The Code app's icon and colour, the same tile as on the Code page. */
const SOURCE_ICON = "ti ti-code";

type Loaded = { preview: CodeVersionPreview; review: CodeVersionReview | null; words: CodeVersionReadModel | null };
type Activation =
  | { kind: "idle" }
  | { kind: "progress"; state: CodeVersionActivation["state"] }
  /** Core's answer is missing or the wait ended: the activation may still run, so nothing claims it did not. */
  | { kind: "unknown" }
  /** Even the status read failed; Cloud reads it again by itself. */
  | { kind: "unreadable" }
  | { kind: "failed"; reason: string | null };

/** The anchor the event line at the end of the chat jumps to. */
export const codeVersionCardAnchor = (versionId: string) => `code-version-${versionId}`;

/** The code a refused version carries when a Cloud administrator rejected it, or revoked its approval. */
const REJECTED = "code_approval_revoked";

/** A conversation message below the card: then the card keeps its full form after switching on in this session. */
const historyBelow = (element: Element | null | undefined): boolean => {
  let node: Element | null = element?.closest("article.k2b-chat-message") ?? null;
  while (node && !node.matches("[data-scroll-preserve], body")) {
    for (let next = node.nextElementSibling; next; next = next.nextElementSibling) {
      if (next.matches("article.k2b-chat-message") || next.querySelector("article.k2b-chat-message")) return true;
    }
    node = node.parentElement;
  }
  return false;
};

/**
 * One saved version of a Code in the chat, in the one approval form Cloud uses everywhere: a question, why it is asked,
 * what changes against the running version, what holds until then, and the answers. It shows no source, file or line.
 * Its state follows Core: the activation preview, the review as the person sees it, and the version in words. A
 * decision or a switch-on elsewhere arrives on the live channel and the card reads its state again in place.
 */
export default function AssistantCodeVersionCard(props: {
  codeId: string;
  versionId: string;
  number: number;
  timeZone: string;
  onActivated?: () => void;
  /** Sends a prepared message to Gustav, such as "Revise version 5 the way Jana wants it". */
  onAsk?: (text: string) => void;
}) {
  const locale = useLocale();
  const live = useAssistantLive();
  const t = createMemo(() => codeVersionCardMessages.resolve([locale()]).t);
  const [loaded, setLoaded] = createSignal<Loaded | "failed" | "denied" | null>(null);
  const [activation, setActivation] = createSignal<Activation>({ kind: "idle" });
  const [nextRun, setNextRun] = createSignal<string | null>(null);
  /** Switched on here while history stands below: the card keeps its full form for this session. */
  const [stayFull, setStayFull] = createSignal(false);
  const [withdrawError, setWithdrawError] = createSignal(false);
  /** "Ask again" submits a new version; the card then follows it under its original anchor. */
  const [versionId, setVersionId] = createSignal(props.versionId);
  const [number, setNumber] = createSignal(props.number);
  /** A stop that came after Gustav had submitted: the number of that version. */
  const [tooLate, setTooLate] = createSignal<number | null>(null);
  const [actionError, setActionError] = createSignal<string | null>(null);
  /** The version was submitted moments ago and this is its first paint: the approval appears once (6a). */
  const [appear, setAppear] = createSignal(false);
  let firstPaint = true;
  let root: HTMLDivElement | undefined;
  let disposed = false;
  let recheck: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    disposed = true;
    clearTimeout(recheck);
  });

  /** Reads overlap when a decision arrives during a read; only the newest one decides what the card shows. */
  let reads = 0;
  let newest: Promise<boolean> = Promise.resolve(true);
  /** `live`: a read for a live update keeps a shown card when it fails, so the update is tried again. */
  const load = (live = false): Promise<boolean> => {
    const read = ++reads;
    const run = (async (): Promise<boolean> => {
      const [preview, review, words] = await Promise.all([
        loadCodeVersionPreview(props.codeId, versionId()),
        loadCodeVersionReview(props.codeId, versionId()),
        loadCodeVersionWords(props.codeId, versionId()),
      ]);
      // A running version shows its next run in the same paint as its line, so nothing moves once it arrives.
      const next =
        typeof preview === "object" && preview.running === number() ? await loadCodeNextRun(browserCodeInvoke, props.codeId) : null;
      if (read !== reads) return newest;
      if (preview === "failed" && live && loaded() !== null) return false;
      // A decision's review that could not be read is tried again by the live channel, never shown as a guess.
      if (live && typeof preview === "object" && review === null && loaded() !== null) return false;
      setNextRun(next);
      if (firstPaint && typeof preview === "object") {
        firstPaint = false;
        const age = words ? Date.now() - Date.parse(words.submittedAt) : Number.POSITIVE_INFINITY;
        setAppear(age >= 0 && age < APPEAR_WINDOW_MS);
      }
      setLoaded(typeof preview === "object" ? { preview, review, words } : preview);
      return preview !== "failed";
    })();
    newest = run;
    return run;
  };

  // One identity per attempt: after a lost answer, asking again with it returns the same durable activation.
  let pending = pendingCodeVersionActivation(props.codeId, versionId());
  let activationId = pending.read() ?? crypto.randomUUID();
  const finish = () => {
    pending.write(null);
    activationId = crypto.randomUUID();
  };
  /** Applies one status; true when it ended the wait. */
  const settle = (status: CodeVersionActivation): boolean => {
    if (status.state === "active") {
      pending.write(null);
      props.onActivated?.();
      // The answer stays busy until the card reads the new state, so it never offers itself again in between.
      void load().then(() => setActivation({ kind: "idle" }));
      return true;
    }
    if (status.state === "failed" || status.state === "cancelled") {
      finish();
      setActivation({ kind: "failed", reason: status.failure?.reason ?? null });
      return true;
    }
    setActivation({ kind: "progress", state: status.state });
    return false;
  };
  const follow = async () => {
    for (let poll = 0; poll < POLLS && !disposed; poll++) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      if (disposed) return;
      const read = await readCodeVersionActivation(props.codeId, activationId);
      if (read.ok && settle(read.status)) return;
    }
    if (!disposed) setActivation({ kind: "unknown" });
  };
  /** Reads the status only; it never starts an activation. */
  const check = async () => {
    clearTimeout(recheck);
    setActivation({ kind: "progress", state: "pending" });
    const read = await readCodeVersionActivation(props.codeId, activationId);
    if (read.ok) {
      if (!settle(read.status)) await follow();
      return;
    }
    // Core has no such activation: nothing changed, and switching on again may reuse this identity.
    if (read.notFound) {
      pending.write(null);
      setActivation({ kind: "failed", reason: null });
      return;
    }
    setActivation({ kind: "unreadable" });
    if (!disposed) recheck = setTimeout(() => void check(), RECHECK_MS);
  };
  const start = async () => {
    setStayFull(historyBelow(root));
    setActivation({ kind: "progress", state: "pending" });
    pending.write(activationId);
    const started = await startCodeVersionActivation(props.codeId, versionId(), activationId);
    if (started.ok) {
      if (!settle(started.status)) await follow();
      return;
    }
    if (started.definite) {
      // Core refused before acting; a later attempt is a new activation.
      finish();
      setActivation({ kind: "failed", reason: started.message });
      return;
    }
    // The answer was lost: Core may have accepted. Its status says what happened.
    await check();
  };
  /** Stops Gustav's automatic revision, at the card or as "Don't start" while it waits. */
  const stopRevision = async () => {
    setActionError(null);
    const answer = await stopCodeReviewRevision(props.codeId, versionId());
    if (!answer) {
      setActionError(t().stopFailed);
      return;
    }
    if (answer.status === "too_late") setTooLate(answer.submittedNumber);
    await load();
  };
  const askAgain = async () => {
    setActionError(null);
    const next = await requestCodeVersionAgain(props.codeId, versionId());
    if (!next) {
      setActionError(t().askAgainFailed);
      return;
    }
    pending = pendingCodeVersionActivation(props.codeId, next.id);
    activationId = pending.read() ?? crypto.randomUUID();
    setVersionId(next.id);
    setNumber(next.number);
    await load();
  };
  const withdraw = async () => {
    setWithdrawError(false);
    if (await withdrawCodeVersion(props.codeId, versionId())) await load();
    else setWithdrawError(true);
  };

  onMount(() => {
    void load();
    // A card opened while an earlier attempt is unresolved continues with that attempt.
    if (pending.read()) void check();
    // Every state can change elsewhere: a decision, a switch-on in another tab, a newer version. The card follows all
    // of them on the live channel and reads its state again; nothing polls for it.
    const changed = matchesAssistantInvalidation(["code-versions"]);
    onCleanup(
      live.register({
        matches: changed,
        // A failed read keeps the card and fails the update, so the live channel tries it again.
        invalidate: async () => {
          if (!(await load(true))) throw new Error("The Code version could not be read again.");
        },
      }),
    );
  });

  const current = () => {
    const value = loaded();
    return value && typeof value === "object" ? value : null;
  };
  /** The version that runs until this one is switched on; `null` for a first version. */
  const keep = () => current()?.preview.running ?? null;
  const when = (iso: string) => {
    const day = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: props.timeZone, dateStyle: "short" }).format(date);
    try {
      if (day(new Date(iso)) === day(new Date())) {
        const time = new Intl.DateTimeFormat(locale(), { timeZone: props.timeZone, timeStyle: "short" }).format(new Date(iso));
        return { short: time, phrase: t().todayAt({ time }) };
      }
    } catch {
      /* An unknown time zone falls back to the full date below. */
    }
    const date = formatCodeTime(iso, locale(), props.timeZone);
    return { short: date, phrase: t().onDate({ date }) };
  };
  const relativeRun = (iso: string) => {
    const minutes = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
    if (minutes >= 0 && minutes < 24 * 60) {
      const format = new Intl.RelativeTimeFormat(locale(), { numeric: "auto" });
      return minutes < 60 ? format.format(minutes, "minute") : format.format(Math.round(minutes / 60), "hour");
    }
    return when(iso).phrase;
  };
  const sentence = (verb: string): NonNullable<ApprovalFrameProps["sentence"]> => [
    { kind: "chip", chip: { kind: "object", title: t().versionChip({ version: number() }) } },
    { kind: "text", text: ` ${t().of} ` },
    { kind: "chip", chip: { kind: "object", title: current()?.preview.title ?? "" } },
    { kind: "text", text: ` ${verb}` },
  ];
  const ask = (text: string) => () => props.onAsk?.(text);
  const page = () => {
    const value = current();
    const href = value ? codeVersionPageHref(value.preview) : null;
    return href ? `${href}?tab=versions&version=${encodeURIComponent(versionId())}` : null;
  };
  const runsHref = () => {
    const value = current();
    const href = value ? codeVersionPageHref(value.preview) : null;
    return href ? `${href}?tab=runs` : null;
  };
  const seeAll = () => {
    const href = page();
    return href ? { label: t().seeAll, href } : undefined;
  };

  /** What changes against the running version: added in plum, dropped in grey, the same as one counted row. */
  const changes = createMemo((): ChangeListItem[] => {
    const words = current()?.words;
    if (!words) return [];
    const rows = words.changes.rows;
    const href = page();
    const items: ChangeListItem[] = rows.items.map((row) => ({
      tone: row.kind === "add" ? "add" : row.kind === "remove" ? "remove" : "neutral",
      icon: row.kind === "same" ? "ti ti-equal" : undefined,
      // What stays the same is listed on the Code page; the card counts it and links there.
      content:
        row.kind === "same" && href ? (
          <>
            {row.text}.{" "}
            <a class="k2b-text-link" href={href}>
              {t().show}
            </a>
          </>
        ) : (
          row.text
        ),
      detail: row.requiresApproval ? (
        <span class="assistant-code-version__needs">
          <i class="ti ti-eye" aria-hidden="true" />
          {t().needsApproval}
        </span>
      ) : (
        row.note
      ),
    }));
    if (rows.more > 0 && rows.moreText) items.push({ tone: "neutral", icon: "ti ti-dots", content: rows.moreText });
    if (items.length === 0 && words.changes.state === "same") items.push({ tone: "neutral", icon: "ti ti-equal", content: t().sameText });
    return items;
  });
  const changeKind = () => {
    const words = current()?.words;
    if (!words || words.changes.state === "first" || keep() === null) return "first" as const;
    const rows = words.changes.rows.items;
    if (rows.some((row) => row.kind === "add")) return "more" as const;
    if (rows.some((row) => row.kind === "remove")) return "less" as const;
    return "same" as const;
  };
  const versionReason = (on: boolean) => {
    const version = keep() ?? 0;
    const kind = changeKind();
    const text = on
      ? {
          first: t().reasonOnFirst,
          more: t().reasonOnMore({ version }),
          less: t().reasonOnLess({ version }),
          same: t().reasonOnSame({ version }),
        }[kind]
      : { first: t().reasonFirst, more: t().reasonMore({ version }), less: t().reasonLess({ version }), same: t().reasonSame({ version }) }[
          kind
        ];
    return { text, icon: "ti ti-eye" };
  };
  const changeDetails = (): ApprovalFrameProps["details"] => {
    const words = current()?.words;
    if (!words || changes().length === 0) return undefined;
    const label = changeKind() === "first" ? t().detailsFirst : t().detailsAgainst({ version: keep() ?? 0 });
    return {
      label,
      content: <ChangeList items={changes()} label={label} />,
      note: { text: words.changes.assurance, icon: "ti ti-info-circle" },
    };
  };
  const examples = () => {
    const words = current()?.words;
    if (words) {
      if (words.examples.state === "none") return null;
      if (words.examples.total > 0)
        return {
          text: t().examples({ passed: words.examples.passed, total: words.examples.total }),
          icon: words.examples.state === "passed" ? "ti ti-circle-check" : "ti ti-alert-triangle",
          tone: words.examples.state === "passed" ? ("success" as const) : ("warning" as const),
        };
    }
    const tests = current()?.preview.tests;
    if (!tests || tests.state === "none" || tests.total === 0) return tests?.state === "none" ? null : undefined;
    return {
      text: t().examples({ passed: tests.passed, total: tests.total }),
      icon: tests.state === "passed" ? "ti ti-circle-check" : "ti ti-alert-triangle",
      tone: tests.state === "passed" ? ("success" as const) : ("warning" as const),
    };
  };
  const exampleFacts = () => {
    const fact = examples();
    if (fact === null) return [{ text: t().noExamples, icon: "ti ti-alert-triangle", tone: "warning" as const }];
    return fact ? [fact] : [];
  };
  const keepFact = () => ({ text: t().keepFoot({ keep: keep() }), icon: "ti ti-history" });

  /** The admin's message and the comments as text: who, when, what. Never a file or a line. */
  const reviewDetails = (label: (input: { name: string }) => string): ApprovalFrameProps["details"] => {
    const review = current()?.review;
    if (!review) return undefined;
    const name = review.decidedBy?.name ?? t().adminSomeone;
    const at = review.decidedAt ? when(review.decidedAt).phrase : null;
    const roots = review.comments.filter((comment) => !comment.parentId);
    return {
      label: label({ name }),
      content: (
        <div class="assistant-code-version__review">
          <Show when={review.message}>{(message) => <ReviewEntry name={name} role={t().adminRole} at={at} text={message()} />}</Show>
          <Show when={review.comments.length > 0}>
            <div class="assistant-code-version__comments">
              <p class="assistant-code-version__comments-label">{t().comments({ count: review.commentCount || roots.length })}</p>
              <For each={review.comments}>
                {(comment) => (
                  <ReviewEntry
                    name={comment.author.name ?? t().adminSomeone}
                    role={t().adminRole}
                    at={when(comment.createdAt).phrase}
                    text={comment.body}
                  />
                )}
              </For>
              <Show when={review.commentCount > review.comments.length}>
                <p class="assistant-code-version__comments-label">
                  {t().moreComments({ count: review.commentCount - review.comments.length })}
                </p>
              </Show>
            </div>
          </Show>
        </div>
      ),
    };
  };

  /** A compact state: the head with its word, one line, and at most one small answer. */
  const compact = (
    status: NonNullable<ApprovalFrameProps["status"]>,
    line: Omit<ChatOutcomeLine, "tone"> & { tone?: ChatOutcomeLine["tone"] },
    state: ApprovalFrameProps["state"] = "decided",
  ): ApprovalFrameProps => ({
    locale: locale(),
    state,
    source: { name: t().source, icon: SOURCE_ICON },
    status,
    reason: { text: "" },
    outcome: <Chat.Outcome lines={{ line: { tone: status.tone === "expired" ? "off" : status.tone, ...line } }} current="line" />,
  });
  const small = (label: string, onClick: () => void, icon?: string) => (
    <Button type="button" variant="secondary" class="k2b-chat-decision__answer" onClick={onClick}>
      <Show when={icon}>{(name) => <i class={name()} aria-hidden="true" />}</Show>
      {label}
    </Button>
  );

  const frame = createMemo((): ApprovalFrameProps => {
    const value = loaded();
    const words = t();
    const base = { locale: locale(), source: { name: words.source, icon: SOURCE_ICON }, anchorId: codeVersionCardAnchor(props.versionId) };
    // Loading keeps the room of the question it will become: sentence, reason, and the details on white.
    if (value === null)
      return {
        ...base,
        state: "decided",
        status: { tone: "running", label: words.loadingWord },
        reason: { text: "" },
        outcome: (
          <div class="assistant-code-version__loading" role="status" aria-busy="true" aria-label={words.loading}>
            <Skeleton class="assistant-code-version__skeleton assistant-code-version__skeleton--sentence" />
            <Skeleton class="assistant-code-version__skeleton assistant-code-version__skeleton--reason" />
            <div class="assistant-code-version__skeleton-details">
              <Skeleton class="assistant-code-version__skeleton assistant-code-version__skeleton--label" />
              <Skeleton class="assistant-code-version__skeleton assistant-code-version__skeleton--row" />
              <Skeleton class="assistant-code-version__skeleton assistant-code-version__skeleton--row" />
              <Skeleton class="assistant-code-version__skeleton assistant-code-version__skeleton--short" />
            </div>
          </div>
        ),
      };
    if (value === "failed")
      return {
        ...compact(
          { tone: "error", label: words.statusNotLoaded },
          { text: words.lineNotLoaded, actions: small(words.retry, () => void load(), "ti ti-refresh") },
        ),
        anchorId: base.anchorId,
      };
    if (value === "denied")
      return {
        ...compact({ tone: "off", label: words.statusNoAccess, icon: "ti ti-lock" }, { text: words.lineNoAccess }),
        anchorId: base.anchorId,
      };
    const { preview, review } = value;
    const status = review?.status;
    const act = activation();
    const withAnchor = (frameProps: ApprovalFrameProps): ApprovalFrameProps => ({ ...frameProps, anchorId: base.anchorId });

    // Switched on: compact, unless history stands below and it was switched on here, then the same full form.
    if (preview.running === number()) {
      const at = preview.activated ? when(preview.activated.at) : null;
      if (stayFull())
        return {
          ...base,
          state: "open",
          status: { tone: "done", label: words.statusOn },
          sentence: sentence(words.isOn),
          reason: versionReason(true),
          details: changeDetails(),
          notes: [
            { text: words.youSwitched({ when: at?.phrase ?? words.todayAt({ time: "" }) }), icon: "ti ti-power" },
            { text: nextRun() ? words.nextRun({ when: relativeRun(nextRun()!) }) : words.noNextRun, icon: "ti ti-clock" },
          ],
          meta: exampleFacts(),
          link: runsHref() ? { label: words.seeRuns, href: runsHref()! } : undefined,
        };
      const runs = runsHref();
      return withAnchor(
        compact(
          { tone: "done", label: words.statusOn },
          {
            text: at ? words.lineOn({ version: number(), when: at.short }) : words.lineOnPlain({ version: number() }),
            detail: nextRun() ? words.lineNextRun({ when: relativeRun(nextRun()!) }) : undefined,
            action: runs ? { label: words.seeRuns, onSelect: () => window.location.assign(runs) } : undefined,
          },
        ),
      );
    }
    if ((preview.latest ?? 0) > number() || status === "superseded")
      return withAnchor(
        compact(
          { tone: "off", label: words.statusSuperseded, icon: "ti ti-history" },
          {
            text: words.lineSuperseded({ version: number(), latest: Math.max(preview.latest ?? 0, number() + 1) }),
            detail: tooLate() ? words.tooLate({ version: tooLate()! }) : undefined,
          },
        ),
      );
    if (status === "withdrawn")
      return withAnchor(
        compact(
          { tone: "off", label: words.statusWithdrawn, icon: "ti ti-arrow-back-up" },
          { text: words.lineWithdrawn({ version: number(), keep: keep() }) },
        ),
      );
    if (status === "expired")
      return withAnchor(
        compact(
          { tone: "expired", label: words.statusExpired, icon: "ti ti-clock-off" },
          {
            text: words.lineExpired({ keep: keep() }),
            detail: actionError() ?? undefined,
            actions: small(words.askAgain, () => void askAgain()),
          },
        ),
      );
    const decider = review?.decidedBy?.name ?? words.adminSomeone;
    // The platform knows two outcomes: requested changes refuse the switch like a rejection, so the review decides.
    const rejected =
      status === "rejected" ||
      (status !== "changes_requested" && preview.readiness.state === "refused" && preview.readiness.code === REJECTED);
    if (rejected)
      return {
        ...base,
        state: "open",
        status: { tone: "error", label: words.statusRejected, icon: "ti ti-circle-x" },
        sentence: sentence(words.wasRejected),
        reason: { text: words.reasonRejected({ name: decider, keep: keep() }), icon: "ti ti-history" },
        details: reviewDetails(words.reasonFrom),
        more: props.onAsk
          ? [{ label: words.buildDifferently, icon: "ti ti-sparkles", onSelect: ask(words.askDifferently({ version: number() })) }]
          : undefined,
      };
    if (status === "changes_requested") {
      const revision = review?.revision ?? null;
      const second = (review?.origin.kind === "ai_chat" && review.origin.automaticAfterReview) || revision?.reason === "already_automatic";
      // Gustav's one automatic revision: it waits for the person's turn, runs, or did not start, and says why.
      const automatic = revision?.state === "queued" || revision?.state === "running";
      const foot = (): ApprovalFrameProps["meta"] => {
        if (actionError()) return [{ text: actionError()!, icon: "ti ti-alert-triangle", tone: "danger" }];
        if (revision?.state === "queued") return [{ text: words.reworkQueued, icon: "ti ti-clock", tone: "ai" }];
        if (revision?.state === "running") return [{ text: words.reworkRunning, icon: "ti ti-loader-2", tone: "ai" }];
        if (second) return [{ text: words.secondTimeFoot, icon: "ti ti-info-circle" }];
        if (revision?.state === "stopped" || revision?.reason === "stopped") return [{ text: words.reworkStopped, icon: "ti ti-player-stop" }];
        if (revision?.state === "skipped") {
          const reason = revision.reason;
          const text =
            reason === "quota"
              ? words.skippedQuota
              : reason === "conversation_gone" || reason === "access_lost"
                ? words.skippedGone
                : reason === "needs_person"
                  ? words.skippedPerson
                  : words.skippedUnavailable;
          return [{ text, icon: "ti ti-info-circle" }];
        }
        return [{ text: words.reworkFoot, icon: "ti ti-refresh" }];
      };
      return {
        ...base,
        state: "open",
        status: { tone: "warning", label: words.statusChanges, icon: "ti ti-message-2" },
        sentence: sentence(words.needsChanges),
        reason: { text: words.reasonChanges({ name: decider, keep: keep() }), icon: "ti ti-history" },
        details: reviewDetails(words.messageFrom),
        meta: foot(),
        // The same place for the one answer in every sub-state, so the card never moves: stop it, or ask for it.
        more: automatic
          ? [{ label: revision?.state === "queued" ? words.dontStart : words.stop, icon: "ti ti-player-stop", onSelect: () => stopRevision() }]
          : undefined,
        confirm:
          !automatic && props.onAsk
            ? {
                label: words.rework,
                icon: "ti ti-sparkles",
                onSelect: ask(words.askRework({ version: number(), name: review?.decidedBy?.name ?? null })),
              }
            : undefined,
      };
    }
    if (preview.readiness.state === "approval_pending" || status === "pending")
      return {
        ...base,
        state: "open",
        status: { tone: "warning", label: words.statusWaitingAdmin, icon: "ti ti-hourglass" },
        sentence: sentence(words.waitsAdmin),
        reason: {
          text: value.words?.changes.approval ? `${words.reasonAdmin} ${value.words.changes.approval.reason}` : words.reasonAdmin,
          icon: "ti ti-eye",
        },
        details: changeDetails(),
        notes: [
          { text: words.notesAdminKnow, icon: "ti ti-bell" },
          { text: words.notesKeep({ keep: keep() }), icon: "ti ti-history" },
        ],
        meta: withdrawError() ? [{ text: words.withdrawFailed, icon: "ti ti-alert-triangle", tone: "danger" }] : exampleFacts(),
        more: [
          { label: words.withdraw, onSelect: () => withdraw() },
          ...(props.onAsk
            ? [
                {
                  label: value.words?.changes.approval?.withoutLabel ?? words.withoutApproval,
                  icon: "ti ti-sparkles",
                  onSelect: ask(
                    value.words?.changes.approval?.accessLabel
                      ? words.askWithout({ version: number(), access: value.words.changes.approval.accessLabel })
                      : words.askWithoutApproval({ version: number() }),
                  ),
                },
              ]
            : []),
        ],
        link: seeAll(),
      };

    // Ready: the person decides. The activation's own states take the card's place while Cloud works on it.
    if (act.kind === "unknown")
      return withAnchor(
        compact(
          { tone: "warning", label: words.statusUnclear },
          { text: words.lineUnclear({ version: number() }), actions: small(words.checkStatus, () => void check()) },
        ),
      );
    if (act.kind === "unreadable")
      return withAnchor(
        compact(
          { tone: "warning", label: words.statusUnclear },
          { text: words.lineCheckFailed, actions: small(words.checkNow, () => void check()) },
        ),
      );
    if (act.kind === "failed")
      return withAnchor(
        compact(
          { tone: "error", label: words.statusFailed },
          {
            text: words.lineFailed({ keep: keep() }),
            detail: act.reason ?? undefined,
            actions: small(
              words.retry,
              () => {
                setActivation({ kind: "idle" });
                void start();
              },
              "ti ti-refresh",
            ),
          },
        ),
      );
    if (act.kind === "progress" && !stayFull())
      return withAnchor(
        compact({ tone: "running", label: words.statusSwitching }, { text: words.lineSwitching({ version: number() }) }, "sending"),
      );

    const approved = status === "approved" && review?.decidedAt;
    const facts = exampleFacts();
    const noExamples = examples() === null;
    const refused = preview.readiness.state === "refused" ? preview.readiness.message : null;
    const blocked = !preview.allowed.allowed
      ? {
          text: preview.allowed.reason === "phone" ? words.phone : words.credential,
          icon: "ti ti-device-mobile-off",
          tone: "warning" as const,
        }
      : refused
        ? { text: refused, icon: "ti ti-alert-triangle", tone: "warning" as const }
        : undefined;
    return {
      ...base,
      state: "open",
      sentence: sentence(words.askOn),
      reason: versionReason(false),
      unavailable: blocked,
      details: changeDetails(),
      notes: approved
        ? [
            { text: words.approvedBy({ name: decider, when: when(review.decidedAt!).phrase }), icon: "ti ti-circle-check" },
            { text: words.untilYouSwitch({ keep: keep() }), icon: "ti ti-history" },
          ]
        : undefined,
      meta: approved ? facts : [...facts, keepFact()],
      link: noExamples ? undefined : seeAll(),
      more:
        noExamples && props.onAsk ? [{ label: words.tryExamples, onSelect: ask(words.askExamples({ version: number() })) }] : undefined,
      confirm: {
        label: act.kind === "progress" ? words.switching : noExamples ? words.switchAnyway : words.switchOn({ version: number() }),
        icon: "ti ti-power",
        busy: act.kind === "progress",
        onSelect: () => {
          void start();
        },
      },
    };
  });

  return (
    <div ref={root} class="assistant-code-version" data-version={number()} data-appear={appear() ? "" : undefined}>
      <ApprovalFrame
        locale={frame().locale}
        state={frame().state}
        mode={frame().mode}
        source={frame().source}
        status={frame().status}
        sentence={frame().sentence}
        reason={frame().reason}
        details={frame().details}
        notes={frame().notes}
        meta={frame().meta}
        confirm={frame().confirm}
        decline={frame().decline}
        back={frame().back}
        link={frame().link}
        more={frame().more}
        remember={frame().remember}
        unavailable={frame().unavailable}
        waiting={frame().waiting}
        outcome={frame().outcome}
        anchorId={frame().anchorId}
      />
    </div>
  );
}

/** One message or comment, flush with the others: avatar, name, role and time on one line, the text below. */
function ReviewEntry(props: { name: string; role: string; at: string | null; text: string }): JSX.Element {
  return (
    <div class="assistant-code-version__entry">
      <Avatar name={props.name} size="xs" />
      <p class="assistant-code-version__entry-head">
        <span class="assistant-code-version__entry-name">{props.name}</span>
        <span class="assistant-code-version__entry-meta">
          {" · "}
          {props.role}
          <Show when={props.at}>{(at) => ` · ${at()}`}</Show>
        </span>
      </p>
      <p class="assistant-code-version__entry-text">{props.text}</p>
    </div>
  );
}
