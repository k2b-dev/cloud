/** Buffer at most one Filegate segment; await its write before reading more. */
export async function uploadStreamChunks(
  body: ReadableStream<Uint8Array>,
  size: number,
  chunkSize: number,
  put: (index: number, chunk: Uint8Array<ArrayBuffer>) => Promise<unknown>,
) {
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new Error("Invalid Filegate chunk size");
  const reader = body.getReader();
  let total = 0,
    index = 0,
    used = 0;
  let buffer = new Uint8Array(Math.min(chunkSize, size));
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      if (total + item.value.byteLength > size) throw new Error("Upload exceeds declared size");
      let offset = 0;
      while (offset < item.value.byteLength) {
        const count = Math.min(buffer.length - used, item.value.byteLength - offset);
        buffer.set(item.value.subarray(offset, offset + count), used);
        used += count;
        offset += count;
        total += count;
        if (used === buffer.length) {
          await put(index++, buffer);
          used = 0;
          buffer = new Uint8Array(Math.min(chunkSize, size - total));
        }
      }
    }
    if (total !== size) throw new Error("Incomplete upload");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
