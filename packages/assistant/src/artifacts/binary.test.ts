import { expect, test } from "bun:test";
import { readBinaryResponse } from "./binary";

test("binary transfers enforce the byte budget across chunks", async () => {
  const response = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0, 255]));
          controller.enqueue(new Uint8Array([1, 128]));
          controller.close();
        },
      }),
    );
  expect(await readBinaryResponse(response(), 4)).toEqual(new Uint8Array([0, 255, 1, 128]));
  await expect(readBinaryResponse(response(), 3)).rejects.toMatchObject({ code: "STORAGE_FULL", message: expect.stringContaining("nothing was written") });
});
