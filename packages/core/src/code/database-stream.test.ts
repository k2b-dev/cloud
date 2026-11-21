import { expect, test } from "bun:test";
import { codeDatabaseStream } from "./database-stream";

test("database stream rejects overflow and truncated declared bodies", async () => {
  for (const [declared, actual] of [
    [8, 9],
    [8, 7],
    [undefined, 9],
  ] as const) {
    const response = new Response(new Uint8Array(actual), {
      headers: declared === undefined ? {} : { "content-length": String(declared) },
    });
    await expect(new Response(codeDatabaseStream(response, 8)).arrayBuffer()).rejects.toBeDefined();
  }
});

test("database stream rejects oversized declarations before pulling the body", () => {
  for (const declared of ["9", "NaN", "-1", "1.2"]) {
    const response = new Response(new Uint8Array(8), { headers: { "content-length": declared } });
    expect(() => codeDatabaseStream(response, 8)).toThrow("code_db_export_limit");
  }
});

test("cancelling the download cancels the producer without buffering the snapshot", async () => {
  const cancelled = Promise.withResolvers<void>();
  const upstream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled.resolve();
    },
  });
  const response = new Response(codeDatabaseStream(new Response(upstream), 100));
  await response.body?.cancel();
  expect(await cancelled.promise.then(() => "cancelled")).toBe("cancelled");
});
