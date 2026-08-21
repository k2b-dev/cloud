import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from "node:http";
import { type RequestOptions as HttpsRequestOptions, request as httpsRequest } from "node:https";
import { resolvePublicNetworkAddresses, type PublicNetworkAddress } from "../services/network-security";
import { AI_FILES_MAX_FILE_BYTES_DEFAULT, aiFileStore, guessAiMediaType, normalizeAiFilePath } from "./files-store";
import { defineAiTool } from "./tools";
import { z } from "zod";

const FETCH_FILE_MAX_REDIRECTS = 5;
const FETCH_FILE_MAX_ADDRESS_ATTEMPTS = 4;
const FETCH_FILE_REQUEST_TIMEOUT_MS = 20_000;

type RequestFactory = (options: HttpsRequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
type PublicFileResponse = {
  statusCode: number;
  headers: IncomingHttpHeaders;
  bytes: Uint8Array;
};
type FetchFileDependencies = {
  resolve?: (hostname: string) => Promise<PublicNetworkAddress[]>;
  request?: RequestFactory;
  requestPublicFile?: (
    url: URL,
    addresses: PublicNetworkAddress[],
    options: { maxBytes: number; signal?: AbortSignal },
  ) => Promise<PublicFileResponse>;
};

export const CloudAiFetchFileInputSchema = z
  .object({
    url: z.string().trim().url().max(2_000),
    filename: z.string().trim().min(1).max(160).optional(),
  })
  .strict();

export const CloudAiFetchFileOutputSchema = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  mediaType: z.string(),
  url: z.string().url(),
});

const publicHttpsUrl = (rawUrl: string): URL => {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") throw new Error("Invalid file link — Use a public HTTPS URL.");
  if (url.username || url.password) throw new Error("Invalid file link — Remove embedded credentials from the URL.");
  return url;
};

const uniqueAddresses = (addresses: PublicNetworkAddress[]): PublicNetworkAddress[] =>
  addresses
    .filter((target, index) => addresses.findIndex((candidate) => candidate.address === target.address) === index)
    .slice(0, FETCH_FILE_MAX_ADDRESS_ATTEMPTS);

export const buildPinnedFetchFileRequestOptions = (url: URL, addresses: PublicNetworkAddress[]): HttpsRequestOptions[] => {
  const targets = uniqueAddresses(addresses);
  if (targets.length === 0) throw new Error("File URL has no public network address.");
  return targets.map((target) => ({
    protocol: "https:",
    hostname: target.address,
    port: url.port ? Number(url.port) : 443,
    path: `${url.pathname}${url.search}`,
    method: "GET",
    headers: {
      accept: "*/*",
      "accept-encoding": "identity",
      host: url.host,
      "user-agent": "Cloud-Assistant",
    },
    servername: url.hostname,
    rejectUnauthorized: true,
    timeout: FETCH_FILE_REQUEST_TIMEOUT_MS,
  }));
};

