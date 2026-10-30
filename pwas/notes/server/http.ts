import { NotesError } from "./errors";
import { limits } from "./limits";

export const requireOrigin = (request: Request, origin: string): void => {
  if (request.headers.get("origin") !== origin) throw new NotesError("origin_forbidden", 403);
};
/** Count bytes while reading; Content-Length alone does not bound chunked bodies. */
export const boundedBody = async (request: Request, maximum: number): Promise<Uint8Array<ArrayBuffer>> => {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) throw new NotesError("body_limit", 413);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  let expired = false;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  request.signal.addEventListener("abort", abort, { once: true });
  const deadline = setTimeout(() => {
    expired = true;
    abort();
  }, limits.heartbeatMs);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      if (request.signal.aborted) throw new NotesError("request_aborted", 400);
      const result = await reader.read();
      if (expired) throw new NotesError("body_timeout", 408);
      if (request.signal.aborted) throw new NotesError("request_aborted", 400);
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maximum) throw new NotesError("body_limit", 413);
      chunks.push(result.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    clearTimeout(deadline);
    request.signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};
export const boundedJson = async (request: Request, maximum: number): Promise<unknown> => {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") throw new NotesError("json_required");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await boundedBody(request, maximum)));
  } catch (error) {
    if (error instanceof NotesError) throw error;
    throw new NotesError("invalid_json");
  }
};
export const snapshotBytes = (value: string): Uint8Array => {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new NotesError("invalid_snapshot");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new NotesError("invalid_snapshot");
  return bytes;
};
