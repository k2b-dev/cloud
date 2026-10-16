import { shellFocusCookie } from "../_internal/shell-focus";

export const SHELL_FOCUS_CHANGE_EVENT = "cloud:shell-focus-change";

const canvas = () => document.querySelector<HTMLElement>(".cloud-app-canvas[data-layout-authenticated]");

export const readShellFocus = (): boolean => canvas()?.dataset.shellFocus === "true";

export const setShellFocus = (hidden: boolean): void => {
  const element = canvas();
  if (!element) return;
  const focused = document.activeElement;
  document.cookie = shellFocusCookie(hidden, location.protocol === "https:");
  if (hidden) element.dataset.shellFocus = "true";
  else delete element.dataset.shellFocus;
  window.dispatchEvent(new CustomEvent(SHELL_FOCUS_CHANGE_EVENT, { detail: { hidden } }));
  if (
    window.matchMedia("(min-width: 768px)").matches &&
    (!focused ||
      focused === document.body ||
      focused.matches("[data-cloud-shell-focus-toggle]") ||
      !focused.isConnected ||
      focused.getClientRects().length === 0)
  ) {
    element.querySelector<HTMLElement>(`[data-cloud-shell-focus-toggle="${hidden ? "show" : "hide"}"]`)?.focus({ preventScroll: true });
  }
};

export const toggleShellFocus = (): void => setShellFocus(!readShellFocus());

/** Delegation also handles the server's buttons before their islands hydrate. */
export const attachShellFocusControls = (): (() => void) => {
  const click = (event: MouseEvent) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLElement>("[data-cloud-shell-focus-toggle]");
    if (button) setShellFocus(button.dataset.cloudShellFocusToggle === "hide");
  };
  let drag: { pointerId: number; x: number; y: number } | undefined;
  const start = (event: PointerEvent) => {
    if (event.pointerType === "mouse" || !(event.target instanceof Element) || !event.target.closest("[data-cloud-shell-reveal]")) return;
    drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  };
  const move = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.x;
    if (dx >= 40 && dx > Math.abs(event.clientY - drag.y)) {
      drag = undefined;
      setShellFocus(false);
    }
  };
  const stop = (event: PointerEvent) => {
    if (event.pointerId === drag?.pointerId) drag = undefined;
  };
  document.addEventListener("click", click);
  document.addEventListener("pointerdown", start);
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", stop);
  window.addEventListener("pointercancel", stop);
  return () => {
    document.removeEventListener("click", click);
    document.removeEventListener("pointerdown", start);
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", stop);
    window.removeEventListener("pointercancel", stop);
    drag = undefined;
  };
};
