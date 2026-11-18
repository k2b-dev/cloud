import { formatCodeMoment } from "@k2b/cloud/code/schedule";
import type { CodePageLinks } from "@k2b/cloud/contracts/code-routes";
import type { CodeVersionCardSnapshot } from "@k2b/cloud/contracts/code-version-cards";
import type { CodeVersionPreview, CodeVersionReview } from "./code-activation";
import { codeVersionPageHref } from "./code-activation";
import { codeVersionCardCopy } from "./code-version-card-copy";
import { codeVersionCardMessages } from "./code-version-card-messages";

type CodeVersionCardCode = Pick<CodeVersionCardSnapshot["code"], "state" | "activeVersionId"> &
  Partial<Pick<CodeVersionCardSnapshot["code"], "pausedAt" | "pausedBy">>;

export type CodeVersionCardLoaded = {
  refreshFailed?: boolean;
  permission?: "reader" | "editor";
  canActivate?: boolean;
  canManage?: boolean;
  preview: CodeVersionPreview;
  review: CodeVersionReview | null;
  facts: CodeVersionCardSnapshot["facts"];
  code: CodeVersionCardCode | null;
  pages: CodePageLinks | null;
  latest: { id: string; number: number } | null;
};
export type CodeVersionCardActivation = { kind: "idle" | "progress" | "checking" | "unknown" | "unreadable" | "failed" };
export type CodeVersionCardAction = {
  id: "activate" | "retry" | "check" | "load" | "withdraw" | "stop" | "askAgain" | "rework" | "different" | "page" | "runs" | "open";
  label: string;
  href?: string;
  filled?: boolean;
  disabled?: boolean;
  busy?: boolean;
};
export type CodeVersionCardModel = {
  kind: string;
  main: string;
  quiet: string;
  alert?: boolean;
  quietAlert?: boolean;
  busy?: boolean;
  primary?: CodeVersionCardAction;
  secondary?: CodeVersionCardAction;
  pages?: CodePageLinks["pages"];
};

