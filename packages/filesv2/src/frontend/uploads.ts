import { DirectSession, FilegateError } from "@k2b/filegate/utils";
import { apiClient } from "../api/client";
import type { EntryResult } from "../contracts";
import { apiFailure } from "./file-preview";

export type UploadProgress = { done: number; total: number; name: string; percent: number };
const requestSignal = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
// DirectSession calls its fetch as a method; native fetch must be bound to the global scope.
const transfer = Object.assign(
  (input: RequestInfo | URL, init?: RequestInit) =>
    fetch(input, {
      ...init,
      signal: init?.signal ? requestSignal(init.signal) : AbortSignal.timeout(60_000),
      credentials: "omit",
    }),
  { preconnect: fetch.preconnect },
) as typeof fetch;
export class UploadConflict extends Error {
  constructor(readonly fileName: string) {
    super("path_conflict");
  }
}
const checkedUrl = (value: string, fallback: string) => {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error();
    return value;
  } catch {
    throw new Error(fallback);
  }
};
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
  options: { onConflict: "error" | "overwrite"; signal: AbortSignal; fallback: string; onProgress?: (bytes: number) => void },
): Promise<EntryResult> {
  options.signal.throwIfAborted();
  const opened = await apiClient.bases[":baseId"].uploads.$post(
    { param: { baseId }, json: { path, size: file.size, onConflict: options.onConflict } },
    { init: { signal: requestSignal(options.signal) } },
  );
  if (options.onConflict === "error" && (await isConflict(opened))) throw new UploadConflict(path.split("/").at(-1)!);
  if (!opened.ok) return apiFailure(opened, options.fallback);
  const session = await opened.json();
  let committing = false;
  try {
    let leaseUrl = checkedUrl(session.url, options.fallback);
    let attempt = 0;
    let progress = 0;
    for (;;) {
      options.signal.throwIfAborted();
      try {
        const status = await new DirectSession(leaseUrl, transfer).upload(file, {
          signal: options.signal,
          onProgress: (bytes) => {
            if (bytes > progress) {
              attempt = 0;
              progress = bytes;
            }
            options.onProgress?.(bytes);
          },
        });
        if (status.state !== "open" || status.received !== file.size) throw new FilegateError(409, "session_unavailable", options.fallback);
        break;
      } catch (error) {
        options.signal.throwIfAborted();
        const expired = error instanceof FilegateError && (error.status === 401 || error.status === 403);
        const retryable = expired || !(error instanceof FilegateError) || error.status === 429 || error.status >= 500;
        if (!retryable || attempt >= 3) throw new Error(options.fallback);
        attempt++;
        await new Promise<void>((resolve, reject) => {
          const cancel = () => {
            clearTimeout(timer);
            reject(options.signal.reason);
          };
          const timer = setTimeout(
            () => {
              options.signal.removeEventListener("abort", cancel);
              resolve();
            },
            200 * 2 ** (attempt - 1),
          );
          options.signal.addEventListener("abort", cancel, { once: true });
          if (options.signal.aborted) cancel();
        });
        if (expired) {
          const renewed = await apiClient.bases[":baseId"].uploads[":id"].lease.$post(
            { param: { baseId, id: session.id } },
            { init: { signal: requestSignal(options.signal) } },
          );
          if (!renewed.ok) return await apiFailure(renewed, options.fallback);
          leaseUrl = checkedUrl((await renewed.json()).url, options.fallback);
        }
      }
    }
    options.signal.throwIfAborted();
    committing = true;
    const committed = await apiClient.bases[":baseId"].uploads[":id"].commit.$post(
      { param: { baseId, id: session.id } },
      { init: { signal: requestSignal(options.signal) } },
    );
    if (options.onConflict === "error" && (await isConflict(committed))) throw new UploadConflict(path.split("/").at(-1)!);
    if (!committed.ok) return await apiFailure(committed, options.fallback);
    return await committed.json();
  } catch (error) {
    // A cancelled/lost commit response can still have published successfully. Reconciliation owns that case.
    if (!committing)
      await apiClient.bases[":baseId"].uploads[":id"].abort
        .$post({ param: { baseId, id: session.id } }, { init: { signal: AbortSignal.timeout(5_000) } })
        .catch(() => {});
    throw error;
  }
}
