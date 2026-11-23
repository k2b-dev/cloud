import { createSignal, For, Show } from "solid-js";
import { ActionButton } from "./button";
import { Icon } from "./marks";
import type { Action } from "./types";

type ToastItem = { id: number; message: string; icon?: string; action?: Action };

const [toasts, setToasts] = createSignal<readonly ToastItem[]>([]);
let next = 0;

export type ToastOptions = {
  /** At most one deed, such as "Rückgängig". */
  action?: Action;
  /** A symbol before the sentence, such as `check`. */
  icon?: string;
  /** How long the toast stays, in ms: 5 s, or 8 s with an action. */
  duration?: number;
};

/**
 * Shows one short sentence at the bottom, such as "In „Lieferanten“ verschoben", with at most one deed. The toast goes
 * by itself; its action closes it too. The `Workspace` holds the region where toasts appear and are announced.
 */
export function toast(message: string, options: ToastOptions = {}): void {
  const id = ++next;
  const close = () => setToasts((list) => list.filter((item) => item.id !== id));
  const action = options.action && {
    ...options.action,
    onClick: () => {
      options.action?.onClick?.();
      close();
    },
  };
  setToasts((list) => [...list, { id, message, icon: options.icon, action }]);
  setTimeout(close, options.duration ?? (action ? 8000 : 5000));
}

/** The region of the toasts (internal: `Workspace` renders it once). */
export const Toasts = () => (
  <div class="k2-toasts" role="status" aria-live="polite">
    <For each={toasts()}>
      {(item) => (
        <div class="k2-toast" data-k2-part="Toast">
          <Show when={item.icon}>{(name) => <Icon name={name()} />}</Show>
          <span>{item.message}</span>
          <Show when={item.action}>{(action) => <ActionButton action={action()} variant="text" />}</Show>
        </div>
      )}
    </For>
  </div>
);
