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
  const finish = () => {
    if (pending) {
      pending = false;
      done();
    }
  };
  // When the element's own transitions end (a timer also fires in a hidden tab, which renders no frames).
  const ends = (element.getAnimations?.() ?? [])
    .filter((animation) => "transitionProperty" in animation)
    .map((animation) => Number(animation.effect?.getComputedTiming().endTime) || 0);
  if (ends.length > 0) setTimeout(finish, Math.max(...ends));
  else finish();
  return finish;
};
