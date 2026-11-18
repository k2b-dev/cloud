import {
  Button,
  ButtonLink,
  type ChatDecisionAnswer,
  type ChatDecisionFact,
  type ChatDecisionReason,
  type ChatOutcomeTone,
  LocaleProvider,
  NoticeRow,
  type NoticeRowProps,
} from "@k2b/ui";
import { createEffect, createMemo, createSignal, type JSX, on, onCleanup, Show } from "solid-js";
import { type ActionText, actionPlainText } from "../ai/chat/action-card";
import { actionMessages } from "../ai/chat/action-messages";

export type ApprovalFrameState = "open" | "sending" | "decided" | "expired" | "loading";
/** State metadata is for accessibility; the visible sentence says the state exactly once. */
export type ApprovalFrameStatus = { tone: ChatOutcomeTone | "expired"; label: string; icon?: string };
export type ApprovalFrameAction = Omit<ChatDecisionAnswer, "onSelect"> & {
  filled?: boolean;
  disabled?: boolean;
} & ({ onSelect: ChatDecisionAnswer["onSelect"]; href?: never } | { href: string; onSelect?: never });

/**
 * The one approval form: an icon, a sentence, one quiet line and at most two controls. Full proposals live behind "See everything"; a direct secondary
 * decision can remain on the card. The frame owns presentation and interaction, never rights or transport.
 */
export type ApprovalFrameProps = {
  locale: string;
  state: ApprovalFrameState;
  mode?: "approve" | "edit";
  source: { name: string; icon: string; accent?: string };
  status?: ApprovalFrameStatus;
  sentence?: ActionText | string;
  reason: ChatDecisionReason;
  quietTitle?: string;
  details?: {
    label: string;
    context?: string;
    reason?: JSX.Element;
    content: JSX.Element | (() => JSX.Element);
    note?: { text: string; icon?: string };
    load?: () => Promise<void>;
  };
  notes?: readonly ChatDecisionReason[];
  meta?: readonly ChatDecisionFact[];
  confirm?: ApprovalFrameAction;
  decline?: ChatDecisionAnswer;
  /** A direct secondary decision; `shortLabel` is used in narrow containers. It never requires the proposal. */
  secondary?: ChatDecisionAnswer & { shortLabel?: string };
  /** Capability proposals keep their detail link in the quiet line, away from the two decisions. */
  detailsPlacement?: "action" | "quiet";
  back?: ChatDecisionAnswer;
  link?: { label: string; href: string };
  more?: readonly ChatDecisionAnswer[];
  remember?: ChatDecisionAnswer;
  unavailable?: ChatDecisionReason;
  waiting?: ChatDecisionReason;
  onAnswerError?: (error: unknown) => void;
  anchorId?: string | number;
  /** Only terminal receipts without controls opt out of the phone reserve. Loading always keeps it. */
  reserve?: boolean;
  alert?: boolean;
  quietAlert?: boolean;
  /** A domain-specific main control, e.g. a public SplitButton; NoticeRow still owns its placement. */
  actions?: NoticeRowProps["actions"];
  resultAnchor?: boolean;
};

