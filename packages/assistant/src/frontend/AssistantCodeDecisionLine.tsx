import { Button, useLocale } from "@k2b/ui";
import { createMemo, createSignal, type JSX, Show } from "solid-js";
import { formatCodeTime } from "./code-client";
import { codeVersionCardMessages } from "./code-version-card-messages";

/** A decision on a version, as Cloud writes it at the end of the chat in which the version was made. */
export type AssistantCodeDecision = {
  codeId: string;
  versionId: string;
  number: number;
  outcome: "approved" | "changes_requested" | "rejected" | "activated";
  person: { id: string | null; name: string | null };
  /** The `data-chat-anchor` of the version card further up. */
  anchor: string;
};

const TONES = {
  approved: { icon: "ti ti-circle-check", tone: "ok" },
  changes_requested: { icon: "ti ti-message-2", tone: "warning" },
  rejected: { icon: "ti ti-circle-x", tone: "danger" },
  activated: { icon: "ti ti-power", tone: "ok" },
} as const;

/**
 * Moves to the version card: scrolls it into view, lights it up once and puts the focus on its main answer, or on its
 * question when it has none. False when the card is not on the page, such as in history not loaded yet.
 */
export const jumpToCodeVersionCard = (anchor: string, root: ParentNode = document): boolean => {
  const card = root.querySelector<HTMLElement>(`[data-chat-anchor="${anchor.replace(/["\\]/g, "\\$&")}"]`);
  if (!card) return false;
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
  card.scrollIntoView?.({ block: "center", behavior: reduced ? "auto" : "smooth" });
  const main =
    card.querySelector<HTMLElement>('.k2b-chat-decision__answer[data-variant="ai"]:not(:disabled)') ??
    card.querySelector<HTMLElement>(".k2b-chat-decision__sentence") ??
    card;
  if (main === card && !card.hasAttribute("tabindex")) card.tabIndex = -1;
  main.focus({ preventScroll: true });
  if (!reduced && typeof card.animate === "function")
    card.animate(
      [
        { boxShadow: "0 0 0 2px var(--k2b-ai-accent)", offset: 0 },
        { boxShadow: "0 0 0 10px color-mix(in srgb, var(--k2b-ai-accent) 0%, transparent)", offset: 1 },
      ],
      { duration: 1100, easing: "ease-out" },
    );
  return true;
};

/**
 * The event line at the end of the chat: who decided what about a version, when, and at most one action that jumps to
 * the card further up. It is a fact Cloud wrote, never a turn of Gustav; it moves nothing and takes no focus by itself.
 */
export default function AssistantCodeDecisionLine(props: {
  decision: AssistantCodeDecision;
  at: string;
  timeZone: string;
  /** Loads history up to the card when it is not on the page; resolves true when the jump then worked. */
  onReveal?: (anchor: string) => Promise<boolean>;
}): JSX.Element {
  const locale = useLocale();
  const t = createMemo(() => codeVersionCardMessages.resolve([locale()]).t);
  const [missing, setMissing] = createSignal(false);
  let line: HTMLDivElement | undefined;
  const when = () => {
    const day = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: props.timeZone, dateStyle: "short" }).format(date);
    try {
      if (day(new Date(props.at)) === day(new Date()))
        return t().todayAt({ time: new Intl.DateTimeFormat(locale(), { timeZone: props.timeZone, timeStyle: "short" }).format(new Date(props.at)) });
    } catch {
      /* An unknown time zone falls back to the full date. */
    }
    return formatCodeTime(props.at, locale(), props.timeZone);
  };
  const sentence = () => {
    const version = props.decision.number;
    switch (props.decision.outcome) {
      case "approved":
        return t().eventApproved({ version });
      case "changes_requested":
        return t().eventChanges({ version });
      case "rejected":
        return t().eventRejected({ version });
      default:
        return t().eventActivated({ version });
    }
  };
  const action = () =>
    props.decision.outcome === "approved"
      ? t().eventSwitchOn
      : props.decision.outcome === "changes_requested"
        ? t().eventSee
        : props.decision.outcome === "rejected"
          ? t().eventReason
          : null;
  const jump = async () => {
    setMissing(false);
    const root = line?.closest("[data-scroll-preserve]") ?? document;
    if (jumpToCodeVersionCard(props.decision.anchor, root)) return;
    if (props.onReveal && (await props.onReveal(props.decision.anchor))) {
      jumpToCodeVersionCard(props.decision.anchor, root);
      return;
    }
    setMissing(true);
  };
  return (
    <div ref={line} class="assistant-code-decision" data-tone={TONES[props.decision.outcome].tone} data-outcome={props.decision.outcome}>
      <i class={`assistant-code-decision__icon ${TONES[props.decision.outcome].icon}`} aria-hidden="true" />
      <p class="assistant-code-decision__text">
        <Show when={props.decision.outcome !== "activated"}>
          <strong>{props.decision.person.name ?? t().adminSomeone}</strong>{" "}
        </Show>
        {sentence()}
        <span class="assistant-code-decision__when"> · {when()}</span>
      </p>
      <Show when={action()}>
        {(label) => (
          <Button type="button" size="sm" variant="secondary" class="assistant-code-decision__action" onClick={() => void jump()}>
            <i class="ti ti-arrow-up" aria-hidden="true" />
            {label()}
          </Button>
        )}
      </Show>
      <Show when={missing()}>
        <p class="assistant-code-decision__missing" role="status">
          {t().eventGone}
        </p>
      </Show>
    </div>
  );
}
