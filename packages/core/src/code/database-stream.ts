/** Stream a bounded SQLite snapshot, rejecting incomplete declared bodies. No complete database is buffered. */
export function codeDatabaseStream(response: Response, maximum: number): ReadableStream<Uint8Array> {
  if (!response.ok || !response.body) throw new Error("code_db_unavailable");
  const header = response.headers.get("content-length");
  const declared = header === null ? null : Number(header);
  if (declared !== null && (!Number.isSafeInteger(declared) || declared < 0 || declared > maximum)) {
    void response.body.cancel();
    throw new Error("code_db_export_limit");
  }
  let bytes = 0;
  return response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > maximum || (declared !== null && bytes > declared)) throw new Error("code_db_export_limit");
        controller.enqueue(chunk);
      },
      flush() {
        if (declared !== null && bytes !== declared) throw new Error("code_db_export_incomplete");
      },
    }),
  );
}
