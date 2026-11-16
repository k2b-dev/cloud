/**
 * Waits for the exit transitions that the stylesheet starts on an element that just closed, such as a dialog whose
 * `[open]` went away, and then calls `done` once. Without a running transition (reduced motion, a sheet that moves
 * itself, a document without the stylesheet) `done` runs at once. Only the element's own transitions count: a spinner
 * inside it may loop forever.
 *
 * Returns a function that ends the wait at once and calls `done` now, for a new dialog that opens meanwhile or a page
 * swap that disposes everything.
 */
export const afterExitTransitions = (element: Element, done: () => void): (() => void) => {
  let pending = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = () => {
    if (!pending) return;
    pending = false;
    if (timer !== undefined) clearTimeout(timer);
    done();
  };
  const running =
    typeof element.getAnimations === "function" && typeof CSSTransition !== "undefined"
      ? element.getAnimations().filter((animation) => animation instanceof CSSTransition)
      : [];
  if (running.length === 0) {
    finish();
    return finish;
  }
  void Promise.allSettled(running.map((animation) => animation.finished)).then(finish);
  // A hidden tab renders no frames, so its transitions never finish; a timer still fires when they would have ended.
  const end = Math.max(...running.map((animation) => Number(animation.effect?.getComputedTiming().endTime) || 0));
  timer = setTimeout(finish, end);
  return finish;
};
