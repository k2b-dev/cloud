import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { type CloudCliContext, cliText } from "@k2b/cloud/cli";
import { cloudRequestError, REQUEST_TIMEOUT_MS } from "./cli-request";
import type { EntryResult, UploadSession } from "./contracts";
import { transferUpload, UploadTransferError } from "./upload-transfer";

/** Cloud opens and commits the session; disk-backed file slices go straight to Filegate. */
export async function uploadFile(
  ctx: Pick<CloudCliContext, "options" | "getDefault" | "setDefault" | "error">,
  input: string,
  api: {
    scope: string;
    open: (size: number, signal: AbortSignal, idempotencyKey: string) => Promise<UploadSession>;
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
  let storageKey: string | undefined;
  try {
    const sourcePath = resolve(input);
    await using handle = await open(sourcePath);
    signal.throwIfAborted();
    const info = await handle.stat();
    if (!info.isFile() || !Number.isSafeInteger(info.size))
      throw new Error(cliText(ctx, { en: "The input path is not a supported file.", de: "Der Eingabepfad ist keine unterstützte Datei." }));
    storageKey = `filesv2.upload.${createHash("sha256")
      .update(JSON.stringify([ctx.options.server, api.scope, resolve(input), info.size, info.mtimeMs, info.ctimeMs]))
      .digest("hex")}`;
    const idempotencyKey = (await ctx.getDefault(storageKey)) ?? crypto.randomUUID();
    await ctx.setDefault(storageKey, idempotencyKey);
    signal.throwIfAborted();
    const name = basename(sourcePath);
    const textProgress = ctx.options.output === "text";
    const tty = textProgress && process.stderr.isTTY;
    let lastProgress = -Infinity;
    let lastBytes = -1;
    const uploading = cliText(ctx, { en: "Uploading", de: "Hochladen" });
    const line = (suffix = "") => {
      let displayName = name;
      const columns = tty && process.stderr.columns;
      if (columns && Bun.stringWidth(`${uploading} ${name}${suffix}`) > columns - 1) {
        displayName = "";
        for (const character of name) {
          if (Bun.stringWidth(`${uploading} ${displayName}${character}…${suffix}`) > columns - 1) break;
          displayName += character;
        }
        displayName += "…";
      }
      return `${uploading} ${displayName}${suffix}`;
    };
    if (textProgress) ctx.error(line());
    const progress = (bytes: number) => {
      if (!tty || bytes === lastBytes) return;
      const now = Date.now();
      if (bytes < info.size && now - lastProgress < 1000) return;
      const mib = (value: number) => `${(value / (1024 * 1024)).toFixed(1)} MiB`;
      const percent = info.size === 0 ? 100 : Math.floor((bytes / info.size) * 100);
      const amount = cliText(ctx, { en: `${mib(bytes)} of ${mib(info.size)}`, de: `${mib(bytes)} von ${mib(info.size)}` });
      // Replace the previous line, starting with the phase line, so a terminal shows one updating line.
      ctx.error(`\x1b[1A\x1b[2K${line(`: ${amount} (${percent} %)`)}`);
      lastProgress = now;
      lastBytes = bytes;
    };
    session = await api.open(info.size, AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]), idempotencyKey);
    if (session.state === "aborted" || session.state === "expired") await ctx.setDefault(storageKey, undefined);
    // Bun.file(fd) shares a mutable seek offset; a path-backed Blob supports SDK resume/hash rereads.
    await transferUpload(Bun.file(sourcePath), session, {
      signal,
      renew: api.renew,
      onProgress: progress,
      failure: cliText(ctx, { en: "Filegate upload failed.", de: "Der Filegate-Upload ist fehlgeschlagen." }),
    });
    progress(info.size);
    const finalInfo = await handle.stat();
    const finalPath = await stat(sourcePath);
    if (
      finalInfo.size !== info.size ||
      finalInfo.mtimeMs !== info.mtimeMs ||
      finalInfo.ctimeMs !== info.ctimeMs ||
      finalPath.ino !== info.ino ||
      finalPath.dev !== info.dev ||
      finalPath.ctimeMs !== info.ctimeMs
    )
      throw new Error(
        cliText(ctx, { en: "The local file changed during upload.", de: "Die lokale Datei wurde während des Uploads verändert." }),
      );
    signal.throwIfAborted();
    if (textProgress) ctx.error(cliText(ctx, { en: "Finishing upload…", de: "Upload abschließen…" }));
    committing = true;
    // A lost commit response is ambiguous. Do not issue an abort after publishing may have succeeded.
    const result = await api.commit(session.id, AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]));
    await ctx.setDefault(storageKey, undefined);
    if (textProgress) ctx.error(cliText(ctx, { en: "Upload done.", de: "Upload abgeschlossen." }));
    return result;
  } catch (error) {
    if (session?.state === "open" && !committing)
      await api
        .abort(session.id, AbortSignal.timeout(5_000))
        .then(async () => {
          if (storageKey) await ctx.setDefault(storageKey, undefined);
        })
        .catch(() => {});
    if (signal.aborted) throw new Error(cliText(ctx, { en: "Upload cancelled.", de: "Upload abgebrochen." }));
    if (error instanceof UploadTransferError) {
      const reasons = {
        stalled: { en: "No response from the file server.", de: "Keine Antwort vom Dateiserver." },
        busy: { en: "The file server is busy. Try again later.", de: "Der Dateiserver ist ausgelastet. Versuche es später erneut." },
        network: { en: "No connection to the file server.", de: "Keine Verbindung zum Dateiserver." },
        final: { en: "Filegate upload failed.", de: "Der Filegate-Upload ist fehlgeschlagen." },
      };
      throw new Error(cliText(ctx, reasons[error.kind]));
    }
    cloudRequestError(ctx, error);
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}
