import { createWriteStream } from "node:fs";
import { link, lstat, mkdtemp, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { type CloudCliContext, cliText } from "@k2b/cloud/cli";
import type { ArchiveDownload, DownloadLease } from "./contracts";

class TransferLimitError extends Error {}
class LeaseRequestError extends Error {
  constructor(cause: unknown) {
    super("lease request failed", { cause });
  }
}

type RequestLease = (signal: AbortSignal) => Promise<DownloadLease | ArchiveDownload>;

/**
 * Only the lease request uses Cloud authentication; file bytes come straight
 * from Filegate. `consume` receives the body and returns the byte count it
 * stored. Every failure is reported without the lease, which is a bearer URL.
 */
async function transfer(
  ctx: Pick<CloudCliContext, "options">,
  requestLease: RequestLease,
  consume: (body: ReadableStream<Uint8Array>, signal: AbortSignal) => Promise<number>,
): Promise<number> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      controller.signal.throwIfAborted();
      const requestSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);
      // Cloud API errors carry no lease and explain themselves; only a cancelled request is reported as a failed download.
      const lease = await requestLease(requestSignal).catch((error: unknown) => {
        throw controller.signal.aborted ? error : new LeaseRequestError(error);
      });
      const url = new URL(lease.url);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        (lease.method !== "GET" && lease.method !== "POST")
      )
        throw new Error();
      const headersController = new AbortController();
      const headersTimeout = setTimeout(() => headersController.abort(), 60_000);
      try {
        // Archive leases are POSTed with their signed manifest; single files are plain GETs.
        response = await fetch(url, {
          method: lease.method,
          body: lease.method === "POST" ? new URLSearchParams({ manifest: lease.manifest }) : undefined,
          credentials: "omit",
          redirect: "error",
          headers: { "Accept-Encoding": "identity" },
          signal: AbortSignal.any([controller.signal, headersController.signal]),
        });
      } finally {
        clearTimeout(headersTimeout);
      }
      if ([401, 403, 429, 502, 503, 504].includes(response.status) && attempt < 2) {
        await response.body?.cancel();
        continue;
      }
      break;
    }
    if (!response || response.status !== 200 || !response.body) {
      await response?.body?.cancel();
      throw new Error();
    }
    const bytes = await consume(response.body, controller.signal);
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) !== bytes)) throw new Error();
    controller.signal.throwIfAborted();
    return bytes;
  } catch (error) {
    if (error instanceof TransferLimitError) throw error;
    if (error instanceof LeaseRequestError) throw error.cause;
    // Fetch errors, redirect targets and response bodies may contain the bearer lease.
    throw new Error(
      cliText(ctx, {
        en: "Filegate download failed or was interrupted. No output file was saved; request a new download to retry.",
        de: "Der Filegate-Download ist fehlgeschlagen oder wurde abgebrochen. Es wurde keine Zieldatei gespeichert; starte den Download erneut.",
      }),
    );
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}

/** Streams a leased download into a new local file; existing paths and symlinks are never overwritten. */
export async function downloadFile(ctx: Pick<CloudCliContext, "options">, output: string, requestLease: RequestLease) {
  const path = resolve(output);
  const exists = () => new Error(cliText(ctx, { en: "The output path already exists.", de: "Der Zielpfad existiert bereits." }));
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (existing) throw exists();
  const temporary = await mkdtemp(join(dirname(path), ".filesv2-download-"));
  const part = join(temporary, "content");
  try {
    const bytes = await transfer(ctx, requestLease, async (body, signal) => {
      await pipeline(body, createWriteStream(part, { flags: "wx", mode: 0o600 }), { signal });
      return (await stat(part)).size;
    });
    // Unlike rename(), link() cannot overwrite a target created during the transfer.
    await link(part, path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") throw exists();
      throw error;
    });
    return { path, bytes };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Reads a leased download into memory and refuses, before returning anything, content above `limit` bytes. */
export async function readFile(ctx: Pick<CloudCliContext, "options">, limit: number, requestLease: RequestLease) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    await transfer(ctx, requestLease, async (body, signal) => {
      await pipeline(
        body,
        new Writable({
          write(chunk: Uint8Array, _encoding, done) {
            size += chunk.byteLength;
            if (size > limit) return done(new TransferLimitError());
            chunks.push(chunk);
            done();
          },
        }),
        { signal },
      );
      return size;
    });
  } catch (error) {
    if (!(error instanceof TransferLimitError)) throw error;
    throw new Error(
      cliText(ctx, {
        en: `The file is larger than ${limit / 1024 / 1024} MiB. Save it with get or --out.`,
        de: `Die Datei ist größer als ${limit / 1024 / 1024} MiB. Speichere sie mit get oder --out.`,
      }),
    );
  }
  return Buffer.concat(chunks);
}
