/**
 * The motion of one dialog element's frame while it stays open: a level that replaces another morphs the frame from
 * the old size to the new one in the same place, without stacking. The old content fades out, the frame changes size
 * over `--k2b-motion-morph` with `--k2b-ease-morph`, and the new content fades in, set at its final size from the
 * first frame so it never rewraps; the frame clips meanwhile. Anything that interrupts a change turns around from the
 * values the eye sees; the endings of the interrupted change are dropped, not run. Reduced motion swaps in one frame.
 *
 * The frame's own size is animated, a named exception to "transform and opacity only" (see the motion guide): the
 * frame stands alone above the page, so nothing beside it moves.
 */

import { restoreScroll } from "../internal/scroll-places";

export { afterExitTransitions } from "../internal/exit-motion";

/** Shares of the morph: the old content fades out in the first 80 of 280 ms, the new one waits 110 ms, then fades in 140 ms. */
const LEAVE_SHARE = 80 / 280;
const ARRIVE_DELAY_SHARE = 110 / 280;
const ARRIVE_SHARE = 140 / 280;

type Anchor = "center" | "bottom" | "fixed";
type Fade = { animation: Animation; to: 0 | 1; done: () => void };

export type FrameMotion = {
  /**
   * Before a level replaces the shown one: remembers the frame as the eye sees it and takes `leaving` out of the flow,
   * visible and inert, at its present size.
   */
  begin: (leaving: HTMLElement, back?: boolean) => void;
  /**
   * A level that replaces another keeps the same `<dialog>`, so a screen reader does not reliably say its new name.
   * The live region inside the dialog does (`announce()` regions sit outside a modal dialog and are silent there): the
   * shown level's name, and for an `alertdialog` its sentence too.
   */
  announce: (role: "dialog" | "alertdialog") => void;
  /**
   * After `arriving` is shown and its frame presentation applied: morphs the frame to its size and fades the contents.
   * `left` runs once `leaving` has faded out (hide a lower level, or dispose a closed one).
   */
  arrive: (arriving: HTMLElement, left: () => void) => void;
  /** Ends every motion now and runs the pending endings, for a frame that leaves the document. */
  stop: () => void;
  /**
   * For a frame that closes and fades out: keeps the size, place and contents exactly as the eye sees them now, and
   * returns the pending endings to run once the frame has left.
   */
  freeze: () => () => void;
};

const STYLE_HELD = ["position", "inset", "width", "height", "flex"] as const;

