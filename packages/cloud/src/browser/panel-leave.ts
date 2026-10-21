/** Internal same-origin collection; no composer content crosses the provider boundary. */
const LEAVE = "cloud.panel.before-leave";
const CHECK = "cloud.panel.has-leave-guard";
type LeaveDecision = { allowed: boolean };

/**
 * Register before enabling editing. Return true only when all provider work is recoverable.
 * A veto keeps the current frame. Saving and retry belong to the provider; no transition is queued.
 */
export function onPanelBeforeLeave(guard: () => boolean): () => void {
  const collect = (event: Event) => {
    const decision = (event as CustomEvent<LeaveDecision>).detail;
    try {
      // Only explicit synchronous true permits leaving; throws and accidental Promises fail closed.
      if (guard() !== true) decision.allowed = false;
    } catch {
      decision.allowed = false;
    }
  };
  const registered = (event: Event) => event.preventDefault();
  window.addEventListener(LEAVE, collect);
  window.addEventListener(CHECK, registered);
  return () => {
    window.removeEventListener(LEAVE, collect);
    window.removeEventListener(CHECK, registered);
  };
}

export function hasPanelLeaveGuard(): boolean {
  return !window.dispatchEvent(new Event(CHECK, { cancelable: true }));
}

export function panelCanLeave(target: Window): boolean {
  const decision: LeaveDecision = { allowed: true };
  try {
    target.dispatchEvent(new CustomEvent<LeaveDecision>(LEAVE, { detail: decision }));
    return decision.allowed;
  } catch {
    return false;
  }
}
