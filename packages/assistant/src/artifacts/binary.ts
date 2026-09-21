import { AiFileWriteError } from "@k2b/cloud/ai";
/** Bound streamed server-side transfers before retaining their bytes. */
export async function readBinaryResponse(response: Response, maximumBytes: number): Promise<Uint8Array> {
  if (!response.body) throw new Error("The file response has no body.");
  let size = 0;
  const bounded = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > maximumBytes)
          throw new AiFileWriteError("STORAGE_FULL", "The exported file exceeds the destination file limit; nothing was written.");
        controller.enqueue(chunk);
      },
    }),
  );
  return new Uint8Array(await new Response(bounded).arrayBuffer());
}
