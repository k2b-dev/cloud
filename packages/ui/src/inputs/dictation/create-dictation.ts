import { type Accessor, createSignal, getOwner, onCleanup } from "solid-js";
import { isServer } from "solid-js/web";
import { announce } from "../../feedback/announce";
import { useLocale } from "../../intl/locale";
import { dictationMessages } from "./dictation-messages";
import type {
  DictationAlternative,
  DictationDevice,
  DictationErrorCode,
  DictationEvent,
  DictationSession,
  DictationSource,
  DictationTarget,
} from "./types";

export type DictationStatus = "idle" | "starting" | "live" | "finishing";

/**
 * What stays visible after a session could not start or ended on its own. `interrupted` and `ended` replace the bar,
 * so "Continue" writes on at the same mark; the others are cards at the microphone.
 */
export type DictationNotice =
  | { kind: "blocked" }
  | { kind: "unavailable" }
  | { kind: "not_available" }
  | { kind: "quota"; resetsAt?: string }
  | { kind: "overloaded" }
  | { kind: "elsewhere" }
  | { kind: "interrupted" }
  | { kind: "ended"; reason: "max_duration" | "silence"; maxMs: number };

export type DictationOptions = {
  source: DictationSource;
  target: DictationTarget;
  /** Offered beside "Try again" when live dictation is busy. */
  alternative?: DictationAlternative;
  /** While true, dictation cannot start, such as in a read-only field; the host calls `end()` when it turns true. */
  disabled?: () => boolean;
};

export type DictationController = {
  status: Accessor<DictationStatus>;
  /** Dictating, starting, or finishing: the bar stands in for the host's controls. */
  active: Accessor<boolean>;
  notice: Accessor<DictationNotice | null>;
  /** Recent levels from 0 to 1, newest last. */
  levels: Accessor<readonly number[]>;
  elapsedMs: Accessor<number>;
  maxMs: Accessor<number>;
  offline: Accessor<boolean>;
  device: Accessor<DictationDevice | undefined>;
  deviceId: Accessor<string | undefined>;
  devices: Accessor<readonly DictationDevice[]>;
  loadDevices(): Promise<void>;
  chooseDevice(id: string): void;
  alternative?: DictationAlternative;
  start(): void;
  stop(): Promise<void>;
  /** Ends the session at once and removes only the text it inserted. */
  discard(): void;
  /** Closes a notice; the text stays. */
  dismiss(): void;
  /** Ends any session at once and closes the dictation; the text stays. For a field that changes or turns read-only. */
  end(): void;
  /** Whether dictation may start now. */
  disabled: Accessor<boolean>;
  /** Elements that receive focus: the microphone after the end, the stop button after the start. */
  bind(role: "microphone" | "stop" | "continue", element: HTMLElement | undefined): void;
};

const deviceKey = "k2b.dictation.deviceId";
const levelCount = 160;
/** A stop waits this long for the source's last words before it gives up the connection. */
const stopGraceMs = 8_000;
const defaultMaxMs = 600_000;

const readDevice = () => {
  try {
    return localStorage.getItem(deviceKey) ?? undefined;
  } catch {
    return undefined;
  }
};
const writeDevice = (id: string) => {
  try {
    localStorage.setItem(deviceKey, id);
  } catch {
    // A private window may refuse storage; the choice then lasts for this page.
  }
};

const noticeFor = (code: DictationErrorCode, resetsAt?: string): DictationNotice => {
  switch (code) {
    case "microphone_blocked":
      return { kind: "blocked" };
    case "microphone_unavailable":
      return { kind: "unavailable" };
    case "not_configured":
    case "no_access":
      return { kind: "not_available" };
    case "daily_limit":
      return { kind: "quota", resetsAt };
    case "overloaded":
      return { kind: "overloaded" };
    case "busy_elsewhere":
      return { kind: "elsewhere" };
    default:
      return { kind: "interrupted" };
  }
};

/** Bar notices stand where the bar was; card notices open at the microphone. */
export const isBarNotice = (notice: DictationNotice | null) => notice?.kind === "interrupted" || notice?.kind === "ended";

/**
 * The state of one dictation place: which session runs, what its bar shows, and the notice it leaves. Render it with
 * `DictationButton` and `DictationBar`; the target decides where text lands. One controller runs one session at a time.
 */
