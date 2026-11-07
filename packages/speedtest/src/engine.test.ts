import { describe, expect, test } from "bun:test";
import {
  type Clock,
  jitter,
  Measurement,
  median,
  normalizeServer,
  type Progress,
  runSpeedtest,
  SpeedtestError,
  type Transport,
} from "./engine";

class FakeClock implements Clock {
  time = 0;
  tasks = new Set<{ at: number; run: () => void }>();
  now = () => this.time;
  schedule = (run: () => void, ms: number) => {
    const task = { at: this.time + ms, run };
    this.tasks.add(task);
    return () => this.tasks.delete(task);
  };
  async advance(ms: number) {
    const end = this.time + ms;
    for (;;) {
      for (let turn = 0; turn < 15; turn++) await Promise.resolve();
      const next = [...this.tasks].filter((task) => task.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.time = next.at;
      this.tasks.delete(next);
      next.run();
    }
    this.time = end;
    for (let turn = 0; turn < 15; turn++) await Promise.resolve();
  }
}
function fixture(clock: FakeClock, options: { slowPing?: boolean; failDownload?: boolean; unstable?: boolean } = {}) {
  let active = 0;
  let maxActive = 0;
  let pings = 0;
  let downloadCalls = 0;
  let uploadCalls = 0;
  const timed = (signal: AbortSignal, action: (finish: () => void) => () => void) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      active++;
      maxActive = Math.max(maxActive, active);
      let stop = () => {};
      const cleanup = () => {
        active--;
        stop();
        signal.removeEventListener("abort", abort);
      };
      const abort = () => {
        cleanup();
        reject(signal.reason);
      };
      const done = () => {
        cleanup();
        resolve();
      };
      signal.addEventListener("abort", abort, { once: true });
      stop = action(done);
    });
  const transfer = (bytes: number, count: (bytes: number) => void, signal: AbortSignal) =>
    timed(signal, (done) => {
      let total = 0;
      let tick = 0;
      let stop = () => {};
      const emit = () => {
        const size = Math.min(bytes - total, options.unstable ? (tick++ % 3 === 0 ? 1_000 : 100_000) : 31_250);
        count(size);
        total += size;
        if (total >= bytes) done();
        else stop = clock.schedule(emit, 250);
      };
      stop = clock.schedule(emit, 250);
      return () => stop();
    });
  const transport: Transport = {
    ping: (signal) =>
      timed(signal, (done) => {
        pings++;
        return clock.schedule(done, options.slowPing && pings === 4 ? 10_000 : 10);
      }),
    download: (bytes, count, signal) => {
      downloadCalls++;
      if (options.failDownload && downloadCalls === 1) return Promise.reject(new SpeedtestError("http", "limited", 429, 30));
      return transfer(bytes, count, signal);
    },
    upload: (bytes, count, signal) => {
      uploadCalls++;
      return transfer(bytes, count, signal);
    },
  };
  return {
    transport,
    active: () => active,
    maxActive: () => maxActive,
    downloadCalls: () => downloadCalls,
    uploadCalls: () => uploadCalls,
  };
}
const server = "https://speedtest.example.com";
const timestamp = "2026-10-15T09:30:00.000Z";

