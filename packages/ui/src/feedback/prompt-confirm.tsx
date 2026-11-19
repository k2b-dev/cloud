import { createSignal, type JSX, Show } from "solid-js";
import type { TextInput } from "../inputs/TextInput";
import { showTruncatedTitle } from "../internal/truncated-title";
import { resolveUiMessages } from "../intl/messages";
import { type DialogTone, dialogToneIcon, dialogToneLabel } from "./dialog-tone";
import { loadedPromptForm, loadPromptForm } from "./prompt-form-loader";
import { resolvePromptMessages } from "./prompt-messages";
import { openPrompt } from "./prompt-sheet";
import type { ConfirmOptions, DialogOptions } from "./prompts";
import { SuccessCheck } from "./success-check";

// The dialog frame and `prompts.confirm`, apart from the form prompts: `PanelDialog` asks before discarding changes,
// and the form prompts render date pickers whose phone sheet is a `PanelDialog`, so one module would be an import cycle.

export type PromptContent = string | HTMLElement | JSX.Element;

const PHRASE_SLOT = "\u0000";

/** A prompt's `variant` is its tone too: a success, warning or danger prompt carries the dialog tone of that name. */
export const promptTone = (variant: DialogOptions["variant"]): DialogTone | undefined => (variant === "primary" ? undefined : variant);

/** A warning asks for care, not for a destructive act: its confirm button stays primary. */
export const promptButtonVariant = (variant: DialogOptions["variant"]): "danger" | "primary" | "success" =>
  variant === undefined || variant === "warning" ? "primary" : variant;

export const DialogHeader = (props: {
  close: () => void;
  title?: string;
  icon?: string;
  tone?: DialogTone;
  /** A success tone draws its check once when the header appears; see `prompts.success`. */
  celebrate?: boolean;
}): JSX.Element => (
  <header class="k2b-dialog__header">
    <Show
      when={props.celebrate && props.tone === "success"}
      fallback={
        <Show when={props.tone ? dialogToneIcon(props.tone) : props.icon}>
          {(icon) => <i class={icon()} data-tone={props.tone} aria-hidden="true" />}
        </Show>
      }
    >
      <SuccessCheck />
    </Show>
    <Show when={props.tone}>
      {(tone) => (
        <span class="k2b-sr-only" data-dialog-tone-label>
          {dialogToneLabel(resolveUiMessages(), tone())}
        </span>
      )}
    </Show>
    <Show when={props.title} fallback={<span class="k2b-dialog__header-spacer" />}>
      {(title) => <h2 onPointerEnter={showTruncatedTitle}>{title()}</h2>}
    </Show>
    <button type="button" class="k2b-dialog__close" aria-label={resolveUiMessages().closeDialog} onClick={props.close}>
      <i class="ti ti-x" aria-hidden="true" />
    </button>
  </header>
);

export const openError = (content: string | HTMLElement, options?: DialogOptions, sheet?: boolean) =>
  openPrompt(
    (close) => (
      <div class="k2b-dialog__panel">
        <DialogHeader title={options?.title ?? resolveUiMessages().error} icon={options?.icon} tone="danger" close={close} />
        <div class="k2b-dialog__body">{content}</div>
        <footer class="k2b-dialog__actions">
          <button type="button" class="k2b-button" onClick={() => close()}>
            {options?.confirmText || resolveUiMessages().close}
          </button>
        </footer>
      </div>
    ),
    { ...options, variant: "danger" },
    resolveUiMessages().error,
    sheet,
  );

/**
 * The fields of a prompt did not load: the person sees why and asks again, which requests them again. The message
 * keeps the dialog in the middle, since the phone sheet loads on demand too.
 */
export const promptFormUnavailable = async (signal?: AbortSignal): Promise<void> => {
  if (!signal?.aborted) await openError(resolvePromptMessages().formUnavailable, { signal }, false);
};

const openConfirm = (content: PromptContent, options: ConfirmOptions | undefined, phraseInput?: typeof TextInput) => {
  const confirmationPhrase = options?.confirmationPhrase;
  let confirmationInput: HTMLInputElement | undefined;

  return openPrompt<boolean>(
    (close) => {
      if (!confirmationPhrase || !phraseInput) {
        return (
          <div class="k2b-dialog__panel">
            <DialogHeader title={options?.title} icon={options?.icon} tone={promptTone(options?.variant)} close={() => close(false)} />
            <div class="k2b-dialog__body">{content}</div>
            <footer class="k2b-dialog__actions">
              <button type="button" class="k2b-button" data-variant="secondary" onClick={() => close(false)}>
                {options?.cancelText || resolveUiMessages().cancel}
              </button>
              <button type="button" class="k2b-button" data-variant={promptButtonVariant(options?.variant)} onClick={() => close(true)}>
                {options?.confirmText || resolvePromptMessages().confirm}
              </button>
            </footer>
          </div>
        );
      }

      const PhraseInput = phraseInput;
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
            <PhraseInput
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
            <button type="submit" class="k2b-button" data-variant={promptButtonVariant(options?.variant)} disabled={!canConfirm()}>
              {options?.confirmText || resolvePromptMessages().confirm}
            </button>
          </footer>
        </form>
      );
    },
    options,
    resolvePromptMessages().confirmation,
    true,
    confirmationPhrase ? () => confirmationInput ?? null : undefined,
  );
};

export const confirmPrompt = (content: PromptContent, options?: ConfirmOptions): Promise<boolean | undefined> => {
  const confirmationPhrase = options?.confirmationPhrase;
  if (confirmationPhrase === undefined) return openConfirm(content, options);
  if (confirmationPhrase.trim().length === 0 || /[\r\n\t]/.test(confirmationPhrase)) {
    throw new Error("confirmationPhrase must be non-empty, visible, and single-line");
  }
  // The typed phrase uses the form's text field, which loads with the form prompts.
  const form = loadedPromptForm();
  if (form) return openConfirm(content, options, form.TextInput);
  return loadPromptForm().then(
    (module) => openConfirm(content, options, module.TextInput),
    async () => {
      await promptFormUnavailable(options?.signal);
      return false;
    },
  );
};

/** `prompts` starts as this object; `PanelDialog` asks through it, so it reaches a replaced `prompts.confirm` too. */
export const sharedPrompts = { confirm: confirmPrompt };
