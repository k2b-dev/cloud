/**
 * Core's fan-out to many applications for one browser request, shared by Universal Search and dashboard widgets:
 * bounded concurrency, one NDJSON line per application as soon as it finishes, and cancellation when the browser
 * stops reading.
 */

/** Media type a client sends in `Accept` and receives back for a stream of JSON lines. */
export const NDJSON_CONTENT_TYPE = "application/x-ndjson";

export const ndjsonStreamHeaders = {
  "content-type": `${NDJSON_CONTENT_TYPE}; charset=utf-8`,
  // Each line must reach the browser when it is written: no cache, no transformation, no proxy buffering.
  "cache-control": "no-store, no-transform",
  "x-accel-buffering": "no",
} as const;

const encoder = new TextEncoder();
export const ndjsonLine = (line: unknown) => `${JSON.stringify(line)}\n`;

/**
 * Starts `run` for every item with at most `concurrency` running at once, in item order. Each item's promise settles
 * on its own, so a caller can act on fast items while slow ones still run. Aborting `signal` settles every item that
 * has not finished as rejected and starts no further item.
 */
export const startBounded = <T, R>(
  items: readonly T[],
  concurrency: number,
  run: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
) => {
  const deferred = items.map(() => {
    let settled = false;
    let resolve!: (result: PromiseSettledResult<R>) => void;
    const promise = new Promise<PromiseSettledResult<R>>((done) => {
      resolve = (result) => {
        if (settled) return;
        settled = true;
        done(result);
      };
    });
    return { promise, resolve };
  });
  const abort = () => {
    const reason = signal?.reason ?? new Error("Fan-out deadline exceeded");
    for (const entry of deferred) entry.resolve({ status: "rejected", reason });
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let next = 0;
  void Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (true) {
        if (signal?.aborted) return;
        const index = next;
        next += 1;
        const item = items[index];
        if (item === undefined) return;
        try {
          deferred[index]?.resolve({
            status: "fulfilled",
            value: await run(item, index),
          });
        } catch (reason) {
          deferred[index]?.resolve({ status: "rejected", reason });
        }
      }
    }),
  ).then(() => signal?.removeEventListener("abort", abort));
  return deferred.map((entry) => entry.promise);
};

/** Waits for work that has already started, but no longer than `signal` allows. */
export const waitWithin = <T>(value: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    // The work has already started; observe its rejection even if the client
    // disconnected before we began waiting.
    value.then(
      (result) => {
        signal.removeEventListener("abort", aborted);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
    if (signal.aborted) return aborted();
    signal.addEventListener("abort", aborted, { once: true });
  });

/**
 * Answers with `first`, then one line per entry of `pending` in the order they finish, then `last(lines)`. A slow
 * entry never holds back the others. When the client stops reading, `onCancel` runs so the caller can stop its work.
 */
export const ndjsonStream = <Line>(options: {
  first: Line;
  pending: readonly Promise<Line>[];
  last: (lines: Line[]) => Line;
  onCancel: () => void;
}): Response => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (line: Line) => {
        if (!cancelled) controller.enqueue(encoder.encode(ndjsonLine(line)));
      };
      write(options.first);
      const lines: Line[] = [];
      void Promise.all(
        options.pending.map((pending) =>
          pending.then((line) => {
            lines.push(line);
            write(line);
          }),
        ),
      ).then(() => {
        write(options.last(lines));
        if (!cancelled) controller.close();
      });
    },
    cancel() {
      cancelled = true;
      options.onCancel();
    },
  });
  return new Response(body, { headers: ndjsonStreamHeaders });
};
