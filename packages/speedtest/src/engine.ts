/** Browser-safe measurement contract shared by the website, CLI and served script. */
export const DEFAULT_SERVER = "https://speedtest.k2b.dev";
export const STREAMS = 4;
export const DOWNLOAD_BYTES = 25 * 1024 * 1024;
export const UPLOAD_BYTES = 16 * 1024 * 1024;
export const CHUNK_BYTES = 64 * 1024;
export const WINDOW_MS = 250;
export const PLANS = {
  quick: { ping: 2_000, download: 6_000, upload: 6_000, samples: 8, warmup: 1_500 },
  accurate: { ping: 3_000, download: 13_000, upload: 13_000, samples: 16, warmup: 2_000 },
} as const;
export type Mode = keyof typeof PLANS;
export type Phase = "ping" | "download" | "upload" | "verify";
export interface Transport {
  begin?(mode: Mode, signal: AbortSignal): Promise<void>;
  end?(): void;
  verify?(signal: AbortSignal): Promise<void>;
  ping(signal: AbortSignal): Promise<void>;
  download(bytes: number, count: (bytes: number) => void, signal: AbortSignal): Promise<void>;
  upload(bytes: number, count: (bytes: number) => void, signal: AbortSignal): Promise<void>;
}
export interface Clock {
  now(): number;
  schedule(callback: () => void, ms: number): () => void;
}
const systemClock: Clock = {
  now: () => performance.now(),
  schedule(callback, ms) {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};
export interface Progress {
  phase: Phase;
  remaining_ms: number;
  progress: number;
  mbps: number;
  bytes: number;
  elapsed_ms: number;
  phase_complete: boolean;
  ping_ms: number | null;
  jitter_ms: number | null;
  loaded_latency_ms: number | null;
}
export interface Result {
  server: string;
  mode: Mode;
  timestamp: string;
  duration_ms: number;
  ping_ms: number;
  jitter_ms: number;
  download_mbps: number;
  upload_mbps: number;
  loaded_latency_ms: number | null;
  download_bytes: number;
  upload_bytes: number;
  stable: { download: boolean; upload: boolean };
}
export class SpeedtestError extends Error {
  constructor(
    public readonly code: "network" | "http" | "slow_server" | "cancelled" | "invalid_server" | "capacity",
    message: string,
    public readonly status?: number,
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "SpeedtestError";
  }
}
export function normalizeServer(server: string): string {
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    throw new SpeedtestError("invalid_server", "Invalid speedtest server");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:")) || url.username || url.password || url.search || url.hash) {
    throw new SpeedtestError("invalid_server", "Use HTTPS, or HTTP on loopback, without credentials, query or fragment");
  }
  return url.href.replace(/\/+$/, "");
}
export const median = (samples: readonly number[]): number => {
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length === 0 ? 0 : sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
export const jitter = (samples: readonly number[]): number =>
  samples.length < 2
    ? 0
    : samples.slice(1).reduce((sum, value, index) => sum + Math.abs(value - samples[index]!), 0) / (samples.length - 1);
const round = (value: number): number => Math.round(value * 100) / 100;

/** One bounded window accumulator; counts only completed windows after warmup. */
export class Measurement {
  bytes = 0;
  measuredBytes = 0;
  measuredMs = 0;
  stable = false;
  mbps = 0;
  private previousBytes = 0;
  private previousMs = 0;
  private rates: number[] = [];
  private moving: number[] = [];
  constructor(private readonly warmup: number) {}
  count(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid byte count");
    this.bytes += bytes;
  }
  sample(elapsed: number): void {
    const duration = elapsed - this.previousMs;
    if (duration <= 0) return;
    const bytes = this.bytes - this.previousBytes;
    this.mbps = (bytes * 8) / duration / 1_000;
    if (this.previousMs >= this.warmup) {
      this.measuredBytes += bytes;
      this.measuredMs += duration;
      this.rates.push(this.mbps);
      if (this.rates.length > 4) this.rates.shift();
      if (this.rates.length === 4) {
        this.moving.push(this.rates.reduce((sum, value) => sum + value, 0) / 4);
        if (this.moving.length > 6) this.moving.shift();
        const mean = this.moving.reduce((sum, value) => sum + value, 0) / this.moving.length;
        this.stable =
          this.measuredMs >= 2_000 &&
          this.moving.length === 6 &&
          mean > 0 &&
          this.moving.every((value) => Math.abs(value - mean) <= mean * 0.05);
      }
    }
    this.previousBytes = this.bytes;
    this.previousMs = elapsed;
  }
  get result(): number {
    return this.measuredMs > 0 ? round((this.measuredBytes * 8) / this.measuredMs / 1_000) : 0;
  }
}

export async function runSpeedtest(options: {
  server: string;
  transport: Transport;
  mode?: Mode;
  signal?: AbortSignal;
  onProgress?: (progress: Progress) => void;
  clock?: Clock;
  timestamp?: string;
}): Promise<Result> {
  const server = normalizeServer(options.server);
  const mode = options.mode ?? "quick";
  const plan = PLANS[mode];
  const clock = options.clock ?? systemClock;
  const start = clock.now();
  const timestamp = options.timestamp ?? new Date().toISOString();
  const totalCap = plan.ping + plan.download + plan.upload;
  let remaining = totalCap;
  const loaded: number[] = [];
  const samples: number[] = [];
  const root = new AbortController();
  const cancel = () => root.abort(new SpeedtestError("cancelled", "Speedtest cancelled"));
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const finish = () => {
        signal.removeEventListener("abort", abort);
        resolve();
      };
      const stop = clock.schedule(finish, ms);
      const abort = () => {
        stop();
        signal.removeEventListener("abort", abort);
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
    });
  const publish = (phase: Phase, mbps: number, bytes: number, complete = false) => {
    options.onProgress?.({
      phase,
      remaining_ms: remaining,
      progress: 1 - remaining / totalCap,
      mbps,
      bytes,
      elapsed_ms: clock.now() - start,
      phase_complete: complete,
      ping_ms: samples.length >= 2 ? round(median(samples)) : null,
      jitter_ms: samples.length >= 2 ? round(jitter(samples)) : null,
      loaded_latency_ms: loaded.length ? round(median(loaded)) : null,
    });
  };
  const execute = async (phase: Exclude<Phase, "verify">, work: (signal: AbortSignal) => Promise<void>, measurement?: Measurement) => {
    root.signal.throwIfAborted();
    const local = new AbortController();
    const phaseStart = clock.now();
    const completed = new Error("Phase complete");
    let stopTick = () => {};
    const stop = () => local.abort(completed);
    const propagate = () => local.abort(root.signal.reason);
    root.signal.addEventListener("abort", propagate, { once: true });
    const phaseCap = Math.max(0, Math.min(plan[phase], totalCap - (clock.now() - start) - (options.transport.verify ? 250 : 0)));
    const stopDeadline = clock.schedule(stop, phaseCap);
    const emit = () => {
      if (local.signal.aborted) return;
      const elapsed = clock.now() - phaseStart;
      measurement?.sample(elapsed);
      remaining = Math.max(0, totalCap - (clock.now() - start));
      publish(phase, measurement?.mbps ?? 0, measurement?.bytes ?? 0);
      if (measurement?.stable) stop();
      else stopTick = clock.schedule(emit, WINDOW_MS);
    };
    const stopped = new Promise<void>((resolve, reject) => {
      local.signal.addEventListener("abort", () => (local.signal.reason === completed ? resolve() : reject(local.signal.reason)), {
        once: true,
      });
    });
    try {
      emit();
      await Promise.race([work(local.signal), stopped]);
    } finally {
      measurement?.sample(Math.min(phaseCap, Math.floor((clock.now() - phaseStart) / WINDOW_MS) * WINDOW_MS));
      stopDeadline();
      stopTick();
      root.signal.removeEventListener("abort", propagate);
      // Stop sibling streams before returning or propagating the first error.
      local.abort(completed);
    }
    remaining = Math.max(0, totalCap - (clock.now() - start));
    root.signal.throwIfAborted();
  };
  try {
    await execute("ping", async (signal) => {
      await options.transport.begin?.(mode, signal);
      await options.transport.ping(signal); // Discard connection warmup.
      for (let index = 0; index < plan.samples; index++) {
        signal.throwIfAborted();
        const before = clock.now();
        await options.transport.ping(signal);
        if (!signal.aborted) samples.push(clock.now() - before);
      }
    });
    if (samples.length < 2) throw new SpeedtestError("slow_server", "The speedtest server responds too slowly");
    publish("ping", 0, 0, true);
    const transfer = async (phase: "download" | "upload") => {
      const measurement = new Measurement(plan.warmup);
      await execute(
        phase,
        async (signal) => {
          const stream = async () => {
            while (!signal.aborted) {
              await options.transport[phase](
                phase === "download" ? DOWNLOAD_BYTES : UPLOAD_BYTES,
                (bytes) => {
                  if (!signal.aborted) measurement.count(bytes);
                },
                signal,
              );
            }
          };
          const latency = async () => {
            while (!signal.aborted) {
              await sleep(500, signal);
              const before = clock.now();
              await options.transport.ping(signal);
              if (!signal.aborted) loaded.push(clock.now() - before);
            }
          };
          await Promise.all([...Array.from({ length: STREAMS }, stream), latency()]);
        },
        measurement,
      );
      if (measurement.measuredBytes === 0) throw new SpeedtestError("slow_server", "No bytes measured after warmup");
      publish(phase, measurement.result, measurement.bytes, true);
      return measurement;
    };
    const download = await transfer("download");
    const upload = await transfer("upload");
    if (options.transport.verify) {
      const allowance = Math.max(0, totalCap - (clock.now() - start));
      if (allowance === 0) throw new SpeedtestError("slow_server", "Server verification timed out");
      const verification = new AbortController();
      const propagate = () => verification.abort(root.signal.reason);
      root.signal.addEventListener("abort", propagate, { once: true });
      if (root.signal.aborted) propagate();
      const stop = clock.schedule(() => verification.abort(new SpeedtestError("slow_server", "Server verification timed out")), allowance);
      let stopTick = () => {};
      const emit = () => {
        if (verification.signal.aborted) return;
        remaining = Math.max(0, totalCap - (clock.now() - start));
        publish("verify", 0, 0);
        stopTick = clock.schedule(emit, WINDOW_MS);
      };
      try {
        emit();
        await Promise.race([
          options.transport.verify(verification.signal),
          new Promise<never>((_, reject) => {
            if (verification.signal.aborted) reject(verification.signal.reason);
            else verification.signal.addEventListener("abort", () => reject(verification.signal.reason), { once: true });
          }),
        ]);
        root.signal.throwIfAborted();
        if (clock.now() - start > totalCap) throw new SpeedtestError("slow_server", "Server verification timed out");
      } finally {
        stop();
        stopTick();
        root.signal.removeEventListener("abort", propagate);
        verification.abort();
      }
    }
    return {
      server,
      mode,
      timestamp,
      duration_ms: Math.round(clock.now() - start),
      ping_ms: round(median(samples)),
      jitter_ms: round(jitter(samples)),
      download_mbps: download.result,
      upload_mbps: upload.result,
      loaded_latency_ms: loaded.length ? round(median(loaded)) : null,
      download_bytes: download.bytes,
      upload_bytes: upload.bytes,
      stable: { download: download.stable, upload: upload.stable },
    };
  } catch (error) {
    if (root.signal.aborted) throw root.signal.reason;
    if (error instanceof SpeedtestError) throw error;
    throw new SpeedtestError("network", error instanceof Error ? error.message : "Speedtest failed");
  } finally {
    root.abort();
    options.transport.end?.();
    options.signal?.removeEventListener("abort", cancel);
  }
}