export const createFrameMotion = (dialog: HTMLDialogElement): FrameMotion => {
  // Exists before its first message: a region inserted and filled at once is often not read.
  const live = document.createElement("div");
  live.className = "k2b-sr-only";
  live.setAttribute("aria-live", "polite");
  live.dataset.k2bDialogLive = "";
  dialog.prepend(live);
  // A region that was just inserted is read only once the accessibility tree knows it: its first message waits a frame.
  let fresh = true;
  requestAnimationFrame(() => {
    fresh = false;
  });
  let frame: Animation | undefined;
  const fades = new Map<HTMLElement, Fade>();

  /** A time token in milliseconds; the stylesheet may hand it over as `280ms` or, registered, as `0.28s`. */
  const token = (name: string) => {
    const value = getComputedStyle(dialog).getPropertyValue(name).trim();
    const amount = Number.parseFloat(value) || 0;
    return value.endsWith("ms") ? amount : value.endsWith("s") ? amount * 1000 : amount;
  };
  const curve = (name: string, fallback: string) => getComputedStyle(dialog).getPropertyValue(name).trim() || fallback;
  const animatable = () => typeof dialog.animate === "function";

  /** Where the frame stays put while it changes size: centred by the stylesheet, a sheet on the bottom edge, or placed. */
  const anchor = (): Anchor => {
    if (dialog.style.position === "fixed") return "fixed";
    if (!dialog.classList.contains("k2b-bottom-sheet-frame")) return "center";
    const asDialog =
      dialog.classList.contains("is-adaptive") && typeof matchMedia === "function" && matchMedia("(min-width: 48rem)").matches;
    return asDialog ? "center" : "bottom";
  };
  /** What the eye sees now, including a size or place that is still moving. */
  const seen = () => ({
    width: dialog.offsetWidth,
    height: dialog.offsetHeight,
    top: Number.parseFloat(getComputedStyle(dialog).top) || 0,
  });

  /** Its exact laid-out size: `offsetWidth` rounds, and a content a fraction narrower can wrap differently. */
  const laidOut = (element: HTMLElement) => {
    const { width, height } = getComputedStyle(element);
    return { width, height };
  };
  /** Out of the flow, at the size it has now, so it neither moves nor takes room while it fades. */
  const hold = (element: HTMLElement) => {
    const { width, height } = laidOut(element);
    element.style.position = "absolute";
    element.style.inset = "0 auto auto 0";
    element.style.width = width;
    element.style.height = height;
    element.inert = true;
    element.setAttribute("aria-hidden", "true");
  };
  const unhold = (element: HTMLElement) => {
    for (const property of STYLE_HELD) element.style.removeProperty(property);
    element.inert = false;
    element.removeAttribute("aria-hidden");
  };
  /** At its final size while the frame moves around it. */
  const pin = (element: HTMLElement) => {
    const { width, height } = laidOut(element);
    element.style.width = width;
    element.style.height = height;
    element.style.flex = "none";
  };

  const fade = (element: HTMLElement, to: 0 | 1, duration: number, delay: number, done: () => void) => {
    const running = fades.get(element);
    // A fade that is under way turns around from its current value; only content that was hidden starts at 0.
    const from = running ? Number(getComputedStyle(element).opacity) : to === 1 ? 0 : 1;
    running?.animation.cancel();
    fades.delete(element);
    if (!duration || !animatable()) {
      done();
      return;
    }
    const animation = element.animate([{ opacity: from }, { opacity: to }], {
      duration,
      delay: running ? 0 : delay,
      easing: "linear",
      fill: "both",
    });
    fades.set(element, { animation, to, done });
    animation.onfinish = () => {
      if (fades.get(element)?.animation !== animation) return;
      fades.delete(element);
      done();
      animation.cancel();
    };
  };

  const endFrame = () => {
    frame?.cancel();
    frame = undefined;
    delete dialog.dataset.k2bFrameMotion;
  };

  let started: { from: ReturnType<typeof seen>; anchor: Anchor; leaving: HTMLElement; scrolled: boolean } | undefined;
  /** The frame scrolls its contents itself, as unstructured content does. */
  const scrolled = () => dialog.scrollTop > 0 || dialog.scrollLeft > 0;

  const begin: FrameMotion["begin"] = (leaving, back) => {
    started = { from: seen(), anchor: anchor(), leaving, scrolled: scrolled() };
    endFrame();
    hold(leaving);
    // The frame clips from now on: the held content, larger than the new one, must not give it a scrollbar while the
    // new content is measured and pinned (a classic scrollbar would narrow it until the old content has gone). A frame
    // that scrolls itself swaps at once and keeps its scroll place instead.
    if (!started.scrolled) dialog.dataset.k2bFrameMotion = "";
    if (!back) return;
    // The shown level stays the dialog's last child, as sheets and tone rules expect; the closed one moves before it,
    // with the scroll places the dialog core kept for it.
    dialog.insertBefore(leaving, live.nextSibling);
    restoreScroll(leaving);
  };

  const announce: FrameMotion["announce"] = (role) => {
    const texts = (attribute: string) =>
      (dialog.getAttribute(attribute) ?? "")
        .split(/\s+/)
        .map((id) => (id ? (document.getElementById(id)?.textContent ?? "").trim() : ""))
        .filter(Boolean);
    const name = dialog.getAttribute("aria-label") ?? texts("aria-labelledby").join(" ");
    const sentence = role === "alertdialog" ? texts("aria-describedby").join(" ") : "";
    live.textContent = "";
    const say = () => {
      live.textContent = [name, sentence].filter(Boolean).join(" ");
    };
    requestAnimationFrame(() => (fresh ? requestAnimationFrame(say) : say()));
  };

  const arrive: FrameMotion["arrive"] = (arriving, left) => {
    const change = started;
    started = undefined;
    if (!change) return;
    const { from, leaving } = change;
    unhold(arriving);
    // Only this change's two contents share the frame: one that still fades out from an earlier change is gone now
    // (one that comes back turns its fade around below).
    for (const [element, { animation, to, done }] of fades)
      if (to === 0 && element !== leaving && element !== arriving) {
        fades.delete(element);
        animation.cancel();
        done();
      }
    const leave = () => {
      unhold(leaving);
      left();
    };
    const duration = animatable() ? token("--k2b-motion-morph") : 0;
    // Between a sheet and a centred dialog there is no shared edge to morph from. A frame that scrolls itself swaps at
    // once too: its contents stand in its scrolled space, which a moving size would cut or shift.
    if (!duration || anchor() !== change.anchor || change.scrolled || scrolled()) {
      delete dialog.dataset.k2bFrameMotion;
      fade(leaving, 0, 0, 0, leave);
      fade(arriving, 1, 0, 0, () => {});
      return;
    }
    const to = seen();
    pin(arriving);
    // The new level's own size limits would cut the old size at the first frame: the motion sets both sizes itself.
    const size = (geometry: typeof from) => ({
      width: `${geometry.width}px`,
      height: `${geometry.height}px`,
      minWidth: "0",
      minHeight: "0",
      maxWidth: "none",
      maxHeight: "none",
      ...(change.anchor === "center" ? { top: `${geometry.top}px` } : {}),
    });
    dialog.dataset.k2bFrameMotion = "";
    const animation = dialog.animate([size(from), size(to)], { duration, easing: curve("--k2b-ease-morph", "ease-out") });
    frame = animation;
    // The new content keeps its final size until the frame has arrived there too, so it never rewraps; its fade
    // ends earlier (at 250 of 280 ms).
    animation.onfinish = () => {
      if (frame !== animation) return;
      endFrame();
      for (const property of ["width", "height", "flex"] as const) arriving.style.removeProperty(property);
      // A sheet measures its rests again at the frame's new size.
      dialog.dispatchEvent(new Event("k2b-frame-resize"));
    };
    fade(leaving, 0, duration * LEAVE_SHARE, 0, leave);
    fade(arriving, 1, duration * ARRIVE_SHARE, duration * ARRIVE_DELAY_SHARE, () => {});
  };

  const stop = () => {
    started = undefined;
    endFrame();
    const pending = [...fades.values()];
    fades.clear();
    for (const { animation, done } of pending) {
      animation.cancel();
      done();
    }
  };

  const freeze = () => {
    started = undefined;
    // What the eye sees stays: the running values become the frame's and the contents' own styles.
    if (frame) {
      frame.commitStyles();
      frame.cancel();
      frame = undefined;
    }
    const pending = [...fades.values()];
    fades.clear();
    for (const { animation } of pending) {
      animation.commitStyles();
      animation.cancel();
    }
    return () => {
      for (const { done } of pending) done();
    };
  };

  return { begin, arrive, announce, stop, freeze };
};
