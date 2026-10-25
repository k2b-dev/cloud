import { expect, spyOn, test } from "bun:test";
import { REQUEST_IDLE_TIMEOUT_SECONDS } from "@k2b/cloud/server";
import { actorId, baseId, candidate, historyFixture, home } from "../../test/activity-reader-fixture";
import { testActor, testCall } from "../../test/files-call";

const call = testCall(testActor);

test("batch context ignores search text and counts local grant-authorized peers, and returns only visible count/completeness", async () => {
  const anchor = candidate(1, { path_before: null });
  const f = historyFixture([
    anchor,
    candidate(2, { path_before: null, path_after: `${home}/secret` }),
    candidate(3, { path_before: `${home}/secret`, path_after: `${home}/peer` }),
    candidate(4, { path_before: `${home}/peer`, path_after: `${home}/secret` }),
    candidate(5, { batch_id: "30000000-0000-4000-8000-000000000002" }),
  ]);
  f.nodes.set(`${home}/secret`, f.node(`${home}/secret`, "stable-a"));
  f.nodes.set(`${home}/peer`, f.node(`${home}/peer`, "stable-a"));
  f.denied.add("secret");
  expect((await f.reader.activity(call, { q: "new" })).batches.find((batch) => batch.id === anchor.batch_id)?.visibleCount).toBe(1);
  f.database.length = 0;
  f.deps.displayNames = async () => {
    throw new Error("Batch context must not resolve people");
  };
  expect(await f.reader.activityBatchContext(call, { activityId: anchor.id })).toEqual({ visibleCount: 4, complete: true });
  expect(f.database).toHaveLength(1);
  expect(f.database[0]).toEqual({
    scope: { admin: false, userId: actorId, bindingIds: [baseId], serverUrl: "http://filegate.test" },
    batch: { id: "30000000-0000-4000-8000-000000000001", anchorId: anchor.id },
    position: null,
    direction: "desc",
    limit: 499,
  });
  f.setMember(false);
  f.database.length = 0;
  await expect(f.reader.activityBatchContext(call, { activityId: anchor.id })).rejects.toMatchObject({ code: "not_found", status: 404 });
  expect(f.database).toEqual([]);
});

test("revoked grants hide own batch snapshots before querying peers", async () => {
  const own = candidate(1, { actor_user_id: actorId });
  const f = historyFixture([own, candidate(2, { actor_user_id: actorId })]);
  f.setMember(false);
  await expect(f.reader.activityBatchContext(call, { activityId: own.id })).rejects.toMatchObject({ code: "not_found", status: 404 });
  expect(f.database).toEqual([]);
  expect(f.requests).toEqual([]);
});

test("unknown, denied and unbatched anchors have the same opaque 404 before querying any peers", async () => {
  const unbatched = candidate(1, { batch_id: null });
  const hidden = candidate(2, { path_before: null });
  const f = historyFixture([unbatched, hidden]);
  f.setMember(false);
  for (const id of [unbatched.id, hidden.id, candidate(99).id])
    await expect(f.reader.activityBatchContext(call, { activityId: id })).rejects.toMatchObject({ code: "not_found", status: 404 });
  expect(f.database).toEqual([]);
});

test.each([499, 500, 501])(
  "batch of %i candidates counts its anchor even outside the newest slice and marks the bound truthfully",
  async (size) => {
    const rows = Array.from({ length: size }, (_, index) => candidate(index + 1, { actor_user_id: actorId }));
    const f = historyFixture(rows);
    f.setMember(true);
    expect(await f.reader.activityBatchContext(call, { activityId: rows[0]!.id })).toEqual({
      visibleCount: Math.min(size, 500),
      complete: size < 500,
    });
    expect(f.database).toHaveLength(1);
    expect(f.database[0]?.limit).toBe(499);
  },
);

test.each(["abort", "deadline"])("batch context shares one request budget and returns no partial count on %s", async (mode) => {
  const schedule = spyOn(globalThis, "setTimeout");
  const clear = spyOn(globalThis, "clearTimeout");
  try {
    const anchor = candidate(1, { actor_user_id: actorId });
    const f = historyFixture([anchor]);
    const controller = new AbortController();
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let canceled = 0;
    f.deps.data!.candidates = async (_input, budget) =>
      budget!.run(
        () =>
          new Promise<never>(() => {
            ready();
          }),
        () => {
          canceled++;
        },
      );
    const pending = f.reader.activityBatchContext({ ...call, requestAbort: controller.signal }, { activityId: anchor.id }).then(
      () => null,
      (error: unknown) => error,
    );
    await started;
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule.mock.calls[0]?.[1]).toBe(REQUEST_IDLE_TIMEOUT_SECONDS * 1000);
    if (mode === "abort") controller.abort(new Error("batch canceled"));
    else {
      const expire = schedule.mock.calls[0]?.[0];
      if (typeof expire !== "function") throw new Error("Missing deadline");
      expire();
    }
    expect(await pending).toMatchObject(mode === "abort" ? { message: "batch canceled" } : { code: "unavailable", status: 503 });
    expect(canceled).toBe(1);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(f.requests).toEqual([]);
  } finally {
    schedule.mockRestore();
    clear.mockRestore();
  }
});

test("already canceled batch reads do not enter identity, SQL or storage", async () => {
  const f = historyFixture();
  const context = spyOn(f.deps, "requestContext");
  const controller = new AbortController();
  controller.abort(new Error("batch canceled"));
  try {
    await expect(
      f.reader.activityBatchContext({ ...call, requestAbort: controller.signal }, { activityId: candidate().id }),
    ).rejects.toThrow("batch canceled");
    expect(context).not.toHaveBeenCalled();
    expect(f.database).toEqual([]);
    expect(f.requests).toEqual([]);
  } finally {
    context.mockRestore();
  }
});
