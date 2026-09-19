import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { type CloudCliContext, cliText } from "@k2b/cloud/cli";
import type { EntryResult, UploadSession } from "./contracts";
import { transferUpload } from "./upload-transfer";

const REQUEST_TIMEOUT_MS = 60_000;

/** Cloud opens and commits the session; disk-backed file slices go straight to Filegate. */
export async function uploadFile(
  ctx: Pick<CloudCliContext, "options" | "getDefault" | "setDefault">,
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
    session = await api.open(info.size, AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]), idempotencyKey);
    if (session.state === "aborted" || session.state === "expired") await ctx.setDefault(storageKey, undefined);
    // Bun.file(fd) shares a mutable seek offset; a path-backed Blob supports SDK resume/hash rereads.
    await transferUpload(Bun.file(sourcePath), session, {
      signal,
      renew: api.renew,
      failure: cliText(ctx, { en: "Filegate upload failed.", de: "Der Filegate-Upload ist fehlgeschlagen." }),
    });
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
    committing = true;
    // A lost commit response is ambiguous. Do not issue an abort after publishing may have succeeded.
    const result = await api.commit(session.id, AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]));
    await ctx.setDefault(storageKey, undefined);
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
    throw error;
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}
