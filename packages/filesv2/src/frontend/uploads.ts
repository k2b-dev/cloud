import { apiClient } from "../api/client";
import type { EntryResult } from "../contracts";
import { transferUpload } from "../upload-transfer";
import { apiFailure } from "./file-preview";
import { browserUploadKey } from "./upload-key";

export type UploadProgress = { done: number; total: number; name: string; percent: number };
const requestSignal = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
export class UploadConflict extends Error {
  constructor(readonly fileName: string) {
    super("path_conflict");
  }
}
const isConflict = async (response: { status: number; clone: () => { json: () => Promise<unknown> } }) => {
  if (response.status !== 409) return false;
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  return typeof body === "object" && body !== null && "code" in body && body.code === "path_conflict";
};

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
  if (options.onConflict === "error" && (await isConflict(opened))) throw new UploadConflict(path.split("/").at(-1)!);
  if (!opened.ok) return apiFailure(opened, options.fallback);
  const session = await opened.json();
  let committing = false;
  try {
    if (session.state === "aborted" || session.state === "expired") start.finish();
    await transferUpload(file, session, {
      signal: options.signal,
      failure: options.fallback,
      onProgress: options.onProgress,
      renew: async (id, signal) => {
        const renewed = await apiClient.bases[":baseId"].uploads[":id"].lease.$post({ param: { baseId, id } }, { init: { signal } });
        if (!renewed.ok) return apiFailure(renewed, options.fallback);
        return renewed.json();
      },
    });
    options.signal.throwIfAborted();
    committing = true;
    const committed = await apiClient.bases[":baseId"].uploads[":id"].commit.$post(
      { param: { baseId, id: session.id } },
      { init: { signal: requestSignal(options.signal) } },
    );
    if (options.onConflict === "error" && (await isConflict(committed))) throw new UploadConflict(path.split("/").at(-1)!);
    if (!committed.ok) return await apiFailure(committed, options.fallback);
    const result = await committed.json();
    start.finish();
    return result;
  } catch (error) {
    // A cancelled/lost commit response can still have published successfully. Reconciliation owns that case.
    if (session.state === "open" && !committing)
      await apiClient.bases[":baseId"].uploads[":id"].abort
        .$post({ param: { baseId, id: session.id } }, { init: { signal: AbortSignal.timeout(5_000) } })
        .then((response) => {
          if (response.ok) start.finish();
        })
        .catch(() => {});
    throw error;
  }
}
