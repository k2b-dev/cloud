/** A verified stream violated its declared byte count; no provider content is retained. */
export class CapabilityStreamSizeError extends Error {
  constructor(readonly reason: "overflow" | "underflow") {
    super(reason === "overflow" ? "Stream exceeds declared size" : "Stream ended before declared size");
  }
}

/** Enforce the declared byte count while preserving backpressure and cancellation. */
export function exactStream(body: ReadableStream<Uint8Array>, size: number): ReadableStream<Uint8Array> {
  let count = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        count += chunk.byteLength;
        if (count > size) throw new CapabilityStreamSizeError("overflow");
        controller.enqueue(chunk);
      },
      flush() {
        if (count !== size) throw new CapabilityStreamSizeError("underflow");
      },
    }),
  );
}
