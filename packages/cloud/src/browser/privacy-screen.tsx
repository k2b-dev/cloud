import { Button, keyboardPlatform } from "@k2b/ui";
import { render } from "solid-js/web";
import type { PrivacyTimerSeconds } from "../contracts/privacy-timer";
import {
  onPrivacyTimer,
  PRIVACY_CHANNEL,
  PRIVACY_REQUEST_EVENT,
  type PrivacyChannelMessage,
  type PrivacyRequest,
  publishPrivacyTimer,
} from "./privacy-timer";

/**
 * The privacy screen hides a person's content from someone looking over their shoulder. It covers, it does not lock:
 * a primary click or a key shows everything again, and the page underneath is never rebuilt, so focus, caret, scroll
 * and unsaved input stay where they were.
 *
 * - Covered: the whole screen, app bar, navigation, content, dialogs and toasts included. Every part outside the
 *   islands gets `inert` and `data-cloud-privacy-covered`, which blurs it.
 * - Islands stay sharp and usable: elements with `data-cloud-privacy="keep"` (such as upload progress) or `"live"`
 *   (such as a running dictation, which also pauses the timer). Inside an island, `data-cloud-privacy="blur"` blurs a
 *   part, such as file names.
 * - The shared workstation's sign-out warning always comes first: while it is open the privacy screen neither starts
 *   nor lifts, the warning stays sharp, and its "Continue working" also lifts the privacy screen.
 * - The lifting click or key never reaches the page: the pointer sequence and the key until its release are used up.
 *   A mouse movement, a scroll, a right or middle click only light up the hint.
 * - With the timer on, a countdown shows during the last ten seconds; any input cancels it.
 * - All Cloud tabs of this browser share the state and the idle time.
 * - Opening or loading a page is input too: every tab shows again and the idle time starts over. A page the person
 *   cannot see yet, such as a background tab or a prerender, counts once it shows; until then it covers with the
 *   other tabs. A return from the back-forward cache counts. A covered page that reloads stays covered: the reload
 *   may be automatic, such as after an update, and nobody may be at the screen.
 */

export const PRIVACY_LEAD_MS = 10_000;
/** How often a tab tells the others that the person is active; they then never reach their deadline. */
const ACTIVITY_SHARE_MS = 5_000;
const WAKE_MS = 2_500;
const COVERED = "data-cloud-privacy-covered";
const ISLAND = '[data-cloud-privacy="keep"], [data-cloud-privacy="live"]';
const LIVE = '[data-cloud-privacy="live"]';
/** The shared workstation's sign-out warning is the open dialog whose "Continue working" button carries this attribute. */
const SESSION_WARNING_ACTION = "[data-cloud-idle-continue]";
/** Set in this tab's session storage when a page leaves while covered, so its reload stays covered. */
const LEFT_COVERED = "cloud.privacy.left-covered";
const isSessionWarning = (element: Element) =>
  element.tagName === "DIALOG" && element.hasAttribute("open") && Boolean(element.querySelector(SESSION_WARNING_ACTION));
const isModal = (dialog: Element) => {
  try {
    return dialog.matches(":modal");
  } catch {
    return dialog.getAttribute("aria-modal") === "true";
  }
};
const SKIPPED = new Set(["SCRIPT", "STYLE", "LINK", "META", "TEMPLATE", "NOSCRIPT"]);
const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "AltGraph", "Fn", "FnLock", "OS", "Hyper", "Super"]);

export type PrivacyScreenText = {
  title: string;
  howToContinue: string;
  keepWorking: string;
  notALock: string;
  on: string;
  onAfterIdle: string;
  off: string;
  newMessages: string;
  countdown: (input: { seconds: number }) => string;
  tabTitle: string;
};

export type PrivacyClock = {
  now(): number;
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};
const systemClock: PrivacyClock = {
  now: () => Date.now(),
  set: (run, ms) => window.setTimeout(run, ms),
  clear: (handle) => window.clearTimeout(handle as number),
};

export type PrivacyScreenOptions = {
  timerSeconds: PrivacyTimerSeconds;
  text: () => PrivacyScreenText;
  clock?: PrivacyClock;
  /**
   * Pages without the command menu, such as pop-out editors, handle Cmd/Ctrl+. here; elsewhere the registered
   * command owns it, so Help and the command menu show it.
   */
  shortcut?: boolean;
};

const isShortcut = (event: KeyboardEvent) =>
  event.key === "." &&
  !event.altKey &&
  (keyboardPlatform() === "apple" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);

