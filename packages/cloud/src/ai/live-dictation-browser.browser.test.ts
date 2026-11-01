import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { ServerWebSocket } from "bun";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser, pageErrors, settled } from "../../../ui/test/browser";
import type { DictationEvent, DictationSession, DictationSource } from "./live-dictation-browser";

declare global {
  interface Window {
    dictationSource: DictationSource;
    dictationTest: {
      controller: AbortController;
      session: DictationSession;
      events: DictationEvent[];
      tracks: MediaStreamTrack[];
      sockets: WebSocket[];
      consumed: Promise<void>;
      ended: boolean;
      stopResolved: boolean;
      receivedDone: boolean;
      doneBeforeStopResolved: boolean;
    };
  }
}

type Connection = {
  socket?: ServerWebSocket<Connection>;
  controls: unknown[];
  frames: { bytes: number; at: number; rms: number }[];
  started: boolean;
  stopped: boolean;
  closed: boolean;
};
const connections: Connection[] = [];
const violations: string[] = [];
let upgrades = 0;
let browser: Browser;
let server: ReturnType<typeof Bun.serve<Connection>>;

beforeAll(async () => {
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "live-dictation-browser.ts")],
    target: "browser",
    format: "esm",
  });
  if (!build.success) throw new AggregateError(build.logs, "Live dictation browser bundle failed");
  const source = await build.outputs[0]!.text();
  server = Bun.serve<Connection>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      const path = new URL(request.url).pathname;
      if (path === "/api/ai/dictation/live") {
        upgrades++;
        if (request.headers.get("origin") !== server.url.origin) violations.push("Socket must use the page's origin");
        if (server.upgrade(request, { data: { controls: [], frames: [], started: false, stopped: false, closed: false } })) return;
        return new Response("Upgrade required", { status: 426 });
      }
      if (path === "/source.js") return new Response(source, { headers: { "content-type": "text/javascript" } });
      if (path === "/frames") return Response.json(connections.at(-1)?.frames.length ?? 0);
      if (path !== "/") return new Response(null, { status: 404 });
      return new Response(
        `<!doctype html><html><body><script type="module">
          import { createLiveDictationSource } from '/source.js';
          window.dictationSource = createLiveDictationSource({ app: 'dictation-browser-test' });
        </script></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    },
    websocket: {
      open(socket) {
        socket.data.socket = socket;
        connections.push(socket.data);
      },
      message(socket, message) {
        const state = socket.data;
        if (typeof message !== "string") {
          if (!state.started || state.stopped) violations.push("Audio outside the started session");
          const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
          let squares = 0;
          for (let offset = 0; offset + 1 < view.byteLength; offset += 2) squares += (view.getInt16(offset, true) / 32768) ** 2;
          state.frames.push({ bytes: message.byteLength, at: performance.now(), rms: Math.sqrt(squares / (view.byteLength / 2)) });
          if (state.frames.length === 1) socket.send(JSON.stringify({ type: "delta", text: "Hello " }));
          if (state.frames.length === 2) socket.send(JSON.stringify({ type: "delta", text: "world" }));
          return;
        }
        const control = JSON.parse(message);
        state.controls.push(control);
        if (control.type === "start" && !state.started) {
          state.started = true;
          socket.send(JSON.stringify({ type: "ready", maxMs: 600_000 }));
        } else if (control.type === "stop" && state.started && !state.stopped) {
          state.stopped = true;
          // The test releases done after checking that stop() is still pending.
          socket.send(JSON.stringify({ type: "finishing" }));
        } else violations.push("Unexpected control message");
      },
      close(socket) {
        socket.data.closed = true;
      },
    },
  });
  // The headless shell rejects capture without fake UI, which bypasses permission denial.
  // Full Chromium supports native capture with permissions controlled per context.
  browser = await launchBrowser({
    ...(browserName === "chromium" ? { channel: "chromium", args: ["--use-fake-device-for-media-stream"] } : {}),
  });
});

afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    await server?.stop(true);
  }
});

const start = async (page: Page) => {
  await page.goto(server.url.href);
  await page.waitForFunction(() => Boolean(window.dictationSource));
  await settled(page);
  await page.evaluate(() => {
    const tracks: MediaStreamTrack[] = [];
    const sockets: WebSocket[] = [];
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await getUserMedia(constraints);
      tracks.push(...stream.getTracks());
      return stream;
    };
    // Observe native resources without replacing capture, audio processing, or transport.
    window.WebSocket = class extends WebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        sockets.push(this);
        this.addEventListener("message", (event) => {
          if (JSON.parse(String(event.data)).type === "done") window.dictationTest.receivedDone = true;
        });
      }
    };
    const controller = new AbortController();
    const session = window.dictationSource.start({ signal: controller.signal });
    const state: Window["dictationTest"] = {
      controller,
      session,
      events: [],
      tracks,
      sockets,
      consumed: Promise.resolve(),
      ended: false,
      stopResolved: false,
      receivedDone: false,
      doneBeforeStopResolved: false,
    };
    window.dictationTest = state;
    state.consumed = (async () => {
      for await (const event of session.events) state.events.push(event);
      state.ended = true;
    })();
  });
};

const waitForFrames = async (page: Page, count: number) => {
  await page.waitForFunction((count) => window.dictationTest.events.filter((event) => event.type === "level").length >= count, count);
  await page.waitForFunction(async (count) => (await (await fetch("/frames")).json()) >= count, count);
};

test.skipIf(browserName !== "chromium")("captures 16 kHz PCM16, streams deltas, and waits for finished on stop", async () => {
  const context = await browser.newContext({ permissions: ["microphone"] });
  try {
    const page = await context.newPage();
    const errors = pageErrors(page);
    const index = connections.length;
    await start(page);
    await waitForFrames(page, 16);
    const connection = connections[index]!;
    expect(connection.controls).toEqual([{ type: "start", app: "dictation-browser-test" }]);
    const frames = [...connection.frames];
    expect(frames.length).toBeGreaterThanOrEqual(16);
    expect(frames.every((frame) => frame.bytes === 3200)).toBe(true);
    const bytesPerSecond = ((frames.length - 1) * 3200 * 1000) / (frames.at(-1)!.at - frames[0]!.at);
    expect(bytesPerSecond).toBeGreaterThan(32_000 * 0.8);
    expect(bytesPerSecond).toBeLessThan(32_000 * 1.2);
    const events = await page.evaluate(() => window.dictationTest.events);
    expect(events.filter((event) => event.type === "state")).toEqual([
      { type: "state", state: "connecting" },
      { type: "state", state: "live", maxMs: 600_000, device: { id: expect.any(String), label: expect.any(String) } },
    ]);
    const device = await page.evaluate(() => {
      const track = window.dictationTest.tracks[0]!;
      return { id: track.getSettings().deviceId, label: track.label };
    });
    expect(device.id).toBeTruthy();
    expect(device.label).toBeTruthy();
    expect(events[1]).toMatchObject({ device });
    const levels = events.filter((event) => event.type === "level");
    expect(levels.every((event) => event.level >= 0 && event.level <= 1)).toBe(true);
    expect(levels.some((event) => event.level > 0)).toBe(true);
    // Matching RMS values also checks that the binary payload is little-endian PCM16.
    for (let index = 0; index < Math.min(frames.length, levels.length); index++)
      expect(Math.abs(frames[index]!.rms - levels[index]!.level)).toBeLessThan(1 / 32768);
    expect(events.filter((event) => event.type === "text")).toEqual([
      { type: "text", text: "Hello " },
      { type: "text", text: "world" },
    ]);

    await page.evaluate(() => {
      void window.dictationTest.session.stop().then(() => {
        window.dictationTest.doneBeforeStopResolved = window.dictationTest.receivedDone;
        window.dictationTest.stopResolved = true;
      });
    });
    await page.waitForFunction(() => window.dictationTest.events.some((event) => event.type === "state" && event.state === "finishing"));
    expect(connection.stopped).toBe(true);
    expect(await page.evaluate(() => window.dictationTest.stopResolved)).toBe(false);
    expect(await page.evaluate(() => window.dictationTest.tracks.every((track) => track.readyState === "ended"))).toBe(true);
    expect(connection.controls).toEqual([{ type: "start", app: "dictation-browser-test" }, { type: "stop" }]);
    connection.socket!.send(JSON.stringify({ type: "done", text: "Hello world!", audioMs: connection.frames.length * 100 }));
    connection.socket!.close(1000);
    await page.waitForFunction(() => window.dictationTest.ended && window.dictationTest.stopResolved);
    expect(await page.evaluate(() => window.dictationTest.doneBeforeStopResolved)).toBe(true);
    expect(await page.evaluate(() => window.dictationTest.events.filter((event) => event.type !== "level").slice(2))).toEqual([
      { type: "text", text: "Hello " },
      { type: "text", text: "world" },
      { type: "state", state: "finishing" },
      { type: "text", text: "!" },
      { type: "state", state: "finished" },
    ]);
    expect(violations).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test.skipIf(browserName !== "chromium")("abort stops the native track and closes the socket immediately", async () => {
  const context = await browser.newContext({ permissions: ["microphone"] });
  try {
    const page = await context.newPage();
    const errors = pageErrors(page);
    const index = connections.length;
    await start(page);
    await waitForFrames(page, 2);
    expect(await page.evaluate(() => window.dictationTest.tracks.map((track) => track.readyState))).toEqual(["live"]);
    const resourceState = await page.evaluate(() => {
      window.dictationTest.controller.abort();
      return {
        tracks: window.dictationTest.tracks.map((track) => track.readyState),
        sockets: window.dictationTest.sockets.map((socket) => socket.readyState),
      };
    });
    expect(resourceState).toEqual({ tracks: ["ended"], sockets: [WebSocket.CLOSING] });
    await page.waitForFunction(() => window.dictationTest.ended && window.dictationTest.sockets.every((socket) => socket.readyState === 3));
    expect(connections[index]!.closed).toBe(true);
    expect(connections[index]!.controls).toEqual([{ type: "start", app: "dictation-browser-test" }]);
    expect(
      await page.evaluate(() =>
        window.dictationTest.events.some((event) => event.type === "error" || (event.type === "state" && event.state === "finished")),
      ),
    ).toBe(false);
    expect(violations).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test("denied microphone permission emits a retryable error without opening a socket", async () => {
  // WebKit cannot grant microphone permission through Playwright; capture rejects there too.
  const context = await browser.newContext({ permissions: [] });
  try {
    const page = await context.newPage();
    const errors = pageErrors(page);
    if (browserName === "chromium") {
      const cdp = await context.newCDPSession(page);
      const { targetInfo } = await cdp.send("Target.getTargetInfo");
      await cdp.send("Browser.setPermission", {
        permission: { name: "microphone" },
        setting: "denied",
        origin: server.url.origin,
        browserContextId: targetInfo.browserContextId,
      });
      await cdp.detach();
    }
    const before = upgrades;
    await start(page);
    await page.waitForFunction(() => window.dictationTest.ended);
    expect(await page.evaluate(() => window.dictationTest.events)).toEqual([
      { type: "state", state: "connecting" },
      { type: "error", code: "microphone_blocked", retryable: true },
    ]);
    expect(
      await page.evaluate(() => ({ tracks: window.dictationTest.tracks.length, sockets: window.dictationTest.sockets.length })),
    ).toEqual({ tracks: 0, sockets: 0 });
    expect(upgrades).toBe(before);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
