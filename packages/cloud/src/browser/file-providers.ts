import { checkMimeType } from "@k2b/stdlib/browser";
import { invokeCapabilityWithDataSchema, listCapabilityCatalog } from "../capabilities/client";
import { transferCapabilityStream } from "../capabilities/streams";
import type { CapabilityCatalogApp, CapabilityClientError, CapabilityHttpOptions } from "../capabilities/types";
import { CapabilityErrorSchema } from "../contracts/capabilities";
import {
  type FileProviderEntry,
  FileProviderListDataSchema,
  FileProviderReadDataSchema,
  fileProviderIssues,
} from "../contracts/file-provider";
import { LOCALE_HEADER } from "../shared/locale";

/** One live application whose catalog manifest offers files, reduced to what choosing a file needs. */
export type FileProviderSource = {
  appId: string;
  name: string;
  icon: string;
  list: string;
  read: string;
  /** The provider's read limit; a consumer combines it with its own. */
  maxBytes: number;
};

export type FileProviderCaller = Pick<CapabilityHttpOptions, "fetch" | "baseUrl"> & { locale: string };

/** A provider failure the chooser explains; `status` 0 means the browser is offline. */
export class FileProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "FileProviderError";
  }
}

/** The page size the chooser asks for; the contract allows 1 to 100. */
export const FILE_PROVIDER_PAGE_SIZE = 50;
/** At most this many provider reads run at the same time. */
export const FILE_PROVIDER_PARALLEL_READS = 2;

const ICON = /^ti(?: ti-[a-z0-9-]{1,60}){1,2}$/;
/** Icons come from other applications; only a Tabler icon class may reach the DOM, never arbitrary classes. */
export const providerIcon = (icon: string | undefined, fallback: string): string => (icon && ICON.test(icon) ? icon : fallback);

const options = (caller: FileProviderCaller): CapabilityHttpOptions => ({
  fetch: caller.fetch,
  baseUrl: caller.baseUrl,
  headers: { [LOCALE_HEADER]: caller.locale },
});

const failure = (error: CapabilityClientError): FileProviderError =>
  new FileProviderError(error.code, error.message, typeof navigator !== "undefined" && navigator.onLine === false ? 0 : error.status);

/** One unreadable manifest leaves out that application, not the whole list. */
const usable = (app: CapabilityCatalogApp): boolean => {
  try {
    return !fileProviderIssues(app.manifest).some((issue) => issue.function !== "save");
  } catch {
    return false;
  }
};

/**
 * Keeps the catalog apps that offer files with a usable `list` and `read`. Core already drops invalid declarations;
 * the check repeats here because a manifest from another Cloud release may name an operation this reader left out.
 */
