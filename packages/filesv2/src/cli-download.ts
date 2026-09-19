import { createWriteStream } from "node:fs";
import { link, lstat, mkdtemp, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { type CloudCliContext, cliText } from "@k2b/cloud/cli";
import type { ArchiveDownload, DownloadLease } from "./contracts";

/** Only the lease request uses Cloud authentication; file bytes go directly to disk. */
export async function downloadFile(
  ctx: Pick<CloudCliContext, "options">,
  output: string,
  requestLease: (signal: AbortSignal) => Promise<DownloadLease | ArchiveDownload>,
) {
  const path = resolve(output);
  const exists = () => new Error(cliText(ctx, { en: "The output path already exists.", de: "Der Zielpfad existiert bereits." }));
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (existing) throw exists();
  const temporary = await mkdtemp(join(dirname(path), ".filesv2-download-"));
  const part = join(temporary, "content");
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    let bytes: number;
    try {
      let response: Response | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        controller.signal.throwIfAborted();
        const requestSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);
        const lease = await requestLease(requestSignal);
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
      await pipeline(response.body, createWriteStream(part, { flags: "wx", mode: 0o600 }), { signal: controller.signal });
      bytes = (await stat(part)).size;
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/.test(length) || Number(length) !== bytes)) throw new Error();
      controller.signal.throwIfAborted();
    } catch {
      // Fetch errors, redirect targets and response bodies may contain the bearer lease.
      throw new Error(
        cliText(ctx, {
          en: "Filegate download failed or was interrupted. No output file was saved; request a new download to retry.",
          de: "Der Filegate-Download ist fehlgeschlagen oder wurde abgebrochen. Es wurde keine Zieldatei gespeichert; starte den Download erneut.",
        }),
      );
    }
    // Unlike rename(), link() cannot overwrite a target created during the transfer.
    await link(part, path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") throw exists();
      throw error;
    });
    return { path, bytes };
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
    await rm(temporary, { recursive: true, force: true });
  }
}
