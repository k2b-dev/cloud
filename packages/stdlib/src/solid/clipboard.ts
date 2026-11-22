import { createSignal, onCleanup, type Accessor } from "solid-js";

// ==========================
// Reactive Clipboard
// ==========================

/**
 * Creates a reactive clipboard hook with copy feedback signal.
 *
 * Errors from the Clipboard API are caught and logged to `console.error` --
 * they are not propagated to the caller. If copying fails, `wasCopied` remains `false`.
 *
 * @param timeout - Time in ms after which wasCopied resets to false (default: 2000)
 * @returns Object with copy function and wasCopied signal
 *
 * @example
 * const { copy, wasCopied } = clipboard.create();
 * await copy("Hello");
 * console.log(wasCopied()); // true (resets after 2s)
 */
const create = (timeout: number = 2000) => {
  const [wasCopied, setWasCopied] = createSignal(false);
  let timerId: ReturnType<typeof setTimeout> | null = null;

  const copy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      console.error("Failed to copy text: ", err);
      return;
    }
    if (timerId !== null) clearTimeout(timerId);
    timerId = setTimeout(() => {
      setWasCopied(false);
      timerId = null;
    }, timeout);
    setWasCopied(true);
  };

  onCleanup(() => {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  });

  return { copy, wasCopied };
};

export type ClipboardWriterOptions<T> = {
  /** Writes the value to the system clipboard. */
  write: (value: T) => Promise<void>;
  /** Time in ms after which successful copy feedback resets (default: 2000). */
  copiedFor?: number;
};

export type ClipboardWriter<T> = {
  /** Writes a value and reports whether that write succeeded. */
  copy: (value: T) => Promise<boolean>;
  /** Whether the latest write succeeded and is still inside its feedback window. */
  wasCopied: Accessor<boolean>;
  /** Error from the latest write attempt, or null. */
  error: Accessor<Error | null>;
};

const normalizeError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(String(value));

/**
 * Creates reactive copy feedback for a custom asynchronous clipboard writer.
 *
 * Only the latest invocation may update state. Starting a new invocation clears
 * previous feedback, and all pending reset timers are bound to the Solid owner.
 */
const createWriter = <T>(options: ClipboardWriterOptions<T>): ClipboardWriter<T> => {
  const [wasCopied, setWasCopied] = createSignal(false);
  const [error, setError] = createSignal<Error | null>(null);
  const copiedFor = options.copiedFor ?? 2000;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let latestInvocation = 0;
  let disposed = false;

  const clearResetTimer = () => {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  };

  const copy = async (value: T): Promise<boolean> => {
    const invocation = ++latestInvocation;
    clearResetTimer();
    setWasCopied(false);
    setError(null);

    try {
      await options.write(value);
    } catch (cause) {
      if (!disposed && invocation === latestInvocation) {
        setError(normalizeError(cause));
      }
      return false;
    }
    if (!disposed && invocation === latestInvocation) {
      timerId = setTimeout(() => {
        if (!disposed && invocation === latestInvocation) setWasCopied(false);
        timerId = null;
      }, copiedFor);
      setWasCopied(true);
    }
    return true;
  };

  onCleanup(() => {
    disposed = true;
    latestInvocation++;
    clearResetTimer();
  });

  return { copy, wasCopied, error };
};

export const clipboard = {
  create,
  createWriter,
} as const;
