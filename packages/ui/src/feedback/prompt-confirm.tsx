import { createSignal, type JSX, Show } from "solid-js";
import { TextInput } from "../inputs/TextInput";
import { resolveUiMessages } from "../intl/messages";
import { dialogCore } from "./dialog-core";
import { type DialogTone, dialogToneIcon, dialogToneLabel } from "./dialog-tone";
import { resolvePromptMessages } from "./prompt-messages";
import type { ConfirmOptions, DialogOptions } from "./prompts";

// The dialog frame and `prompts.confirm`, apart from the form prompts: `PanelDialog` asks before discarding changes,
// and the form prompts render date pickers whose phone sheet is a `PanelDialog`, so one module would be an import cycle.

export type PromptContent = string | HTMLElement | JSX.Element;

const PHRASE_SLOT = "\u0000";

/** A prompt's `variant` is its tone too: a success or danger prompt carries the dialog tone of that name. */
export const promptTone = (variant: DialogOptions["variant"]): DialogTone | undefined =>
  variant === "success" || variant === "danger" ? variant : undefined;

export const DialogHeader = (props: { close: () => void; title?: string; icon?: string; tone?: DialogTone }): JSX.Element => (
  <header class="k2b-dialog__header">
    <Show when={props.tone ? dialogToneIcon(props.tone) : props.icon}>
      {(icon) => <i class={icon()} data-tone={props.tone} aria-hidden="true" />}
    </Show>
    <Show when={props.title} fallback={<span class="k2b-dialog__header-spacer" />}>
      {(title) => (
        <h2>
          <Show when={props.tone}>{(tone) => <span class="k2b-sr-only">{dialogToneLabel(resolveUiMessages(), tone())} </span>}</Show>
          {title()}
        </h2>
      )}
    </Show>
    <button type="button" class="k2b-dialog__close" aria-label={resolveUiMessages().closeDialog} onClick={props.close}>
      <i class="ti ti-x" aria-hidden="true" />
    </button>
  </header>
);

export const panelClass = (options?: Pick<DialogOptions, "size" | "surface" | "variant">): string => {
  const size = options?.size ?? "medium";
  const variant = options?.variant && options.variant !== "primary" ? ` k2b-dialog--${options.variant}` : "";
  return `k2b-dialog k2b-dialog--${size}${variant}${options?.surface === "bare" ? " is-bare" : ""}`;
};

export const contentClass = (surface?: DialogOptions["surface"]): string =>
  surface === "bare" ? "k2b-dialog__viewport is-bare" : "k2b-dialog__viewport";

export const confirmPrompt = (content: PromptContent, options?: ConfirmOptions): Promise<boolean | undefined> => {
  const confirmationPhrase = options?.confirmationPhrase;
  if (confirmationPhrase !== undefined && (confirmationPhrase.trim().length === 0 || /[\r\n\t]/.test(confirmationPhrase))) {
    throw new Error("confirmationPhrase must be non-empty, visible, and single-line");
  }
  let confirmationInput: HTMLInputElement | undefined;

  return dialogCore.open<boolean>(
    (close) => {
      if (!confirmationPhrase) {
        return (
          <div class="k2b-dialog__panel">
            <DialogHeader title={options?.title} icon={options?.icon} tone={promptTone(options?.variant)} close={() => close(false)} />
            <div class="k2b-dialog__body">{content}</div>
            <footer class="k2b-dialog__actions">
              <button type="button" class="k2b-button" data-variant="secondary" onClick={() => close(false)}>
                {options?.cancelText || resolveUiMessages().cancel}
              </button>
              <button type="button" class="k2b-button" data-variant={options?.variant ?? "primary"} onClick={() => close(true)}>
                {options?.confirmText || resolvePromptMessages().confirm}
              </button>
            </footer>
          </div>
        );
      }

      // The catalog owns word order; the slot marks where the verbatim phrase is rendered as code.
      const [labelBefore, labelAfter] = resolvePromptMessages().typeToConfirm({ phrase: PHRASE_SLOT }).split(PHRASE_SLOT);
      const [confirmationValue, setConfirmationValue] = createSignal("");
      const canConfirm = () => confirmationValue() === confirmationPhrase;
      const submit = (event: SubmitEvent) => {
        event.preventDefault();
        if (canConfirm()) close(true);
      };

      return (
        <form class="k2b-dialog__panel" onSubmit={submit}>
          <DialogHeader title={options?.title} icon={options?.icon} tone={promptTone(options?.variant)} close={() => close(false)} />
          <div class="k2b-dialog__body k2b-prompt-form">
            <div class="k2b-prompt-copy">{content}</div>
            <TextInput
              ref={(element) => {
                confirmationInput = element;
              }}
              label={
                <>
                  {labelBefore}
                  <code class="k2b-confirmation-phrase">{confirmationPhrase}</code>
                  {labelAfter}
                </>
              }
              value={confirmationValue}
              onValueChange={setConfirmationValue}
              autocomplete="off"
              autocapitalize="off"
              spellcheck={false}
              monospace
              required
            />
          </div>
          <footer class="k2b-dialog__actions">
            <button type="button" class="k2b-button" data-variant="secondary" onClick={() => close(false)}>
              {options?.cancelText || resolveUiMessages().cancel}
            </button>
            <button type="submit" class="k2b-button" data-variant={options?.variant ?? "primary"} disabled={!canConfirm()}>
              {options?.confirmText || resolvePromptMessages().confirm}
            </button>
          </footer>
        </form>
      );
    },
    {
      panelClassName: panelClass(options),
      contentClassName: contentClass(options?.surface),
      initialFocus: confirmationPhrase ? () => confirmationInput ?? null : undefined,
      signal: options?.signal,
      cancelBehavior: options?.cancelBehavior,
      history: options?.history,
      ariaLabel: options?.ariaLabel ?? options?.title ?? resolvePromptMessages().confirmation,
    },
  );
};

/** `prompts` starts as this object; `PanelDialog` asks through it, so it reaches a replaced `prompts.confirm` too. */
export const sharedPrompts = { confirm: confirmPrompt };
