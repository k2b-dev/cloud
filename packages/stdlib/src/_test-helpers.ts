import { createRoot } from "solid-js";

/**
 * Wraps a function in SolidJS createRoot for testing reactive primitives.
 * Returns the result and a dispose function for cleanup.
 */
export const testRoot = <T>(fn: () => T): { result: T; dispose: () => void } => {
  let result!: T;
  const dispose = createRoot((d) => {
    result = fn();
    return d;
  });
  return { result, dispose };
};
