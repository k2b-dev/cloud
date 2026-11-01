import { liveDictationWorklet } from "./live-dictation-pcm";

export type DictationErrorCode =
  | "not_configured"
  | "no_access"
  | "daily_limit"
  | "overloaded"
  | "busy_elsewhere"
  | "provider_failed"
  | "connection_lost"
  | "microphone_blocked"
  | "microphone_unavailable";
export type DictationDevice = { id: string; label: string };
export type DictationEvent =
  | { type: "state"; state: "connecting" }
  | { type: "state"; state: "live"; maxMs: number; device?: DictationDevice }
  | { type: "state"; state: "finishing" }
  | { type: "state"; state: "finished"; reason?: "max_duration" | "silence" | "daily_limit" }
  | { type: "level"; level: number }
  | { type: "text"; text: string }
  | { type: "error"; code: DictationErrorCode; retryable: boolean; resetsAt?: string };
export type DictationSession = {
  /** Ends after finished or error, or silently when the start signal is aborted. */
  events: AsyncIterable<DictationEvent>;
  /** Regular stop waits for the last words and finished (or error). */
  stop(): Promise<void>;
};
export type DictationSource = {
  start(options: { deviceId?: string; signal: AbortSignal }): DictationSession;
  devices(): Promise<DictationDevice[]>;
};
const errorCodes: readonly string[] = [
  "not_configured",
  "no_access",
  "daily_limit",
  "overloaded",
  "busy_elsewhere",
  "provider_failed",
  "connection_lost",
];
const isErrorCode = (code: unknown): code is DictationErrorCode => typeof code === "string" && errorCodes.includes(code);
const finishReason = (reason: unknown): reason is "max_duration" | "silence" | "daily_limit" =>
  reason === "max_duration" || reason === "silence" || reason === "daily_limit";

/** Append-only mapping: final text may add the last words but may never revise earlier deltas. */
export const mapLiveDictationMessage = (
  message: unknown,
  text: string,
  device?: DictationDevice,
): { events: DictationEvent[]; text: string; ended?: boolean } => {
  if (typeof message !== "object" || message === null || !("type" in message)) throw new Error("Invalid dictation event");
  if (
    message.type === "ready" &&
    "maxMs" in message &&
    typeof message.maxMs === "number" &&
    Number.isFinite(message.maxMs) &&
    message.maxMs > 0
  )
    return { text, events: [{ type: "state", state: "live", maxMs: message.maxMs, ...(device ? { device } : {}) }] };
  if (message.type === "delta" && "text" in message && typeof message.text === "string")
    return { text: text + message.text, events: [{ type: "text", text: message.text }] };
  if (message.type === "finishing") return { text, events: [{ type: "state", state: "finishing" }] };
  if (message.type === "done" && "text" in message && typeof message.text === "string" && message.text.startsWith(text)) {
    const suffix = message.text.slice(text.length);
    const reason = "reason" in message && finishReason(message.reason) ? message.reason : undefined;
    return {
      text: message.text,
      ended: true,
      events: [
        ...(suffix ? [{ type: "text" as const, text: suffix }] : []),
        { type: "state", state: "finished", ...(reason ? { reason } : {}) },
      ],
    };
  }
  if (
    message.type === "error" &&
    "code" in message &&
    isErrorCode(message.code) &&
    "retryable" in message &&
    typeof message.retryable === "boolean"
  )
    return {
      text,
      ended: true,
      events: [
        {
          type: "error",
          code: message.code,
          retryable: message.retryable,
          ...("resetsAt" in message && typeof message.resetsAt === "string" ? { resetsAt: message.resetsAt } : {}),
        },
      ],
    };
  if (message.type === "warning") return { text, events: [] };
  throw new Error("Invalid dictation event");
};

