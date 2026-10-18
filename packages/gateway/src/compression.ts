import { constants, createBrotliCompress, createGzip } from "node:zlib";

const MIN_COMPRESSION_BYTES = 1024;
type Encoding = "br" | "gzip";

export const chooseEncoding = (acceptEncoding: string | null): Encoding | null => {
  const weights = new Map<string, number>();
  for (const entry of acceptEncoding?.split(",") ?? []) {
    const [name = "", ...parameters] = entry.trim().toLowerCase().split(";");
    const coding = name.trim() === "x-gzip" ? "gzip" : name.trim();
    if (!coding) continue;
    const weight = parameters.length === 0 ? 1 : /^\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)\s*$/.exec(parameters.join(";"));
    weights.set(coding, typeof weight === "number" ? weight : weight ? Number(weight[1]) : 0);
  }
  const br = weights.get("br") ?? weights.get("*") ?? 0;
  const gzip = weights.get("gzip") ?? weights.get("*") ?? 0;
  const best = Math.max(br, gzip);
  // A client that ranks identity above every coding we offer gets identity.
  if (best <= 0 || best < (weights.get("identity") ?? 0)) return null;
  return br >= gzip ? "br" : "gzip";
};

/** Whether a Cache-Control value carries the no-transform directive (quoted values ignored). */
const hasNoTransform = (headers: Headers): boolean =>
  (headers.get("Cache-Control")?.match(/(?:[^,"]|"[^"]*")+/g) ?? []).some(
    (directive) => directive.split("=", 1)[0]?.trim().toLowerCase() === "no-transform",
  );

export const isCompressionEligible = (method: string, status: number, hasBody: boolean, headers: Headers): boolean => {
  if (method === "HEAD" || status < 200 || [204, 206, 304].includes(status) || !hasBody) return false;
  if (headers.has("Content-Range") || headers.has("Content-Encoding") || hasNoTransform(headers)) return false;
  const type = headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (type !== "text/html" && type !== "application/json" && !/^application\/[^\s/;]+\+json$/.test(type)) return false;
  return !headers.has("Content-Length") || Number(headers.get("Content-Length")) >= MIN_COMPRESSION_BYTES;
};

/** Zlib bounds its readable/writable buffers; the pump reads one upstream chunk at a time. */
export const encodeStream = (
  body: ReadableStream<Uint8Array>,
  encoding: Encoding,
  length: number | undefined,
): ReadableStream<Uint8Array> => {
  const encoder =
    encoding === "br"
      ? createBrotliCompress({
          params: {
            [constants.BROTLI_PARAM_QUALITY]: 5,
            [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
            ...(length === undefined ? {} : { [constants.BROTLI_PARAM_SIZE_HINT]: length }),
          },
        })
      : createGzip({ level: 6 });
  const reader = body.getReader();
  // Pull from zlib's bounded readable buffer only when the client asks.
  const chunks = encoder[Symbol.asyncIterator]();
  let cancelled = false;
  let pump: Promise<void>;
  const output = new ReadableStream<Uint8Array>({
    start(controller) {
      const error = (reason: Error) => controller.error(reason);
      encoder.on("error", error);
      encoder.once("close", () => {
        encoder.off("error", error);
        void reader.cancel().catch(() => {});
      });
    },
    async pull(controller) {
      try {
        const chunk = await chunks.next();
        if (cancelled) return;
        if (chunk.done) controller.close();
        else controller.enqueue(chunk.value);
      } catch (error) {
        if (!cancelled) controller.error(error);
      }
    },
    async cancel(reason) {
      cancelled = true;
      encoder.destroy();
      await reader.cancel(reason).catch(() => {});
      await pump;
    },
  });

  // A cancellation can close zlib while a write/flush callback is pending.
  const operation = (run: (done: (error?: Error | null) => void) => void): Promise<void> =>
    new Promise((resolve, reject) => {
      const done = (error?: Error | null) => {
        encoder.off("error", done);
        encoder.off("close", closed);
        error ? reject(error) : resolve();
      };
      const closed = () => done(new Error("Compression stream closed"));
      encoder.once("error", done);
      encoder.once("close", closed);
      run(done);
    });
  pump = (async () => {
    try {
      while (!encoder.destroyed) {
        const { done, value } = await reader.read();
        if (encoder.destroyed) break;
        if (done) {
          encoder.end();
          break;
        }
        await operation((callback) => encoder.write(value, callback));
        await operation((callback) =>
          encoder.flush(encoding === "br" ? constants.BROTLI_OPERATION_FLUSH : constants.Z_SYNC_FLUSH, callback),
        );
      }
    } catch (error) {
      encoder.destroy(error instanceof Error ? error : new Error(String(error)));
      await reader.cancel(error).catch(() => {});
    } finally {
      reader.releaseLock();
    }
  })();
  return output;
};

/** The encoding depends on these request headers, so caches must key on all of them. */
const mergeVary = (headers: Headers) => {
  const vary = headers.get("Vary");
  const tokens = vary?.split(",").map((token) => token.trim().toLowerCase()) ?? [];
  if (tokens.includes("*")) return;
  const missing = ["Accept-Encoding", "Sec-Fetch-Site", "Sec-Fetch-Dest"].filter((name) => !tokens.includes(name.toLowerCase()));
  if (missing.length > 0) headers.set("Vary", [vary, ...missing].filter(Boolean).join(", "));
};

/**
 * Compress an eligible HTML or JSON body for a same-origin, direct, or non-browser
 * request. Mutates only the copied client headers; any other body stays byte-identical.
 */
export const compressBody = (req: Request, response: Response, headers: Headers): ReadableStream<Uint8Array> | null => {
  const body = response.body;
  if (response.status === 304) {
    // A cache replaces the stored Vary and ETag with the ones on a 304. Keep the
    // gateway's keys, and keep the weak tag of a compressed copy the client holds.
    if (headers.has("Vary")) mergeVary(headers);
    const etag = headers.get("ETag");
    const held =
      req.headers
        .get("If-None-Match")
        ?.split(",")
        .map((tag) => tag.trim()) ?? [];
    if (etag?.startsWith('"') && held.includes(`W/${etag}`)) headers.set("ETag", `W/${etag}`);
  }
  if (!body || !isCompressionEligible(req.method, response.status, true, headers)) return body;
  mergeVary(headers);
  // The client's own no-transform asks intermediaries to leave the content unchanged.
  if (hasNoTransform(req.headers)) return body;
  // BREACH needs credentialed requests whose input the attacker chooses. Session
  // cookies are SameSite=Lax, so such requests are cross-site navigations; they
  // stay identity. Current browsers send Sec-Fetch-Site on HTTPS requests; a
  // request without it comes from a non-browser client or a browser too old for it.
  const site = req.headers.get("Sec-Fetch-Site");
  if (site !== null && site !== "same-origin" && site !== "none") return body;
  // Stored Markdown can embed same-origin images with a chosen URL, and pages echo
  // their path and query. Only documents and fetch/XHR get a compressed body;
  // HTML and JSON loaded as an image, style, script or frame gain nothing from it.
  const dest = req.headers.get("Sec-Fetch-Dest");
  if (dest !== null && dest !== "document" && dest !== "empty") return body;
  const encoding = chooseEncoding(req.headers.get("Accept-Encoding"));
  if (!encoding) return body;
  const length = headers.has("Content-Length") ? Number(headers.get("Content-Length")) : undefined;
  headers.set("Content-Encoding", encoding);
  headers.delete("Content-Length");
  headers.delete("Accept-Ranges");
  const etag = headers.get("ETag");
  if (etag?.startsWith('"')) headers.set("ETag", `W/${etag}`);
  return encodeStream(body, encoding, length);
};
