import type { ChatDecisionState } from "@k2b/ui";
import { createEffect, createSignal, type JSX, on, onCleanup, onMount, Show } from "solid-js";
import { type ActionCard, type ActionText, actionPlainText } from "../ai/chat/action-card";
import { actionMessages } from "../ai/chat/action-messages";
import type { ActionLine } from "../ai/chat/action-question";
import type { Block } from "../blocks/schema";
import { ApprovalFrame, type ApprovalFrameStatus } from "./ApprovalFrame";

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
  /** Offers remembering this approval for the chat in its detail dialog. */
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

let ActionDetails: typeof import("../ai/chat/action-details")["ActionDetails"];

const confirmIcon = (card: ActionCard): string | undefined => (card.reason.code === "sends" ? "ti ti-send" : undefined);

/** The exact time until `expiresAt`, read once a minute, so the server render and the first browser render agree. */
function useTimeLeft(expiresAt: () => string | undefined) {
  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    onCleanup(() => clearInterval(timer));
  });
  return () => {
    const at = expiresAt();
    if (!at) return undefined;
    const left = Date.parse(at) - now();
    return Number.isFinite(left) ? Math.max(0, left) : undefined;
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
  const timeLeft = useTimeLeft(() => props.expiresAt);
  const editable = () => Boolean(props.card.draft?.editable && props.onEditDraft);
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
  const meta = () => {
    const left = timeLeft();
    return left === undefined
      ? []
      : [{ icon: "ti ti-clock", text: left < 60_000 ? t().expiresSoon : t().expiresIn({ milliseconds: left }) }];
  };
  // A complete proposal that is not inline must be read before it can be approved.
  const [loadedContent, setLoadedContent] = createSignal<string>();
  const unavailable = () =>
    props.unavailable ??
    (props.card.contentRef && loadedContent() !== `${props.card.contentRef.href}:${props.card.contentRef.digest}`
      ? t().fullReviewRequired
      : undefined);
  const reason = () => ({ text: props.waiting ?? (editing() ? t().draftNote : (unavailable() ?? props.card.reason.text)) });
  const currentLine = () => props.outcome.lines[props.outcome.current];
  const open = () => props.state === "open";
  const resultSentence = () => {
    const line = currentLine();
    const text = actionPlainText(line?.text ?? props.card.forms.unknown);
    return line?.detail && !/[.!?…]["“”»«]?\s*$/.test(text) ? `${text}.` : text;
  };
  const status = (): ApprovalFrameStatus | undefined =>
    open()
      ? undefined
      : {
          tone: props.state === "expired" ? "expired" : (currentLine()?.tone ?? "running"),
          label: resultSentence(),
        };
  const resultQuiet = () => (props.state === "expired" ? undefined : currentLine()?.detail);
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
    <ApprovalFrame
      locale={props.card.locale}
      state={props.state}
      mode={editing() ? "edit" : "approve"}
      anchorId={props.anchorId}
      source={props.card.app}
      status={status()}
      sentence={open() ? (editing() ? intent(props.card) : props.card.question) : resultSentence()}
      reason={
        open()
          ? { text: [reason().text, ...meta().map((fact) => fact.text)].join(" · ") }
          : {
              text: (
                <>
                  {resultQuiet()}
                  <Show when={currentLine()?.time}>
                    {(time) => (
                      <>
                        {resultQuiet() ? " · " : ""}
                        {time()}
                      </>
                    )}
                  </Show>
                </>
              ),
            }
      }
      quietTitle={
        !open() && typeof resultQuiet() === "string" ? [resultQuiet(), currentLine()?.time].filter(Boolean).join(" · ") : undefined
      }
      alert={currentLine()?.tone === "error" && !open()}
      unavailable={open() && ((!editing() && unavailable()) || sending()) ? reason() : undefined}
      waiting={props.waiting ? reason() : undefined}
      details={
        // A proposal loads its renderer; a decision-only dialog still gets the pure reason, without repeating meta.
        currentLine()?.actions ||
        (props.card.view?.length ?? 0) > 0 ||
        props.card.readMore ||
        props.card.contentRef ||
        props.card.links.length > 0 ||
        (props.card.consequences ?? []).length > 0
          ? {
              label: t().detailsFrom({ app: props.card.app.name }),
              reason: props.card.reason.text,
              load: async () => {
                ActionDetails = (await import("../ai/chat/action-details")).ActionDetails;
              },
              content: () => (
                <>
                  {!open() ? currentLine()?.actions : undefined}
                  <ActionDetails
                    card={props.card}
                    onContentLoaded={setLoadedContent}
                    draft={{
                      editable: editing(),
                      values: values(),
                      onChange: (name, value) => setValues((current) => ({ ...current, [name]: value })),
                    }}
                  />
                </>
              ),
            }
          : open() || meta().length > 0
            ? { label: t().detailsFrom({ app: props.card.app.name }), reason: props.card.reason.text, content: null }
            : undefined
      }
      detailsPlacement="quiet"
      secondary={open() ? { label: props.card.decline, onSelect: props.onDecline } : undefined}
      meta={editing() ? [] : meta()}
      confirm={
        !open()
          ? currentLine()?.action
            ? { ...currentLine()!.action!, filled: currentLine()?.tone === "error" }
            : undefined
          : editing()
            ? { label: `${props.card.confirm.label} …`, icon: confirmIcon(props.card), onSelect: moveOn }
            : { label: props.card.confirm.label, onSelect: props.onConfirm }
      }
      decline={open() ? { label: editing() ? t().discard : props.card.decline, onSelect: props.onDecline } : undefined}
      back={
        open() && !editing() && editable()
          ? {
              label: t().change,
              onSelect: () => {
                setEditing(true);
              },
            }
          : undefined
      }
      remember={
        open() && props.remember
          ? { label: props.remember.website ? t().rememberWebsite : t().remember, onSelect: props.remember.onSelect }
          : undefined
      }
    />
  );
}
