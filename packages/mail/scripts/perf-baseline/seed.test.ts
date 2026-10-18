import { expect, mock, spyOn, test } from "bun:test";
import { seedWithAbort } from "./seed";

test("abort immediately closes the observer to interrupt a pending seed and allow cleanup", async () => {
  const controller = new AbortController();
  const query = Promise.withResolvers<string>();
  const db = {
    close: mock(async () => {
      query.reject(new Error("Observer closed"));
    }),
  };
  const remove = spyOn(controller.signal, "removeEventListener");
  let cleaned = false;
  const seeding = seedWithAbort(db, controller.signal, () => query.promise).finally(() => {
    cleaned = true;
  });
  controller.abort();
  expect(db.close).toHaveBeenCalledWith({ timeout: 0 });
  await expect(seeding).rejects.toThrow("Observer closed");
  expect(cleaned).toBe(true);
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  remove.mockRestore();
});

test("completed or failed seeds remove the abort listener; pre-aborted runs never start seeding", async () => {
  for (const fail of [false, true]) {
    const controller = new AbortController();
    const db = { close: mock(async () => {}) };
    const seeding = seedWithAbort(db, controller.signal, async () => {
      if (fail) throw new Error("Seed failed");
      return "fixture";
    });
    if (fail) await expect(seeding).rejects.toThrow("Seed failed");
    else expect(await seeding).toBe("fixture");
    controller.abort();
    expect(db.close).not.toHaveBeenCalled();
    const seed = mock(async () => "fixture");
    await expect(seedWithAbort(db, controller.signal, seed)).rejects.toThrow();
    expect(seed).not.toHaveBeenCalled();
    expect(db.close).not.toHaveBeenCalled();
  }
});
