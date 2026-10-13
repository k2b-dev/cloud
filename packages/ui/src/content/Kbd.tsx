import { createMemo, createSignal, For, type JSX, onMount, sharedConfig, Show } from "solid-js";
import { isServer } from "solid-js/web";
import { useLocale } from "../intl/locale";
import { formatShortcut, keyboardPlatform, type KeyboardPlatform } from "../intl/shortcut";

export type KbdProps = {
  /** Shortcut such as "mod+k", "shift+/", "enter". */
  keys: string;
  /** Set on the server when the host knows the reader's platform. */
  platform?: KeyboardPlatform;
  class?: string;
};

/**
 * Accessible key caps using the inherited locale and the reader's platform.
 * A host rendering caps on the server passes `platform` to avoid a switch after hydration.
 * @example <Kbd keys="mod+k" platform="apple" />
 */
export function Kbd(props: KbdProps): JSX.Element {
  const locale = useLocale();
  const [platform, setPlatform] = createSignal<KeyboardPlatform>(isServer || sharedConfig.context ? "other" : keyboardPlatform());
  onMount(() => setPlatform(keyboardPlatform()));
  const shortcut = createMemo(() => formatShortcut(props.keys, { platform: props.platform ?? platform(), locale: locale() }));
  return (
    <Show when={shortcut().keys.length > 0}>
      <kbd class={`k2b-kbd${props.class ? ` ${props.class}` : ""}`}>
        <span class="k2b-sr-only">{shortcut().name}</span>
        <span class="k2b-kbd__keys" aria-hidden="true">
          <For each={shortcut().keys}>{(key) => <kbd class="k2b-kbd__key">{key.label}</kbd>}</For>
        </span>
      </kbd>
    </Show>
  );
}
export default Kbd;
