/**
 * The motion of one dialog element's frame while it stays open: a level that replaces another morphs the frame from
 * the old size to the new one in the same place, without stacking. The old content fades out, the frame changes size
 * over `--k2b-motion-morph` with `--k2b-ease-morph`, and the new content fades in, set at its final size from the
 * first frame so it never rewraps; the frame clips meanwhile. Anything that interrupts a change turns around from the
 * values the eye sees; the endings of the interrupted change are dropped, not run. Reduced motion swaps in one frame.
 *
 * The frame also follows its content's height while it is open: when a notice comes or goes, fields appear, or text
 * grows, the frame goes from the height the eye sees to the new one over `--k2b-motion-fold` with `--k2b-ease-glide`,
 * and new content fades in over `--k2b-motion-fast` from 40 % of that time. Its top edge stays where it is: it grows
 * downwards and moves up together with growth only when the room below runs out; a sheet grows from the bottom edge. Frames with a size of
 * their own (fixed, workspace, full, sheets with detents) never follow. Neither the first open, the close, a window
 * resize, nor the on-screen keyboard starts an animation; a resize during a fold retargets it.
 *
 * The frame's own size is animated, a named exception to "transform and opacity only" (see the motion guide): the
 * frame stands alone above the page, so nothing beside it moves.
 */

import { restoreScroll } from "../internal/scroll-places";

export { afterExitTransitions } from "../internal/exit-motion";

