import { StoreFullError, type Worker } from "@k2b/sync";
import { getProcessApplicationPackage } from "../../_internal/process-identity";
import { lazySync } from "../../_internal/process-sync";
import { get } from "../settings";
import { hasPreviewReader, previewService, setPreviewSubmit } from "./index";
import { previewJobKey } from "./store";
import { PREVIEW_DEADLINE_MS, type PreviewSource } from "./types";

/** Each application owns its own queues and schedule: a job names a source only its own reader can open. */
const owned = (name: string) => {
  const packageName = getProcessApplicationPackage();
  if (!packageName) throw new Error("Start the application before using previews");
  return `cloud-previews-${packageName}-${name}`;
};
// 64 metadata messages per lane: a bounded burst, about three hours at the job deadline.
const queue = (priority: "high" | "low") =>
  lazySync((sync) =>
    sync.job<PreviewSource>({
      id: owned(priority),
      // 32 KiB also fits the worst-case JSON escaping of all bounded source fields.
      maxPayloadBytes: 32 * 1024,
      retention: { maxMessages: 64, maxBytes: 64 * 32 * 1024, maxAgeMs: 4 * 60 * 60_000 },
      deadLetterRetention: { maxBytes: 16 * 32 * 1024 },
      whenFull: "reject",
      delivery: { maxAttempts: 2, ackWaitMs: PREVIEW_DEADLINE_MS + 30_000 },
    }),
  );
const high = queue("high");
const low = queue("low");
const maintenance = lazySync((sync) => sync.scheduler({ id: owned("retention"), delivery: { maxAttempts: 2, ackWaitMs: 60_000 } }));

export async function startPreviewsRuntime(): Promise<() => Promise<void>> {
  if (!hasPreviewReader()) return async () => {};
  const service = previewService();
  const stopping = new AbortController();
  const workers: Worker[] = [];
  setPreviewSubmit(async (source, priority) => {
    if (stopping.signal.aborted) return;
    try {
      await (priority === "high" ? high : low)().submit({ key: previewJobKey(source), input: source, coalesce: true });
    } catch (error) {
      if (!(error instanceof StoreFullError)) throw error;
    }
  });
  try {
    for (const lane of [high, low])
      workers.push(
        await lane().process({ concurrency: 1 }, async (context) => {
          await service.work(context.input, AbortSignal.any([context.signal, stopping.signal]));
        }),
      );
    await maintenance().create({
      id: "budget",
      cron: "*/10 * * * *",
      timezone: "UTC",
      misfire: "latest",
      meta: { family: "previews", label: "Preview storage budget" },
      process: async ({ signal, heartbeat }) => {
        const bounded = AbortSignal.any([signal, stopping.signal, AbortSignal.timeout(30_000)]);
        const maxBytes = await get<number>("previews.max_bytes");
        await service.maintain(maxBytes, bounded);
        await heartbeat();
      },
    });
    workers.push(await maintenance().process({ concurrency: 1 }));
  } catch (error) {
    stopping.abort();
    for (const worker of workers) worker.stop();
    await service.stop();
    await Promise.all(workers.map((worker) => worker.drain({ timeoutMs: 30_000 })));
    throw error;
  }
  return async () => {
    stopping.abort();
    for (const worker of workers) worker.stop();
    await service.stop();
    await Promise.all(workers.map((worker) => worker.drain({ timeoutMs: 30_000 })));
  };
}
