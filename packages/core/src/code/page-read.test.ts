import { expect, mock, test } from "bun:test";
import { readPageSnapshot } from "./page-read";

test("cancellation bounds an uncooperative read and cancels Bun SQL where supported", async () => {
  for (const cancellable of [false, true]) {
    const controller = new AbortController();
    const gate = Promise.withResolvers<string>();
    const cancel = mock(() => {});
    const work = cancellable ? Object.assign(gate.promise, { cancel }) : gate.promise;
    const read = readPageSnapshot(controller.signal, () => work);
    controller.abort(new DOMException("Turn stopped", "AbortError"));
    await expect(read).rejects.toThrow("Turn stopped");
    expect(cancel).toHaveBeenCalledTimes(cancellable ? 1 : 0);
    gate.reject(new Error("Late read failure is observed"));
  }
});

test("an expired budget starts no read; completed reads detach their abort handler", async () => {
  const controller = new AbortController();
  const cancel = mock(() => {});
  expect(await readPageSnapshot(controller.signal, () => Object.assign(Promise.resolve("pages"), { cancel }))).toBe("pages");
  controller.abort(new DOMException("Read budget exceeded", "TimeoutError"));
  expect(cancel).not.toHaveBeenCalled();
  const read = mock(async () => "must not read");
  await expect(readPageSnapshot(controller.signal, read)).rejects.toThrow("Read budget exceeded");
  expect(read).not.toHaveBeenCalled();
});
