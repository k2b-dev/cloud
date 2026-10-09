import { checkMimeType } from "@k2b/stdlib/browser";
import { invokeCapabilityWithDataSchema, listCapabilityCatalog } from "../capabilities/client";
import { readCapabilityResponse } from "../capabilities/response";
import { transferCapabilityStream } from "../capabilities/streams";
import type { CapabilityCatalogApp, CapabilityClientError, CapabilityHttpOptions } from "../capabilities/types";
import { CapabilityErrorSchema, type CapabilityStream, capabilityResultSchema } from "../contracts/capabilities";
import { CapabilityStreamStatusSchema } from "../contracts/capability-streams";
import {
  type FileProviderEntry,
  type FileProviderIssue,
  FileProviderListDataSchema,
  FileProviderReadDataSchema,
  FileProviderSaveDataSchema,
  FileProviderSaveInputSchema,
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
  /** The provider's `save` Action and its write limit, when it stores new files. */
  save?: { id: string; maxBytes: number };
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
const issuesOf = (app: CapabilityCatalogApp): FileProviderIssue[] | null => {
  try {
    return fileProviderIssues(app.manifest);
  } catch {
    return null;
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
      const issues = declaration ? issuesOf(app) : null;
      if (!declaration || !issues || issues.some((issue) => issue.function !== "save")) return [];
      const read = app.manifest.queries.find((query) => query.localId === declaration.read);
      if (!read?.stream) return [];
      // A `save` that does not fit leaves a provider to choose from, not one to save into.
      const save = issues.length === 0 ? app.manifest.actions.find((action) => action.localId === declaration.save) : undefined;
      return [
        {
          appId: app.appId,
          name: app.appName,
          icon: providerIcon(app.appIcon, "ti ti-folders"),
          list: declaration.list,
          read: declaration.read,
          maxBytes: read.stream.maxBytes,
          ...(save?.stream ? { save: { id: save.localId, maxBytes: save.stream.maxBytes } } : {}),
        },
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name, locale));

/**
 * Reads every catalog page; the catalog is the only discovery, there is no provider route. A refusal keeps its status
 * (401 or 403), so the page's file choosing can tell a visitor without providers from a failed load.
 */
export const loadFileProviders = async (caller: FileProviderCaller, signal?: AbortSignal): Promise<FileProviderSource[]> => {
  const apps: CapabilityCatalogApp[] = [];
  let cursor: string | undefined;
  do {
    const result = await listCapabilityCatalog({ ...options(caller), limit: 25, cursor, signal });
    if (!result.ok) throw failure(result.error);
    apps.push(...result.data.apps);
    const next = result.data.page.hasMore ? result.data.page.nextCursor : undefined;
    if (next && cursor && next <= cursor) throw new FileProviderError("INVALID_APP_RESPONSE", "Invalid catalog cursor", 502);
    cursor = next;
  } while (cursor);
  return fileProviderSources(apps, caller.locale);
};

export type FileProviderPage = { items: FileProviderEntry[]; next: string | null; writable: boolean };

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
  return { items: result.data.data.items, next: result.data.data.next, writable: result.data.data.writable };
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

/** What a consumer offers to save: the bytes, or a same-origin URL the page reads them from with its session. */
export type SaveFileSource = {
  /** The file name to save under. Path separators and control characters become `_`. */
  name: string;
  /** The bytes, or a same-origin URL such as the app's own download route. */
  content: Blob | string;
  /** Defaults to the Blob's or the response's type, then `application/octet-stream`. */
  mediaType?: string;
  /** The size when it is known before reading, so a file above the provider's limit is refused before it downloads. */
  size?: number;
};

/** A file the provider created, with the provider's `open` link when it returned one. */
export type SavedProviderFile = { id: string; name: string; size: number; href?: string };

const nameSchema = FileProviderSaveInputSchema.shape.name;
/** Whether a provider accepts this as a file name: one path segment without control characters, not `.` or `..`. */
export const isSaveableName = (name: string): boolean => nameSchema.safeParse(name).success;

/** A name every provider accepts: separators and control characters become `_`, and an empty name becomes `file`. */
export const saveableName = (name: string): string => {
  const cleaned = name
    .replace(/[/\\\u0000-\u001f\u007f]/g, "_")
    .trim()
    .slice(0, 255);
  return isSaveableName(cleaned) ? cleaned : "file";
};

/** The name a conflict suggests next: `Report.pdf` becomes `Report (2).pdf`, and `Report (2).pdf` becomes `Report (3).pdf`. */
export const nextFreeName = (name: string): string => {
  const dot = name.lastIndexOf(".");
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  const numbered = /^(.*) \((\d{1,9})\)$/.exec(stem);
  const [base, count] = numbered ? [numbered[1]!, Number(numbered[2]) + 1] : [stem, 2];
  const suffix = ` (${count})${extension}`;
  return `${base.slice(0, Math.max(1, 255 - suffix.length))}${suffix}`;
};

/** The contract takes a printable media type without parameters; anything else is sent as `application/octet-stream`. */
const saveMediaType = (value: string | null | undefined): string => {
  const type = value?.split(";", 1)[0]?.trim().toLowerCase();
  return type && /^[\x21-\x7e]{1,255}$/.test(type) ? type : "application/octet-stream";
};

const tooLarge = () => new FileProviderError("FILE_TOO_LARGE", "The file is larger than allowed", 413);
const offline = () => typeof navigator !== "undefined" && navigator.onLine === false;

/**
 * Reads what a consumer offers into a Blob, never more than `maxBytes`: a known `size` or `content-length` above it
 * fails before any byte moves, and a body that grows past it is cancelled. Aborting the signal cancels the read.
 */
export const readSaveSource = async (
  source: SaveFileSource,
  options: Pick<CapabilityHttpOptions, "fetch"> & {
    maxBytes: number;
    signal?: AbortSignal;
    onProgress?: (loaded: number, total: number) => void;
  },
): Promise<Blob> => {
  if (source.content instanceof Blob) {
    if (source.content.size > options.maxBytes) throw tooLarge();
    const type = saveMediaType(source.mediaType ?? source.content.type);
    return source.content.type === type ? source.content : new Blob([source.content], { type });
  }
  if (source.size !== undefined && source.size > options.maxBytes) throw tooLarge();
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(source.content, { credentials: "same-origin", signal: options.signal });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new FileProviderError("SOURCE_UNAVAILABLE", "The file could not be read", offline() ? 0 : 503);
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new FileProviderError("SOURCE_UNAVAILABLE", `The file could not be read (status ${response.status})`, response.status);
  }
  const announced = Number(response.headers.get("content-length") ?? Number.NaN);
  if (announced > options.maxBytes) {
    await response.body.cancel().catch(() => undefined);
    throw tooLarge();
  }
  const total = Number.isFinite(announced) && announced > 0 ? announced : (source.size ?? 0);
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let loaded = 0;
  options.onProgress?.(0, total);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      options.signal?.throwIfAborted();
      if (done) break;
      loaded += value.byteLength;
      if (loaded > options.maxBytes) throw tooLarge();
      chunks.push(value);
      options.onProgress?.(loaded, Math.max(total, loaded));
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof FileProviderError || options.signal?.aborted) throw error;
    throw new FileProviderError("SOURCE_UNAVAILABLE", "The file could not be read", offline() ? 0 : 503);
  }
  return new Blob(chunks, { type: saveMediaType(source.mediaType ?? response.headers.get("content-type")) });
};

