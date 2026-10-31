import { describe, expect, spyOn, test } from "bun:test";
import { createLiveDictationSource, mapLiveDictationMessage } from "./live-dictation-browser";
import { createDictationPcmEncoder, liveDictationWorklet } from "./live-dictation-pcm";

describe("live dictation PCM", () => {
  for (const rate of [8000, 16000, 44100, 48000]) {
    test(`emits exact 100 ms little-endian frames from ${rate} Hz across input blocks`, () => {
      const frames: ArrayBuffer[] = [];
      const levels: number[] = [];
      const encode = createDictationPcmEncoder(rate, (frame, level) => {
        frames.push(frame);
        levels.push(level);
      });
      const samples = new Float32Array(rate).fill(-0.5);
      for (let offset = 0; offset < samples.length; offset += 128) encode(samples.subarray(offset, offset + 128));
      // Upsampling needs the next input sample to interpolate the final point.
      encode(new Float32Array([-0.5]));
      expect(frames).toHaveLength(10);
      for (const frame of frames) {
        expect(frame.byteLength).toBe(3200);
        const view = new DataView(frame);
        for (let offset = 0; offset < frame.byteLength; offset += 2) expect(view.getInt16(offset, true)).toBe(-16384);
      }
      expect(levels.every((level) => Math.abs(level - 0.5) < 0.00001)).toBe(true);
    });
  }
  test("linear interpolation remains continuous between chunks and clips PCM", () => {
    const frames: ArrayBuffer[] = [];
    const encode = createDictationPcmEncoder(32000, (frame) => frames.push(frame));
    encode(new Float32Array([0, 0.25, 0.5]));
    encode(new Float32Array(3197).fill(2));
    expect(frames).toHaveLength(1);
    const view = new DataView(frames[0]!);
    expect(view.getInt16(0, true)).toBe(0);
    expect(view.getInt16(2, true)).toBe(16384);
    expect(view.getInt16(4, true)).toBe(32767);
  });
  test("regular stop flushes the final partial PCM frame exactly once", () => {
    const frames: ArrayBuffer[] = [];
    const encode = createDictationPcmEncoder(16000, (frame) => frames.push(frame));
    encode(new Float32Array(800).fill(0.25));
    expect(frames).toHaveLength(0);
    encode.flush();
    encode.flush();
    expect(frames).toHaveLength(1);
    expect(frames[0]?.byteLength).toBe(1600);
    expect(new DataView(frames[0]!).getInt16(1598, true)).toBe(8192);
  });
  test("worklet contains the encoder and transfers frames without WAV headers", () => {
    const posted: { frame: ArrayBuffer; level: number }[] = [];
    let process: ((inputs: Float32Array[][]) => boolean) | undefined;
    class Processor {
      port = { postMessage: (value: { frame: ArrayBuffer; level: number }) => posted.push(value) };
    }
    new Function("AudioWorkletProcessor", "sampleRate", "registerProcessor", liveDictationWorklet())(
      Processor,
      16000,
      (_name: string, Constructor: new () => { process(inputs: Float32Array[][]): boolean }) => {
        process = new Constructor().process.bind(new Constructor());
      },
    );
    expect(process?.([[new Float32Array(1600)]])).toBe(true);
    expect(posted[0]?.frame.byteLength).toBe(3200);
    expect(posted[0]?.level).toBe(0);
  });
});

describe("browser protocol", () => {
  test("ready exposes the actual microphone; final suffix precedes finished", () => {
    const device = { id: "actual", label: "USB microphone" };
    expect(mapLiveDictationMessage({ type: "ready", maxMs: 600000 }, "", device).events).toEqual([
      { type: "state", state: "live", maxMs: 600000, device },
    ]);
    const delta = mapLiveDictationMessage({ type: "delta", text: "Hello" }, "");
    expect(delta.text).toBe("Hello");
    expect(mapLiveDictationMessage({ type: "done", text: "Hello world", audioMs: 100, reason: "silence" }, delta.text)).toEqual({
      text: "Hello world",
      ended: true,
      events: [
        { type: "text", text: " world" },
        { type: "state", state: "finished", reason: "silence" },
      ],
    });
    expect(() => mapLiveDictationMessage({ type: "done", text: "Revised" }, delta.text)).toThrow();
  });
  test("server errors preserve retry and reset metadata", () => {
    const event = { type: "error", code: "daily_limit", retryable: true, resetsAt: "2026-11-02T00:00:00Z" } as const;
    expect(mapLiveDictationMessage(event, "kept")).toEqual({ text: "kept", ended: true, events: [event] });
    expect(mapLiveDictationMessage({ type: "finishing" }, "kept").events).toEqual([{ type: "state", state: "finishing" }]);
    expect(mapLiveDictationMessage({ type: "warning", code: "time_left", ms: 1000 }, "kept").events).toEqual([]);
  });
  test("an already-aborted start ends silently without touching the microphone", async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() });
    try {
      const source = createLiveDictationSource({ app: "test" });
      const session = source.start({ signal: AbortSignal.abort() });
      expect(await Array.fromAsync(session.events)).toEqual([]);
      await session.stop();
    } finally {
      if (previous) Object.defineProperty(globalThis, "window", previous);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
});

