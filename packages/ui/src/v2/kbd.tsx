import { createMemo, createSignal, For, onMount, Show, sharedConfig } from "solid-js";
import { isServer } from "solid-js/web";
import { useLocale } from "../intl/locale";
import { formatShortcut, type KeyboardPlatform, keyboardPlatform } from "../intl/shortcut";

export type KbdProps = {
  /**
   * The shortcut, plus-separated: `mod+k`, `mod+shift+p`, `escape`, `enter`. `mod` is Command on Apple keyboards and
   * Ctrl ("Strg" in German) elsewhere.
   */
  keys: string;
  /**
   * The keyboard the person has. Without it the server and the first render show the other keyboards' caps and the
   * browser switches to its own after mounting; a page that knows the platform from the request's User-Agent
   * (`keyboardPlatform(userAgent)`) passes it, so nothing changes after the first render.
   */
  platform?: KeyboardPlatform;
};

/**
 * A shortcut as keycaps, such as ⌘ K on a Mac and Strg + K elsewhere: small round caps in the meta type, beside a menu
 * entry, a button's hint or a sentence. Assistive technology hears the keys by name ("Command K").
 */
export const Kbd = (props: KbdProps) => {
  const locale = useLocale();
  // the server cannot know the keyboard; the first render in the browser shows what the server sent
  const [own, setOwn] = createSignal<KeyboardPlatform>(isServer || sharedConfig.context ? "other" : keyboardPlatform());
  onMount(() => setOwn(keyboardPlatform()));
  const shortcut = createMemo(() => formatShortcut(props.keys, { platform: props.platform ?? own(), locale: locale() }));
  return (
    <Show when={shortcut().keys.length > 0}>
      <kbd class="k2-kbd" data-k2-part="Kbd">
        <span class="k2-kbd-name">{shortcut().name}</span>
        <For each={shortcut().keys}>
          {(key) => (
            <kbd class="k2-kbd-key" aria-hidden="true">
              {key.label}
            </kbd>
          )}
        </For>
      </kbd>
    </Show>
  );
};
