import { expect, mock, spyOn, test } from "bun:test";
import { anchor, digestPlan, fixtureShortIds, planLargeMailbox } from "../../test/fixtures/large-mailbox";
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

test("two mailbox plans reserve globally unique short IDs while retaining deterministic fixture content", () => {
  for (const seed of [0, 20261001, 4294967295]) {
    const parameters = { seed, anchor, messages: 20000, conversations: 3000, folders: 30 };
    const a = planLargeMailbox(parameters);
    const ids = fixtureShortIds(a);
    const bParameters = { ...parameters, seed: (seed + 1) >>> 0 };
    const b = planLargeMailbox(bParameters, ids);
    const bIds = fixtureShortIds(b);
    expect(new Set([...ids, ...bIds]).size).toBe(ids.length + bIds.length);
    expect(digestPlan(b)).toBe(digestPlan(planLargeMailbox(bParameters, ids)));
    expect(b.bodyCorpus).not.toBe(a.bodyCorpus);
    // Stable folder keys and identity addresses are scoped to the new resource/mailbox.
    expect(b.folders.map((folder) => folder.stableKey)).toEqual(a.folders.map((folder) => folder.stableKey));
    expect(b.parameters).toEqual(bParameters);
  }
  const parameters = { seed: 42, anchor, messages: 100, conversations: 10, folders: 8 };
  const a = planLargeMailbox(parameters);
  // Force collision retries, rather than relying on two random plans happening to collide.
  const b = planLargeMailbox(parameters, fixtureShortIds(a));
  const ids = [...fixtureShortIds(a), ...fixtureShortIds(b)];
  expect(new Set(ids).size).toBe(ids.length);
});
