import { createEffect, createMemo, createSignal, createUniqueId, For, type JSX, on, onCleanup, Show, useContext } from "solid-js";
import { Button } from "../actions/Button";
import { TextInput } from "../inputs/TextInput";
import { DecisionScope, spokenText } from "./ChatDecision";
import type { ChatDecisionAnswer, ChatDecisionReason } from "./types";

export type ChatDecisionFieldProps = {
  /** Facts with their icons on the surface colour above the field, such as where the value goes; no label needed. */
  facts?: readonly ChatDecisionReason[];
  /** The field's name for screen readers, such as "Value for Parcel_API"; the sentence already names it visibly. */
  label: string;
  /** The value stays with the caller; the field never keeps, logs, or writes it into an attribute. */
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  /** The eye's fixed name, such as "Show value"; `aria-pressed` tells whether the value shows. */
  revealLabel?: string;
  /**
   * Every line one flow can show under the field, such as where the value goes, an error, or "Open in another window".
   * All of them share one cell, so the question keeps its height between them. A change is announced once.
   */
  lines: Readonly<Record<string, ChatDecisionReason>>;
  /** The key of the visible line. */
  current: string;
  /** The value cannot be taken as it is: a red edge, and the field takes the focus back from the answers. */
  invalid?: boolean;
  /**
   * Locks the field, the eye and both answers, such as while another window holds the question. While an answer's
   * promise runs, the question locks them by itself.
   */
  disabled?: boolean;
  /** Receives the input, for a host that moves the focus into the field, such as after a jump to the question. */
  inputRef?: (input: HTMLInputElement) => void;
  /**
   * The main answer, filled, beside the field, such as "Save securely". A promise it returns locks the field, the eye
   * and both answers until it settles and keeps the question answered here, so an outcome set before it settles takes
   * the focus. A question still open afterwards gives the focus back to the field.
   */
  confirm: ChatDecisionAnswer;
  /** The quiet answer in the AI colour under it, such as "Decline". */
  decline?: ChatDecisionAnswer;
};

/** An answer's label with every other label it can take in the same cell; only the current one is seen and named. */
const faces = (choice: ChatDecisionAnswer) => (
  <span class="k2b-chat-decision__faces">
    <span class="k2b-chat-decision__face" data-current="true">
      <Show when={choice.icon}>{(icon) => <i class={icon()} aria-hidden="true" />}</Show>
      {choice.label}
    </span>
    <For each={(choice.alternates ?? []).filter((alternate) => alternate.label !== choice.label)}>
      {(alternate) => (
        <span class="k2b-chat-decision__face" aria-hidden="true">
          <Show when={alternate.icon}>{(icon) => <i class={icon()} />}</Show>
          {alternate.label}
        </span>
      )}
    </For>
  </span>
);

/**
 * The answer row of a `Chat.Decision` that asks for one value, passed as its `entry`: a password field with an eye, one
 * line under it, the filled answer beside the field, and a quiet one beside the line. Every line and every label shares
 * one cell, so no state moves anything. Typing, or the focus in the field, turns the question into the raised island
 * for good.
 */
