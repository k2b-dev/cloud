import { isServiceError } from "@k2b/stdlib";
import { exactStream } from "../capabilities/stream-body";
import type { CapabilityExecutionContext } from "../contracts/capabilities";
import {
  CAPABILITY_MAX_RESULT_BYTES,
  CapabilityStreamSchema,
  CapabilityStreamStatusSchema,
  capabilityResultSchema,
} from "../contracts/capabilities";
import type { CompiledCapabilities } from "./capabilities";

const failure = (status: number, code: string, message: string) => Response.json({ code, message }, { status });
export async function invokeCapabilityStream(params: {
  compiled: CompiledCapabilities;
  kind: "queries" | "actions";
  localId: string;
  verb: string;
  request: Request;
  context: CapabilityExecutionContext;
}): Promise<Response> {
  const operation = params.compiled[params.kind].get(params.localId);
  const definition = operation?.definition.stream;
  if (!operation || !definition) return failure(404, "STREAM_NOT_FOUND", "Stream operation not found");
  const offer = params.request.headers.get("x-cloud-stream-offer");
  if (!offer || offer.length > 24000) return failure(400, "STREAM_INVALID", "Invalid stream offer");
  const receipt = (value: unknown) => {
    const parsed = capabilityResultSchema(operation.definition.data).parse(value);
    if (parsed.stream) throw new Error("Stream receipts cannot issue another stream");
    return parsed;
  };
  try {
    const stream = CapabilityStreamSchema.parse(JSON.parse(Buffer.from(offer, "base64url").toString()));
    if (stream.direction !== definition.direction || stream.size > definition.maxBytes || Date.parse(stream.expiresAt) <= Date.now())
      return failure(410, "STREAM_EXPIRED", "Stream expired or outside its byte budget");
    if (definition.direction === "read") {
      if (params.verb !== "read") return failure(403, "STREAM_DENIED", "Read-only stream");
      const response = await definition.read(stream, params.context);
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        return failure(502, "STREAM_FAILED", "Source could not be read");
      }
      return new Response(exactStream(response.body, stream.size), {
        headers: { "content-type": stream.mediaType, "cache-control": "no-store" },
      });
    }
    let result: unknown;
    if (params.verb === "write") {
      const body = exactStream(
        params.request.body ??
          new ReadableStream({
            start(c) {
              c.close();
            },
          }),
        stream.size,
      );
      try {
        const value = await definition.write(stream, body, params.context);
        result = receipt(value);
      } finally {
        if (!body.locked) await body.cancel().catch(() => undefined);
      }
    } else if (params.verb === "status") {
      const status = CapabilityStreamStatusSchema.parse(await definition.status(stream, params.context));
      if (status.state === "completed") receipt(status.result);
      result = status;
    } else if (params.verb === "abort") {
      await definition.abort(stream, params.context);
      const status = CapabilityStreamStatusSchema.parse(await definition.status(stream, params.context));
      if (status.state === "completed") receipt(status.result);
      result = status;
    } else return failure(400, "STREAM_INVALID", "Unknown stream operation");
    const json = JSON.stringify(result);
    if (Buffer.byteLength(json) > CAPABILITY_MAX_RESULT_BYTES)
      return failure(502, "STREAM_FAILED", "Stream receipt is too large; inspect status before retrying");
    return new Response(json, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch (error) {
    if (isServiceError(error)) return failure(error.status, error.code, error.message);
    return failure(409, "STREAM_FAILED", "Transfer failed; inspect status before retrying a write");
  }
}
