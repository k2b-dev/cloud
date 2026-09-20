import { CapabilityStreamSchema, CapabilityStreamStatusSchema, capabilityResultSchema } from "@k2b/cloud/contracts";
import { z } from "zod";
import { LIMITS } from "../contracts";

export const RuntimeStream = CapabilityStreamSchema.extend({ callId: z.uuid() }).strict();
export type RuntimeStream = z.infer<typeof RuntimeStream>;
export async function runStream(ref: RuntimeStream, verb: string, body: Blob | undefined, signal: AbortSignal) {
  if (ref.size > LIMITS.inputFileBytes) throw new Error("Stream exceeds the 50 MiB code-run file budget");
  if (verb === "write" && (!body || body.size !== ref.size)) throw new Error("Upload size differs from the authorized stream");
  const response = await fetch(`/api/assistant/artifacts/runtime/capabilities/${encodeURIComponent(ref.callId)}/stream/${verb}`, {
    method: "POST",
    body: verb === "write" ? body : undefined,
    signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]),
    credentials: "same-origin",
    redirect: "error",
    headers: { "content-type": "application/octet-stream" },
  });
  if (!response.ok) throw new Error(`Stream ${verb} failed (HTTP ${response.status}); inspect upload status before retrying`);
  if (verb !== "read") {
    const json = await response.json();
    return verb === "write" ? capabilityResultSchema(z.unknown()).parse(json) : CapabilityStreamStatusSchema.parse(json);
  }
  if (!response.body) throw new Error("Missing stream body");
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > ref.size) throw new Error("Stream exceeded its declared size");
      chunks.push(new Uint8Array(next.value));
    }
    if (size !== ref.size) throw new Error("Incomplete stream");
    return new File(chunks, ref.name ?? "content", { type: ref.mediaType });
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