export function ChatDecisionField(props: ChatDecisionFieldProps): JSX.Element {
  const question = useContext(DecisionScope);
  const id = createUniqueId();
  // A running answer holds the question: the field and the eye lock like `disabled`, the answers stay focusable but
  // take nothing, as the question's own buttons do.
  const pending = () => question?.pending();
  const locked = () => Boolean(props.disabled) || Boolean(pending());
  const confirmOff = () => Boolean(question?.off()) || Boolean(props.disabled);
  const declineOff = () => question?.off() === "all" || Boolean(props.disabled);
  const keys = createMemo(() => {
    const all = Object.keys(props.lines);
    return all.includes(props.current) ? all : [props.current, ...all];
  });
  const lineId = (key: string) => `k2b-chat-decision-field-${id}-${keys().indexOf(key)}`;
  let input: HTMLInputElement | undefined;
  let cell: HTMLParagraphElement | undefined;

  // A value, typed or given, makes the question the island; in the browser only, so the server page matches the first frame.
  createEffect(() => {
    if (props.value !== "") question?.edit();
  });

  const [live, setLive] = createSignal("");
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    if (timer) clearTimeout(timer);
  });
  // One live region: a new line is spoken once, and the same words again are a change too.
  createEffect(
    on(
      () => props.current,
      () => {
        setLive("");
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          const line = cell?.querySelector('[data-current="true"]');
          setLive(line ? spokenText(line) : "");
        }, 40);
      },
      { defer: true },
    ),
  );
  // A value that cannot be taken sends the focus back into the field, unless the person is somewhere else by now.
  createEffect(
    on(
      () => Boolean(props.invalid),
      (invalid) => {
        if (!invalid) return;
        const active = document.activeElement;
        if (!active || active === document.body || input?.closest(".k2b-chat-decision")?.contains(active))
          input?.focus({ preventScroll: true });
      },
      { defer: true },
    ),
  );

  // The lock takes the focus from the field; a question that stays open afterwards, such as after a failed save,
  // gives it back, unless the person is somewhere else by now.
  createEffect(
    on(
      () => Boolean(pending()),
      (running, was) => {
        if (running || !was) return;
        const active = document.activeElement;
        if (!active || active === document.body) input?.focus({ preventScroll: true });
      },
      { defer: true },
    ),
  );

  const confirm = () => {
    if (props.confirm.busy) return;
    if (question) question.answer("confirm", props.confirm, !confirmOff());
    else if (!confirmOff()) void props.confirm.onSelect();
  };
  const decline = (choice: ChatDecisionAnswer) => {
    if (question) question.answer("decline", choice, !declineOff());
    else if (!declineOff()) void choice.onSelect();
  };

  return (
    <>
      <Show when={(props.facts?.length ?? 0) > 0}>
        <div class="k2b-chat-decision__details">
          <div class="k2b-chat-decision__facts">
            <For each={props.facts}>
              {(line) => (
                <p class="k2b-chat-line k2b-chat-decision__fact-line" data-tone={line.tone ?? "neutral"}>
                  <i class={`k2b-chat-line__icon ${line.icon ?? "ti ti-info-circle"}`} aria-hidden="true" />
                  <span class="k2b-chat-line__text">{line.text}</span>
                </p>
              )}
            </For>
          </div>
        </div>
      </Show>
      <div class="k2b-chat-decision__entry">
        <div class="k2b-chat-decision__field" onFocusIn={() => question?.edit()}>
          <TextInput
            aria-label={props.label}
            password
            revealLabel={props.revealLabel}
            value={props.value}
            onValueChange={(value) => props.onValueChange(value)}
            onSubmit={confirm}
            placeholder={props.placeholder}
            disabled={locked()}
            error={props.invalid ? props.lines[props.current]?.text : undefined}
            externalErrorId={props.invalid ? lineId(props.current) : undefined}
            aria-describedby={props.invalid ? undefined : lineId(props.current)}
            autocomplete="off"
            spellcheck={false}
            ref={(element: HTMLInputElement) => {
              input = element;
              props.inputRef?.(element);
            }}
          />
        </div>
        <Button
          class="k2b-chat-decision__answer k2b-chat-decision__confirm"
          variant="ai"
          disabled={confirmOff()}
          aria-disabled={props.confirm.busy || pending() ? "true" : undefined}
          aria-busy={props.confirm.busy || pending() === "confirm" ? "true" : undefined}
          data-busy={props.confirm.busy || pending() === "confirm" ? "" : undefined}
          onClick={confirm}
        >
          {faces(props.confirm)}
        </Button>
        <p ref={cell} class="k2b-chat-decision__line-cell">
          <For each={keys()}>
            {(key) => (
              <Show when={props.lines[key]}>
                {(line) => (
                  <span
                    id={lineId(key)}
                    class="k2b-chat-line k2b-chat-decision__line"
                    data-tone={line().tone ?? "neutral"}
                    data-current={key === props.current ? "true" : undefined}
                    aria-hidden={key === props.current ? undefined : "true"}
                  >
                    <i class={`k2b-chat-line__icon ${line().icon ?? "ti ti-info-circle"}`} aria-hidden="true" />
                    <span class="k2b-chat-line__text">{line().text}</span>
                  </span>
                )}
              </Show>
            )}
          </For>
        </p>
        <Show when={props.decline}>
          {(choice) => (
            <Button
              class="k2b-chat-decision__answer k2b-chat-decision__decline"
              variant="text"
              disabled={declineOff()}
              aria-disabled={pending() ? "true" : undefined}
              aria-busy={pending() === "decline" ? "true" : undefined}
              onClick={() => decline(choice())}
            >
              {faces(choice())}
            </Button>
          )}
        </Show>
        <span class="k2b-sr-only" role="status" aria-live="polite">
          {live()}
        </span>
      </div>
    </>
  );
}
