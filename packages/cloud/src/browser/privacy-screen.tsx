import { Button } from "@k2b/ui";
import { render } from "solid-js/web";
import type { PrivacyTimerSeconds } from "../contracts/screen-preferences";
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
 * - Covered: every part of the page outside the islands gets `inert` and `data-cloud-privacy-covered`, which blurs it.
 *   The app bar stays recognizable but unusable; only its counts and the avatar blur.
 * - Islands stay sharp and usable: elements with `data-cloud-privacy="keep"` (such as upload progress) or `"live"`
 *   (such as a running dictation, which also pauses the timer). Inside an island, `data-cloud-privacy="blur"` blurs a
 *   part, such as file names.
 * - The shared workstation's sign-out warning always comes first: while it is open the privacy screen neither starts
 *   nor lifts, the warning stays sharp, and its "Continue working" also lifts the privacy screen.
 * - The lifting click or key never reaches the page: the pointer sequence and the key until its release are used up.
 *   A mouse movement, a scroll, a right or middle click only light up the hint.
 * - With the timer on, a countdown shows during the last ten seconds; any input cancels it.
 * - All Cloud tabs of this browser share the state and the idle time.
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

  const hint = document.createElement("div");
  hint.className = "cloud-privacy-hint";
  hint.setAttribute("role", "dialog");
  hint.dataset.cloudPrivacy = "keep";
  const ids = { title: "cloud-privacy-title", body: "cloud-privacy-body", note: "cloud-privacy-note" };
  hint.setAttribute("aria-labelledby", ids.title);
  hint.setAttribute("aria-describedby", `${ids.body} ${ids.note}`);
  const disposeHint = render(() => <PrivacyHint text={options.text} ids={ids} onContinue={() => lift()} />, hint);

  // ── Covering ─────────────────────────────────────────────────────────
  const isIsland = (element: Element) => element === hint || element === live || element.matches(ISLAND) || isSessionWarning(element);
  const holdsIsland = (element: Element) =>
    element.contains(hint) || Boolean(element.querySelector(`${ISLAND}, ${SESSION_WARNING_ACTION}, .layout-rail`));
  const mark = (element: Element, kind: string) => {
    element.setAttribute(COVERED, kind);
    covered.add(element);
    if (!element.hasAttribute("inert")) {
      element.setAttribute("inert", "");
      madeInert.add(element);
    }
  };
  let arrived = false;
  const cover = (container: Element, fresh: boolean) => {
    for (const child of Array.from(container.children)) {
      if (SKIPPED.has(child.tagName) || child.hasAttribute(COVERED) || isIsland(child)) continue;
      if (child.classList.contains("layout-rail")) mark(child, "rail");
      else if (holdsIsland(child)) cover(child, fresh);
      else {
        mark(child, "");
        // Toasts and dialogs that arrive while covered stay covered; the screen reader hears only that something came.
        if (fresh && !arrived && container === document.body && child.querySelector(".k2b-toast, [role=alert], [role=status]")) {
          arrived = true;
          say(options.text().newMessages);
        }
      }
    }
  };
  /** Parts of an island that would tell too much, such as file names, blur and rest like the covered page. */
  const coverParts = () => {
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
  const placeHint = () => {
    const host = hintHost();
    if (hint.parentElement !== host) host.append(hint);
    const area = document.querySelector(".cloud-app-canvas [data-cloud-app-area]")?.getBoundingClientRect();
    const x = area && area.width > 0 ? area.left + area.width / 2 : window.innerWidth / 2;
    const y = area && area.height > 0 ? area.top + area.height / 2 : window.innerHeight / 2;
    hint.style.setProperty("--cloud-privacy-hint-x", `${Math.round(x)}px`);
    hint.style.setProperty("--cloud-privacy-hint-y", `${Math.round(y)}px`);
  };
  const observer = new MutationObserver((records) => {
    if (!active) return;
    const fresh = records.some((record) =>
      Array.from(record.addedNodes).some((node) => node instanceof Element && !node.closest(`[${COVERED}]`) && node !== hint),
    );
    if (!fresh) return;
    placeHint();
    cover(document.body, true);
    coverParts();
  });
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
    placeHint();
    cover(document.body, false);
    coverParts();
    arrived = false;
    observer.observe(document.body, { childList: true, subtree: true });
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
      // A dictation or the warning may end without an input; look again in a while.
      if (!active && timerSeconds > 0) deadlineHandle = clock.set(check, 1_000);
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
    const moved = lastPointer !== null && (lastPointer.x !== event.clientX || lastPointer.y !== event.clientY);
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
    if (data?.type === "activity") activity(false);
    else if (data?.type === "timer") publishPrivacyTimer(data.seconds);
    else if (data?.type === "on") activate("channel");
    else if (data?.type === "off") lift(true);
  };
  const resize = () => active && placeHint();

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
  window.addEventListener(PRIVACY_REQUEST_EVENT, request);
  channel?.addEventListener("message", message);
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
    window.removeEventListener(PRIVACY_REQUEST_EVENT, request);
    channel?.close();
    disposeHint();
    hint.remove();
    live.remove();
    root.style.removeProperty("--cloud-privacy-rest");
  };
};