const SaveResultSchema = capabilityResultSchema(FileProviderSaveDataSchema, { consumer: true });

/**
 * Sends a write stream's body. Browsers report upload progress only for XMLHttpRequest, so the page uses it; a caller
 * with its own `fetch`, such as a test, sends through that transport instead.
 */
const sendWriteStream = (
  stream: CapabilityStream,
  body: Blob,
  caller: FileProviderCaller,
  signal: AbortSignal | undefined,
  onProgress: (loaded: number) => void,
): Promise<Response> => {
  if (caller.fetch || typeof XMLHttpRequest === "undefined")
    return transferCapabilityStream(stream, "write", { ...options(caller), body, signal });
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const settle = () => signal?.removeEventListener("abort", abort);
    request.open("POST", `${(caller.baseUrl ?? "/api").replace(/\/$/, "")}/capabilities/v1/streams/write`);
    request.setRequestHeader("x-cloud-stream-id", stream.id);
    request.setRequestHeader("content-type", "application/octet-stream");
    request.setRequestHeader(LOCALE_HEADER, caller.locale);
    request.upload.onprogress = (event) => onProgress(event.loaded);
    request.onload = () => {
      settle();
      if (request.status < 200 || request.status > 599) return reject(new TypeError("The write was interrupted"));
      resolve(new Response(request.responseText, { status: request.status, headers: { "content-type": "application/json" } }));
    };
    request.onerror = () => {
      settle();
      reject(new TypeError("The write was interrupted"));
    };
    request.onabort = () => {
      settle();
      reject(signal?.reason ?? new DOMException("The write was cancelled", "AbortError"));
    };
    request.send(body);
  });
};

