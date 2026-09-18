import { DirectSession, FilegateError } from "@k2b/filegate/utils";
import { apiClient } from "../api/client";
import type { EntryResult } from "../contracts";
import { apiFailure } from "./file-preview";

export type UploadProgress = { done: number; total: number; name: string; percent: number };
// DirectSession calls its fetch as a method; native fetch must be bound to the global scope.
const transfer = Object.assign((input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, credentials: "omit" }), {
  preconnect: fetch.preconnect,
}) as typeof fetch;
export class UploadConflict extends Error {
  constructor(readonly fileName: string) {
    super("path_conflict");
  }
}

/** One file: Cloud opens the session, the browser streams segments to Filegate, Cloud commits. */
export async function uploadFile(
  baseId: string,
  path: string,
  file: Blob,
  options: { onConflict: "error" | "overwrite"; signal: AbortSignal; fallback: string; onProgress?: (bytes: number) => void },
): Promise<EntryResult> {
  const opened = await apiClient.bases[":baseId"].uploads.$post(
    { param: { baseId }, json: { path, size: file.size, onConflict: options.onConflict } },
    { init: { signal: options.signal } },
  );
  if ((opened.status as number) === 409 && options.onConflict === "error") throw new UploadConflict(path.split("/").at(-1)!);
  if (!opened.ok) return apiFailure(opened, options.fallback);
  const session = await opened.json();
  const url = new URL(session.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error(options.fallback);
  const abort = () =>
    void apiClient.bases[":baseId"].uploads[":id"].abort.$post({ param: { baseId, id: session.id } }).catch(() => {});
  try {
    let leaseUrl = session.url;
    for (;;) {
      try {
        await new DirectSession(leaseUrl, transfer).upload(file, { signal: options.signal, onProgress: (bytes) => options.onProgress?.(bytes) });
        break;
      } catch (error) {
        // An expired lease is renewed through Cloud; the session resumes at the missing segments.
        if (!(error instanceof FilegateError && (error.status === 401 || error.status === 403))) throw error;
        const renewed = await apiClient.bases[":baseId"].uploads[":id"].lease.$post({ param: { baseId, id: session.id } }, { init: { signal: options.signal } });
        if (!renewed.ok) return apiFailure(renewed, options.fallback);
        leaseUrl = (await renewed.json()).url;
      }
    }
    const committed = await apiClient.bases[":baseId"].uploads[":id"].commit.$post({ param: { baseId, id: session.id } });
    // A file created while the transfer ran surfaces here; the caller may retry with overwrite.
    if ((committed.status as number) === 409 && options.onConflict === "error") throw new UploadConflict(path.split("/").at(-1)!);
    if (!committed.ok) return apiFailure(committed, options.fallback);
    return await committed.json();
  } catch (error) {
    abort();
    throw error;
  }
}
