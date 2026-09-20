import { expect, test } from "bun:test";
import { readBoundedBody } from "./bounded-body";

const response = (value = "png") => new Response(value);

test("bounded reads reject oversized unknown-length and dishonest bodies", async () => {
  await expect(readBoundedBody(response("12345"), 4, new AbortController().signal)).rejects.toMatchObject({ code: "preview_too_large" });
  await expect(
    readBoundedBody(new Response("123", { headers: { "content-length": "2" } }), 4, new AbortController().signal),
  ).rejects.toMatchObject({ code: "unavailable" });
});

test("bounded reads cancel a hanging response at the total deadline", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  await expect(readBoundedBody(new Response(stream), 10, AbortSignal.timeout(10))).rejects.toBeDefined();
  expect(cancelled).toBe(true);
});
