import { copyToClipboard } from "@k2b/stdlib/browser";
import { createSignal, type JSX, onCleanup, splitProps } from "solid-js";
import { useUiMessages } from "../intl/messages";
import { Button, type ButtonProps } from "./Button";

export type CopyButtonValue = { text: string; value?: string } | { text?: string; value: string };

export type CopyButtonProps = CopyButtonValue &
  Omit<ButtonProps, "children" | "onClick"> & {
    label?: string;
    copiedLabel?: string;
    iconOnly?: boolean;
    onCopied?: () => void;
    onCopyError?: (error: unknown) => void;
    resetAfter?: number;
  };

export async function copyText(
  text: string,
  onCopyError?: (error: unknown) => void,
  copy: (text: string) => Promise<void> = copyToClipboard,
): Promise<void> {
  try {
    await copy(text);
  } catch (error) {
    onCopyError?.(error);
    throw error;
  }
}

export function CopyButton(props: CopyButtonProps): JSX.Element {
  const messages = useUiMessages();
  const [local, rest] = splitProps(props, [
    "class",
    "copiedLabel",
    "disabled",
    "iconOnly",
    "label",
    "loading",
    "loadingLabel",
    "onCopied",
    "onCopyError",
    "resetAfter",
    "size",
    "text",
    "type",
    "value",
    "variant",
  ]);
  const [copied, setCopied] = createSignal(false);
  let resetTimer: ReturnType<typeof setTimeout> | undefined;

  onCleanup(() => {
    if (resetTimer) clearTimeout(resetTimer);
  });

  const copy = async () => {
    // `copyText` reports through `onCopyError` and then rethrows so direct
    // callers can await it. The click handler is not awaited by anyone, so it
    // has to absorb the rejection here — otherwise a denied clipboard
    // permission surfaces as an unhandled rejection despite `onCopyError`.
    try {
      await copyText(local.text ?? local.value ?? "", local.onCopyError);
    } catch {
      return;
    }
    setCopied(true);
    local.onCopied?.();
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = setTimeout(() => setCopied(false), local.resetAfter ?? 2000);
  };

  const visibleLabel = () => (copied() ? (local.copiedLabel ?? messages().copied) : (local.label ?? messages().copy));
  const icon = () => (copied() ? "ti ti-check" : "ti ti-copy");
  const iconOnly = () => local.iconOnly ?? local.label === undefined;
  const buttonLabel = () => (local.loading && local.loadingLabel ? local.loadingLabel : visibleLabel());
  const button = (tooltip?: string) => (
    <Button
      {...rest}
      tooltip={tooltip}
      disabled={local.disabled || local.loading}
      type={local.type ?? "button"}
      class={`k2b-copy-button ${local.class ?? ""}`}
      size={local.size ?? "sm"}
      variant={local.variant ?? "ghost"}
      aria-busy={local.loading ? "true" : undefined}
      aria-label={iconOnly() ? buttonLabel() : undefined}
      onClick={copy}
    >
      <i class={local.loading ? "ti ti-loader-2 k2b-spin" : icon()} aria-hidden="true" />
      {!iconOnly() && <span>{buttonLabel()}</span>}
    </Button>
  );

  return iconOnly() ? (
    <>
      {button(visibleLabel())}
      <span class="k2b-sr-only" aria-live="polite">
        {copied() ? visibleLabel() : ""}
      </span>
    </>
  ) : (
    button(undefined)
  );
}

export default CopyButton;