export function ApprovalFrame(props: ApprovalFrameProps): JSX.Element {
  const t = () => actionMessages(props.locale);
  let root: HTMLElement | undefined;
  let detailsAbort: AbortController | undefined;
  const [pending, setPending] = createSignal<"confirm" | "secondary" | null>(null);
  const [remembered, setRemembered] = createSignal(false);
  const [detailFailure, setDetailFailure] = createSignal(false);
  const [answerFailure, setAnswerFailure] = createSignal(false);
  let focusOwned = false;
  onCleanup(() => detailsAbort?.abort());
  const sentence = () =>
    props.state === "loading" && !props.sentence
      ? t().frameLoading
      : typeof props.sentence === "string"
        ? props.sentence
        : actionPlainText(props.sentence ?? []);
  const reason = createMemo(() => props.waiting ?? props.unavailable ?? props.reason);
  const quiet = () => (detailFailure() ? t().fullReviewFailed : answerFailure() ? t().frameAnswerFailed : reason().text);
  const quietTitle = (): string | undefined => {
    const text = quiet();
    return detailFailure() || answerFailure()
      ? typeof text === "string"
        ? text
        : undefined
      : (props.quietTitle ?? (typeof text === "string" ? text : undefined));
  };
  const disabled = () => Boolean(props.waiting || props.unavailable || props.confirm?.disabled || props.confirm?.busy || pending());
  const hasDetails = () =>
    Boolean(
      props.details || props.decline || props.back || props.more?.length || props.remember || props.notes?.length || props.meta?.length,
    );
  const restoreFocus = () => {
    if (!focusOwned || !root) return;
    const active = root.ownerDocument.activeElement;
    // A deliberate move to another control always wins, including one outside this card.
    if (
      active !== root.ownerDocument.body &&
      active !== root &&
      !(active && root.contains(active) && active.matches("[data-approval-primary]"))
    )
      return;
    const next = root.querySelector<HTMLElement>("[data-approval-primary]:not(:disabled)");
    (next ?? root).focus({ preventScroll: true });
  };
  createEffect(
    on(
      () => [props.state, props.mode, props.confirm?.label] as const,
      () => {
        queueMicrotask(restoreFocus);
      },
      { defer: true },
    ),
  );
  const invoke = async (answer: ChatDecisionAnswer, confirming = false) => {
    if (pending() || props.waiting || (confirming && disabled())) return;
    focusOwned = Boolean(root?.contains(root.ownerDocument.activeElement)) || Boolean(detailsAbort);
    setPending(confirming ? "confirm" : "secondary");
    setAnswerFailure(false);
    try {
      const choice = confirming && remembered() && props.remember && props.mode !== "edit" ? props.remember : answer;
      await choice.onSelect();
    } catch (error) {
      setAnswerFailure(true);
      props.onAnswerError?.(error);
    } finally {
      setPending(null);
      queueMicrotask(restoreFocus);
    }
  };
  const showDetails = async () => {
    if (detailsAbort) return;
    setDetailFailure(false);
    const controller = new AbortController();
    detailsAbort = controller;
    try {
      const [{ openApprovalDetails }] = await Promise.all([import("./approval-details"), props.details?.load?.()]);
      if (!controller.signal.aborted)
        await openApprovalDetails({ props, invoke, remembered, setRemembered, pending, failed: answerFailure, signal: controller.signal });
    } catch (error) {
      setDetailFailure(true);
      props.onAnswerError?.(error);
    } finally {
      if (detailsAbort === controller) detailsAbort = undefined;
      queueMicrotask(restoreFocus);
    }
  };
  const confirm = (): ApprovalFrameAction | undefined =>
    props.confirm ?? (props.state === "open" && props.more?.[0] ? { ...props.more[0], filled: false } : undefined);
  const directLink = () => (props.link && !props.decline && !props.back && !props.remember && !props.more?.length ? props.link : undefined);
  const button = (narrow: boolean) => (
    <Show keyed when={confirm()}>
      {(answer) =>
        answer.href ? (
          <ButtonLink
            data-approval-primary=""
            size={narrow ? "md" : "sm"}
            variant={answer.filled === false ? "secondary" : "ai"}
            wrap
            href={answer.href!}
          >
            {answer.label}
          </ButtonLink>
        ) : (
          <Button
            data-approval-primary=""
            size={narrow ? "md" : "sm"}
            variant={answer.filled === false || (props.state === "open" && props.mode === "edit") ? "secondary" : "ai"}
            wrap
            disabled={disabled()}
            loading={pending() === "confirm" || answer.busy}
            onClick={() => {
              if (props.state === "open" && props.mode === "edit") void showDetails();
              else if (answer.onSelect) void invoke({ ...answer, onSelect: answer.onSelect! }, true);
            }}
          >
            {answer.label}
          </Button>
        )
      }
    </Show>
  );
  return (
    <LocaleProvider locale={props.locale}>
      <NoticeRow
        ref={(element) => {
          root = element;
        }}
        class="cloud-approval-frame"
        tone="ai"
        icon="ti ti-shield-check"
        data-approval-frame=""
        data-outcome-tone={props.status?.tone}
        data-k2b-primary="ai"
        data-state={props.state}
        data-mode={props.mode ?? "approve"}
        data-chat-anchor={props.anchorId}
        data-review-result={props.resultAnchor ? "" : undefined}
        tabIndex={-1}
        aria-label={`${t().approvalKind} · ${props.source.name}`}
        aria-busy={props.state === "loading" || props.state === "sending" || undefined}
        reserve={props.state === "loading" || props.reserve !== false}
        children={
          <>
            <span role="status" aria-atomic="true">
              {props.alert ? "" : sentence()}
            </span>
            <span role="alert" aria-atomic="true">
              {props.alert ? sentence() : ""}
            </span>
          </>
        }
        detail={
          <>
            <span>{props.quietAlert || detailFailure() || answerFailure() ? "" : quiet()}</span>
            <span role="alert" aria-atomic="true">
              {props.quietAlert || detailFailure() || answerFailure() ? quiet() : ""}
            </span>
          </>
        }
        detailAction={
          props.detailsPlacement === "quiet" && hasDetails() ? (
            <button type="button" class="k2b-text-link" onClick={() => void showDetails()}>
              {t().seeEverything}
            </button>
          ) : undefined
        }
        detailTitle={quietTitle()}
        actions={
          props.actions ??
          (({ narrow }) => (
            <>
              <Show when={props.secondary}>
                {(answer) => (
                  <Button
                    size={narrow ? "md" : "sm"}
                    variant={narrow ? "secondary" : "link"}
                    wrap
                    disabled={Boolean(props.waiting || pending())}
                    loading={pending() === "secondary"}
                    onClick={() => void invoke(answer())}
                  >
                    {narrow && answer().shortLabel ? answer().shortLabel : answer().label}
                  </Button>
                )}
              </Show>
              <Show when={!props.secondary && props.detailsPlacement !== "quiet" && (props.link || hasDetails())}>
                <Show
                  when={directLink()}
                  fallback={
                    <Button size={narrow ? "md" : "sm"} variant={narrow ? "secondary" : "link"} wrap onClick={() => void showDetails()}>
                      {t().seeEverything}
                    </Button>
                  }
                >
                  {(link) => (
                    <ButtonLink size={narrow ? "md" : "sm"} variant={narrow ? "secondary" : "link"} wrap href={link().href}>
                      {link().label}
                    </ButtonLink>
                  )}
                </Show>
              </Show>
              {button(narrow)}
            </>
          ))
        }
      />
    </LocaleProvider>
  );
}
