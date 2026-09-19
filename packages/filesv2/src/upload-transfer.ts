import { DirectSession, FilegateError } from "@k2b/filegate/utils";
import type { UploadSession } from "./contracts";

/** Filegate owns segment paging, verification and transport retries. Cloud alone renews authorization. */
export async function transferUpload(
  file: Blob,
  session: UploadSession,
  options: {
    signal: AbortSignal;
    renew: (id: string, signal: AbortSignal) => Promise<{ url: string }>;
    onProgress?: (bytes: number) => void;
    failure: string;
  },
): Promise<void> {
  options.signal.throwIfAborted();
  if (session.state === "committed") return;
  if (session.state !== "open" || !session.url) throw new Error(options.failure);
  let url = session.url;
  let renewals = 0;
  let progress = -1;
  for (;;) {
    options.signal.throwIfAborted();
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error(options.failure);
      const status = await new DirectSession(url).upload(file, {
        signal: options.signal,
        onProgress: (bytes) => {
          if (bytes > progress) {
            renewals = 0;
            progress = bytes;
          }
          options.onProgress?.(bytes);
        },
      });
      if (status.state === "committed") return;
      if (status.state !== "open" || status.received !== file.size) throw new Error(options.failure);
      return;
    } catch (error) {
      options.signal.throwIfAborted();
      // No second transport retry loop: SDK honors Retry-After, cancellation and replayability.
      if (!(error instanceof FilegateError && error.status === 401 && error.code === "expired_capability") || renewals >= 3)
        throw new Error(options.failure);
      renewals++;
      url = (await options.renew(session.id, AbortSignal.any([options.signal, AbortSignal.timeout(60_000)]))).url;
    }
  }
}
