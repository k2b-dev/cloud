import { expect, test } from "bun:test";
import { uploadStreamChunks } from "./stream-chunks";

test("stream uploads split arbitrary input boundaries into exact Filegate chunks", async () => {
  const chunks: Uint8Array[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array([1]));
      c.enqueue(new Uint8Array([2, 3, 4, 5, 6]));
      c.enqueue(new Uint8Array([7]));
      c.close();
    },
  });
  await uploadStreamChunks(body, 7, 3, async (index, bytes) => {
    expect(index).toBe(chunks.length);
    chunks.push(bytes);
  });
  expect(chunks.map((c) => [...c])).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
});
test("short and oversized bodies fail; empty files need no segment", async () => {
  await expect(uploadStreamChunks(new Blob(["abc"]).stream(), 4, 2, async () => {})).rejects.toThrow("Incomplete");
  await expect(uploadStreamChunks(new Blob(["abc"]).stream(), 2, 2, async () => {})).rejects.toThrow("exceeds");
  let count = 0;
  await uploadStreamChunks(new Blob([]).stream(), 0, 2, async () => {
    count++;
  });
  expect(count).toBe(0);
});
test("failed segment cancels the source and cannot reach a later segment", async () => {
  let cancelled = false,
    calls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      c.enqueue(new Uint8Array(3));
    },
    cancel() {
      cancelled = true;
    },
  });
  await expect(
    uploadStreamChunks(body, 9, 3, async () => {
      calls++;
      throw new Error("offline");
    }),
  ).rejects.toThrow("offline");
  expect(calls).toBe(1);
  expect(cancelled).toBe(true);
});