/** New content fades in from this share of the fold. */
const FOLD_DELAY_SHARE = 0.4;
/** Frames whose size is their own: they never follow their content. A sheet with detents only while it is a sheet. */
const OWN_SIZE = ".is-fixed, .is-workspace, .k2b-dialog--full";

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
  /** Follows the height of the level that shows now; `arrive` follows the arriving level by itself. */
  follow: (level: HTMLElement) => void;
  /** Ends every motion now and runs the pending endings, for a frame that leaves the document. */
  stop: () => void;
  /** An explicit position wins over a fold, including its pending completion. */
  position: () => void;
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
  /** Whether the running frame animation is a morph between levels or a fold to new content. */
  let frameKind: "morph" | "fold" | undefined;
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
    if (!dialog.classList.contains("k2b-bottom-sheet-frame")) {
      // A caller's stylesheet may anchor the top edge (translateX only), just as setPosition does inline.
      const transform = getComputedStyle(dialog).transform;
      return !transform || transform === "none" || new DOMMatrixReadOnly(transform).m42 === 0 ? "fixed" : "center";
    }
    const asDialog =
      dialog.classList.contains("is-adaptive") && typeof matchMedia === "function" && matchMedia("(min-width: 48rem)").matches;
    return asDialog ? "center" : "bottom";
  };
  /** What the eye sees now, including a size or place that is still moving. */
  const seen = () => {
    const { width, height } = dialog.getBoundingClientRect();
    return { width, height, top: Number.parseFloat(getComputedStyle(dialog).top) || 0 };
  };

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
    frameKind = undefined;
    delete dialog.dataset.k2bFrameMotion;
  };

  // ---- Following the content's height ----

  let level: HTMLElement | undefined;
  /** Between measurements the frame holds its height; content never grows it ahead of a fold. */
  let rested = 0;
  let placed = false;
  let followingAnchor: Anchor | undefined;
  let initialMeasure = false;
  let viewportHeight = window.innerHeight;
  let queued = 0;
  let resized = false;
  let firstRest = false;
  let restFrame = 0;
  let busy = false;
  let loadingChange = false;
  let arrived = new Set<HTMLElement>();
  let arrivalFrame = 0;
  const pointers = new Set<number>();
  let deferredFold = false;

  const ownSize = () => dialog.matches(OWN_SIZE) || (dialog.matches("[data-sheet-detents]") && anchor() === "bottom");
  const BUSY_CONTENT = '[aria-busy="true"]:not(button, [role="button"])';
  const isBusyNode = (node: Element) => node.matches(BUSY_CONTENT) || Boolean(node.querySelector(BUSY_CONTENT));
  const isBusy = () => Boolean(level && isBusyNode(level));
  const textFocused = () => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !level?.contains(active)) return false;
    if (active instanceof HTMLInputElement) return /^(text|search|email|url|tel|password|number)$/.test(active.type);
    return active instanceof HTMLTextAreaElement || active.isContentEditable;
  };
  const place = (offset: number) => {
    placed = offset !== 0;
    if (placed) dialog.style.top = `${window.innerHeight / 2 + offset}px`;
    else dialog.style.removeProperty("top");
  };
  /** Keep the top edge, moving up with growth only as far as the new height needs. */
  const edgeFor = (shown: ReturnType<typeof seen>, height: number) => {
    const viewport = window.visualViewport?.scale === 1 ? window.visualViewport : null;
    const bottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
    const cap = Number.parseFloat(getComputedStyle(dialog).maxHeight);
    const margin = Number.isFinite(cap) ? Math.max(0, ((viewport?.height ?? window.innerHeight) - cap) / 2) : 0;
    return Math.max((viewport?.offsetTop ?? 0) + margin, Math.min(shown.top - shown.height / 2, bottom - margin - height));
  };
  const holdHeight = (height: number) => {
    dialog.style.height = `${height}px`;
    rested = height;
  };
  const changed = () => {
    if (!level || queued) return;
    queued = requestAnimationFrame(() => {
      queued = 0;
      fold();
    });
  };

  const fold = () => {
    if (!level || started || frameKind === "morph") return;
    const loading = busy || loadingChange || isBusy();
    const where = anchor();
    const anchorChanged = followingAnchor !== where;
    // A pressed control stays under the pointer even when a size report, rather than focusout, starts the fold.
    // Viewport/anchor corrections and loading still take their natural size immediately.
    if (pointers.size && firstRest && !initialMeasure && !loading && !resized && !anchorChanged) {
      deferredFold = true;
      return;
    }
    deferredFold = false;
    // A child already animating its height owns that motion. Measure its final height once, rather than folding
    // the frame towards intermediate samples and then folding it a second time.
    const heightMotion = dialog
      .getAnimations({ subtree: true })
      .filter(
        (animation) =>
          animation !== frame &&
          animation.timeline === document.timeline &&
          Number.isFinite(animation.effect?.getComputedTiming().endTime) &&
          animation.playState === "running" &&
          animation.effect instanceof KeyframeEffect &&
          animation.effect.target !== dialog &&
          animation.effect
            .getKeyframes()
            .some(
              (keyframe) => "height" in keyframe || "maxHeight" in keyframe || "minHeight" in keyframe || "gridTemplateRows" in keyframe,
            ),
      );
    if (heightMotion.length && !resized && !anchorChanged) {
      for (const animation of heightMotion)
        if (!waiting.has(animation)) {
          waiting.add(animation);
          void animation.finished.catch(() => {}).then(changed);
        }
      return;
    }
    if (refreshShells) {
      refreshShells = false;
      observeContent(level);
    }
    const added = arrived;
    arrived = new Set();
    busy = isBusy();
    loadingChange = false;
    const wasResize = resized;
    resized = false;
    // Release only the top owned here, before own-size/detent handling and natural-height measurement.
    if (anchorChanged) {
      if (placed) place(0);
      followingAnchor = where;
    }
    const shown = seen();
    if (wasResize && where === "center" && !placed && !anchorChanged) shown.top -= (window.innerHeight - viewportHeight) / 2;
    viewportHeight = window.innerHeight;
    const interrupted = Boolean(frame);
    if (interrupted) endFrame();
    // All measurement and layout writes run here, in a frame, never inside an observer delivery.
    dialog.style.removeProperty("height");
    if (ownSize()) {
      rested = dialog.getBoundingClientRect().height;
      return;
    }
    const natural = dialog.getBoundingClientRect().height;
    const canFold = firstRest && !initialMeasure && !loading;
    const height = canFold && !wasResize && textFocused() ? Math.max(natural, shown.height) : natural;
    const from = interrupted ? shown.height : rested;
    const edge = edgeFor({ ...shown, height: from }, height);
    const offset = edge + height / 2 - window.innerHeight / 2;
    const moving = dialog.getAnimations().filter((animation) => animation.playState === "running" || animation.playState === "paused");
    const duration = canFold && (!wasResize || interrupted) && !moving.length && animatable() ? token("--k2b-motion-fold") : 0;
    initialMeasure = false;
    holdHeight(height);
    if (!duration || Math.abs(height - from) < 1) {
      if (where === "center") place(firstRest && !anchorChanged ? offset : 0);
      if (Math.abs(height - from) >= 1 || wasResize) dialog.dispatchEvent(new Event("k2b-frame-resize"));
      return;
    }
    // Both edges begin where the eye sees them. Top and height share one curve, so the bottom stays in view.
    const top = shown.top - from / 2;
    if (where === "center") place(offset);
    const keyframes =
      where === "center"
        ? [
            { height: `${from}px`, top: `${top + from / 2}px` },
            { height: `${height}px`, top: `${window.innerHeight / 2 + offset}px` },
          ]
        : [{ height: `${from}px` }, { height: `${height}px` }];
    dialog.dataset.k2bFrameMotion = "";
    const animation = dialog.animate(keyframes, { duration, easing: curve("--k2b-ease-glide", "ease-out") });
    frame = animation;
    frameKind = "fold";
    animation.onfinish = () => {
      if (frame !== animation) return;
      if (where === "center") place(offset);
      endFrame();
      dialog.dispatchEvent(new Event("k2b-frame-resize"));
      // An image or font can change intrinsic size while the frame clips its content.
      changed();
    };
    if (height > from) {
      const fast = token("--k2b-motion-fast");
      const active = document.activeElement;
      const inFlow = (element: HTMLElement) => {
        for (let node: HTMLElement | null = element; node && node !== level; node = node.parentElement)
          if (node.getAttribute("aria-hidden") === "true" || /^(absolute|fixed)$/.test(getComputedStyle(node).position)) return false;
        return true;
      };
      for (const element of added)
        if (element.isConnected && !element.contains(active) && !active?.contains(element) && inFlow(element))
          fade(element, 1, fast, duration * FOLD_DELAY_SHARE, () => {});
    }
  };

  const waiting = new WeakSet<Animation>();
  const known = new WeakSet<Element>();
  let firstDelivery = true;
  let followingMorph = false;
  const measured = new WeakMap<Element, { width: number; height: number }>();
  const watched = new Set<Element>();
  const shells = new WeakSet<Element>();
  let refreshShells = false;
  const sizes =
    typeof ResizeObserver === "function"
      ? new ResizeObserver((entries) => {
          let resized = false;
          const initial = firstDelivery;
          firstDelivery = false;
          for (const {
            target,
            contentRect: { width, height },
          } of entries) {
            const previous = measured.get(target);
            measured.set(target, { width, height });
            const changedSize =
              previous === undefined ||
              !Number.isFinite(previous.width) ||
              !Number.isFinite(previous.height) ||
              Math.abs(width - previous.width) >= 0.01 ||
              Math.abs(height - previous.height) >= 0.01;
            resized ||= changedSize && (frameKind !== "fold" || !shells.has(target));
          }
          initialMeasure ||= initial && resized && !followingMorph;
          if (resized) changed();
        })
      : undefined;

  // Watch the structural shells down to natural-flow content, not every rendered row, word, or editor overlay.
  // A flex/grid or scrolling shell can be stretched by the held frame, so its children report intrinsic changes.
  // This traversal runs once per level; a preview replacing hundreds of descendants needs no observe/unobserve calls.
  const observeContent = (element: Element, pending: Element[] = [], stretched = true) => {
    const style = getComputedStyle(element);
    // Positioned overlays (for example MarkdownEditor's highlighted copy) do not contribute to the frame's height.
    if (
      element !== level &&
      (element.getAttribute("aria-hidden") === "true" || style.position === "absolute" || style.position === "fixed")
    )
      return;
    if (!watched.has(element)) {
      watched.add(element);
      // Capture the content box before registering any roots: an intrinsic change between follow() and the first
      // delivery must not become an invisible baseline. Computed dimensions round CSS pixels to decimal text;
      // the delivery comparison ignores only that sub-hundredth-pixel serialization difference.
      const inset = (axis: "width" | "height") =>
        style.boxSizing !== "border-box"
          ? 0
          : axis === "width"
            ? Number.parseFloat(style.paddingLeft) +
              Number.parseFloat(style.paddingRight) +
              Number.parseFloat(style.borderLeftWidth) +
              Number.parseFloat(style.borderRightWidth)
            : Number.parseFloat(style.paddingTop) +
              Number.parseFloat(style.paddingBottom) +
              Number.parseFloat(style.borderTopWidth) +
              Number.parseFloat(style.borderBottomWidth);
      measured.set(element, {
        width: Number.parseFloat(style.width) - inset("width"),
        height: Number.parseFloat(style.height) - inset("height"),
      });
      pending.push(element);
    }
    // Only boxes stretched by the held frame need another observation level. A natural row already reports
    // all its descendants, even when it happens to use flex or grid internally.
    if (stretched && (element === level || /flex|grid|contents/.test(style.display) || /auto|scroll/.test(style.overflowY))) {
      shells.add(element);
      for (const child of element.children) {
        const childStyle = getComputedStyle(child);
        const grows = childStyle.flexGrow !== "0";
        const crossStretch =
          /flex/.test(style.display) &&
          !style.flexDirection.startsWith("column") &&
          (childStyle.alignSelf === "stretch" || (childStyle.alignSelf === "auto" && /normal|stretch/.test(style.alignItems)));
        observeContent(child, pending, grows || crossStretch || /grid|contents/.test(style.display));
      }
    }
    if (element === level) for (const target of pending) sizes?.observe(target);
  };
  const changes =
    typeof MutationObserver === "function"
      ? new MutationObserver((records) => {
          // Once per batch, keep only live observation targets. Losing an observed root (including the last
          // body child) is itself a size signal; the held shells cannot report that removal for us.
          for (const target of watched)
            if (!target.isConnected || !level?.contains(target)) {
              changed();
              sizes?.unobserve(target);
              watched.delete(target);
            }
          for (const record of records) for (const node of record.removedNodes) if (node instanceof Element) known.add(node);
          const eligible = (node: HTMLElement) => {
            for (let parent: HTMLElement | null = node; parent && parent !== level; parent = parent.parentElement)
              if (parent.getAttribute("aria-hidden") === "true" || /^(absolute|fixed)$/.test(parent.style.position)) return false;
            return Boolean(level?.contains(node));
          };
          for (const record of records) {
            if (record.type === "childList") {
              for (const node of record.removedNodes) if (node instanceof Element) loadingChange ||= isBusyNode(node);
              for (const node of record.addedNodes)
                if (node instanceof HTMLElement) {
                  const inFlow = eligible(node);
                  if (!known.has(node) && inFlow) arrived.add(node);
                  known.add(node);
                  loadingChange ||= isBusyNode(node);
                  if (inFlow && record.target instanceof Element && shells.has(record.target)) {
                    // Registration has no layout read. The first report schedules structural discovery in a frame.
                    watched.add(node);
                    sizes?.observe(node);
                    refreshShells = true;
                  }
                }
            } else if (record.type === "attributes" && record.target instanceof HTMLElement) {
              if (record.attributeName === "aria-busy" && record.oldValue === "true" && !record.target.matches('button, [role="button"]'))
                loadingChange = true;
              if (record.attributeName === "hidden") {
                if (!record.target.hidden && eligible(record.target)) arrived.add(record.target);
                changed();
              }
            }
          }
          for (const node of arrived) {
            if (!eligible(node)) {
              arrived.delete(node);
              continue;
            }
            // Fade the outer arrival once, rather than fading every inserted descendant as well.
            for (let parent = node.parentElement; parent && parent !== level; parent = parent.parentElement)
              if (arrived.has(parent)) {
                arrived.delete(node);
                break;
              }
          }
          if (arrivalFrame) cancelAnimationFrame(arrivalFrame);
          // Let this batch's layout/ResizeObserver wave enqueue its measurement first. Unchanged previews
          // expire after that frame, without forcing layout or waiting for an unrelated later fold.
          arrivalFrame = requestAnimationFrame(() => {
            arrivalFrame = requestAnimationFrame(() => {
              arrivalFrame = 0;
              if (!queued && frameKind !== "fold") arrived.clear();
            });
          });
        })
      : undefined;
  const onFocusOut = () => {
    deferredFold = true;
    if (!pointers.size) changed();
  };
  const onFocusIn = () => {
    if (!textFocused() || frameKind !== "fold") return;
    const shown = seen();
    if (rested >= shown.height) return;
    holdHeight(shown.height);
    if (anchor() === "center") place(shown.top - window.innerHeight / 2);
    endFrame();
  };
  const onPointerDown = (event: PointerEvent) => {
    pointers.add(event.pointerId);
    if (frameKind !== "fold") return;
    const shown = seen();
    holdHeight(shown.height);
    if (anchor() === "center") place(shown.top - window.innerHeight / 2);
    endFrame();
    deferredFold = true;
  };
  const onPointerEnd = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    if (!pointers.size && deferredFold) changed();
  };
  const onResize = () => {
    resized = true;
    changed();
  };
  const onVisualResize = () => {
    if (window.visualViewport?.scale === 1) onResize();
  };

  const follow: FrameMotion["follow"] = (next) => {
    sizes?.disconnect();
    watched.clear();
    changes?.disconnect();
    if (queued) cancelAnimationFrame(queued);
    queued = 0;
    level = next;
    firstDelivery = true;
    followingMorph = frameKind === "morph";
    initialMeasure = false;
    followingAnchor = anchor();
    viewportHeight = window.innerHeight;
    arrived = new Set();
    busy = isBusy();
    loadingChange = busy;
    // A morph's pinned content has its final size already. Its observer begins measuring after the morph releases it.
    if (frameKind !== "morph") {
      rested = dialog.getBoundingClientRect().height;
      if (!ownSize()) holdHeight(rested);
    }
    known.add(next);
    for (const child of next.querySelectorAll("*")) known.add(child);
    observeContent(next);
    changes?.observe(next, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ["hidden", "aria-busy"],
    });
    next.addEventListener("focusout", onFocusOut);
    next.addEventListener("focusin", onFocusIn);
    dialog.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointerup", onPointerEnd, true);
    window.addEventListener("pointercancel", onPointerEnd, true);
    window.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("resize", onVisualResize);
    if (!firstRest) {
      const markRest = () => {
        restFrame = 0;
        if (level !== next) return;
        const moving = dialog.getAnimations().filter((animation) => animation.playState === "running" || animation.playState === "paused");
        if (!moving.length) firstRest = true;
        else
          void Promise.allSettled(moving.map((animation) => animation.finished)).then(() => {
            if (level === next) restFrame = requestAnimationFrame(markRest);
          });
      };
      restFrame = requestAnimationFrame(markRest);
    }
  };
  const unfollow = () => {
    sizes?.disconnect();
    watched.clear();
    changes?.disconnect();
    if (queued) cancelAnimationFrame(queued);
    if (restFrame) cancelAnimationFrame(restFrame);
    restFrame = 0;
    queued = 0;
    level?.removeEventListener("focusout", onFocusOut);
    level?.removeEventListener("focusin", onFocusIn);
    dialog.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("pointerup", onPointerEnd, true);
    window.removeEventListener("pointercancel", onPointerEnd, true);
    pointers.clear();
    deferredFold = false;
    if (arrivalFrame) cancelAnimationFrame(arrivalFrame);
    arrivalFrame = 0;
    arrived.clear();
    level = undefined;
    window.removeEventListener("resize", onResize);
    window.visualViewport?.removeEventListener("resize", onVisualResize);
  };

  let started: { from: ReturnType<typeof seen>; anchor: Anchor; leaving: HTMLElement; scrolled: boolean } | undefined;
  /** The frame scrolls its contents itself, as unstructured content does. */
  const scrolled = () => dialog.scrollTop > 0 || dialog.scrollLeft > 0;

  const begin: FrameMotion["begin"] = (leaving, back) => {
    unfollow();
    started = { from: seen(), anchor: anchor(), leaving, scrolled: scrolled() };
    endFrame();
    dialog.style.removeProperty("height");
    hold(leaving);
    // The frame clips from now on: the held content, larger than the new one, must not give it a scrollbar while the
    // new content is measured and pinned (a classic scrollbar would narrow it until the old content has gone). A frame
    // that scrolls itself swaps at once and keeps its scroll place instead.
    if (!started.scrolled) dialog.dataset.k2bFrameMotion = "";
    // A level that replaces another stands in the centre again.
    place(0);
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
      follow(arriving);
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
    frameKind = "morph";
    // The new content keeps its final size until the frame has arrived there too, so it never rewraps; its fade
    // ends earlier (at 250 of 280 ms).
    animation.onfinish = () => {
      if (frame !== animation) return;
      endFrame();
      for (const property of ["width", "height", "flex"] as const) arriving.style.removeProperty(property);
      // A sheet measures its rests again at the size the morph reached.
      dialog.dispatchEvent(new Event("k2b-frame-resize"));
      // Content that changed during the morph gets a fold from the size the morph reached.
      holdHeight(to.height);
      firstRest = true;
      changed();
    };
    follow(arriving);
    rested = to.height;
    fade(leaving, 0, duration * LEAVE_SHARE, 0, leave);
    fade(arriving, 1, duration * ARRIVE_SHARE, duration * ARRIVE_DELAY_SHARE, () => {});
  };

  const stop = () => {
    unfollow();
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
    unfollow();
    started = undefined;
    // What the eye sees stays: the running values become the frame's and the contents' own styles.
    if (frame) {
      frame.commitStyles();
      frame.cancel();
      frame = undefined;
    }
    const pending = [...fades];
    fades.clear();
    for (const [element, { animation }] of pending) {
      if (element.getClientRects().length) animation.commitStyles();
      animation.cancel();
    }
    return () => {
      for (const [, { done }] of pending) done();
    };
  };

  const position = () => {
    if (frameKind === "fold") {
      holdHeight(seen().height);
      endFrame();
    }
    placed = false;
    followingAnchor = undefined;
  };

  return { begin, arrive, announce, follow, stop, freeze, position };
};
