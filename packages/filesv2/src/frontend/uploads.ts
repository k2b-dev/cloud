import { apiClient } from "../api/client";
import type { EntryResult, UploadSession } from "../contracts";
import { transferUpload, UploadTransferError, uploadFailureAction, uploadRequestFailure, uploadResponseFailure } from "../upload-transfer";
import { browserUploadKey } from "./upload-key";

export const requestSignal = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
export class UploadConflict extends Error {
  constructor(readonly fileName: string) {
    super("path_conflict");
  }
}
/** One file: Cloud authorizes sessions; bytes go directly to Filegate. Three consecutive retries bound failures without limiting healthy long transfers. */
export async function uploadFile(
  baseId: string,
  path: string,
  file: Blob,
  options: {
    expectedRevision?: string;
    onConflict: "error" | "overwrite";
    signal: AbortSignal;
    fallback: string;
    onProgress?: (bytes: number) => void;
  },
): Promise<EntryResult> {
  options.signal.throwIfAborted();
  const start = await browserUploadKey(["private", baseId, path, options.onConflict, options.expectedRevision ?? ""], file);
  let session: UploadSession | undefined;
  let committing = false;
  try {
    const opened = await apiClient.bases[":baseId"].uploads.$post(
      {
        param: { baseId },
        json: {
          path,
          expectedRevision: options.expectedRevision,
          size: file.size,
          onConflict: options.onConflict,
          idempotencyKey: start.idempotencyKey,
        },
      },
      { init: { signal: requestSignal(options.signal) } },
    );
    if (!opened.ok) throw await uploadResponseFailure(opened, options.fallback);
    session = await opened.json();
    if (session.state === "aborted" || session.state === "expired") start.finish();
    await transferUpload(file, session, {
      signal: options.signal,
      failure: options.fallback,
      onProgress: options.onProgress,
      renew: async (id, signal) => {
        try {
          const renewed = await apiClient.bases[":baseId"].uploads[":id"].lease.$post({ param: { baseId, id } }, { init: { signal } });
          if (!renewed.ok) throw await uploadResponseFailure(renewed, options.fallback);
          return await renewed.json();
        } catch (error) {
          throw uploadRequestFailure(error, options.fallback, options.signal);
        }
      },
    });
    options.signal.throwIfAborted();
    committing = true;
    const committed = await apiClient.bases[":baseId"].uploads[":id"].commit.$post(
      { param: { baseId, id: session.id } },
      { init: { signal: requestSignal(options.signal) } },
    );
    if (!committed.ok) throw await uploadResponseFailure(committed, options.fallback);
    const result = await committed.json();
    start.finish();
    return result;
  } catch (caught) {
    // Keep the caller's cancellation intact, including an ambiguous commit.
    const error = options.signal.aborted ? caught : uploadRequestFailure(caught, options.fallback, options.signal);
    const action = uploadFailureAction(error, { session, committing, cancelled: options.signal.aborted });
    if (action === "drop") start.finish();
    if (action === "abort" && session)
      await apiClient.bases[":baseId"].uploads[":id"].abort
        .$post({ param: { baseId, id: session.id } }, { init: { signal: AbortSignal.timeout(5_000) } })
        .then(async (response) => {
          if (!response.ok) throw await uploadResponseFailure(response, options.fallback);
          start.finish();
        })
        .catch(() => {});
    if (
      !options.signal.aborted &&
      options.onConflict === "error" &&
      error instanceof UploadTransferError &&
      error.kind === "final" &&
      error.origin === "cloud" &&
      ((!session && error.code === "path_conflict") || (committing && ["path_conflict", "write_conflict"].includes(error.code ?? "")))
    )
      throw new UploadConflict(path.split("/").at(-1)!);
    throw error;
  }
}
