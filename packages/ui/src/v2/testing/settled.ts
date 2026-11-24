import type { Page } from "playwright";

/**
 * Guards against state sampled before it settled (#1476, #1499).
 * Waits for fonts, the first resize delivery and its scheduled frame, running finite document-timeline animations, then two frames.
 * Infinite, scroll-driven, and paused animations are not waited for. A page that
 * keeps starting finite animations is not settled: this throws with their names,
 * and the test must wait for its own condition instead. Suites not about motion
 * pass `reducedMotion: "reduce"` to newPage/newContext themselves. Playwright's
 * pointer rests at the top left from the first page on, touch contexts included,
 * so content that arrives there later fades into hover; the error marks such
 * targets with `"hovered":true`.
 */
export const settled = async (page: Page): Promise<void> => {
  const remaining = await page.evaluate(async () => {
    await document.fonts.ready;
    // MutationObserver can schedule the next frame; ResizeObserver reports after layout and schedules the frame
    // after that. Include that first observation wave, once, before the snapshot. Later animation starts still fail.
    await new Promise<void>((resolve) => {
      const sizes = new ResizeObserver(() => {
        sizes.disconnect();
        requestAnimationFrame(() => resolve());
      });
      sizes.observe(document.documentElement);
    });
    const running = () =>
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.timeline === document.timeline &&
            animation.playState === "running" &&
            Number.isFinite(animation.effect?.getComputedTiming().endTime),
        );
    const frames = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    // A navigation the test triggered can start a document view transition a frame after it commits.
    // Its user-agent animations belong to that navigation, not to a page that keeps animating, so they
    // are awaited too, a bounded number of times. Any other animation that starts meanwhile still fails.
    const viewTransition = (animation: Animation) =>
      animation instanceof CSSAnimation &&
      animation.animationName.startsWith("-ua-") &&
      animation.effect instanceof KeyframeEffect &&
      animation.effect.target === document.documentElement;
    await Promise.allSettled(running().map((animation) => animation.finished));
    await frames();
    for (let round = 0; round < 3; round++) {
      const pending = running();
      if (!pending.length || !pending.every(viewTransition)) break;
      await Promise.allSettled(pending.map((animation) => animation.finished));
      await frames();
    }
    return running().map((animation) => {
      const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
      return {
        target:
          target instanceof Element
            ? `${target.tagName.toLowerCase()}${target.id ? `#${target.id}` : ""}${Array.from(target.classList, (name) => `.${name}`).join("")}`
            : null,
        name:
          animation instanceof CSSTransition
            ? animation.transitionProperty
            : animation instanceof CSSAnimation
              ? animation.animationName
              : animation.id,
        currentTime: animation.currentTime,
        hovered: target instanceof Element && target.matches(":hover"),
      };
    });
  });
  if (remaining.length) {
    throw new Error(
      `settled: the page kept animating; finite animations started while it settled: ${JSON.stringify(remaining)}. Wait for the test's own condition instead.`,
    );
  }
};
