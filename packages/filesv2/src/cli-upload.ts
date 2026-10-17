import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { type CloudCliContext, cliText } from "@k2b/cloud/cli";
import { REQUEST_TIMEOUT_MS } from "./cli-request";
import type { EntryResult, UploadSession } from "./contracts";
import { classifyUploadFailure, createUploadRetryBudget, nextUploadRetry, sleepUploadRetry, UPLOAD_RETRY_DELAYS_MS } from "./upload-retry";
import {
  transferUpload,
  UPLOAD_COMMIT_DEADLINE_MS,
  UploadTransferError,
  uploadFailureAction,
  uploadRequestFailure,
} from "./upload-transfer";

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
  options: { retryDelays?: readonly number[] } = {},
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
    const budget = createUploadRetryBudget();
    for (;;) {
      try {
        session = await api.open(info.size, AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]), idempotencyKey);
        signal.throwIfAborted();
        committing = false;
        if (session.state === "aborted" || session.state === "expired") await ctx.setDefault(storageKey, undefined);
        // Bun.file(fd) shares a mutable seek offset; a path-backed Blob supports SDK resume/hash rereads.
        await transferUpload(Bun.file(sourcePath), session, {
          signal,
          renew: async (id, renewSignal) => {
            try {
              return await api.renew(id, renewSignal);
            } catch (error) {
              throw uploadRequestFailure(error, "", signal);
            }
          },
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
        const result = await api.commit(session.id, AbortSignal.any([signal, AbortSignal.timeout(UPLOAD_COMMIT_DEADLINE_MS)]));
        await ctx.setDefault(storageKey, undefined);
        if (textProgress) ctx.error(cliText(ctx, { en: "Upload done.", de: "Upload abgeschlossen." }));
        return result;
      } catch (caught) {
        signal.throwIfAborted();
        const failure = classifyUploadFailure(caught);
        const retry = nextUploadRetry(failure, budget, false, options.retryDelays ?? UPLOAD_RETRY_DELAYS_MS);
        if (!retry) throw failure ?? caught;
        if (textProgress) {
          const seconds = Math.ceil(retry.delay / 1000);
          const counter = ` (${retry.attempt}/${retry.of})`;
          const reasons = {
            network: { en: "Waiting for the network", de: "Warte auf das Netzwerk" },
            stalled:
              failure?.origin === "cloud"
                ? { en: "No response from Cloud", de: "Keine Antwort von Cloud" }
                : { en: "No response from the file server", de: "Keine Antwort vom Dateiserver" },
            busy: { en: "The file server is busy", de: "Der Dateiserver ist ausgelastet" },
            rate_limited: { en: "Too many uploads in a short time", de: "Zu viele Uploads in kurzer Zeit" },
          };
          ctx.error(
            `${cliText(ctx, reasons[retry.kind])}${cliText(ctx, {
              en: `, retrying in ${seconds} s`,
              de: `, neuer Versuch in ${seconds} s`,
            })}${retry.kind === "rate_limited" ? "" : counter}`,
          );
        }
        await sleepUploadRetry(retry.delay, signal);
        signal.throwIfAborted();
        // Progress replaces the phase line above it, never the reason for the wait.
        if (textProgress) ctx.error(line());
        lastProgress = -Infinity;
        lastBytes = -1;
      }
    }
  } catch (caught) {
    const error = signal.aborted ? caught : uploadRequestFailure(caught, "", signal);
    const action = uploadFailureAction(error, { session, committing, cancelled: signal.aborted });
    if (action === "drop" && storageKey) await ctx.setDefault(storageKey, undefined);
    // The key goes only after Cloud confirmed the abort; otherwise a rerun resumes or retries the abort.
    if (action === "abort" && session)
      await api
        .abort(session.id, AbortSignal.timeout(5_000))
        .then(async () => {
          if (storageKey) await ctx.setDefault(storageKey, undefined);
        })
        .catch(() => {});
    if (signal.aborted) throw new Error(cliText(ctx, { en: "Upload cancelled.", de: "Upload abgebrochen." }), { cause: error });
    if (error instanceof UploadTransferError) {
      const reasons = {
        stalled:
          error.origin === "cloud"
            ? committing
              ? {
                  en: "Cloud did not finish the upload in time. Run the command again to continue.",
                  de: "Cloud hat den Upload nicht rechtzeitig abgeschlossen. Führe den Befehl erneut aus, um fortzufahren.",
                }
              : { en: "No response from Cloud within 60 seconds.", de: "Keine Antwort von Cloud innerhalb von 60 Sekunden." }
            : { en: "No response from the file server.", de: "Keine Antwort vom Dateiserver." },
        busy: { en: "The file server is busy. Try again later.", de: "Der Dateiserver ist ausgelastet. Versuche es später erneut." },
        network:
          error.origin === "cloud"
            ? { en: "No connection to Cloud.", de: "Keine Verbindung zu Cloud." }
            : { en: "No connection to the file server.", de: "Keine Verbindung zum Dateiserver." },
        rate_limited: {
          en: "Too many uploads in a short time. Try again later.",
          de: "Zu viele Uploads in kurzer Zeit. Versuche es später erneut.",
        },
        server: { en: "Filegate upload failed.", de: "Der Filegate-Upload ist fehlgeschlagen." },
        final: { en: "Filegate upload failed.", de: "Der Filegate-Upload ist fehlgeschlagen." },
      };
      throw new Error(
        error.origin === "cloud" && (error.kind === "final" || error.kind === "server") ? error.message : cliText(ctx, reasons[error.kind]),
        { cause: error },
      );
    }
    throw error;
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}