const navigationType = () => {
  const activation = window.navigation?.activation?.navigationType;
  if (activation) return activation;
  const entry = performance.getEntriesByType("navigation")[0];
  return entry instanceof PerformanceNavigationTiming ? entry.type : null;
};

export const privacyScreenActive = () => document.documentElement.dataset.cloudPrivacy === "on";
export const sessionWarningOpen = () =>
  Array.from(document.querySelectorAll(SESSION_WARNING_ACTION)).some((action) => action.closest("dialog[open]"));

function PrivacyHint(props: { text: () => PrivacyScreenText; onContinue: () => void; ids: { title: string; body: string; note: string } }) {
  return (
    <>
      <span class="cloud-privacy-hint__icon" aria-hidden="true">
        <i class="ti ti-eye-off" />
      </span>
      <h2 class="cloud-privacy-hint__title" id={props.ids.title}>
        {props.text().title}
      </h2>
      <p class="cloud-privacy-hint__body" id={props.ids.body}>
        {props.text().howToContinue}
      </p>
      <Button size="sm" class="cloud-privacy-hint__continue" onClick={props.onContinue}>
        {props.text().keepWorking}
      </Button>
      <p class="cloud-privacy-hint__note" id={props.ids.note}>
        <i class="ti ti-info-circle" aria-hidden="true" />
        {props.text().notALock}
      </p>
    </>
  );
}

