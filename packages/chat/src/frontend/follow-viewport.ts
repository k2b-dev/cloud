/** A visual viewport this much shorter than the tallest one seen in this orientation has a keyboard over it. */
const KEYBOARD_THRESHOLD = 120;
/** iOS 26.0 does not always report the final visual viewport right after the keyboard moved (WebKit bug 297779). */
const LATE_CHECK_MS = 450;
const PHONE = "(max-width: 47.999rem)";
const INTERACTIVE_WIDGET = "interactive-widget=resizes-content";

/**
 * Keeps a phone conversation inside what the reader can see, as the composer spike's `vv` mode: the frame takes the
 * visual viewport's top and height (CSS reads `--chat-viewport-top` and `--chat-viewport-height`), so the header stays
 * on screen and the composer sits on the keyboard. Android also gets `interactive-widget=resizes-content`. While a
 * keyboard is open, drags outside the history and an overflowing field would pan the whole page on iOS, so they are
 * cancelled; a tap on the field focuses it without the reveal scroll that pushes the header out. Returns the cleanup.
 */
export const followVisualViewport = (frame: HTMLElement): (() => void) => {
  const cleanups: (() => void)[] = [];
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (meta && !meta.content.includes("interactive-widget")) {
    const original = meta.content;
    meta.content = `${original}, ${INTERACTIVE_WIDGET}`;
    cleanups.push(() => {
      meta.content = original;
    });
  }
  const viewport = window.visualViewport;
  if (!viewport) return () => cleanups.forEach((cleanup) => cleanup());
  const phone = window.matchMedia(PHONE);
  let tallest = 0;
  let late = 0;
  const keyboard = () => frame.hasAttribute("data-keyboard");
  const apply = () => {
    tallest = Math.max(tallest, viewport.height);
    frame.toggleAttribute("data-keyboard", viewport.height < tallest - KEYBOARD_THRESHOLD);
    frame.style.setProperty("--chat-viewport-top", `${viewport.offsetTop}px`);
    frame.style.setProperty("--chat-viewport-height", `${viewport.height}px`);
  };
  const onViewport = () => {
    // The page itself never scrolls here; a scrolled document is iOS revealing the field.
    if (phone.matches && window.scrollY > 0) window.scrollTo(0, 0);
    apply();
    clearTimeout(late);
    late = window.setTimeout(apply, LATE_CHECK_MS);
  };
  const resetOrientation = () => {
    tallest = 0;
  };
  const onTouchMove = (event: TouchEvent) => {
    if (!phone.matches || !keyboard()) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !frame.contains(target) || target.closest(".k2b-virtual-feed__viewport")) return;
    if (target instanceof HTMLTextAreaElement && target.scrollHeight > target.clientHeight) return;
    event.preventDefault();
  };
  let tap: { x: number; y: number } | null = null;
  const onTouchStart = (event: TouchEvent) => {
    const touch = event.touches[0];
    const field = event.target instanceof HTMLTextAreaElement && !event.target.readOnly ? event.target : null;
    tap = field && document.activeElement !== field && touch ? { x: touch.clientX, y: touch.clientY } : null;
  };
  const onTouchEnd = (event: TouchEvent) => {
    const touch = event.changedTouches[0];
    const field = event.target;
    const start = tap;
    tap = null;
    if (!phone.matches || !start || !touch || !(field instanceof HTMLTextAreaElement) || document.activeElement === field) return;
    if (Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 10) return;
    event.preventDefault();
    field.focus({ preventScroll: true });
    field.setSelectionRange(field.value.length, field.value.length);
  };
  apply();
  viewport.addEventListener("resize", onViewport);
  viewport.addEventListener("scroll", onViewport);
  window.addEventListener("orientationchange", resetOrientation);
  document.addEventListener("touchmove", onTouchMove, { passive: false });
  frame.addEventListener("touchstart", onTouchStart, { passive: true });
  frame.addEventListener("touchend", onTouchEnd);
  cleanups.push(() => {
    clearTimeout(late);
    viewport.removeEventListener("resize", onViewport);
    viewport.removeEventListener("scroll", onViewport);
    window.removeEventListener("orientationchange", resetOrientation);
    document.removeEventListener("touchmove", onTouchMove);
    frame.removeEventListener("touchstart", onTouchStart);
    frame.removeEventListener("touchend", onTouchEnd);
    frame.removeAttribute("data-keyboard");
    frame.style.removeProperty("--chat-viewport-top");
    frame.style.removeProperty("--chat-viewport-height");
  });
  return () => cleanups.forEach((cleanup) => cleanup());
};
