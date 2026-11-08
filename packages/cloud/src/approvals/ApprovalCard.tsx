import { Chat, type ChatDecisionState, type ChatOutcomeTone, LocaleProvider } from "@k2b/ui";
import { createEffect, createMemo, createSignal, type JSX, on, onCleanup, onMount } from "solid-js";
import type { ActionCard, ActionText } from "../ai/chat/action-card";
import { actionMessages } from "../ai/chat/action-messages";
import { ActionDetails, type ActionLine, ActionReceipt, ActionTextView } from "../ai/chat/action-question";
import type { Block } from "../blocks/schema";

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
  /**
   * Sends a draft's edited fields so Cloud reviews the Action again; resolves `true` once the card shows the new
   * review. Without it, or where the card's draft is not editable, the draft is shown as the approval at once.
   */
  onEditDraft?: (values: Record<string, string>) => Promise<boolean>;
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

/** The field values a draft shows, from its blocks. */
const draftValues = (blocks: readonly Block[] | undefined): Record<string, string> => {
  const values: Record<string, string> = {};
  const visit = (block: Block) => {
    if (block.kind === "Section") block.children.forEach(visit);
    if (block.kind === "Draft")
      for (const field of block.fields) values[field.name] = typeof field.value === "string" ? field.value : String(field.value ?? "");
  };
  (blocks ?? []).forEach(visit);
  return values;
};

/** The intent of a draft as one statement: the app's short sentence, ending like a sentence. */
const intent = (card: ActionCard): ActionText => [{ kind: "text", text: /[.!?…]$/.test(card.short) ? card.short : `${card.short}.` }];

export function ApprovalCard(props: ApprovalCardProps): JSX.Element {
  const t = () => actionMessages(props.card.locale);
  const minutesLeft = useMinutesLeft(() => props.expiresAt);
  const editable = () => props.card.draft?.editable === true && props.onEditDraft !== undefined;
  // A draft the person may change starts in edit mode; "Change" returns to it, "Send …" moves on to approving.
  const [editing, setEditing] = createSignal(editable());
  const [values, setValues] = createSignal(draftValues(props.card.view));
  const [sending, setSending] = createSignal(false);
  // A new review, such as the one Cloud returns for the edited draft, brings its own values.
  createEffect(
    on(
      () => props.card.view,
      (view) => setValues(draftValues(view)),
      { defer: true },
    ),
  );
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
      : editing()
        ? { text: t().draftNote, icon: "ti ti-lock", tone: "neutral" as const }
        : unavailable()
          ? { text: unavailable()!, icon: "ti ti-player-pause", tone: "neutral" as const }
          : { text: props.card.reason.text, icon: props.card.reason.icon, tone: props.card.reason.tone };
  const moveOn = async () => {
    if (sending()) return;
    const original = draftValues(props.card.view);
    const changed = Object.keys(values()).some((name) => values()[name] !== original[name]);
    if (!changed || !props.onEditDraft) return void setEditing(false);
    setSending(true);
    const accepted = await props.onEditDraft(values()).catch(() => false);
    setSending(false);
    if (accepted) setEditing(false);
  };
  return (
    <LocaleProvider locale={props.card.locale}>
      <Chat.Decision
        state={props.state}
        mode={editing() && props.state === "open" ? "edit" : "approve"}
        anchorId={props.anchorId}
        kind={editing() ? { label: t().draftKind, icon: "ti ti-pencil" } : { label: t().approvalKind, icon: "ti ti-shield-check" }}
        source={{ name: props.card.app.name, icon: props.card.app.icon, accent: props.card.app.accent }}
        status={status()}
        sentence={<ActionTextView text={editing() ? intent(props.card) : props.card.question} accent={props.card.app.accent} />}
        reason={reason()}
        unavailable={!editing() && unavailable() ? reason() : sending() ? reason() : undefined}
        waiting={props.waiting ? reason() : undefined}
        details={
          props.card.view || props.card.contentRef || props.card.links.length > 0 || (props.card.consequences ?? []).length > 0
            ? {
                label: t().detailsFrom({ app: props.card.app.name }),
                content: (
                  <ActionDetails
                    card={props.card}
                    onContentLoaded={setLoadedContent}
                    draft={{
                      editable: editing(),
                      values: values(),
                      onChange: (name, value) => setValues((current) => ({ ...current, [name]: value })),
                    }}
                  />
                ),
              }
            : undefined
        }
        meta={editing() ? [] : meta()}
        confirm={
          editing()
            ? { label: `${props.card.confirm.label} …`, icon: confirmIcon(props.card), onSelect: moveOn }
            : { label: props.card.confirm.label, icon: confirmIcon(props.card), onSelect: props.onConfirm }
        }
        decline={{ label: editing() ? t().discard : props.card.decline, onSelect: props.onDecline }}
        back={
          !editing() && editable()
            ? {
                label: t().change,
                onSelect: () => {
                  setEditing(true);
                },
              }
            : undefined
        }
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