export const installPrivacyScreen = (options: PrivacyScreenOptions): (() => void) => {
  const clock = options.clock ?? systemClock;
  const root = document.documentElement;
  let timerSeconds: number = options.timerSeconds;
  let active = false;
  let lastActivity = clock.now();
  let lastShared = 0;
  let deadlineHandle: unknown;
  let tickHandle: unknown;
  let wakeHandle: unknown;
  let countdownAnnounced = false;
  let countingDown = false;
  let restoreFocus: Element | null = null;
  let savedTitle: string | null = null;
  let heldKey: string | null = null;
  let consumedKey: string | null = null;
  let swallowPointer = false;
  let lastPointer: { x: number; y: number } | null = null;
  const covered = new Set<Element>();
  const madeInert = new Set<Element>();
  const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(PRIVACY_CHANNEL);

  // One polite live region, an island itself, so the screen reader hears the state while everything else is inert.
  const live = document.createElement("div");
  live.className = "sr-only";
  live.setAttribute("aria-live", "polite");
  live.setAttribute("aria-atomic", "true");
  live.dataset.cloudPrivacy = "keep";
  document.body.append(live);
  let sayHandle: unknown;
  const say = (message: string) => {
    live.textContent = "";
    clock.clear(sayHandle);
    sayHandle = clock.set(() => (live.textContent = message), 30);
  };

  // The hint is no island: a click on it lifts, and Enter on its button is used up like any key. It shows in the top
  // layer, so a dialog's transform or clipping never moves it.
  const hint = document.createElement("div");
  hint.className = "cloud-privacy-hint";
  hint.setAttribute("role", "dialog");
  hint.setAttribute("popover", "manual");
  const ids = { title: "cloud-privacy-title", body: "cloud-privacy-body", note: "cloud-privacy-note" };
  hint.setAttribute("aria-labelledby", ids.title);
  hint.setAttribute("aria-describedby", `${ids.body} ${ids.note}`);
  const disposeHint = render(() => <PrivacyHint text={options.text} ids={ids} onContinue={() => lift()} />, hint);

  // ── Covering ─────────────────────────────────────────────────────────
  const isIsland = (element: Element) => element === hint || element === live || element.matches(ISLAND) || isSessionWarning(element);
  const holdsIsland = (element: Element) =>
    element.contains(hint) || Boolean(element.querySelector(`${ISLAND}, ${SESSION_WARNING_ACTION}`));
  const mark = (element: Element, kind: string) => {
    element.setAttribute(COVERED, kind);
    covered.add(element);
    // A dialog that hosts the hint blurs but stays usable: the hint in the top layer escapes the blur, not an inert
    // ancestor. Its other input lifts the screen like any click or key.
    if (!element.hasAttribute("inert") && !element.contains(hint)) {
      element.setAttribute("inert", "");
      madeInert.add(element);
    }
  };
  /** Text of its own beside an island cannot blur alone, so such a container covers whole, the island with it. */
  const hasOwnText = (element: Element) =>
    Array.from(element.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()));
  const cover = (container: Element) => {
    for (const child of Array.from(container.children)) {
      if (SKIPPED.has(child.tagName) || isIsland(child)) continue;
      if (holdsIsland(child) && !hasOwnText(child)) cover(child);
      else mark(child, "");
    }
  };
  /**
   * Open dialogs and popovers render in the top layer, outside the filter of a covered ancestor; each covers on its
   * own. Parts of an island that would tell too much, such as file names, blur and rest like the covered page; they
   * also leave the accessibility tree, so an island's announcements cannot name them.
   */
  const coverSurfaces = () => {
    const open = (selector: string) => {
      try {
        return Array.from(document.querySelectorAll(selector));
      } catch {
        return [];
      }
    };
    for (const surface of [...open("dialog[open]"), ...open(":popover-open")]) {
      if (surface === hint || isIsland(surface) || surface.hasAttribute(COVERED)) continue;
      if (holdsIsland(surface) && !hasOwnText(surface)) cover(surface);
      else mark(surface, "");
    }
    for (const part of document.querySelectorAll('[data-cloud-privacy="blur"]')) {
      if (!part.closest(`[${COVERED}]`)) mark(part, "part");
    }
  };
  const uncover = () => {
    for (const element of covered) element.removeAttribute(COVERED);
    for (const element of madeInert) element.removeAttribute("inert");
    covered.clear();
    madeInert.clear();
  };
  /** A modal dialog makes everything outside it inert, so the hint moves into the topmost one that is not the warning. */
  const hintHost = (): Element => {
    const dialogs = Array.from(document.querySelectorAll("dialog[open]")).filter((dialog) => isModal(dialog) && !isSessionWarning(dialog));
    return dialogs.at(-1) ?? document.body;
  };
  const showHint = (show: boolean) => {
    try {
      if (show && !hint.matches(":popover-open")) hint.showPopover();
      if (!show && hint.matches(":popover-open")) hint.hidePopover();
    } catch {
      /* Without the popover API the hint stays a fixed layer in its host. */
    }
  };
  const placeHint = () => {
    const host = hintHost();
    if (hint.parentElement !== host) {
      showHint(false);
      host.append(hint);
    }
    // The warning has priority; while it is open the hint waits behind it.
    hint.hidden = sessionWarningOpen();
    showHint(!hint.hidden);
    const area = document.querySelector(".cloud-app-canvas [data-cloud-app-area]")?.getBoundingClientRect();
    const x = area && area.width > 0 ? area.left + area.width / 2 : window.innerWidth / 2;
    const y = area && area.height > 0 ? area.top + area.height / 2 : window.innerHeight / 2;
    hint.style.setProperty("--cloud-privacy-hint-x", `${Math.round(x)}px`);
    hint.style.setProperty("--cloud-privacy-hint-y", `${Math.round(y)}px`);
  };
  /** One pass from scratch: islands, dialogs and popovers may have come, gone, opened or closed since the last. */
  const reconcile = () => {
    uncover();
    placeHint();
    cover(document.body);
    coverSurfaces();
  };
  let arrived = false;
  let reconciling = false;
  let fresh = false;
  const scheduleReconcile = () => {
    if (reconciling) return;
    reconciling = true;
    queueMicrotask(() => {
      reconciling = false;
      if (!active) return;
      reconcile();
      observer.takeRecords();
      // Toasts that arrive while covered stay covered; the screen reader hears only that something came.
      if (fresh && !arrived) {
        arrived = true;
        say(options.text().newMessages);
      }
      fresh = false;
    });
  };
  const observer = new MutationObserver((records) => {
    if (!active) return;
    const relevant = records.some((record) => {
      if (record.type === "attributes") return true;
      // Changes deep inside covered content stay covered; only new islands, warnings, or anything outside matter,
      // text included: text beside an island covers its container.
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      const inside = Boolean(target?.closest(`[${COVERED}]`));
      if (record.type === "characterData") return !inside;
      const nodes = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)].filter((node) => node !== hint);
      if (!nodes.length) return false;
      return (
        !inside ||
        nodes.some((node) => node instanceof Element && (node.matches(`${ISLAND}, ${SESSION_WARNING_ACTION}`) || holdsIsland(node)))
      );
    });
    if (!relevant) return;
    fresh ||= records.some((record) =>
      Array.from(record.addedNodes).some(
        (node) =>
          node instanceof Element &&
          record.target === document.body &&
          Boolean(node.querySelector(".k2b-toast, [role=alert], [role=status]")),
      ),
    );
    scheduleReconcile();
  });
  /** Showing a popover changes no attribute; its toggle event says so. */
  const toggled = (event: Event) => {
    if (active && event.target !== hint) scheduleReconcile();
  };
  const titleObserver = new MutationObserver(() => {
    if (!active || document.title === options.text().tabTitle) return;
    savedTitle = document.title;
    document.title = options.text().tabTitle;
  });

  // ── State ────────────────────────────────────────────────────────────
  const wake = () => {
    hint.dataset.wake = "true";
    clock.clear(wakeHandle);
    wakeHandle = clock.set(() => delete hint.dataset.wake, WAKE_MS);
  };
  const activate = (source: "timer" | "request" | "channel") => {
    if (active || sessionWarningOpen()) return;
    active = true;
    stopCountdown();
    const focused = document.activeElement;
    restoreFocus = focused && focused !== document.body ? focused : null;
    // A key still held from the activation, such as Enter in the search, is used up until it is released.
    if (heldKey) consumedKey = heldKey;
    root.dataset.cloudPrivacy = "on";
    reconcile();
    arrived = false;
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["open", "popover", "data-cloud-privacy"],
    });
    savedTitle = document.title;
    document.title = options.text().tabTitle;
    const title = document.querySelector("head > title");
    if (title) titleObserver.observe(title, { childList: true, characterData: true, subtree: true });
    hint.querySelector<HTMLElement>(".cloud-privacy-hint__continue")?.focus({ preventScroll: true });
    say(source === "timer" ? options.text().onAfterIdle : options.text().on);
    if (source !== "channel") channel?.postMessage({ type: "on" } satisfies PrivacyChannelMessage);
  };
  const lift = (fromChannel = false) => {
    if (!active) return;
    active = false;
    observer.disconnect();
    titleObserver.disconnect();
    uncover();
    delete root.dataset.cloudPrivacy;
    delete hint.dataset.wake;
    showHint(false);
    hint.remove();
    if (savedTitle !== null) document.title = savedTitle;
    savedTitle = null;
    const back = restoreFocus;
    restoreFocus = null;
    if (!sessionWarningOpen() && back instanceof HTMLElement && back.isConnected && !back.closest("[inert]")) {
      back.focus({ preventScroll: true });
    }
    countdownAnnounced = false;
    say(options.text().off);
    lastActivity = clock.now();
    schedule();
    if (!fromChannel) channel?.postMessage({ type: "off" } satisfies PrivacyChannelMessage);
  };

  // ── Timer and countdown ──────────────────────────────────────────────
  const paused = () => active || timerSeconds === 0 || sessionWarningOpen() || Boolean(document.querySelector(LIVE));
  const stopCountdown = () => {
    clock.clear(tickHandle);
    if (!countingDown) return;
    countingDown = false;
    delete root.dataset.cloudPrivacyCountdown;
  };
  const showCountdown = (rest: number) => {
    const seconds = Math.max(1, Math.ceil(rest / 1000));
    root.style.setProperty("--cloud-privacy-rest", String(Math.max(0, Math.min(1, rest / PRIVACY_LEAD_MS))));
    for (const digits of document.querySelectorAll("[data-cloud-privacy-seconds]")) digits.textContent = String(seconds);
    if (!countingDown) {
      countingDown = true;
      root.dataset.cloudPrivacyCountdown = "";
      // Spoken once until the privacy screen has actually come; cancelled countdowns stay silent.
      if (!countdownAnnounced) {
        countdownAnnounced = true;
        say(options.text().countdown({ seconds }));
      }
    }
  };
  /** Runs at the next moment that matters: the countdown's start, each tick while it runs, and the deadline. */
  const check = () => {
    clock.clear(deadlineHandle);
    clock.clear(tickHandle);
    if (paused()) {
      stopCountdown();
      // A dictation or the warning may end without an input; look again in a while. The idle time starts again when
      // the pause ends, so the full time and its countdown follow.
      if (!active && timerSeconds > 0) {
        lastActivity = clock.now();
        deadlineHandle = clock.set(check, 1_000);
      }
      return;
    }
    const rest = lastActivity + timerSeconds * 1000 - clock.now();
    if (rest <= 0) {
      activate("timer");
      return;
    }
    if (rest <= PRIVACY_LEAD_MS) {
      showCountdown(rest);
      tickHandle = clock.set(check, Math.min(250, rest));
      return;
    }
    stopCountdown();
    deadlineHandle = clock.set(check, rest - PRIVACY_LEAD_MS);
  };
  const schedule = () => check();
  const activity = (share: boolean) => {
    lastActivity = clock.now();
    if (countingDown) check();
    if (share && lastActivity - lastShared >= ACTIVITY_SHARE_MS) {
      lastShared = lastActivity;
      channel?.postMessage({ type: "activity" } satisfies PrivacyChannelMessage);
    }
  };

  // ── Input ────────────────────────────────────────────────────────────
  /** A click anywhere else lifts, also on the hint; islands and the sign-out warning keep their own input. */
  const inIsland = (target: EventTarget | null) =>
    target instanceof Element && Boolean(target.closest(ISLAND) || target.closest("dialog[open]")?.querySelector(SESSION_WARNING_ACTION));
  const stop = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const keydown = (event: KeyboardEvent) => {
    if (!event.isTrusted) return;
    heldKey = event.code || event.key;
    activity(true);
    if (consumedKey && (event.code || event.key) === consumedKey) return stop(event);
    if (!active && options.shortcut && !event.repeat && !event.isComposing && isShortcut(event) && !sessionWarningOpen()) {
      stop(event);
      activate("request");
      return;
    }
    if (!active || sessionWarningOpen()) return;
    if (event.isComposing || event.keyCode === 229 || MODIFIERS.has(event.key)) return;
    // Tab moves between the hint and the islands that stay usable.
    if (event.key === "Tab") return;
    if ((event.key === "Enter" || event.key === " ") && inIsland(event.target)) return;
    stop(event);
    consumedKey = event.code || event.key;
    if (!event.repeat) lift();
  };
  const keyEnd = (event: KeyboardEvent) => {
    const key = event.code || event.key;
    if (event.type === "keyup" && heldKey === key) heldKey = null;
    if (!consumedKey || key !== consumedKey) return;
    stop(event);
    if (event.type === "keyup") consumedKey = null;
  };
  const pointerdown = (event: PointerEvent) => {
    if (!event.isTrusted) return;
    activity(true);
    swallowPointer = false;
    if (!active || sessionWarningOpen() || inIsland(event.target)) return;
    stop(event);
    swallowPointer = true;
    if (event.button === 0) lift();
    else wake();
  };
  const pointerRest = (event: Event) => {
    if (!swallowPointer) return;
    stop(event);
    if (event.type === "click" || event.type === "auxclick" || event.type === "contextmenu") swallowPointer = false;
  };
  const pointercancel = () => {
    swallowPointer = false;
  };
  const pointermove = (event: PointerEvent) => {
    if (!event.isTrusted) return;
    // The first trusted movement counts too: it may come during the countdown.
    const moved = lastPointer === null || lastPointer.x !== event.clientX || lastPointer.y !== event.clientY;
    lastPointer = { x: event.clientX, y: event.clientY };
    if (!moved) return;
    activity(true);
    if (active) wake();
  };
  const wheel = (event: WheelEvent) => {
    if (!event.isTrusted) return;
    activity(true);
    if (!active) return;
    if (!inIsland(event.target)) event.preventDefault();
    wake();
  };
  const click = (event: MouseEvent) => {
    // "Continue working" in the sign-out warning keeps the session and lifts the privacy screen with it.
    if (active && event.isTrusted && event.target instanceof Element && event.target.closest(SESSION_WARNING_ACTION)) {
      queueMicrotask(() => lift());
    }
  };
  const blur = () => {
    consumedKey = null;
    heldKey = null;
  };
  const request = (event: Event) => {
    const detail = (event as CustomEvent<PrivacyRequest>).detail;
    if (detail?.action === "on") activate("request");
    else if (detail?.action === "off") lift();
  };
  const message = (event: MessageEvent<PrivacyChannelMessage>) => {
    const data = event.data;
    // A tab that opens unseen or reloads covered asks the others for the state, so it covers while they are covered.
    if (data?.type === "hello") channel?.postMessage({ type: active ? "on" : "activity" } satisfies PrivacyChannelMessage);
    else if (data?.type === "activity") activity(false);
    else if (data?.type === "timer") publishPrivacyTimer(data.seconds);
    else if (data?.type === "on") activate("channel");
    else if (data?.type === "off") lift(true);
  };
  const resize = () => active && placeHint();

  // ── Arrival ──────────────────────────────────────────────────────────
  /** Opening, loading or returning to a page is the person's input: like a click, it shows every tab again. */
  const arrive = () => {
    activity(false);
    lastShared = lastActivity;
    channel?.postMessage({ type: "activity" } satisfies PrivacyChannelMessage);
    if (sessionWarningOpen()) return;
    if (active) lift();
    else channel?.postMessage({ type: "off" } satisfies PrivacyChannelMessage);
  };
  const seen = () => document.visibilityState === "visible" && !("prerendering" in document && document.prerendering === true);
  let unseen = false;
  /** A background tab or a prerender arrives when the person first sees it. */
  const shown = () => {
    if (!unseen || !seen()) return;
    unseen = false;
    arrive();
  };
  const pageshow = (event: PageTransitionEvent) => {
    if (event.persisted) arrive();
  };
  const pagehide = () => {
    try {
      if (active) sessionStorage.setItem(LEFT_COVERED, "");
      else sessionStorage.removeItem(LEFT_COVERED);
    } catch {
      /* Without session storage a reload of a covered page counts as input. */
    }
  };
  const reloadedCovered = () => {
    try {
      const left = sessionStorage.getItem(LEFT_COVERED) !== null;
      sessionStorage.removeItem(LEFT_COVERED);
      // Only a reload of that page: a later sign-in after the shared workstation's sign-out is the person's input.
      return left && navigationType() === "reload";
    } catch {
      return false;
    }
  };

  const stopTimer = onPrivacyTimer((seconds) => {
    timerSeconds = seconds;
    lastActivity = clock.now();
    schedule();
  });
  const pointerEvents = ["pointerup", "mousedown", "mouseup", "click", "auxclick", "contextmenu", "dblclick"] as const;
  window.addEventListener("keydown", keydown, true);
  window.addEventListener("keypress", keyEnd, true);
  window.addEventListener("keyup", keyEnd, true);
  window.addEventListener("pointerdown", pointerdown, true);
  for (const type of pointerEvents) window.addEventListener(type, pointerRest, true);
  window.addEventListener("pointercancel", pointercancel, true);
  window.addEventListener("pointermove", pointermove, { capture: true, passive: true });
  window.addEventListener("wheel", wheel, { capture: true, passive: false });
  window.addEventListener("click", click, true);
  window.addEventListener("blur", blur);
  window.addEventListener("resize", resize);
  document.addEventListener("toggle", toggled, true);
  document.addEventListener("visibilitychange", shown);
  document.addEventListener("prerenderingchange", shown);
  window.addEventListener("pageshow", pageshow);
  window.addEventListener("pagehide", pagehide);
  window.addEventListener(PRIVACY_REQUEST_EVENT, request);
  channel?.addEventListener("message", message);
  // A page the person sees has just been opened by them. Lifting is instant (only covering fades in), so a page that
  // covered while unseen shows sharp in its first visible frame.
  const following = reloadedCovered();
  if (following) activate("channel");
  else if (seen()) arrive();
  else unseen = true;
  // A page that does not arrive asks the other tabs for the state, so it covers while they are covered.
  if (following || unseen) channel?.postMessage({ type: "hello" } satisfies PrivacyChannelMessage);
  schedule();

  return () => {
    lift(true);
    stopCountdown();
    clock.clear(deadlineHandle);
    clock.clear(wakeHandle);
    clock.clear(sayHandle);
    stopTimer();
    window.removeEventListener("keydown", keydown, true);
    window.removeEventListener("keypress", keyEnd, true);
    window.removeEventListener("keyup", keyEnd, true);
    window.removeEventListener("pointerdown", pointerdown, true);
    for (const type of pointerEvents) window.removeEventListener(type, pointerRest, true);
    window.removeEventListener("pointercancel", pointercancel, true);
    window.removeEventListener("pointermove", pointermove, true);
    window.removeEventListener("wheel", wheel, true);
    window.removeEventListener("click", click, true);
    window.removeEventListener("blur", blur);
    window.removeEventListener("resize", resize);
    document.removeEventListener("toggle", toggled, true);
    document.removeEventListener("visibilitychange", shown);
    document.removeEventListener("prerenderingchange", shown);
    window.removeEventListener("pageshow", pageshow);
    window.removeEventListener("pagehide", pagehide);
    window.removeEventListener(PRIVACY_REQUEST_EVENT, request);
    channel?.close();
    disposeHint();
    hint.remove();
    live.remove();
    root.style.removeProperty("--cloud-privacy-rest");
  };
};