describe("shared speedtest", () => {
  test("median and consecutive-difference jitter", () => {
    expect(median([30, 1, 10, 20])).toBe(15);
    expect(jitter([10, 14, 12])).toBe(3);
  });
  test("discards warmup and detects positive stable throughput", () => {
    const meter = new Measurement(1_500);
    for (let time = 250; time <= 4_000; time += 250) {
      meter.count(time <= 1_500 ? 99_000_000 : 125_000);
      meter.sample(time);
    }
    expect(meter.result).toBe(4);
    expect(meter.stable).toBe(true);
  });
  test("does not call zero throughput stable", () => {
    const meter = new Measurement(1_500);
    for (let time = 250; time <= 6_000; time += 250) meter.sample(time);
    expect(meter.stable).toBe(false);
  });
  for (const mode of ["quick", "accurate"] as const) {
    test(`${mode} enforces its deadline, five requests, monotonic remaining time and slow upload bytes`, async () => {
      const clock = new FakeClock();
      const fake = fixture(clock, { slowPing: true, unstable: true });
      const progress: Progress[] = [];
      const result = runSpeedtest({
        server,
        mode,
        transport: fake.transport,
        clock,
        timestamp,
        onProgress: (event) => progress.push(event),
      });
      await clock.advance(mode === "quick" ? 14_000 : 29_000);
      const data = await result;
      expect(data.duration_ms).toBe(mode === "quick" ? 14_000 : 29_000);
      expect(data.upload_mbps).toBeGreaterThan(0);
      expect(data.upload_bytes).toBeGreaterThan(0);
      expect(data.loaded_latency_ms).toBe(10);
      expect(fake.maxActive()).toBeLessThanOrEqual(5);
      expect(fake.active()).toBe(0);
      expect(clock.tasks.size).toBe(0);
      for (let index = 1; index < progress.length; index++) {
        expect(progress[index]!.remaining_ms).toBeLessThanOrEqual(progress[index - 1]!.remaining_ms);
        expect(progress[index]!.progress).toBeGreaterThanOrEqual(progress[index - 1]!.progress);
      }
      expect(progress.at(-1)!.remaining_ms).toBe(0);
    });
  }
  test("a slow server fails before transfer and cleans timers", async () => {
    const clock = new FakeClock();
    const transport = fixture(clock).transport;
    transport.ping = (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    const result = runSpeedtest({ server, transport, clock, timestamp });
    const failure = result.catch((error: unknown) => error);
    await clock.advance(2_000);
    expect(await failure).toMatchObject({ code: "slow_server" });
    expect(clock.tasks.size).toBe(0);
  });
  test("first HTTP failure aborts every sibling and preserves Retry-After", async () => {
    const clock = new FakeClock();
    const fake = fixture(clock, { failDownload: true });
    const result = runSpeedtest({ server, transport: fake.transport, clock, timestamp });
    const failure = result.catch((error: unknown) => error);
    await clock.advance(250);
    expect(await failure).toMatchObject({ status: 429, retryAfter: 30 });
    expect(fake.active()).toBe(0);
    expect(fake.uploadCalls()).toBe(0);
    expect(clock.tasks.size).toBe(0);
  });
  test("external cancellation aborts all requests without later progress", async () => {
    const clock = new FakeClock();
    const fake = fixture(clock);
    const controller = new AbortController();
    const progress: Progress[] = [];
    const result = runSpeedtest({
      server,
      transport: fake.transport,
      clock,
      timestamp,
      signal: controller.signal,
      onProgress: (event) => progress.push(event),
    });
    const failure = result.catch((error: unknown) => error);
    await clock.advance(1_000);
    controller.abort();
    expect(await failure).toMatchObject({ code: "cancelled" });
    const count = progress.length;
    await clock.advance(30_000);
    expect(progress.length).toBe(count);
    expect(fake.active()).toBe(0);
    expect(clock.tasks.size).toBe(0);
  });
  test("stable phases finish early", async () => {
    const clock = new FakeClock();
    const fake = fixture(clock);
    const result = runSpeedtest({ server, transport: fake.transport, clock, timestamp });
    await clock.advance(14_000);
    expect((await result).duration_ms).toBeLessThan(14_000);
    expect((await result).stable).toEqual({ download: true, upload: true });
  });
  test("admission belongs to the ping deadline and releases a session after failure", async () => {
    const clock = new FakeClock();
    const fake = fixture(clock);
    let ended = false;
    fake.transport.begin = () => new Promise(() => {});
    fake.transport.end = () => {
      ended = true;
    };
    const failure = runSpeedtest({ server, transport: fake.transport, clock, timestamp }).catch((error: unknown) => error);
    await clock.advance(2_000);
    expect(await failure).toMatchObject({ code: "slow_server" });
    expect(ended).toBe(true);
    expect(fake.downloadCalls()).toBe(0);
    expect(clock.tasks.size).toBe(0);
  });
  test("a capacity refusal at the last phase boundary never becomes a successful result", async () => {
    const clock = new FakeClock();
    const fake = fixture(clock, { slowPing: true, unstable: true });
    fake.transport.verify = async () => {
      throw new SpeedtestError("capacity", "budget", 503, 1);
    };
    const failure = runSpeedtest({ server, transport: fake.transport, clock, timestamp }).catch((error: unknown) => error);
    await clock.advance(14_000);
    expect(await failure).toMatchObject({ code: "capacity" });
    expect(clock.tasks.size).toBe(0);
  });
  test("server verification stays within the whole-test deadline", async () => {
    const clock = new FakeClock();
    const fake = fixture(clock, { slowPing: true, unstable: true });
    fake.transport.verify = () => new Promise(() => {});
    let finished = 0;
    const failure = runSpeedtest({ server, transport: fake.transport, clock, timestamp }).catch((error: unknown) => {
      finished = clock.now();
      return error;
    });
    await clock.advance(14_000);
    expect(await failure).toMatchObject({ code: "slow_server" });
    expect(finished).toBe(14_000);
    expect(clock.tasks.size).toBe(0);
  });
  test("server selection never silently falls back or carries credentials", () => {
    expect(normalizeServer("http://127.0.0.1:8080/")).toBe("http://127.0.0.1:8080");
    for (const url of ["invalid", "http://example.org", "https://user:pass@example.org", "https://example.org/?token=secret"])
      expect(() => normalizeServer(url)).toThrow(SpeedtestError);
  });
});
