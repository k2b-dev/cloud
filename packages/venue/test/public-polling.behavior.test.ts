import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import type { PublicStatus } from "../src/contracts";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
};

const flush = async () => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
};

const status = (name: string): PublicStatus => ({
  venue: {
    id: "VENU01",
    slug: "student-cafe",
    name,
    icon: "ti ti-building",
    description: null,
    timezone: "Europe/Berlin",
    openMode: "combined",
    signupMode: "both",
    publicEnabled: true,
    feedbackEnabled: false,
    accentColor: "#2563eb",
    logoBase64: null,
    bannerBase64: null,
    icalToken: "calendar-token",
    permission: "read",
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
  },
  open: false,
  spontaneousOpen: false,
  statusLabel: "Closed",
  todayLabel: "Closed today",
  nextOpeningLabel: null,
  activeWindowLabel: null,
  upcomingOpenings: [],
  openingRules: [],
  sections: [],
});

describe("Venue public polling behavior", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("keeps last-good data, retries, pauses while hidden, and aborts on dispose", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let visible = true;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => !visible });

    let nextTimer = 0;
    const timers = new Map<number, { callback: () => void; delay: number }>();
    globalThis.setTimeout = ((callback: TimerHandler, delay?: number) => {
      const id = ++nextTimer;
      timers.set(id, { callback: callback as () => void, delay: delay ?? 0 });
      return id;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id: number | undefined) => {
      if (id !== undefined) timers.delete(id);
    }) as typeof clearTimeout;

    const requests: Array<{ signal: AbortSignal; response: ReturnType<typeof deferred<Response>> }> = [];
    globalThis.fetch = (async (_input, init) => {
      const response = deferred<Response>();
      requests.push({ signal: init?.signal as AbortSignal, response });
      return response.promise;
    }) as typeof fetch;

    const runTimer = (delay: number) => {
      const entry = [...timers.entries()].find(([, timer]) => timer.delay === delay);
      if (!entry) throw new Error(`No ${delay}ms timer scheduled`);
      timers.delete(entry[0]);
      entry[1].callback();
    };
    const runNextTimer = () => {
      const entry = timers.entries().next().value as [number, { callback: () => void; delay: number }] | undefined;
      if (!entry) throw new Error("No timer scheduled");
      timers.delete(entry[0]);
      entry[1].callback();
    };

    const { default: PublicVenuePage } = await import("../src/frontend/public/[slug]/PublicVenuePage.island.tsx");
    const dispose = render(
      () =>
        createComponent(PublicVenuePage, {
          venueId: "VENU01",
          initialStatus: status("Last good"),
          displayHeight: "scroll",
          feedbackUrl: "https://cloud.example/feedback",
          refresh: true,
        }),
      dom.root,
    );

    runNextTimer();
    await flush();
    requests[0]!.response.reject(new Error("offline"));
    await flush();
    expect(dom.root.textContent).toContain("Last good");
    expect(dom.root.textContent).toContain("Live updates paused");

    dom.root.querySelector<HTMLButtonElement>("button")?.click();
    runTimer(0);
    await flush();
    requests[1]!.response.resolve(Response.json(status("Fresh")));
    await flush();
    expect(dom.root.textContent).toContain("Fresh");
    expect(dom.root.textContent).not.toContain("Live updates paused");

    runNextTimer();
    await flush();
    visible = false;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(requests[2]!.signal.aborted).toBeTrue();

    visible = true;
    document.dispatchEvent(new Event("visibilitychange"));
    runTimer(0);
    await flush();
    dispose();
    expect(requests[3]!.signal.aborted).toBeTrue();

    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    dom.cleanup();
  });
});