export function createDictation(options: DictationOptions): DictationController {
  const [status, setStatus] = createSignal<DictationStatus>("idle");
  const [notice, setNotice] = createSignal<DictationNotice | null>(null);
  const [levels, setLevels] = createSignal<readonly number[]>([]);
  const [elapsedMs, setElapsedMs] = createSignal(0);
  const [maxMs, setMaxMs] = createSignal(defaultMaxMs);
  const [device, setDevice] = createSignal<DictationDevice>();
  const [deviceId, setDeviceId] = createSignal<string | undefined>(isServer ? undefined : readDevice());
  const [devices, setDevices] = createSignal<readonly DictationDevice[]>([]);
  const [offline, setOffline] = createSignal(!isServer && typeof navigator !== "undefined" && navigator.onLine === false);
  const elements: Partial<Record<"microphone" | "stop" | "continue", HTMLElement>> = {};
  let session: DictationSession | undefined;
  let abort: AbortController | undefined;
  /** The target's mark stays open while a notice offers to continue. */
  let open = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let liveSince = 0;
  let disposed = false;
  let grace: ReturnType<typeof setTimeout> | undefined;

  const locale = useLocale();
  const t = () => dictationMessages.resolve([locale()]).t;
  /** Set while a new microphone takes over, so the mark stays where the words go on. */
  let restarting = false;
  const focusLater = (role: "microphone" | "stop" | "continue") =>
    queueMicrotask(() => requestAnimationFrame(() => elements[role]?.focus({ preventScroll: true })));
  const clearTimer = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  const close = () => {
    if (!open) return;
    open = false;
    options.target.end();
  };
  const settle = (next: DictationNotice | null, message?: string) => {
    clearTimer();
    if (grace) clearTimeout(grace);
    grace = undefined;
    session = undefined;
    abort = undefined;
    setStatus("idle");
    setNotice(next);
    if (restarting && !next) {
      // A new microphone takes over at the same mark.
      queueMicrotask(start);
      return;
    }
    restarting = false;
    if (!next) close();
    if (message) announce(message);
    // A card takes the focus itself and returns it to the microphone when it closes.
    if (!next || isBarNotice(next)) focusLater(next ? "continue" : "microphone");
  };

  const run = async (current: DictationSession, signal: AbortSignal) => {
    let finished = false;
    try {
      for await (const event of current.events as AsyncIterable<DictationEvent>) {
        if (signal.aborted || disposed) return;
        switch (event.type) {
          case "state":
            if (event.state === "connecting") setStatus("starting");
            else if (event.state === "live") {
              setMaxMs(event.maxMs || defaultMaxMs);
              if (event.device) setDevice(event.device);
              liveSince = performance.now();
              setElapsedMs(0);
              clearTimer();
              timer = setInterval(() => setElapsedMs(performance.now() - liveSince), 250);
              const resumed = restarting;
              restarting = false;
              setStatus("live");
              if (!resumed) {
                announce(t().running);
                focusLater("stop");
              }
            } else if (event.state === "finishing") setStatus("finishing");
            else {
              finished = true;
              if (event.reason === "daily_limit") settle({ kind: "quota" }, t().ended);
              else if (event.reason) settle({ kind: "ended", reason: event.reason, maxMs: maxMs() }, t().ended);
              else settle(null, t().ended);
              return;
            }
            break;
          case "level":
            setLevels((previous) => [...previous.slice(1 - levelCount), Math.max(0, Math.min(1, event.level))]);
            break;
          case "text":
            if (event.text) options.target.insert(event.text);
            break;
          case "error":
            finished = true;
            settle(noticeFor(event.code, event.resetsAt));
            return;
        }
      }
    } catch {
      if (signal.aborted || disposed) return;
      finished = true;
      settle({ kind: "interrupted" });
      return;
    }
    if (!finished && !signal.aborted && !disposed) settle({ kind: "interrupted" });
  };

  const start = () => {
    if (disposed || offline() || options.disabled?.() || status() !== "idle") return;
    setNotice(null);
    if (!restarting) setDevice(undefined);
    options.target.begin();
    open = true;
    setLevels([]);
    setElapsedMs(0);
    setStatus("starting");
    const controller = new AbortController();
    abort = controller;
    try {
      session = options.source.start({ deviceId: deviceId(), signal: controller.signal });
    } catch {
      settle({ kind: "interrupted" });
      return;
    }
    void run(session, controller.signal);
  };

  const stop = async () => {
    const current = session;
    const controller = abort;
    if (!current || !controller || (status() !== "live" && status() !== "starting")) return;
    if (status() === "starting") {
      // Nothing was said yet: end it like a discard, without removing anything.
      controller.abort();
      settle(null);
      return;
    }
    setStatus("finishing");
    clearTimer();
    // The deadline stays until the session settled, also when stop() itself fails, so "Finishing" always ends.
    grace = setTimeout(() => {
      if (abort !== controller) return;
      controller.abort();
      settle({ kind: "interrupted" });
    }, stopGraceMs);
    try {
      await current.stop();
    } catch {
      // The event stream reports how it ended; the deadline covers a stream that stalls.
    }
  };

  const discard = () => {
    restarting = false;
    abort?.abort();
    if (open) options.target.discard();
    settle(null, t().discarded);
  };

  if (!isServer && typeof window !== "undefined") {
    const online = () => setOffline(false);
    const lost = () => setOffline(true);
    window.addEventListener("online", online);
    window.addEventListener("offline", lost);
    if (getOwner())
      onCleanup(() => {
        window.removeEventListener("online", online);
        window.removeEventListener("offline", lost);
      });
  }
  if (getOwner())
    onCleanup(() => {
      disposed = true;
      clearTimer();
      abort?.abort();
      if (open) {
        open = false;
        options.target.end();
      }
    });

  return {
    status,
    active: () => status() !== "idle",
    notice,
    levels,
    elapsedMs,
    maxMs,
    offline,
    device,
    deviceId,
    devices,
    loadDevices: async () => {
      try {
        setDevices(await options.source.devices());
      } catch {
        setDevices([]);
      }
    },
    chooseDevice: (id) => {
      writeDevice(id);
      setDeviceId(id);
      const chosen = devices().find((item) => item.id === id);
      if (chosen) setDevice(chosen);
      // A running session keeps its microphone; the next words come from the new one after a short finish.
      if (status() !== "live") return;
      restarting = true;
      void stop();
    },
    get alternative() {
      return options.alternative;
    },
    start: () => start(),
    stop,
    discard,
    dismiss: () => {
      setNotice(null);
      close();
    },
    end: () => {
      restarting = false;
      if (status() === "idle" && !notice() && !open) return;
      abort?.abort();
      clearTimer();
      if (grace) clearTimeout(grace);
      grace = undefined;
      session = undefined;
      abort = undefined;
      setStatus("idle");
      setNotice(null);
      close();
    },
    disabled: () => Boolean(options.disabled?.()),
    bind: (role, element) => {
      if (element) elements[role] = element;
      else delete elements[role];
    },
  };
}