/** One presentation for all version states; details and source never enter the card. */
export function describeCodeVersionCard(input: {
  value: CodeVersionCardLoaded | "failed" | "denied" | null;
  version: number;
  versionId: string;
  locale: string;
  timeZone: string;
  activation: CodeVersionCardActivation;
  nextRun: string | null;
  canAsk: boolean;
  actionError?: string | null;
  actionBusy?: boolean;
}): CodeVersionCardModel {
  const { value, version, locale, timeZone, activation: act } = input;
  const t = codeVersionCardMessages.resolve([locale]).t;
  const c = codeVersionCardCopy.resolve([locale]).t;
  const join = (...texts: Array<string | null | undefined>) => texts.filter(Boolean).join(" · ");
  const action = (id: CodeVersionCardAction["id"], label: string, filled = false): CodeVersionCardAction => ({ id, label, filled });
  if (value === null) return { kind: "loading", main: c.loading, quiet: c.loadingQuiet, busy: true };
  if (value === "failed")
    return { kind: "load-failed", main: c.loadFailed, quiet: c.unchanged, alert: true, primary: action("load", t.retry, true) };
  if (value === "denied") return { kind: "denied", main: t.lineNoAccess, quiet: "" };
  const { preview, review, facts, code } = value;
  const base = codeVersionPageHref(preview);
  const page = base ? `${base}?tab=versions&version=${encodeURIComponent(input.versionId)}` : null;
  const details: CodeVersionCardAction | undefined = page ? { id: "page", label: t.seeAll, href: page } : undefined;
  const runs: CodeVersionCardAction | undefined = base ? { id: "runs", label: t.seeRuns, href: `${base}?tab=runs` } : undefined;
  const name = review?.decidedBy?.name ?? t.adminSomeone;
  const keep = preview.running === version ? null : preview.running;
  const unchanged = code?.state === "paused" ? c.currentPaused : code === null ? c.operatingUnavailable : c.stays({ keep });
  const moment = (at: string) => formatCodeMoment(at, { locale, timeZone });
  const nextMoment = () => {
    if (!input.nextRun) return null;
    const minutes = Math.round((Date.parse(input.nextRun) - Date.now()) / 60_000);
    const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    return c.nextRun({
      when:
        minutes >= 0 && minutes < 24 * 60
          ? minutes < 60
            ? relative.format(minutes, "minute")
            : relative.format(Math.round(minutes / 60), "hour")
          : moment(input.nextRun),
    });
  };
  const summary = join(preview.title, ...(facts.length ? facts : [c.noSummary]));
  const quote = review?.message ? (locale.startsWith("de") ? `„${review.message}“` : `“${review.message}”`) : null;
  const reviewQuiet = join(quote, review?.commentCount ? c.comments({ count: review.commentCount }) : null) || summary;
  let result: CodeVersionCardModel;

  if (preview.running === version) {
    if (!code)
      result = {
        kind: "state-unavailable",
        main: c.unavailable,
        quiet: c.unavailableQuiet,
        primary: action("load", t.retry),
        secondary: details,
      };
    else if (code.state === "paused" && code.activeVersionId === input.versionId) {
      result = {
        kind: "paused",
        main: c.paused({ version }),
        quiet: join(
          preview.title,
          code.pausedAt ? c.since({ when: moment(code.pausedAt) }) : null,
          code.pausedBy ? c.by({ name: code.pausedBy.name }) : null,
        ),
        primary: base ? { id: "page", label: c.resume, href: base } : undefined,
      };
    } else if (code.state !== "active" || code.activeVersionId !== input.versionId) {
      result = {
        kind: "state-unavailable",
        main: c.unavailable,
        quiet: c.unavailableQuiet,
        primary: action("load", t.retry),
        secondary: details,
      };
    } else {
      const pages = value.pages?.versionId === input.versionId ? value.pages : null;
      const open = pages?.homeUrl && pages.pages.some((item) => item.href === pages.homeUrl);
      result = !pages
        ? {
            kind: "pages-unavailable",
            main: c.on({ version }),
            quiet: c.pagesFailed,
            quietAlert: true,
            primary: action("load", t.retry, true),
            secondary: runs,
          }
        : {
            kind: open ? "on" : "on-without-page",
            main: c.on({ version }),
            quiet: join(preview.title, preview.activated ? c.since({ when: moment(preview.activated.at) }) : null, nextMoment()),
            primary: open ? { id: "open", label: c.open, href: pages.homeUrl!, filled: true } : runs,
            secondary: open ? runs : undefined,
            pages: open ? pages.pages : undefined,
          };
    }
  } else if (preview.latest > version || review?.status === "superseded") {
    const latest = value.latest?.number ?? preview.latest;
    result = {
      kind: "replaced",
      main: latest > version ? c.replaced({ version, latest }) : c.superseded({ version }),
      quiet: join(preview.title, latest > version ? c.replacedQuiet({ latest }) : c.noSummary),
      primary: base
        ? {
            id: "page",
            label: value.latest ? c.latest({ latest }) : t.seeAll,
            href: value.latest ? `${base}?tab=versions&version=${encodeURIComponent(value.latest.id)}` : `${base}?tab=versions`,
          }
        : undefined,
    };
  } else if (review?.status === "withdrawn")
    result = { kind: "withdrawn", main: c.withdrawn({ version }), quiet: join(preview.title, unchanged), primary: details };
  else if (review?.status === "expired")
    result = {
      kind: "expired",
      main: c.expired,
      quiet: join(preview.title, c.expiredQuiet, unchanged),
      primary: action("askAgain", t.askAgain),
    };
  else if (review?.status === "changes_requested") {
    const revision = review.revision;
    const automatic = revision?.state === "queued" || revision?.state === "running";
    const reason = revision?.reason;
    const note =
      revision?.state === "stopped"
        ? t.reworkStopped
        : revision?.state === "skipped"
          ? reason === "quota"
            ? t.skippedQuota
            : reason === "needs_person"
              ? t.skippedPerson
              : reason === "conversation_gone" || reason === "access_lost"
                ? t.skippedGone
                : t.skippedUnavailable
          : reason === "already_automatic" || (review.origin.kind === "ai_chat" && review.origin.automaticAfterReview)
            ? t.secondTimeFoot
            : null;
    result = automatic
      ? {
          kind: "revising",
          main: c.revising({ version }),
          quiet: revision?.state === "queued" ? t.reworkQueued : join(c.from({ name }), c.revisionNext),
          primary: action("stop", revision?.state === "queued" ? t.dontStart : t.stop),
        }
      : {
          kind: "changes",
          main: c.changes({ version, name }),
          quiet: note ? join(quote, note) : reviewQuiet,
          primary: input.canAsk ? action("rework", t.rework, true) : details,
          secondary: input.canAsk ? details : undefined,
        };
  } else if (
    review?.status === "rejected" ||
    (preview.readiness.state === "refused" && preview.readiness.code === "code_approval_revoked")
  ) {
    result = {
      kind: "rejected",
      main: c.rejected({ version, name }),
      quiet: join(quote, unchanged),
      primary: input.canAsk ? action("different", t.buildDifferently) : details,
    };
  } else if (preview.readiness.state === "approval_pending" || review?.status === "pending") {
    const self = preview.readiness.state === "approval_pending" && preview.readiness.selfApproval;
    result = {
      kind: "waiting",
      main: self ? c.waitingYou({ version }) : c.waiting({ version }),
      quiet: summary,
      primary: details,
      secondary: action("withdraw", t.withdraw),
    };
  } else if (act.kind === "unknown" || act.kind === "unreadable") {
    result = {
      kind: "unknown",
      main: c.unknown({ version }),
      quiet: act.kind === "unreadable" ? t.lineCheckFailed : c.unknownQuiet,
      primary: action("check", t.checkStatus),
      secondary: details,
    };
  } else if (act.kind === "failed") {
    result = {
      kind: "activation-failed",
      main: c.failed,
      quiet: join(preview.title, c.unchanged),
      alert: true,
      primary: action("retry", t.retry, true),
      secondary: details,
    };
  } else {
    const progress = act.kind === "progress" || act.kind === "checking";
    const blocked = !preview.allowed.allowed
      ? preview.allowed.reason === "phone"
        ? t.phone
        : t.credential
      : preview.readiness.state === "refused"
        ? preview.readiness.message
        : null;
    result = {
      kind: progress ? "switching" : "ready",
      main:
        act.kind === "checking"
          ? c.checking
          : progress
            ? t.lineSwitching({ version })
            : review?.status === "approved"
              ? c.approved({ version, name })
              : c.ready({ version }),
      quiet: act.kind === "checking" ? c.unknownQuiet : (blocked ?? summary),
      busy: progress,
      primary: { ...action("activate", c.activate, true), busy: progress, disabled: Boolean(blocked) },
      secondary: details,
    };
  }
  if (value.canManage === false) {
    const readable = (item: CodeVersionCardAction | undefined) =>
      item && ["page", "runs", "open", "load"].includes(item.id) ? item : undefined;
    result = { ...result, primary: readable(result.primary) ?? details, secondary: readable(result.secondary) };
    if (result.secondary?.href === result.primary?.href) result.secondary = undefined;
  } else if (value.canActivate === false && (result.primary?.id === "activate" || result.primary?.id === "retry")) {
    result = { ...result, primary: details, secondary: undefined };
  }
  if (value.refreshFailed)
    result = { ...result, quiet: c.refreshFailed, quietAlert: true, primary: action("load", t.retry, true), secondary: details };
  if (input.actionError) result = { ...result, quiet: input.actionError, quietAlert: true };
  if (input.actionBusy)
    result = {
      ...result,
      busy: true,
      primary: result.primary ? { ...result.primary, busy: true } : undefined,
      secondary: result.secondary ? { ...result.secondary, disabled: true } : undefined,
    };
  return result;
}
