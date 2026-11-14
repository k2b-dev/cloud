import { getApp } from "@k2b/cloud";
import { signCodeOwnerRead } from "@k2b/cloud/capabilities/server";
import { CAPABILITY_MAX_RESULT_BYTES, cloudResourceRefAppId } from "@k2b/cloud/contracts";
import { z } from "zod";

class CodeOwnerTransportError extends Error {}
async function body(response: Response): Promise<unknown> {
  if (!response.body) throw new CodeOwnerTransportError("Owner unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > CAPABILITY_MAX_RESULT_BYTES) throw new CodeOwnerTransportError("Owner response invalid");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
  }
  const combined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(combined));
  } catch {
    throw new CodeOwnerTransportError("Owner response invalid");
  }
}
async function decode<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new CodeOwnerTransportError(`Owner HTTP ${response.status}`);
  }
  const parsed = z.object({ data: schema }).safeParse(await body(response));
  if (!parsed.success) throw new CodeOwnerTransportError("Owner response invalid");
  return parsed.data.data;
}

/** Core-only, title-only projection under the exact owning Code account. No session is retained. */
export async function readCodeResourceOwnerTitle(
  ref: { type: string; id: string },
  principal: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const appId = cloudResourceRefAppId(ref);
  const app = await getApp(appId);
  if (!app) throw new CodeOwnerTransportError("Owner unavailable");
  const token = await signCodeOwnerRead(appId, principal);
  return (
    await decode(
      await fetch(new URL("/api/_internal/capabilities/v1/code-owner/queries/code.owner.title", app.baseUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(ref),
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      }),
      z.object({ title: z.string().min(1).max(500).nullable() }).strict(),
    )
  ).title;
}
