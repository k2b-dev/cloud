/** Enforce the declared byte count while preserving backpressure and cancellation. */
export function exactStream(body: ReadableStream<Uint8Array>, size: number): ReadableStream<Uint8Array> {
  let count = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        count += chunk.byteLength;
        if (count > size) throw new Error("Stream exceeds declared size");
        controller.enqueue(chunk);
      },
      flush() {
        if (count !== size) throw new Error("Stream ended before declared size");
      },
    }),
  );
}