export const createLiveDictationSource = ({ app }: { app: string }): DictationSource => ({
  async devices() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    return (await navigator.mediaDevices.enumerateDevices())
      .filter((device) => device.kind === "audioinput")
      .map((device) => ({ id: device.deviceId, label: device.label }));
  },
  start({ deviceId, signal }) {
    const queue: DictationEvent[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    let live = false;
    let stopRequested = false;
    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;
    let node: AudioWorkletNode | undefined;
    let socket: WebSocket | undefined;
    let device: DictationDevice | undefined;
    let text = "";
    let socketDeadline: ReturnType<typeof setTimeout> | undefined;
    let stopDeadline: ReturnType<typeof setTimeout> | undefined;
    let flushDeadline: ReturnType<typeof setTimeout> | undefined;
    let finishStop = () => {};
    const stopped = new Promise<void>((resolve) => {
      finishStop = resolve;
    });
    const emit = (event: DictationEvent) => {
      if (ended) return;
      if (event.type === "level" && queue.at(-1)?.type === "level") queue.pop();
      queue.push(event);
      wake?.();
      wake = undefined;
    };
    const stopMic = () => {
      live = false;
      node?.disconnect();
      node?.port.close();
      node = undefined;
      stream?.getTracks().forEach((track) => track.stop());
      stream = undefined;
      if (context) {
        void context.close().catch(() => {});
        context = undefined;
      }
    };
    const finish = (silent = false) => {
      if (ended) return;
      ended = true;
      if (silent) queue.length = 0;
      clearTimeout(socketDeadline);
      clearTimeout(stopDeadline);
      clearTimeout(flushDeadline);
      signal.removeEventListener("abort", abort);
      window.removeEventListener("pagehide", abort);
      stopMic();
      socket?.close();
      wake?.();
      wake = undefined;
      finishStop();
    };
    const error = (code: DictationErrorCode, retryable = true) => {
      emit({ type: "error", code, retryable });
      finish();
    };
    const abort = () => finish(true);
    const commitStop = () => {
      clearTimeout(flushDeadline);
      stopMic();
      if (socket?.readyState === WebSocket.OPEN && !ended) {
        socket.send(JSON.stringify({ type: "stop" }));
        // Server finalization takes at most five seconds; allow one second for transport.
        stopDeadline = setTimeout(() => error("connection_lost"), 6000);
      }
    };
    const regularStop = () => {
      stream?.getTracks().forEach((track) => track.stop());
      stream = undefined;
      flushDeadline = setTimeout(() => error("connection_lost"), 2000);
      node?.port.postMessage({ stop: true });
    };
    signal.addEventListener("abort", abort, { once: true });
    window.addEventListener("pagehide", abort, { once: true });
    if (signal.aborted) finish(true);
    else {
      emit({ type: "state", state: "connecting" });
      void (async () => {
        try {
          if (!navigator.mediaDevices?.getUserMedia) {
            error("microphone_unavailable");
            return;
          }
          const constraints = { channelCount: 1, echoCancellation: true, noiseSuppression: true };
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              audio: { ...constraints, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) },
            });
          } catch (failure) {
            if (ended) return;
            if (
              deviceId &&
              typeof failure === "object" &&
              failure !== null &&
              "name" in failure &&
              (failure.name === "OverconstrainedError" || failure.name === "NotFoundError")
            )
              stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
            else throw failure;
          }
          if (ended) {
            stream.getTracks().forEach((track) => track.stop());
            stream = undefined;
            return;
          }
          const track = stream.getAudioTracks()[0];
          if (!track) {
            error("microphone_unavailable");
            return;
          }
          device = { id: track.getSettings().deviceId ?? "", label: track.label };
          track.addEventListener("ended", () => error("microphone_unavailable"), { once: true });
          context = new AudioContext();
          const audioContext = context;
          const workletUrl = URL.createObjectURL(new Blob([liveDictationWorklet()], { type: "text/javascript" }));
          try {
            await audioContext.audioWorklet.addModule(workletUrl);
          } finally {
            URL.revokeObjectURL(workletUrl);
          }
          if (ended) return;
          node = new AudioWorkletNode(audioContext, "cloud-live-dictation");
          node.port.onmessage = (event: MessageEvent<{ frame?: ArrayBuffer; level?: number; done?: boolean }>) => {
            if (event.data.done) {
              if (stopRequested && !ended) commitStop();
              return;
            }
            if (!live || ended || socket?.readyState !== WebSocket.OPEN || !event.data.frame) return;
            if (socket.bufferedAmount > 64_000) {
              error("connection_lost");
              return;
            }
            socket.send(event.data.frame);
            emit({ type: "level", level: Math.max(0, Math.min(1, event.data.level ?? 0)) });
          };
          audioContext.createMediaStreamSource(stream).connect(node);
          // A connected silent output keeps the worklet processing without microphone playback.
          const mute = audioContext.createGain();
          mute.gain.value = 0;
          node.connect(mute);
          mute.connect(audioContext.destination);
          await audioContext.resume();
          if (ended) return;
          const url = new URL("/api/ai/dictation/live", window.location.href);
          url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
          socket = new WebSocket(url);
          socket.binaryType = "arraybuffer";
          socketDeadline = setTimeout(() => error("connection_lost"), 10_000);
          socket.onopen = () => {
            if (!ended) socket?.send(JSON.stringify({ type: "start", app }));
          };
          socket.onmessage = (event) => {
            if (ended) return;
            try {
              const result = mapLiveDictationMessage(JSON.parse(String(event.data)), text, device);
              text = result.text;
              for (const item of result.events) {
                emit(item);
                if (item.type === "state" && item.state === "live") {
                  clearTimeout(socketDeadline);
                  live = true;
                  if (stopRequested) regularStop();
                }
                if (item.type === "state" && item.state === "finishing") {
                  clearTimeout(flushDeadline);
                  stopMic();
                  clearTimeout(stopDeadline);
                  stopDeadline = setTimeout(() => error("connection_lost"), 6000);
                }
              }
              if (result.ended) finish();
            } catch {
              error("connection_lost");
            }
          };
          socket.onclose = (event) => {
            if (!ended) error(event.code === 1008 && isErrorCode(event.reason) ? event.reason : "connection_lost", event.code !== 1008);
          };
          socket.onerror = () => {
            if (!ended) error("connection_lost");
          };
        } catch (failure) {
          if (ended) return;
          const name = failure instanceof Error ? failure.name : "";
          error(["NotAllowedError", "SecurityError"].includes(name) ? "microphone_blocked" : "microphone_unavailable");
        }
      })();
    }
    return {
      events: {
        async *[Symbol.asyncIterator]() {
          try {
            while (true) {
              const item = queue.shift();
              if (item) yield item;
              else if (ended) return;
              else
                await new Promise<void>((resolve) => {
                  wake = resolve;
                });
            }
          } finally {
            finish(true);
          }
        },
      },
      stop() {
        if (!stopRequested && !ended) {
          stopRequested = true;
          if (live) regularStop();
        }
        return stopped;
      },
    };
  },
});
