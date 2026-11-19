import { createSignal, type JSX } from "solid-js";
import type { TextInput } from "../inputs/TextInput";
import { resolveUiMessages } from "../intl/messages";
import { DialogHeader, promptButtonVariant, promptTone } from "./prompt-header";
import { resolvePromptMessages } from "./prompt-messages";
import { openPrompt } from "./prompt-sheet";
import type { ConfirmOptions, DialogOptions } from "./prompts";

// The dialog frame and `prompts.confirm`, apart from the form prompts: `PanelDialog` asks before discarding changes,
// and the form prompts render date pickers whose phone sheet is a `PanelDialog`, so one module would be an import cycle.

export type PromptContent = string | HTMLElement | JSX.Element;

const PHRASE_SLOT = "\u0000";

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
  // A confirmation that asks for a phrase never opens without the field to type it.
  if (confirmationPhrase && !phraseInput) throw new Error("A confirmationPhrase needs its text field");
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
  const field = phraseField?.loaded();
  if (field) return openConfirm(content, options, field);
  if (!phraseField) return promptFormUnavailable(options?.signal).then(() => false);
  return phraseField.load().then(
    (input) => openConfirm(content, options, input),
    async () => {
      await promptFormUnavailable(options?.signal);
      return false;
    },
  );
};

/**
 * Where the typed phrase's text field comes from: `prompts` provides it from the form chunk that loads on demand.
 * `PanelDialog` imports this module for its discard question, and the form's date picker imports `PanelDialog`
 * through its phone sheet, so importing the form's loader here would be an import cycle.
 */
let phraseField: { loaded: () => typeof TextInput | undefined; load: () => Promise<typeof TextInput> } | undefined;
export const providePhraseField = (source: NonNullable<typeof phraseField>) => {
  phraseField = source;
};

/** `prompts` starts as this object; `PanelDialog` asks through it, so it reaches a replaced `prompts.confirm` too. */
export const sharedPrompts = { confirm: confirmPrompt };
