import { expect, test } from "bun:test";
import { readPreviewSource } from "./generate";
import { textExcerpt } from "./text";

const encode = (text: string) => new TextEncoder().encode(text);

test("keeps complete text, and cuts a truncated prefix at the last newline", () => {
  expect(textExcerpt(encode("first\nlast"), false)).toBe("first\nlast");
  expect(textExcerpt(encode("first\r\nlast"), true)).toBe("first\r\n");
  expect(textExcerpt(encode("one long line"), true)).toBe("one long line");
  expect(textExcerpt(new Uint8Array(), false)).toBe("");
});
test("rejects malformed UTF-8 but permits a code point split by the prefix boundary", () => {
  expect(textExcerpt(new Uint8Array([0xff, 0x0a]), true)).toBeNull();
  expect(textExcerpt(encode("a€").slice(0, 3), true)).toBe("a");
  expect(textExcerpt(encode("a€").slice(0, 3), false)).toBeNull();
});
test("text stops at 2 KiB and cancels its source without reading the rest", async () => {
  let cancelled = false;
  let pulled = 0;
  const source = { key: "text", revision: "1", name: "file.txt", locator: "text", size: 5000 };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(c) {
        pulled++;
        c.enqueue(encode("x".repeat(3000)));
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const result = await readPreviewSource(async () => body, source, "text", new AbortController().signal);
  expect(result.bytes.length).toBe(2048);
  expect(result.truncated).toBe(true);
  expect(pulled).toBe(1);
  expect(cancelled).toBe(true);
});

test("a reader that returns late cannot retain a generator slot after cancellation", async () => {
  const abort = new AbortController();
  let resolve!: (response: Response) => void;
  let entered!: () => void;
  const started = new Promise<void>((done) => {
    entered = done;
  });
  const delayed = new Promise<Response>((done) => {
    resolve = done;
  });
  const pending = readPreviewSource(
    async () => {
      entered();
      return delayed;
    },
    { key: "late", revision: "1", locator: "late", name: "late.txt", size: 1 },
    "text",
    abort.signal,
  );
  await started;
  abort.abort(new Error("cancelled"));
  await expect(pending).rejects.toThrow("cancelled");
  let finished!: () => void;
  const cancelled = new Promise<void>((done) => {
    finished = done;
  });
  resolve(
    new Response(
      new ReadableStream({
        cancel() {
          finished();
        },
      }),
    ),
  );
  await cancelled;
});