const declaredContentLength = (headers: IncomingHttpHeaders): number | null => {
  const value = headers["content-length"];
  if (value === undefined) return null;
  if (Array.isArray(value) || !/^(0|[1-9]\d*)$/.test(value))
    throw new Error("Invalid file response — The server sent an invalid Content-Length header.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("Invalid file response — The server sent an invalid Content-Length header.");
  return parsed;
};

const responseError = (message: string): Error => Object.assign(new Error(message), { responseReceived: true });

const fileLimitLabel = (bytes: number): string => (bytes >= 1024 * 1024 ? `${Math.floor(bytes / (1024 * 1024))} MB` : `${bytes} byte`);

const httpFileError = (statusCode: number): Error => {
  if (statusCode === 401) return responseError("Authorization required — This file may require an account or a signed-in session.");
  if (statusCode === 403) return responseError("Access denied — This file may require an account or permission from its owner.");
  if (statusCode === 404 || statusCode === 410)
    return responseError("File not found — The linked file does not exist or is no longer available.");
  if (statusCode === 429) return responseError("File server is busy — The server is rate-limiting downloads. Try again later.");
  if (statusCode >= 500) return responseError(`File server error — The server returned HTTP ${statusCode}. Try again later.`);
  return responseError(`File could not be downloaded — The server returned HTTP ${statusCode}.`);
};

const requestOneAddress = (
  request: RequestFactory,
  options: HttpsRequestOptions,
  input: { maxBytes: number; signal?: AbortSignal },
): Promise<PublicFileResponse> =>
  new Promise((resolve, reject) => {
    let settled = false;
    let responseReceived = false;
    let outgoing: ClientRequest;
    const abort = () => outgoing.destroy(new Error("File download was cancelled."));
    const finish = (result: { value?: PublicFileResponse; error?: Error }) => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener("abort", abort);
      if (result.error) reject(responseReceived ? Object.assign(result.error, { responseReceived: true }) : result.error);
      else resolve(result.value!);
    };
    outgoing = request(options, (incoming) => {
      responseReceived = true;
      const statusCode = incoming.statusCode ?? 0;
      if (statusCode >= 300 && statusCode < 400) {
        incoming.resume();
        finish({ value: { statusCode, headers: incoming.headers, bytes: new Uint8Array() } });
        return;
      }
      if (statusCode < 200 || statusCode >= 300) {
        incoming.resume();
        finish({ error: httpFileError(statusCode) });
        return;
      }
      const contentEncoding = String(incoming.headers["content-encoding"] ?? "identity")
        .trim()
        .toLowerCase();
      if (contentEncoding !== "" && contentEncoding !== "identity") {
        incoming.destroy();
        finish({ error: responseError("Unsupported file response — The server compressed the download unexpectedly.") });
        return;
      }
      let declared: number | null;
      try {
        declared = declaredContentLength(incoming.headers);
      } catch (error) {
        incoming.destroy();
        finish({ error: responseError(error instanceof Error ? error.message : "File response length is invalid.") });
        return;
      }
      if (declared !== null && declared > input.maxBytes) {
        incoming.destroy();
        finish({ error: responseError(`File is too large — The download exceeds the ${fileLimitLabel(input.maxBytes)} limit.`) });
        return;
      }

      const chunks: Uint8Array[] = [];
      let size = 0;
      incoming.on("data", (chunk: Buffer | string) => {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        size += bytes.byteLength;
        if (size > input.maxBytes) {
          incoming.destroy();
          finish({ error: responseError(`File is too large — The download exceeds the ${fileLimitLabel(input.maxBytes)} limit.`) });
          return;
        }
        chunks.push(bytes);
      });
      incoming.on("end", () => {
        if (declared !== null && size !== declared) {
          finish({ error: responseError("Incomplete file download — The received size did not match the server response.") });
          return;
        }
        const body = Buffer.concat(chunks, size);
        finish({ value: { statusCode, headers: incoming.headers, bytes: new Uint8Array(body) } });
      });
      incoming.on("error", (error) => finish({ error }));
    });
    outgoing.on("timeout", () => outgoing.destroy(new Error("File server did not respond — Try again later.")));
    outgoing.on("error", (error) => finish({ error }));
    if (input.signal?.aborted) {
      abort();
      return;
    }
    input.signal?.addEventListener("abort", abort, { once: true });
    outgoing.end();
  });

const requestPublicFile = async (
  url: URL,
  addresses: PublicNetworkAddress[],
  options: { maxBytes: number; signal?: AbortSignal },
  request: RequestFactory = httpsRequest,
): Promise<PublicFileResponse> => {
  let lastError: unknown;
  for (const requestOptions of buildPinnedFetchFileRequestOptions(url, addresses)) {
    try {
      return await requestOneAddress(request, requestOptions, options);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (error && typeof error === "object" && "responseReceived" in error) throw error;
      lastError = error;
    }
  }
  if (options.signal?.aborted) throw lastError instanceof Error ? lastError : new Error("File download was cancelled.");
  if (lastError instanceof Error && lastError.message === "File server did not respond — Try again later.") throw lastError;
  throw new Error("File server could not be reached — Check the link or try again later.");
};

const resolveFileAddresses = async (
  resolve: NonNullable<FetchFileDependencies["resolve"]>,
  hostname: string,
): Promise<PublicNetworkAddress[]> => {
  try {
    return await resolve(hostname);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (/not allowed|private or reserved|unsupported address family|invalid address/i.test(message)) {
      throw new Error("File access blocked — The link does not point to a public internet address.");
    }
    if (/could not be resolved/i.test(message) || code === "ENOTFOUND") {
      throw new Error("File server not found — Check the hostname in the link.");
    }
    throw new Error("File server could not be resolved — Check the link or try again later.");
  }
};

const responseLocation = (headers: IncomingHttpHeaders): string | null => {
  const value = headers.location;
  return typeof value === "string" && value.trim() ? value : null;
};

