import { formatCodeMoment } from "@k2b/cloud/code/schedule";
import { Button, LinkCard, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { codeDecisionMessages } from "./code-decision-messages";
import { type CodeDecisionPages, loadCodeDecisionPages } from "./code-decision-pages";
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
  nextRunAt?: string | null;
  pageCount?: number;
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
  /** A later line already says what the person did about this version: this one stays as history, without action. */
  settled?: boolean;
  /** Gustav revises by himself after these changes: the line has no action; the start line below says that he does. */
  automatic?: boolean;
  /** An already authorized snapshot, also used by server-rendered fixtures. */
  pages?: CodeDecisionPages | null;
}): JSX.Element {
  const locale = useLocale();
  const t = createMemo(() => codeVersionCardMessages.resolve([locale()]).t);
  const pageText = createMemo(() => codeDecisionMessages.resolve([locale()]).t);
  const [pages, setPages] = createSignal(props.pages);
  const [pageState, setPageState] = createSignal<"loading" | "failed" | "ready">(props.pages === undefined ? "loading" : "ready");
  let disposed = false;
  const pageRead = new AbortController();
  onCleanup(() => {
    disposed = true;
    pageRead.abort();
  });
  const readPages = async () => {
    setPageState("loading");
    const result = await loadCodeDecisionPages(props.decision.codeId, props.decision.versionId, pageRead.signal);
    if (disposed) return;
    if (result === "failed") {
      setPageState("failed");
      return;
    }
    setPages(result);
    setPageState("ready");
  };
  onMount(() => {
    if (props.pages === undefined && props.decision.outcome === "activated" && props.decision.pageCount !== 0) void readPages();
  });
  const [missing, setMissing] = createSignal(false);
  let line: HTMLDivElement | undefined;
  // The same moment as on the card above and on the Code page.
  const when = () => formatCodeMoment(props.at, { locale: locale(), timeZone: props.timeZone });
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
  const nextRun = () => {
    const at = props.decision.nextRunAt;
    if (props.decision.outcome !== "activated" || !at) return null;
    const minutes = Math.round((Date.parse(at) - Date.now()) / 60_000);
    if (minutes < 0 || minutes >= 24 * 60) return null;
    const format = new Intl.RelativeTimeFormat(locale(), { numeric: "auto" });
    return t().eventNextRun({ when: minutes < 60 ? format.format(minutes, "minute") : format.format(Math.round(minutes / 60), "hour") });
  };
  const action = () =>
    props.settled || props.automatic
      ? null
      : props.decision.outcome === "approved"
        ? // The card switches on; the line only leads there, so the same action never stands twice (v12 §9).
          t().eventToCard
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
        <span class="assistant-code-decision__when">
          {" · "}
          {when()}
          <Show when={nextRun()}>{(text) => ` · ${text()}`}</Show>
        </span>
      </p>
      <Show when={action()}>
        {(label) => (
          <Button type="button" size="sm" variant="secondary" class="assistant-code-decision__action" onClick={() => void jump()}>
            <i class="ti ti-arrow-up" aria-hidden="true" />
            {label()}
          </Button>
        )}
      </Show>
      <Show when={props.decision.outcome === "activated" && props.decision.pageCount !== 0}>
        <Show
          when={pages()}
          fallback={
            <Show when={pageState() !== "ready"}>
              <div
                class="assistant-code-decision__pages assistant-code-decision__pages-pending"
                data-multiple={(props.decision.pageCount ?? 1) > 1 || undefined}
                role="status"
              >
                {pageState() === "loading" ? pageText().loading : pageText().failed}
                <Show when={pageState() === "failed"}>
                  <Button size="sm" variant="secondary" onClick={() => void readPages()}>
                    {pageText().retry}
                  </Button>
                </Show>
              </div>
            </Show>
          }
        >
          {(handoff) => {
            const home = () => handoff().pages.pages[0]!;
            const title = (page: CodeDecisionPages["pages"]["pages"][number]) => page.title ?? (page.isRoot ? handoff().title : page.path);
            return (
              <div class="assistant-code-decision__pages">
                <LinkCard href={home().href} title={title(home())} description={home().path} meta={pageText().open} />
                <Show when={handoff().pages.pages.length > 1}>
                  <p class="assistant-code-decision__more">
                    {pageText().more}{" "}
                    <For each={handoff().pages.pages.slice(1)}>
                      {(page, index) => (
                        <>
                          {index() > 0 ? " · " : ""}
                          <a href={page.href}>{title(page)}</a>
                        </>
                      )}
                    </For>
                  </p>
                </Show>
              </div>
            );
          }}
        </Show>
      </Show>
      <Show when={missing()}>
        <p class="assistant-code-decision__missing" role="status">
          {t().eventGone}
        </p>
      </Show>
    </div>
  );
}

/**
 * The visible start of Gustav's one automatic revision, right under the decision line that already says who asked
 * for which changes and that Gustav starts by himself: it names only that his turn begins now, never the decision again.
 */
export function AssistantCodeReviewStartLine(props: { number: number | null }): JSX.Element {
  const locale = useLocale();
  const t = createMemo(() => codeVersionCardMessages.resolve([locale()]).t);
  return (
    <div class="assistant-code-decision" data-tone="ai" data-outcome="review_start">
      <i class="assistant-code-decision__icon ti ti-sparkles" aria-hidden="true" />
      <p class="assistant-code-decision__text">
        {props.number === null ? t().reviewStartPlain : t().reviewStart({ version: props.number })}
      </p>
    </div>
  );
}
