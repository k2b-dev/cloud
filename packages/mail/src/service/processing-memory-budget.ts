import { logger } from "@k2b/cloud/services";

// Estimated working set for background MIME parsing, sanitizing and attachment extraction,
// beside the ~250–450 MiB process baseline and API traffic. #1549 measured +650 MiB
// with four hydration workers and extraction; count limits alone did not bound memory.
export const MAIL_PROCESSING_MEMORY_BUDGET_BYTES = 256 * 1024 * 1024;

export const estimateHydrationWorkingSet = ({ sourceBytes, htmlBytes }: { sourceBytes: number; htmlBytes: number }): number =>
  // 30 MiB source with little HTML: ~4.3–6.2x source after the blob-copy fixes.
  // HTML sanitizing alone: ~30–38x HTML bytes (4 MiB added 120–150 MiB RSS).
  Math.ceil(6 * sourceBytes + 40 * htmlBytes);

export const estimateExtractionWorkingSet = (inputBytes: number): number =>
  // 18 MiB CSV: +355 MiB RSS (~19.7x); anydoc builds Markdown before truncating.
  Math.ceil(20 * inputBytes);

type Waiter = {
  weightBytes: number;
  start: () => void;
};
const queue: Waiter[] = [];
let inFlightBytes = 0;
let inFlightCount = 0;
let highWaterBytes = 0;
let largestAloneBytes = 0;

export const processingMemoryState = () => ({
  inFlightBytes,
  inFlightCount,
  waiting: queue.length,
  highWaterBytes,
  largestAloneBytes,
});

export const resetProcessingMemoryHighWater = (): void => {
  highWaterBytes = inFlightBytes;
  largestAloneBytes = inFlightCount === 1 ? inFlightBytes : 0;
};

const drain = (): void => {
  while (queue.length > 0) {
    const first = queue[0]!;
    if (inFlightCount > 0 && inFlightBytes + first.weightBytes > MAIL_PROCESSING_MEMORY_BUDGET_BYTES) return;
    queue.shift();
    inFlightBytes += first.weightBytes;
    inFlightCount += 1;
    highWaterBytes = Math.max(highWaterBytes, inFlightBytes);
    if (inFlightCount === 1) largestAloneBytes = Math.max(largestAloneBytes, first.weightBytes);
    first.start();
  }
};

export const withProcessingMemory = async <T>(
  params: { weightBytes: number; label: string; signal?: AbortSignal },
  work: () => Promise<T>,
): Promise<T> => {
  if (!Number.isFinite(params.weightBytes) || params.weightBytes <= 0) {
    throw new RangeError("Processing memory weight must be a positive finite byte count");
  }
  const weightBytes = Math.ceil(params.weightBytes);
  const { signal } = params;
  const cancelled = () => signal?.reason ?? Object.assign(new Error("Mail processing was cancelled"), { code: "PROCESSING_CANCELLED" });
  if (signal?.aborted) throw cancelled();
  const queuedAt = performance.now();
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      const index = queue.indexOf(waiter);
      if (index < 0) return;
      queue.splice(index, 1);
      signal?.removeEventListener("abort", abort);
      reject(cancelled());
      drain();
    };
    const waiter: Waiter = {
      weightBytes,
      start: () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      },
    };
    queue.push(waiter);
    signal?.addEventListener("abort", abort, { once: true });
    drain();
  });
  try {
    const waitedMs = performance.now() - queuedAt;
    if (waitedMs > 1000 || weightBytes > MAIL_PROCESSING_MEMORY_BUDGET_BYTES) {
      logger("mail:processing-memory").info("Mail processing memory reservation", { label: params.label, weightBytes, waitedMs });
    }
    signal?.throwIfAborted();
    return await work();
  } finally {
    inFlightBytes -= weightBytes;
    inFlightCount -= 1;
    drain();
  }
};
