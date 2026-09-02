export type BoundedJsonResult = { ok: true; data: unknown } | { ok: false; reason: "too_large" | "invalid_json" };

/** Reads JSON without allowing a missing or forged Content-Length to bypass the byte cap. */
export const readBoundedJson = async (message: Request | Response, maxBytes: number): Promise<BoundedJsonResult> => {
  const declared = message.headers.get("content-length");
  if (declared !== null) {
    const bytes = Number(declared);
    if (Number.isFinite(bytes) && bytes > maxBytes) {
      await message.body?.cancel().catch(() => undefined);
      return { ok: false, reason: "too_large" };
    }
  }

  const reader = message.body?.getReader();
  if (!reader) return { ok: false, reason: "invalid_json" };

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too_large" };
      }
      chunks.push(next.value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return { ok: false, reason: "invalid_json" };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return { ok: true, data: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
};
