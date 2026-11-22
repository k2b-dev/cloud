import { onCleanup } from "solid-js";

/**
 * Creates a debounced function with additional control methods for manual triggering
 * and cancellation. Useful for more complex debouncing scenarios.
 *
 * @assumption Must be called inside a SolidJS reactive owner (component or createRoot)
 *   so that the `onCleanup` handler is registered and pending timers are cleared on unmount.
 *
 * Side effects: registers an `onCleanup` handler that cancels any pending debounced call.
 *
 * @template T - The type signature of the callback function
 * @param callback - The function to debounce
 * @param delay - The number of milliseconds to delay execution
 * @returns Object with debounced function and control methods
 *
 * @example
 * ```tsx
 * const { debouncedFn, trigger, cancel, isPending } = timed.debounce(
 *   (text: string) => console.log("Saving:", text),
 *   1000
 * );
 *
 * // Use normally
 * debouncedFn("hello");
 *
 * // Force immediate execution
 * trigger("immediate save");
 *
 * // Cancel pending execution
 * cancel();
 *
 * // Check if execution is pending
 * if (isPending()) {
 *   console.log("Save is pending...");
 * }
 * ```
 */
const debounce = <T extends (...args: any[]) => any>(
  callback: T,
  delay: number,
): {
  debouncedFn: (...args: Parameters<T>) => void;
  trigger: (...args: Parameters<T>) => void;
  cancel: () => void;
  isPending: () => boolean;
} => {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const cancel = () => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };

  const trigger = (...args: Parameters<T>) => {
    cancel();
    callback(...args);
  };

  const isPending = (): boolean => {
    return timeoutId !== null;
  };

  onCleanup(() => {
    cancel();
  });

  const debouncedFn = (...args: Parameters<T>) => {
    cancel();
    timeoutId = setTimeout(() => {
      callback(...args);
      timeoutId = null;
    }, delay);
  };

  return {
    debouncedFn,
    trigger,
    cancel,
    isPending,
  };
};

/**
 * Creates an interval with control methods for starting, stopping, and status checking.
 * Automatically cleans up when the SolidJS component unmounts.
 *
 * @assumption Must be called inside a SolidJS reactive owner (component or createRoot)
 *   so that the `onCleanup` handler is registered and the interval is stopped on unmount.
 *
 * Side effects: registers an `onCleanup` handler that stops the interval.
 *   When `autoStart` is true (the default), the interval begins immediately.
 *
 * @param callback - The function to execute repeatedly at each interval
 * @param delay - The number of milliseconds between each execution
 * @param options - Configuration options for the interval behavior
 * @param options.autoStart - If true, starts the interval immediately when created (default: true)
 * @param options.executeImmediately - If true, executes the callback once immediately when started (default: true)
 * @returns Object with interval control methods
 *
 * @example
 * ```tsx
 * // Basic usage
 * const { start, stop, isRunning } = timed.interval(
 *   () => console.log("Tick:", Date.now()),
 *   1000
 * );
 *
 * // Manual control
 * const { start, stop, execute, isRunning } = timed.interval(
 *   () => fetchUpdates(),
 *   2000,
 *   { autoStart: false, executeImmediately: false }
 * );
 *
 * // Manual control
 * start(); // Begin interval
 * stop();  // Stop interval
 * execute(); // Run callback once without affecting interval
 *
 * // Status checking
 * if (isRunning()) {
 *   console.log("Timer is active");
 * }
 * ```
 */
const interval = (
  callback: () => void,
  delay: number,
  options: {
    autoStart?: boolean;
    executeImmediately?: boolean;
  } = { autoStart: true, executeImmediately: true },
): {
  start: () => void;
  stop: () => void;
  execute: () => void;
  isRunning: () => boolean;
} => {
  let intervalId: ReturnType<typeof setInterval> | null = null;

  const stop = () => {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };

  const execute = () => {
    callback();
  };

  const start = () => {
    stop();
    if (options.executeImmediately) {
      execute();
    }
    intervalId = setInterval(callback, delay);
  };

  const isRunning = (): boolean => {
    return intervalId !== null;
  };

  onCleanup(() => {
    stop();
  });

  if (options.autoStart) {
    start();
  }

  return {
    start,
    stop,
    execute,
    isRunning,
  };
};

export const timed = {
  debounce,
  interval,
} as const;
