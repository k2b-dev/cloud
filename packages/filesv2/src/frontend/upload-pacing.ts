import { MIN_UPLOAD_BYTES_PER_SECOND } from "../upload-transfer";

// Filegate receipts are fixed-size parts. Pace the bytes inside a PUT, retaining
// the original Blob so Filegate can replay retries and verify resumed parts.
const HEADROOM = 0.85;
const MIN_SAMPLE_MS = 1000;
const nonstreamingOrigins = new Set<string>();
const hidden = () => typeof document !== "undefined" && document.hidden;

function supportsRequestStreams() {
  let duplexRead = false;
  const request = new Request(
    "https://localhost/",
    Object.defineProperty({ method: "PUT", body: new ReadableStream({ start: (controller) => controller.close() }) }, "duplex", {
      get() {
        duplexRead = true;
        return "half";
      },
    }),
  );
  return duplexRead && !request.headers.has("Content-Type");
}

function wait(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** One transfer's capacity estimate. CLI requests retain their existing transport. */
export function createPacedUploadRequest(): typeof fetch {
  let streaming = false;
  try {
    streaming = supportsRequestStreams();
  } catch {
    // Browsers without streaming request bodies keep the replayable Blob path.
  }
  let capacity: number | undefined;
  let previousTail: number | undefined;
  return Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const blob = init?.method === "PUT" && init.body instanceof Blob ? init.body : undefined;
      if (!streaming || !blob) return fetch(input, init);
      const origin = new URL(
        input instanceof Request ? input.url : String(input),
        typeof location === "undefined" ? undefined : location.href,
      ).origin;
      if (nonstreamingOrigins.has(origin)) return fetch(input, init);
      const started = performance.now();
      const calibrating = capacity === undefined;
      const target =
        capacity === undefined || hidden() || capacity * HEADROOM < MIN_UPLOAD_BYTES_PER_SECOND ? undefined : capacity * HEADROOM;
      const cancelled = new AbortController();
      const signal = AbortSignal.any(init?.signal ? [init.signal, cancelled.signal] : [cancelled.signal]);
      let body: Blob | ReadableStream<Uint8Array> = blob;
      let lastOffered = started;
      let pacing = target !== undefined;
      if (target !== undefined) {
        // About 20 ms of traffic, bounded in memory and small enough for slow links.
        const burst = Math.min(1024 * 1024, Math.max(8192, Math.floor(target / 50)));
        let tokens = 0;
        let refilled = started;
        let offset = 0;
        body = new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              signal.throwIfAborted();
              if (offset === blob.size) return controller.close();
              const size = Math.min(burst, blob.size - offset);
              if (hidden()) pacing = false;
              while (pacing && tokens < size) {
                const now = performance.now();
                tokens = Math.min(burst, tokens + ((now - refilled) * target) / 1000);
                refilled = now;
                if (tokens < size) {
                  const delay = Math.ceil(((size - tokens) / target) * 1000);
                  const began = performance.now();
                  await wait(delay, signal);
                  // Background timer batching must never turn a paced upload
                  // into a stalled one. Finish this request without pacing.
                  if (hidden() || performance.now() - began > delay + 200) pacing = false;
                }
              }
              if (pacing) tokens -= size;
              const bytes = await blob.slice(offset, offset + size).arrayBuffer();
              signal.throwIfAborted();
              offset += size;
              lastOffered = performance.now();
              controller.enqueue(new Uint8Array(bytes));
            },
            cancel: (reason) => cancelled.abort(reason),
          },
          { highWaterMark: 0 },
        );
      }
      try {
        const response = await fetch(input, {
          ...init,
          body,
          ...(target === undefined ? {} : { duplex: "half" }),
        });
        const elapsed = performance.now() - started;
        if (response.ok && elapsed >= MIN_SAMPLE_MS) {
          const observed = blob.size / (elapsed / 1000);
          if (calibrating) capacity = observed;
          else if (pacing && capacity !== undefined) {
            // Constant fsync/lock latency is not growing network congestion.
            // Compare paced PUT tails, never repeatedly multiply paced speed.
            const tail = performance.now() - lastOffered;
            if (previousTail !== undefined && tail > previousTail + 200)
              capacity = Math.max(MIN_UPLOAD_BYTES_PER_SECOND / HEADROOM, Math.min(capacity, observed));
            previousTail = tail;
          }
        }
        return response;
      } catch (error) {
        // Chromium rejects streaming over HTTP/1.1, even when feature detection
        // passed. Let the SDK's existing bounded retry replay the original Blob.
        if (target !== undefined && error instanceof TypeError && !init?.signal?.aborted) {
          streaming = false;
          nonstreamingOrigins.add(origin);
        }
        throw error;
      } finally {
        cancelled.abort();
      }
    },
    { preconnect: fetch.preconnect },
  );
}
