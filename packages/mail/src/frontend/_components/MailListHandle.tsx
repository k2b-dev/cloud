import { MovedHint, ResizeSeparator, useLocale } from "@k2b/ui";
import { createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { mailWorkspaceMessages } from "../mail-workspace-messages";

/**
 * F8: the list takes this share of the area beside the reader until a person moves the handle. It mirrors
 * `DEFAULT_MAIL_LIST_SHARE` in the contracts, which carry Zod and stay out of the mailbox's first load; a test keeps
 * both equal.
 */
export const MAIL_DEFAULT_LIST_SHARE = 0.4;
/** The list never gets narrower than this, the reader never narrower than `MAIL_READER_MIN`, in px. */
export const MAIL_LIST_MIN = 320;
export const MAIL_READER_MIN = 480;
/** The handle's own width between list and reader, in px. */
const HANDLE_WIDTH = 12;

/** The list's share in percent, one decimal, as the stylesheet and the handle use it. */
export const mailListPercent = (share: number | null): number => Math.round((share ?? MAIL_DEFAULT_LIST_SHARE) * 1000) / 10;

/** The narrowest and widest list in percent of the split's width, so list and reader keep their minimums. */
export const mailListPercentRange = (width: number): { min: number; max: number } => {
  if (width <= 0) return { min: 20, max: 80 };
  const min = Math.min(100, (MAIL_LIST_MIN / width) * 100);
  const max = Math.max(min, ((width - MAIL_READER_MIN - HANDLE_WIDTH) / width) * 100);
  return { min: Math.round(min * 10) / 10, max: Math.round(max * 10) / 10 };
};

/**
 * The list's share as one custom property on the workspace. The server renders it, so the first frame already has
 * the person's width; the handle changes it in place while it moves.
 */
export function MailListShareStyle(props: { percent: number }) {
  return <style innerHTML={`.k2b-ui .mail-workspace{--mail-list-share:${props.percent}}`} />;
}

/**
 * The handle between list and reader: drag, arrow keys (Shift for larger steps), Home and End, and a double click or
 * Enter back to the default. The share is saved when a move ends and cleared by a reset. `hint` shows the one-time
 * note for the old view key at the handle itself.
 */
export function MailListHandle(props: {
  percent: number;
  onResize: (percent: number) => void;
  onResizeEnd: (percent: number) => void;
  onReset: () => void;
  hint: { open: boolean; onDismiss: () => void };
}) {
  const locale = useLocale();
  const t = createMemo(() => mailWorkspaceMessages.resolve([locale()]).t);
  let slot: HTMLSpanElement | undefined;
  const [width, setWidth] = createSignal(0);
  onMount(() => {
    const split = slot?.closest<HTMLElement>(".mail-split-panes");
    if (!split || typeof ResizeObserver === "undefined") return;
    setWidth(split.getBoundingClientRect().width);
    const observer = new ResizeObserver(() => setWidth(split.getBoundingClientRect().width));
    observer.observe(split);
    onCleanup(() => observer.disconnect());
  });
  const range = createMemo(() => mailListPercentRange(width()));
  const target = () => slot?.querySelector<HTMLElement>(".mail-list-handle") ?? undefined;
  return (
    <span ref={slot} class="contents">
      <ResizeSeparator
        class="mail-list-handle"
        label={t().resizeList}
        orientation="vertical"
        controls="mail-conversation-list"
        min={range().min}
        max={range().max}
        value={Math.min(range().max, Math.max(range().min, props.percent))}
        unit={Math.max(1, width() / 100)}
        step={1}
        largeStep={5}
        grow="end"
        onResize={props.onResize}
        onResizeEnd={props.onResizeEnd}
        onReset={props.onReset}
      />
      <MovedHint
        open={props.hint.open}
        onDismiss={props.hint.onDismiss}
        target={target}
        placement="right"
        action={{ label: t().resetListWidth, onClick: props.onReset }}
      >
        {t().densityHint}
      </MovedHint>
    </span>
  );
}
