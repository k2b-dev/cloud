import { logger } from "@k2b/cloud/services";
import type { Contact } from "../service/types";

const log = logger("contacts:export");

/** Pull one page at a time; a failed page must fail the download. */
export const exportBody = (
  pages: (signal: AbortSignal) => AsyncIterable<Contact[]>,
  serialize: (page: Contact[]) => string,
  config: { bookId: string; format: "vcf" | "csv"; signal: AbortSignal; header?: string },
  logError = log.error,
): ReadableStream<Uint8Array> => {
  const cancellation = new AbortController();
  const signal = AbortSignal.any([config.signal, cancellation.signal]);
  const iterator = pages(signal)[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  let header = config.header;
  let cancelled = false;

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          signal.throwIfAborted();
          if (header !== undefined) {
            controller.enqueue(encoder.encode(header));
            header = undefined;
            return;
          }
          const next = await iterator.next();
          signal.throwIfAborted();
          if (next.done) controller.close();
          else controller.enqueue(encoder.encode(serialize(next.value)));
        } catch (error) {
          if (!signal.aborted) {
            logError("Contacts export failed", {
              bookId: config.bookId,
              format: config.format,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          if (!cancelled) {
            controller.error(error);
            await iterator.return?.();
          }
        }
      },
      async cancel(reason) {
        cancelled = true;
        cancellation.abort(reason);
        await iterator.return?.();
      },
    },
    { highWaterMark: 0 },
  );
};