/** A completed write's receipt: the provider's file and its `open` link. */
const receipt = (data: unknown, name: string, size: number): SavedProviderFile => {
  const parsed = SaveResultSchema.safeParse(data);
  if (!parsed.success) throw new FileProviderError("INVALID_APP_RESPONSE", "The provider returned an invalid receipt", 502);
  const file = parsed.data.data.file;
  const href = parsed.data.links?.find((link) => link.rel === "open")?.href;
  return { id: file?.id ?? "", name: file?.name ?? name, size: file?.size ?? size, ...(href ? { href } : {}) };
};

/**
 * Creates one file in a provider folder: the provider's `save` Action opens a write stream, the bytes follow, and the
 * receipt names the file. A taken name fails with `FILE_PROVIDER_NAME_CONFLICT`, from the Action or from the write.
 * `idempotencyKey` belongs to this name and folder: retrying with it never creates a second file. A write whose
 * answer was lost is looked up through the stream's status before it fails; a cancelled one is aborted.
 */
export const saveProviderFile = async (
  provider: FileProviderSource,
  input: { parent: string; name: string; body: Blob; idempotencyKey: string },
  caller: FileProviderCaller & { signal?: AbortSignal; onProgress?: (loaded: number, total: number) => void },
): Promise<SavedProviderFile> => {
  if (!provider.save) throw new FileProviderError("NOT_FOUND", "This app does not store files", 404);
  if (input.body.size > provider.save.maxBytes) throw tooLarge();
  const opened = await invokeCapabilityWithDataSchema(
    {
      appId: provider.appId,
      capabilityId: provider.save.id,
      kind: "action",
      input: { parent: input.parent, name: input.name, mediaType: saveMediaType(input.body.type), size: input.body.size },
      idempotencyKey: input.idempotencyKey,
      signal: caller.signal,
    },
    FileProviderSaveDataSchema,
    options(caller),
  );
  if (!opened.ok) throw failure(opened.error);
  const stream = opened.data.stream;
  if (stream?.direction !== "write" || stream.size !== input.body.size)
    throw new FileProviderError("INVALID_APP_RESPONSE", "The provider returned no matching write stream", 502);
  const control = (verb: "status" | "abort") =>
    transferCapabilityStream(stream, verb, { ...options(caller), signal: verb === "status" ? caller.signal : undefined });
  caller.onProgress?.(0, stream.size);
  let response: Response;
  try {
    response = await sendWriteStream(stream, input.body, caller, caller.signal, (loaded) => caller.onProgress?.(loaded, stream.size));
  } catch (error) {
    if (caller.signal?.aborted) {
      void control("abort").catch(() => undefined);
      throw error;
    }
    // The bytes may have arrived and only the answer was lost; the stream's status knows.
    const status = await control("status")
      .then(async (answer) => (answer.ok ? CapabilityStreamStatusSchema.safeParse(await answer.json()) : null))
      .catch(() => null);
    if (status?.success && status.data.state === "completed") return receipt(status.data.result, input.name, input.body.size);
    throw new FileProviderError("APP_UNAVAILABLE", "The file could not be saved", offline() ? 0 : 503);
  }
  const answer = await readCapabilityResponse(response, SaveResultSchema);
  if (!answer.ok) throw failure(answer.error);
  caller.onProgress?.(stream.size, stream.size);
  return receipt(answer.data, input.name, input.body.size);
};