export const fileProviderSources = (apps: readonly CapabilityCatalogApp[], locale: string): FileProviderSource[] =>
  apps
    .flatMap((app) => {
      const declaration = app.manifest.fileProvider;
      if (!declaration || !usable(app)) return [];
      const read = app.manifest.queries.find((query) => query.localId === declaration.read);
      if (!read?.stream) return [];
      return [
        {
          appId: app.appId,
          name: app.appName,
          icon: providerIcon(app.appIcon, "ti ti-folders"),
          list: declaration.list,
          read: declaration.read,
          maxBytes: read.stream.maxBytes,
        },
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name, locale));

/**
 * Reads every catalog page; the catalog is the only discovery, there is no provider route. A caller the catalog
 * refuses, such as a visitor of a public page, has no providers, so choosing files stays with the device.
 */
export const loadFileProviders = async (caller: FileProviderCaller, signal?: AbortSignal): Promise<FileProviderSource[]> => {
  const apps: CapabilityCatalogApp[] = [];
  let cursor: string | undefined;
  do {
    const result = await listCapabilityCatalog({ ...options(caller), limit: 25, cursor, signal });
    if (!result.ok && (result.error.status === 401 || result.error.status === 403)) return [];
    if (!result.ok) throw failure(result.error);
    apps.push(...result.data.apps);
    const next = result.data.page.hasMore ? result.data.page.nextCursor : undefined;
    if (next && cursor && next <= cursor) throw new FileProviderError("INVALID_APP_RESPONSE", "Invalid catalog cursor", 502);
    cursor = next;
  } while (cursor);
  return fileProviderSources(apps, caller.locale);
};

export type FileProviderPage = { items: FileProviderEntry[]; next: string | null };

/** One folder page. Without `parent` it is the provider's root. */
export const listProviderFolder = async (
  provider: FileProviderSource,
  input: { parent?: string; query?: string; cursor?: string },
  caller: FileProviderCaller,
  signal?: AbortSignal,
): Promise<FileProviderPage> => {
  const result = await invokeCapabilityWithDataSchema(
    {
      appId: provider.appId,
      capabilityId: provider.list,
      kind: "query",
      input: {
        ...(input.parent === undefined ? {} : { parent: input.parent }),
        ...(input.query ? { query: input.query } : {}),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        limit: FILE_PROVIDER_PAGE_SIZE,
      },
      signal,
    },
    FileProviderListDataSchema,
    options(caller),
  );
  if (!result.ok) throw failure(result.error);
  return { items: result.data.data.items, next: result.data.data.next };
};

export type EntryProblem = "type" | "size";

/** Why a file cannot be chosen: its type does not match `accept`, or it is larger than the effective limit. */
export const entryProblem = (entry: FileProviderEntry, accept: string | undefined, maxBytes: number): EntryProblem | undefined => {
  if (entry.kind === "folder") return undefined;
  if (accept && !checkMimeType(new File([], entry.name, { type: entry.mediaType ?? "" }), accept)) return "type";
  if (entry.size > maxBytes) return "size";
  return undefined;
};

const streamFailure = async (response: Response): Promise<FileProviderError> => {
  const body = CapabilityErrorSchema.safeParse(await response.json().catch(() => null));
  return body.success
    ? new FileProviderError(body.data.code, body.data.message, response.status)
    : new FileProviderError("INVALID_APP_RESPONSE", `Read failed with status ${response.status}`, response.status);
};

/**
 * Reads one file through the provider's read stream into a `File`. Before any byte moves it checks the read's own
 * size and media type against `maxBytes` and `accept` again, since the file may have changed since it was listed.
 * It rejects a body that differs from the announced size and reports received bytes. Aborting the signal cancels
 * the transfer.
 */
export const readProviderFile = async (
  provider: FileProviderSource,
  entry: Extract<FileProviderEntry, { kind: "file" }>,
  caller: FileProviderCaller & {
    maxBytes: number;
    accept?: string;
    signal?: AbortSignal;
    onProgress?: (loaded: number, total: number) => void;
  },
): Promise<File> => {
  const result = await invokeCapabilityWithDataSchema(
    { appId: provider.appId, capabilityId: provider.read, kind: "query", input: { id: entry.id }, signal: caller.signal },
    FileProviderReadDataSchema,
    options(caller),
  );
  if (!result.ok) throw failure(result.error);
  const stream = result.data.stream;
  if (stream?.direction !== "read") throw new FileProviderError("INVALID_APP_RESPONSE", "The provider returned no read stream", 502);
  const problem = entryProblem({ ...entry, size: stream.size, mediaType: stream.mediaType }, caller.accept, caller.maxBytes);
  if (problem === "size") throw new FileProviderError("FILE_TOO_LARGE", "The file is larger than allowed", 413);
  if (problem === "type") throw new FileProviderError("UNSUPPORTED_MEDIA_TYPE", "The file type is not accepted", 415);
  let response: Response;
  try {
    response = await transferCapabilityStream(stream, "read", { ...options(caller), signal: caller.signal });
  } catch (error) {
    if (caller.signal?.aborted) throw error;
    throw new FileProviderError("APP_UNAVAILABLE", "The file could not be read", navigator.onLine === false ? 0 : 503);
  }
  if (!response.ok || !response.body) throw await streamFailure(response);
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let loaded = 0;
  caller.onProgress?.(0, stream.size);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      caller.signal?.throwIfAborted();
      if (done) break;
      loaded += value.byteLength;
      if (loaded > stream.size) throw new FileProviderError("INVALID_APP_RESPONSE", "The file is larger than announced", 502);
      chunks.push(value);
      caller.onProgress?.(loaded, stream.size);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof FileProviderError || caller.signal?.aborted) throw error;
    throw new FileProviderError("APP_UNAVAILABLE", "The file could not be read", navigator.onLine === false ? 0 : 503);
  }
  if (loaded !== stream.size) throw new FileProviderError("INVALID_APP_RESPONSE", "The file ended early", 502);
  const lastModified = entry.updatedAt ? Date.parse(entry.updatedAt) : Date.now();
  return new File(chunks, entry.name, { type: stream.mediaType, lastModified });
};

/** Runs `work` for every item, at most `limit` at once. `work` handles its own failures. */
export const eachLimited = async <T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> => {
  let index = 0;
  const run = async () => {
    while (index < items.length) await work(items[index++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
};