describe("browser source lifecycle without a microphone", () => {
  const fixture = (failure?: string, vanished = false) => {
    const saved = new Map(
      ["window", "navigator", "WebSocket", "AudioContext", "AudioWorkletNode"].map((name) => [
        name,
        Object.getOwnPropertyDescriptor(globalThis, name),
      ]),
    );
    const page = Object.assign(new EventTarget(), { location: { href: "https://cloud.example/notes" } });
    let stopped = 0;
    let contextsClosed = 0;
    let requested = 0;
    let constraints: MediaStreamConstraints | undefined;
    const track = Object.assign(new EventTarget(), {
      label: "Actual microphone",
      getSettings: () => ({ deviceId: "actual" }),
      stop: () => {
        stopped++;
      },
    });
    class Socket {
      static OPEN = 1;
      static current: Socket;
      readyState = 0;
      bufferedAmount = 0;
      sent: unknown[] = [];
      binaryType = "";
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onclose?: () => void;
      onerror?: () => void;
      constructor(readonly url: URL) {
        Socket.current = this;
        queueMicrotask(() => {
          this.readyState = 1;
          this.onopen?.();
        });
      }
      send(value: unknown) {
        this.sent.push(value);
      }
      close() {
        this.readyState = 3;
      }
      message(value: unknown) {
        this.onmessage?.({ data: JSON.stringify(value) });
      }
    }
    class Context {
      audioWorklet = { addModule: async () => {} };
      destination = {};
      createMediaStreamSource() {
        return { connect() {} };
      }
      createGain() {
        return { gain: { value: 1 }, connect() {} };
      }
      resume = async () => {};
      close = async () => {
        contextsClosed++;
      };
    }
    class Worklet {
      port: { close(): void; postMessage(value: unknown): void; onmessage?: (event: { data: { done: boolean } }) => void } = {
        close() {},
        postMessage: () => {
          this.port.onmessage?.({ data: { done: true } });
        },
      };
      connect() {}
      disconnect() {}
    }
    const media = {
      async enumerateDevices() {
        return [{ kind: "audioinput", deviceId: "selected", label: "Selected microphone" }];
      },
      async getUserMedia(value: MediaStreamConstraints) {
        requested++;
        constraints = value;
        if (failure) throw new DOMException("Fixture", failure);
        if (vanished && requested === 1) throw new DOMException("Gone", "OverconstrainedError");
        return { getTracks: () => [track], getAudioTracks: () => [track] };
      },
    };
    for (const [name, value] of Object.entries({
      window: page,
      navigator: { mediaDevices: media },
      WebSocket: Socket,
      AudioContext: Context,
      AudioWorkletNode: Worklet,
    }))
      Object.defineProperty(globalThis, name, { configurable: true, value });
    return {
      Socket,
      page,
      track,
      stopped: () => stopped,
      contextsClosed: () => contextsClosed,
      requested: () => requested,
      constraints: () => constraints,
      restore() {
        for (const [name, previous] of saved) {
          if (previous) Object.defineProperty(globalThis, name, previous);
          else Reflect.deleteProperty(globalThis, name);
        }
      },
    };
  };
  const opened = async (hasSocket: () => boolean) => {
    for (let tries = 0; tries < 20; tries++) {
      if (hasSocket()) return;
      await Bun.sleep(1);
    }
    throw new Error("Fixture socket did not open");
  };

  test("normal stop keeps final words, uses the actual device and closes every resource", async () => {
    const f = fixture(undefined, true);
    const controller = new AbortController();
    try {
      const source = createLiveDictationSource({ app: "notebooks" });
      expect(await source.devices()).toEqual([{ id: "selected", label: "Selected microphone" }]);
      const session = source.start({ deviceId: "selected", signal: controller.signal });
      const events = Array.fromAsync(session.events);
      await opened(() => !!f.Socket.current);
      expect(f.requested()).toBe(2);
      expect(f.constraints()).toEqual({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      expect(f.Socket.current.sent).toEqual(['{"type":"start","app":"notebooks"}']);
      f.Socket.current.message({ type: "ready", maxMs: 600000 });
      f.Socket.current.message({ type: "delta", text: "hello" });
      let resolved = false;
      const stop = session.stop().then(() => {
        resolved = true;
      });
      await Promise.resolve();
      expect(resolved).toBe(false);
      expect(f.Socket.current.sent.at(-1)).toBe('{"type":"stop"}');
      expect(f.stopped()).toBe(1);
      f.Socket.current.message({ type: "finishing" });
      f.Socket.current.message({ type: "done", text: "hello world", audioMs: 100 });
      await stop;
      expect(await events).toEqual([
        { type: "state", state: "connecting" },
        { type: "state", state: "live", maxMs: 600000, device: { id: "actual", label: "Actual microphone" } },
        { type: "text", text: "hello" },
        { type: "state", state: "finishing" },
        { type: "text", text: " world" },
        { type: "state", state: "finished" },
      ]);
      expect(f.contextsClosed()).toBe(1);
      expect(f.Socket.current.readyState).toBe(3);
    } finally {
      controller.abort();
      f.restore();
    }
  });
  test("a stalled server-initiated finish stops the microphone and ends with a recoverable error", async () => {
    const f = fixture();
    const controller = new AbortController();
    const scheduled = spyOn(globalThis, "setTimeout");
    try {
      const session = createLiveDictationSource({ app: "notebooks" }).start({ signal: controller.signal });
      const events = Array.fromAsync(session.events);
      await opened(() => !!f.Socket.current);
      f.Socket.current.message({ type: "ready", maxMs: 600000 });
      f.Socket.current.message({ type: "finishing" });
      expect(f.stopped()).toBe(1);
      const deadline = scheduled.mock.calls.findLast((call) => call[1] === 6000)?.[0];
      expect(typeof deadline).toBe("function");
      if (typeof deadline === "function") deadline();
      expect((await events).at(-1)).toEqual({ type: "error", code: "connection_lost", retryable: true });
      await session.stop();
      expect(f.Socket.current.readyState).toBe(3);
    } finally {
      controller.abort();
      scheduled.mockRestore();
      f.restore();
    }
  });
  for (const name of ["NotAllowedError", "SecurityError", "NotFoundError", "NotReadableError", "OverconstrainedError"]) {
    test(`maps microphone ${name} to a recoverable terminal state`, async () => {
      const f = fixture(name);
      try {
        const session = createLiveDictationSource({ app: "mail" }).start({ signal: new AbortController().signal });
        const events = await Array.fromAsync(session.events);
        expect(events.at(-1)).toEqual({
          type: "error",
          code: ["NotAllowedError", "SecurityError"].includes(name) ? "microphone_blocked" : "microphone_unavailable",
          retryable: true,
        });
        await session.stop();
      } finally {
        f.restore();
      }
    });
  }
  for (const exit of ["abort", "pagehide", "connection_lost"] as const) {
    test(`${exit} closes microphone and socket without reconnecting`, async () => {
      const f = fixture();
      const controller = new AbortController();
      try {
        const session = createLiveDictationSource({ app: "chat" }).start({ signal: controller.signal });
        const events = Array.fromAsync(session.events);
        await opened(() => !!f.Socket.current);
        f.Socket.current.message({ type: "ready", maxMs: 600000 });
        if (exit === "abort") controller.abort();
        else if (exit === "pagehide") f.page.dispatchEvent(new Event("pagehide"));
        else f.Socket.current.onclose?.();
        const received = await events;
        await session.stop();
        expect(f.stopped()).toBe(1);
        expect(f.contextsClosed()).toBe(1);
        expect(f.requested()).toBe(1);
        expect(received.at(-1)?.type === "error").toBe(exit === "connection_lost");
        if (exit === "connection_lost") expect(received.at(-1)).toEqual({ type: "error", code: "connection_lost", retryable: true });
      } finally {
        controller.abort();
        f.restore();
      }
    });
  }
});
