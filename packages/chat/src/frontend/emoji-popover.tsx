import { importOnDemand } from "@k2b/cloud/browser/reload";
import type { EmojiPicker } from "@k2b/ui";
import { type ComponentProps, createEffect, createSignal, type JSX, lazy, Show } from "solid-js";

const Picker = lazy(async () => (await importOnDemand(() => import("./chat-emoji-picker"))) ?? { default: () => null });

/** `EmojiPicker.Popover`, whose code loads the first time it gets an anchor and then stays. */
export function EmojiPopover(props: ComponentProps<typeof EmojiPicker.Popover>): JSX.Element {
  const [used, setUsed] = createSignal(false);
  createEffect(() => {
    if (props.anchor) setUsed(true);
  });
  return (
    <Show when={used()}>
      <Picker {...props} />
    </Show>
  );
}
