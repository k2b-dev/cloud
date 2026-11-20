import { type JSX, Show } from "solid-js";
import { showTruncatedTitle } from "../internal/truncated-title";
import { resolveUiMessages } from "../intl/messages";
import { type DialogTone, dialogToneIcon, dialogToneLabel } from "./dialog-tone";
import type { DialogOptions } from "./prompts";
import { SuccessCheck } from "./success-check";

// The prompt header and tone helpers, shared by the confirmations and by the form prompts that load on demand. A
// module of their own keeps the on-demand form free of an import cycle back into the prompts.

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
