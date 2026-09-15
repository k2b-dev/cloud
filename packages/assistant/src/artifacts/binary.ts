/** Bound streamed server-side transfers before retaining their bytes. */
export async function readBinaryResponse(response: Response, maximumBytes: number): Promise<Uint8Array> {
  if (!response.body) throw new Error("The file response has no body.");
  let size = 0;
  const bounded = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > maximumBytes) throw new Error("The exported file exceeds the destination file limit.");
        controller.enqueue(chunk);
      },
    }),
  );
  return new Uint8Array(await new Response(bounded).arrayBuffer());
}