export const downloadPublicFile = async (
  rawUrl: string,
  options: FetchFileDependencies & { maxBytes?: number; signal?: AbortSignal } = {},
): Promise<{ bytes: Uint8Array; headers: IncomingHttpHeaders; url: URL }> => {
  const resolve = options.resolve ?? resolvePublicNetworkAddresses;
  const perform =
    options.requestPublicFile ??
    ((url: URL, addresses: PublicNetworkAddress[], input: { maxBytes: number; signal?: AbortSignal }) =>
      requestPublicFile(url, addresses, input, options.request));
  const maxBytes = options.maxBytes ?? AI_FILES_MAX_FILE_BYTES_DEFAULT;
  let url = publicHttpsUrl(rawUrl);

  for (let redirects = 0; redirects <= FETCH_FILE_MAX_REDIRECTS; redirects++) {
    const addresses = await resolveFileAddresses(resolve, url.hostname);
    const response = await perform(url, addresses, { maxBytes, signal: options.signal });
    if (response.statusCode >= 300 && response.statusCode < 400) {
      const location = responseLocation(response.headers);
      if (!location) throw new Error("Invalid file redirect — The server did not provide a destination.");
      if (redirects === FETCH_FILE_MAX_REDIRECTS) throw new Error("Too many file redirects — Use the final file URL instead.");
      try {
        url = publicHttpsUrl(new URL(location, url).toString());
      } catch (error) {
        if (error instanceof Error && error.message.includes(" — ")) throw error;
        throw new Error("Invalid file redirect — The server provided an invalid destination.");
      }
      continue;
    }
    return { bytes: response.bytes, headers: response.headers, url };
  }
  throw new Error("Too many file redirects — Use the final file URL instead.");
};

const safeFilename = (requested: string | undefined, url: URL): string => {
  let basename = requested;
  if (!basename) {
    const rawBasename = url.pathname.split("/").filter(Boolean).at(-1) ?? "download";
    try {
      basename = decodeURIComponent(rawBasename);
    } catch {
      basename = rawBasename;
    }
  }
  const cleaned = basename.replace(/[\u0000-\u001f\u007f/\\"<>]/g, "_").trim();
  const bounded = cleaned.slice(0, 160);
  return !bounded || bounded === "." || bounded === ".." ? "download" : bounded;
};

const responseMediaType = (headers: IncomingHttpHeaders, path: string): string => {
  const raw = headers["content-type"];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(value) ? value : guessAiMediaType(path);
};

export const runCloudAiFetchFile = async (
  input: z.infer<typeof CloudAiFetchFileInputSchema>,
  context: { conversationId?: string; signal?: AbortSignal },
  dependencies: FetchFileDependencies = {},
): Promise<z.infer<typeof CloudAiFetchFileOutputSchema>> => {
  if (!context.conversationId) throw new Error("The fetch_file tool needs a conversation context.");
  const downloaded = await downloadPublicFile(input.url, { ...dependencies, signal: context.signal });
  const path = normalizeAiFilePath(`/imports/${safeFilename(input.filename, downloaded.url)}`);
  if (!path) throw new Error("Could not derive a valid conversation file path.");
  const stat = await aiFileStore.createAssistantFile({
    conversationId: context.conversationId,
    path,
    bytes: downloaded.bytes,
    mediaType: responseMediaType(downloaded.headers, path),
  });
  return { path: stat.path, size: stat.size, mediaType: stat.mediaType, url: downloaded.url.toString() };
};

export const createCloudAiFetchFileTool = (dependencies: FetchFileDependencies = {}) =>
  defineAiTool({
    name: "fetch_file",
    description:
      "Download one exact public HTTPS file URL into the current conversation. Use this for images, raw GitHub files, documents, or other source files the user wants inspected. This does not browse or clone repositories, authenticate to websites, or fetch private network targets. After downloading, inspect the returned path with read_file or view_image and use present when the user should receive the file.",
    inputSchema: CloudAiFetchFileInputSchema,
    outputSchema: CloudAiFetchFileOutputSchema,
    approval: "never",
    timeoutMs: 90_000,
    promptHint:
      "fetch an exact public HTTPS source file into the chat when the user provides a file link; inspect it with read_file or view_image and present it when useful.",
  }).server((input, context) => runCloudAiFetchFile(input, context, dependencies));

export type CloudAiFetchFileInput = z.infer<typeof CloudAiFetchFileInputSchema>;
export type CloudAiFetchFileOutput = z.infer<typeof CloudAiFetchFileOutputSchema>;
