import type { RealtimeTranscriptionProvider, RealtimeWebSocketFactory, Usage } from "@k2b/nessi/ai";
import { z } from "zod";
import { beginAiCall, finishAiCall } from "./inference-calls";
import { type createLiveDictationLimits, liveDictationLimits } from "./live-dictation-limits";
import { createAiLiveTranscriptionProvider, liveDictationCredential } from "./live-dictation-model";
import { safelyRecordStructuredRun } from "./structured-runs";
import type { AiModelProfile } from "./types";

export const LIVE_DICTATION_MAX_MS = 600_000;
export const LIVE_DICTATION_BYTES_PER_SECOND = 32_000;
export const LIVE_DICTATION_MAX_FRAME_BYTES = 16_384;
// Two seconds of base64 PCM, plus its append envelope.
export const LIVE_DICTATION_PROVIDER_BUFFER_BYTES = Math.ceil((64_000 * 4) / 3) + 256;
export type LiveDictationCode =
  | "not_configured"
  | "no_access"
  | "daily_limit"
  | "overloaded"
  | "busy_elsewhere"
  | "max_duration"
  | "silence"
  | "provider_failed"
  | "connection_lost";
export type LiveDictationFinishReason = "max_duration" | "silence" | "daily_limit";
export type LiveDictationClock = { now(): number; schedule(ms: number, run: () => void | Promise<void>): () => void };
const realClock: LiveDictationClock = {
  now: Date.now,
  schedule(ms, run) {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};
const startSchema = z.object({ type: z.literal("start"), app: z.string().regex(/^[a-z][a-z0-9-]{0,119}$/) }).strict();
const stopSchema = z.object({ type: z.literal("stop") }).strict();

/** Bounded in-memory PCM; normal end drains, cancellation discards immediately. */
class AudioFrames implements AsyncIterable<Uint8Array> {
  private frames: Uint8Array[] = [];
  private bytes = 0;
  private ended = false;
  private wake?: () => void;
  push(frame: Uint8Array) {
    if (this.ended || this.bytes + frame.byteLength > 64_000) return false;
    this.frames.push(frame);
    this.bytes += frame.byteLength;
    this.wake?.();
    return true;
  }
  end(discard = false) {
    this.ended = true;
    if (discard) {
      this.frames = [];
      this.bytes = 0;
    }
    this.wake?.();
  }
  async *[Symbol.asyncIterator]() {
    while (true) {
      const frame = this.frames.shift();
      if (frame) {
        this.bytes -= frame.byteLength;
        yield frame;
      } else if (this.ended) return;
      else
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
    }
  }
}

export type LiveDictationAccounting = {
  begin(profile: AiModelProfile, userId: string, app: string): Promise<string>;
  finish(input: {
    id: string;
    profile: AiModelProfile;
    userId: string;
    app: string;
    durationMs: number;
    audioMs: number;
    usage?: Usage;
    status: "ok" | "failed" | "aborted";
    code?: LiveDictationCode;
  }): Promise<void>;
};
const accounting: LiveDictationAccounting = {
  async begin(profile, userId, app) {
    return (
      await beginAiCall({ ...profile, pricing: undefined }, { kind: "live-transcription", task: "live-dictation", userId, appId: app }, 0)
    ).id;
  },
  async finish(input) {
    try {
      await finishAiCall(input.id, input.usage, input.status === "aborted" ? "ok" : input.status, {
        audioMs: input.audioMs,
        cancelled: input.status === "aborted",
      });
    } finally {
      await safelyRecordStructuredRun({
        task: "live-dictation",
        appId: input.app,
        attribution: { userId: input.userId },
        modelId: input.profile.id,
        providerModel: input.profile.model,
        mode: "live-transcription",
        durationMs: input.durationMs,
        audioMs: input.audioMs,
        usage: input.usage,
        status: input.status === "failed" ? "failed" : "ok",
        errorCode: input.status === "failed" ? input.code : undefined,
        attempts: 1,
      });
    }
  },
};

export type LiveDictationOptions = {
  userId: string;
  profile: AiModelProfile;
  concurrency: number;
  minutesPerDay: number;
  timeZone: string;
  send(event: Record<string, unknown>): void;
  close(code: number, reason?: string): void;
  revalidate(): Promise<boolean>;
  clock?: LiveDictationClock;
  limits?: ReturnType<typeof createLiveDictationLimits>;
  accounting?: LiveDictationAccounting;
  /** A transport seam for deterministic integration tests; production always uses Bun's socket. */
  webSocket?: (url: string, headers: Record<string, string>) => WebSocket;
};

/** Owns one socket, one lease and one cancellable Nessi stream. Never stores audio or transcript. */
export const createLiveDictationSession = (options: LiveDictationOptions) => {
  const clock = options.clock ?? realClock;
  const limits = options.limits ?? liveDictationLimits;
  const ledger = options.accounting ?? accounting;
  const token = crypto.randomUUID();
  const controller = new AbortController();
  const audio = new AudioFrames();
  const timers = new Set<() => void>();
  let phase: "waiting" | "connecting" | "live" | "finishing" | "ended" = "waiting";
  let reserved = false;
  let app = "";
  let callId: string | undefined;
  let accountingFinished = false;
  let startedAt: number | undefined;
  let lastChargedAt: number | undefined;
  let text = "";
  let audioBytes = 0;
  let silenceSamples = 0;
  let billingEndsAt: number | undefined;
  let reason: LiveDictationFinishReason | undefined;
  let bucket = 64_000;
  let bucketAt = clock.now();
  let stopDeadline: (() => void) | undefined;
  let connectDeadline: (() => void) | undefined;
  let checking = false;
  let lastAccessAt = clock.now();
  let cleanupPromise = Promise.resolve();
  let startPromise = Promise.resolve();
  let chargeTail = Promise.resolve<Awaited<ReturnType<typeof limits.charge>>>(null);
  let leaseDeadline: (() => void) | undefined;
  let silenceDeadline: (() => void) | undefined;
  let usage: Usage | undefined;

  const schedule = (ms: number, run: () => void | Promise<void>) => {
    if (phase === "ended") return () => {};
    let cancelTimer = () => {};
    const cancel = () => {
      timers.delete(cancel);
      cancelTimer();
    };
    cancelTimer = clock.schedule(ms, () => {
      timers.delete(cancel);
      if (phase !== "ended") return run();
    });
    timers.add(cancel);
    return cancel;
  };
  const send = (event: Record<string, unknown>) => {
    if (phase === "ended") return;
    try {
      options.send(event);
    } catch {
      end("aborted", "connection_lost");
      options.close(1000);
    }
  };
  const charge = () => {
    if (lastChargedAt === undefined) return Promise.resolve({ usedSeconds: 0, resetsAt: "" });
    const now = billingEndsAt ?? clock.now();
    const from = lastChargedAt;
    lastChargedAt = now;
    chargeTail = chargeTail.then(() => limits.charge(options.userId, token, from, now, options.timeZone));
    return chargeTail;
  };
  const finishAccounting = async (status: "ok" | "failed" | "aborted", code?: LiveDictationCode) => {
    if (!callId || accountingFinished) return;
    accountingFinished = true;
    await ledger.finish({
      id: callId,
      profile: options.profile,
      userId: options.userId,
      app,
      durationMs: startedAt === undefined ? 0 : clock.now() - startedAt,
      audioMs: Math.round(audioBytes / 32),
      usage,
      status,
      code,
    });
  };
  const end = (status: "ok" | "failed" | "aborted", code?: LiveDictationCode) => {
    if (phase === "ended") return;
    phase = "ended";
    controller.abort();
    audio.end(true);
    for (const cancel of timers) cancel();
    timers.clear();
    cleanupPromise = (async () => {
      try {
        if (reserved) await charge();
      } finally {
        try {
          if (reserved) {
            reserved = false;
            await limits.release(options.userId, token);
          }
        } finally {
          await finishAccounting(status, code);
        }
      }
    })().catch(() => {
      console.warn("[ai:live-dictation] Accounting or lease cleanup failed", {
        userId: options.userId,
        modelId: options.profile.modelId,
        app,
      });
    });
  };
  const fail = (code: LiveDictationCode, retryable = false, resetsAt?: string) => {
    if (phase === "ended") return;
    controller.abort();
    send({ type: "error", code, retryable, ...(resetsAt ? { resetsAt } : {}) });
    end("failed", code);
    options.close(1008, code);
  };
  const done = () => {
    if (controller.signal.aborted) return;
    send({ type: "done", text, audioMs: Math.round(audioBytes / 32), ...(reason ? { reason } : {}) });
    end("ok");
    options.close(1000);
  };
  const stop = (finishReason?: LiveDictationFinishReason) => {
    if (phase !== "live") return;
    phase = "finishing";
    billingEndsAt = clock.now();
    reason = finishReason;
    send({ type: "finishing" });
    audio.end();
    stopDeadline = schedule(5_000, done);
  };
  const tick = async () => {
    if (checking || phase === "ended") return;
    checking = true;
    try {
      const renewedAt = clock.now();
      if (!(await limits.renew(options.userId, token))) {
        fail("connection_lost", true);
        return;
      }
      if (controller.signal.aborted) return;
      leaseDeadline?.();
      leaseDeadline = schedule(Math.max(0, renewedAt + 15_000 - clock.now()), () => fail("connection_lost", true));
      if (clock.now() - lastAccessAt >= 30_000) {
        lastAccessAt = clock.now();
        const allowed = await options.revalidate();
        if (controller.signal.aborted) return;
        if (!allowed) {
          fail("no_access");
          return;
        }
      }
      if (phase === "live") {
        const balance = await charge();
        if (controller.signal.aborted) return;
        if (!balance) {
          fail("connection_lost", true);
          return;
        }
        if (balance.usedSeconds >= options.minutesPerDay * 60) stop("daily_limit");
      }
    } catch {
      fail("connection_lost", true);
    } finally {
      checking = false;
      if (!controller.signal.aborted) schedule(5_000, () => tick());
    }
  };
  const ready = () => {
    if (phase !== "connecting") return;
    connectDeadline?.();
    phase = "live";
    startedAt = clock.now();
    lastChargedAt = startedAt;
    send({ type: "ready", maxMs: LIVE_DICTATION_MAX_MS });
    silenceDeadline = schedule(120_000, () => stop("silence"));
    schedule(540_000, () => {
      if (phase === "live") send({ type: "warning", code: "time_left", ms: 60_000 });
    });
    schedule(LIVE_DICTATION_MAX_MS, () => stop("max_duration"));
  };
  const start = async () => {
    try {
      const reservation = await limits.reserve({
        userId: options.userId,
        token,
        now: clock.now(),
        concurrency: options.concurrency,
        minutesPerDay: options.minutesPerDay,
        timeZone: options.timeZone,
      });
      if (reservation.result !== "ok") {
        fail(reservation.result, true, reservation.result === "daily_limit" ? reservation.resetsAt : undefined);
        return;
      }
      reserved = true;
      if (controller.signal.aborted) {
        await limits.release(options.userId, token);
        reserved = false;
        return;
      }
      leaseDeadline = schedule(15_000, () => fail("connection_lost", true));
      schedule(5_000, () => tick());
      callId = await ledger.begin(options.profile, options.userId, app);
      if (controller.signal.aborted) {
        await finishAccounting("aborted");
        return;
      }
      const key = await liveDictationCredential(options.profile);
      if (controller.signal.aborted) return;
      const webSocket: RealtimeWebSocketFactory = (url, headers) => {
        const socket =
          options.webSocket?.(url, headers) ??
          new (WebSocket as typeof WebSocket & { new (url: string, options: { headers: Record<string, string> }): WebSocket })(url, {
            headers,
          });
        socket.addEventListener("message", (event) => {
          try {
            if (z.object({ type: z.literal("session.created") }).safeParse(JSON.parse(String(event.data))).success) ready();
          } catch {
            /* Nessi owns provider protocol validation. */
          }
        });
        return {
          addEventListener: socket.addEventListener.bind(socket),
          close: socket.close.bind(socket),
          send(data) {
            if (socket.bufferedAmount > LIVE_DICTATION_PROVIDER_BUFFER_BYTES) {
              fail("overloaded", true);
              throw new Error("overloaded");
            }
            socket.send(data);
            if (socket.bufferedAmount > LIVE_DICTATION_PROVIDER_BUFFER_BYTES) {
              fail("overloaded", true);
              throw new Error("overloaded");
            }
          },
        };
      };
      const provider: RealtimeTranscriptionProvider = createAiLiveTranscriptionProvider(options.profile, key ?? undefined, webSocket);
      connectDeadline = schedule(5_000, () => fail("provider_failed", true));
      for await (const event of provider.stream({ audio, signal: controller.signal })) {
        if (phase === "ended") break;
        if (event.type === "delta") {
          text += event.text;
          send({ type: "delta", text: event.text });
        } else {
          if (phase !== "finishing") stop();
          if (event.text.startsWith(text)) text = event.text;
          usage = event.usage;
          stopDeadline?.();
          done();
        }
      }
    } catch {
      if (!controller.signal.aborted) fail("provider_failed", true);
    }
  };
  const startDeadline = schedule(5_000, () => fail("connection_lost", true));
  return {
    receive(data: string | ArrayBuffer | ArrayBufferView) {
      if (controller.signal.aborted) return;
      if (typeof data === "string") {
        if (data.length > 256) {
          fail("connection_lost");
          return;
        }
        let value: unknown;
        try {
          value = JSON.parse(data);
        } catch {
          fail("connection_lost");
          return;
        }
        const parsed = startSchema.safeParse(value);
        if (phase === "waiting" && parsed.success) {
          startDeadline();
          phase = "connecting";
          app = parsed.data.app;
          startPromise = start();
          return;
        }
        if ((phase === "live" || phase === "finishing") && stopSchema.safeParse(value).success) {
          stop();
          return;
        }
        fail("connection_lost");
        return;
      }
      if (
        (phase !== "live" && phase !== "finishing") ||
        data.byteLength === 0 ||
        data.byteLength > LIVE_DICTATION_MAX_FRAME_BYTES ||
        data.byteLength % 2 !== 0
      ) {
        fail("connection_lost");
        return;
      }
      const now = clock.now();
      bucket = Math.min(64_000, bucket + (now - bucketAt) * 32);
      bucketAt = now;
      if (data.byteLength > bucket) {
        fail("connection_lost");
        return;
      }
      bucket -= data.byteLength;
      if (phase === "finishing") return;
      const frame = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
        : new Uint8Array(data).slice();
      if (!audio.push(frame)) {
        fail("overloaded", true);
        return;
      }
      audioBytes += frame.byteLength;
      const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
      let squares = 0;
      for (let offset = 0; offset < frame.byteLength; offset += 2) squares += (view.getInt16(offset, true) / 32768) ** 2;
      // -50 dBFS: ordinary microphone noise does not keep an unattended session alive.
      const silent = Math.sqrt(squares / (frame.byteLength / 2)) < 0.0031623;
      silenceSamples = silent ? silenceSamples + frame.byteLength / 2 : 0;
      if (!silent) {
        silenceDeadline?.();
        silenceDeadline = schedule(120_000, () => stop("silence"));
      }
      if (silenceSamples >= 120 * 16_000) stop("silence");
    },
    abort() {
      if (phase === "ended") return;
      end("aborted");
      options.close(1000);
    },
    settled: async () => {
      await startPromise;
      await cleanupPromise;
    },
    signal: controller.signal,
  };
};
