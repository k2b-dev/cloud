import { expect, test } from "bun:test";
import { Filegate } from "@valentinkolb/filegate/client";

const bytes = [0, 128, 255];
const inputs = [
  { name: "ArrayBuffer", data: () => new Uint8Array(bytes).buffer },
  { name: "Blob", data: () => new Blob([new Uint8Array(bytes)]) },
  { name: "Uint8Array slice", data: () => new Uint8Array([42, ...bytes, 43]).subarray(1, 4) },
  { name: "Buffer slice", data: () => Buffer.from([42, ...bytes, 43]).subarray(1, 4) },
  {
    name: "SharedArrayBuffer slice",
    data: () => {
      const data = new Uint8Array(new SharedArrayBuffer(5));
      data.set([42, ...bytes, 43]);
      return data.subarray(1, 4);
    },
  },
];

for (const operation of ["single", "chunk"] as const) {
  for (const input of inputs) {
    test(`Filegate ${operation} upload preserves exact ${input.name} bytes`, async () => {
      let received: { method: string; path: string; bytes: number[]; authorization: string | null } | undefined;
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          received = {
            method: request.method,
            path: new URL(request.url).pathname,
            bytes: Array.from(new Uint8Array(await request.arrayBuffer())),
            authorization: request.headers.get("authorization"),
          };
          return Response.json({ accepted: true });
        },
      });
      try {
        const client = new Filegate({ url: `http://127.0.0.1:${server.port}`, token: "test-only" });
        const data = input.data();
        const result =
          operation === "single"
            ? await client.upload.single({ path: "/test", filename: "bytes.bin", data })
            : await client.upload.chunked.send({ uploadId: "test-upload", index: 0, data });
        expect(result.ok).toBe(true);
        expect(received).toEqual({
          method: operation === "single" ? "PUT" : "POST",
          path: operation === "single" ? "/files/content" : "/files/upload/chunk",
          bytes,
          authorization: "Bearer test-only",
        });
      } finally {
        await server.stop(true);
      }
    });
  }
}
