import { Chat, type ChatDecisionState, type ChatOutcomeTone, LocaleProvider } from "@k2b/ui";
import { createMemo, createSignal, type JSX, onCleanup, onMount } from "solid-js";
import type { ActionCard } from "../ai/chat/action-card";
import { actionMessages } from "../ai/chat/action-messages";
import { type ActionLine, ActionPreview, ActionReceipt, ActionTextView } from "../ai/chat/action-question";

/**
 * The one approval of Cloud. Every place shows it the same way: the Assistant chat, the side panel, the approvals
 * page, Code pages, other apps, and phones. Only its width follows the place. Cloud draws the head, the sentence, the
 * reason, the answers, and every outcome; the app supplies only its details and its sentence templates. There are no
 * look props: a place passes data and answers, never a class, a style, or a variant (`scripts/checks/approval-card-calls.ts`).
 */
export type ApprovalCardProps = {
  card: ActionCard;
  /** `open` asks; every other state shows the head with the outcome's state and one outcome line. */
  state: ChatDecisionState;
  /** Every line one flow can reach, and the current one. */
  outcome: { lines: Readonly<Record<string, ActionLine>>; current: string };
  timeZone: string;
  onConfirm: () => void | Promise<void>;
  onDecline: () => void | Promise<void>;
  /** Where the approval may be remembered for this chat; without, the card says that it asks every time. */
  remember?: { website?: boolean; onSelect: () => void | Promise<void> };
  /** When the open request expires, if Cloud knows it. */
  expiresAt?: string;
  /** Turns the confirming answers off; this reason replaces the asking reason in its place. */
  unavailable?: string;
  /** Turns every answer off until it clears, such as without a connection. */
  waiting?: string;
  anchorId?: string | number;
};

const STATUS_ICONS: Record<ChatOutcomeTone | "expired", string> = {
  running: "ti ti-loader-2",
  done: "ti ti-circle-check",
  off: "ti ti-circle-x",
  waiting: "ti ti-clock",
  warning: "ti ti-alert-triangle",
  error: "ti ti-alert-circle",
  expired: "ti ti-clock-x",
};

const confirmIcon = (card: ActionCard): string | undefined => (card.reason.code === "sends" ? "ti ti-send" : undefined);

/** Minutes until `expiresAt`, read once a minute, so the server render and the first browser render agree. */
function useMinutesLeft(expiresAt: () => string | undefined) {
  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    onCleanup(() => clearInterval(timer));
  });
  return () => {
    const at = expiresAt();
    if (!at) return undefined;
    const left = Date.parse(at) - now();
    return Number.isFinite(left) ? Math.max(0, Math.ceil(left / 60_000)) : undefined;
  };
}

export function ApprovalCard(props: ApprovalCardProps): JSX.Element {
  const t = () => actionMessages(props.card.locale);
  const minutesLeft = useMinutesLeft(() => props.expiresAt);
  const status = createMemo(() => {
    if (props.state === "open") return undefined;
    const line = props.outcome.lines[props.outcome.current];
    const words = t();
    if (props.state === "expired") return { label: words.statusExpired, icon: STATUS_ICONS.expired, tone: "off" as const };
    const tone = line?.tone ?? "running";
    const label = {
      running: words.statusRunning,
      done: words.statusDone,
      off: words.statusDeclined,
      waiting: words.statusWaiting,
      warning: words.statusUnknown,
      error: words.statusFailed,
    }[tone];
    return { label, icon: STATUS_ICONS[tone], tone };
  });
  const meta = createMemo(() => {
    const words = t();
    const items: { text: string; icon: string }[] = [];
    const left = minutesLeft();
    if (left !== undefined) items.push({ icon: "ti ti-clock", text: left < 1 ? words.expiresSoon : words.expiresIn({ minutes: left }) });
    if (!props.remember) items.push({ icon: "ti ti-repeat", text: words.asksEveryTime });
    return items;
  });
  // A complete proposal that is not inline must be read before it can be approved.
  const [loadedContent, setLoadedContent] = createSignal<string>();
  const unavailable = () =>
    props.unavailable ??
    (props.card.contentRef && loadedContent() !== `${props.card.contentRef.href}:${props.card.contentRef.digest}`
      ? t().fullReviewRequired
      : undefined);
  const reason = () =>
    props.waiting
      ? { text: props.waiting, icon: "ti ti-wifi-off", tone: "neutral" as const }
      : unavailable()
        ? { text: unavailable()!, icon: "ti ti-player-pause", tone: "neutral" as const }
        : { text: props.card.reason.text, icon: props.card.reason.icon, tone: props.card.reason.tone };
  return (
    <LocaleProvider locale={props.card.locale}>
      <Chat.Decision
        state={props.state}
        anchorId={props.anchorId}
        kind={{ label: t().approvalKind, icon: "ti ti-shield-check" }}
        source={{ name: props.card.app.name, icon: props.card.app.icon, accent: props.card.app.accent }}
        status={status()}
        sentence={<ActionTextView text={props.card.question} accent={props.card.app.accent} />}
        reason={reason()}
        unavailable={unavailable() ? reason() : undefined}
        waiting={props.waiting ? reason() : undefined}
        details={
          props.card.preview || props.card.contentRef || props.card.links.length > 0
            ? {
                label: t().detailsFrom({ app: props.card.app.name }),
                content: <ActionPreview card={props.card} timeZone={props.timeZone} onContentLoaded={setLoadedContent} />,
              }
            : undefined
        }
        meta={meta()}
        confirm={{ label: props.card.confirm.label, icon: confirmIcon(props.card), onSelect: props.onConfirm }}
        decline={{ label: props.card.decline, onSelect: props.onDecline }}
        remember={
          props.remember
            ? { label: props.remember.website ? t().rememberWebsite : t().remember, onSelect: props.remember.onSelect }
            : undefined
        }
        outcome={<ActionReceipt card={props.card} lines={props.outcome.lines} current={props.outcome.current} />}
      />
    </LocaleProvider>
  );
}
