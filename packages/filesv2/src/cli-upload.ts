import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type CloudCliContext, cliText } from "@k2b/cloud/cli";
import { DirectSession, FilegateError } from "@k2b/filegate/utils";
import type { EntryResult, UploadSession } from "./contracts";

// DirectSession calls its fetch as a method; keep the global binding and omit credentials.
const transfer = Object.assign((input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, credentials: "omit" }), {
  preconnect: fetch.preconnect,
}) as typeof fetch;
const RETRIES = 3;
const REQUEST_TIMEOUT_MS = 60_000;

const checkedUrl = (value: string) => {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid transfer URL");
  return value;
};

/** Cloud opens and commits the session; disk-backed file slices go straight to Filegate. */
export async function uploadFile(
  ctx: Pick<CloudCliContext, "options">,
  input: string,
  api: {
    open: (size: number, signal: AbortSignal) => Promise<UploadSession>;
    renew: (id: string, signal: AbortSignal) => Promise<{ url: string }>;
    commit: (id: string, signal: AbortSignal) => Promise<EntryResult>;
    abort: (id: string, signal: AbortSignal) => Promise<void>;
  },
) {
  const controller = new AbortController();
  const signal = controller.signal;
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  let session: UploadSession | undefined;
  let committing = false;
  try {
    await using handle = await open(resolve(input));
    signal.throwIfAborted();
    const info = await handle.stat();
    if (!info.isFile() || !Number.isSafeInteger(info.size))
      throw new Error(cliText(ctx, { en: "The input path is not a supported file.", de: "Der Eingabepfad ist keine unterstützte Datei." }));
    session = await api.open(info.size, AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]));
    signal.throwIfAborted();
    let url = checkedUrl(session.url);
    const request = async <T>(run: (direct: DirectSession, requestSignal: AbortSignal) => Promise<T>): Promise<T> => {
      let retries = 0;
      for (;;) {
        signal.throwIfAborted();
        try {
          return await run(new DirectSession(url, transfer), AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]));
        } catch (error) {
          signal.throwIfAborted();
          const expired = error instanceof FilegateError && (error.status === 401 || error.status === 403);
          const retryable = expired || !(error instanceof FilegateError) || error.status === 429 || error.status >= 500;
          if (!retryable || retries >= RETRIES)
            throw new Error(cliText(ctx, { en: "Filegate upload failed.", de: "Der Filegate-Upload ist fehlgeschlagen." }));
          retries++;
          await delay(200 * 2 ** (retries - 1), undefined, { signal });
          if (expired)
            url = checkedUrl((await api.renew(session!.id, AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]))).url);
        }
      }
    };
    const status = await request((direct, requestSignal) => direct.status(requestSignal));
    if (status.size !== info.size || !Number.isSafeInteger(status.chunkSize) || status.chunkSize < 1 || status.state !== "open")
      throw new Error(
        cliText(ctx, { en: "The upload session is no longer available.", de: "Die Upload-Sitzung ist nicht mehr verfügbar." }),
      );
    const file = Bun.file(handle.fd);
    for (let offset = 0, index = 0; offset < info.size; offset += status.chunkSize, index++) {
      signal.throwIfAborted();
      const chunk = file.slice(offset, Math.min(info.size, offset + status.chunkSize));
      const priorHash = status.segments[String(index)];
      if (priorHash) {
        const hash = createHash("sha256");
        for await (const bytes of chunk.stream()) {
          signal.throwIfAborted();
          hash.update(bytes);
        }
        if (`sha256:${hash.digest("hex")}` !== priorHash)
          throw new Error(
            cliText(ctx, { en: "The local file changed during upload.", de: "Die lokale Datei wurde während des Uploads verändert." }),
          );
      } else {
        await request((direct, requestSignal) => direct.put(index, chunk, requestSignal));
      }
    }
    const finalInfo = await handle.stat();
    if (finalInfo.size !== info.size || finalInfo.mtimeMs !== info.mtimeMs || finalInfo.ctimeMs !== info.ctimeMs)
      throw new Error(
        cliText(ctx, { en: "The local file changed during upload.", de: "Die lokale Datei wurde während des Uploads verändert." }),
      );
    signal.throwIfAborted();
    committing = true;
    // A lost commit response is ambiguous. Do not issue an abort after publishing may have succeeded.
    return await api.commit(session.id, AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]));
  } catch (error) {
    if (session && !committing) await api.abort(session.id, AbortSignal.timeout(5_000)).catch(() => {});
    if (signal.aborted) throw new Error(cliText(ctx, { en: "Upload cancelled.", de: "Upload abgebrochen." }));
    throw error;
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}
