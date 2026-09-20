import { type CapabilityStream, CapabilityStreamSchema } from "../contracts/capabilities";
import type { CapabilityHttpOptions } from "./types";

export type CapabilityStreamVerb = "read" | "write" | "status" | "abort";
/** Binary bodies never pass through the JSON capability envelope. */
export async function transferCapabilityStream(
  stream: CapabilityStream,
  verb: CapabilityStreamVerb,
  options: CapabilityHttpOptions & {
    body?: BodyInit;
    signal?: AbortSignal;
  } = {},
): Promise<Response> {
  const ref = CapabilityStreamSchema.parse(stream);
  const headers = new Headers(options.headers);
  headers.set("x-cloud-stream-id", ref.id);
  headers.set("content-type", "application/octet-stream");
  return (options.fetch ?? fetch)(`${(options.baseUrl ?? "/api").replace(/\/$/, "")}/capabilities/v1/streams/${verb}`, {
    method: "POST",
    headers,
    body: options.body,
    signal: options.signal,
    credentials: "same-origin",
    redirect: "error",
    // @ts-expect-error Server clients may supply a ReadableStream.
    duplex: options.body instanceof ReadableStream ? "half" : undefined,
  });
}
