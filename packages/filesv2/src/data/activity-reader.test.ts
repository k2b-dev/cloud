import { expect, mock, spyOn, test } from "bun:test";
import { type ReservedSQL, SQL, sql } from "bun";
import { type ActivityReadBudget, withActivityReadBudget } from "../service/activity-read-budget";

const services = await import("@k2b/cloud/services");
const warning = mock(() => {});
mock.module("@k2b/cloud/services", () => ({
  ...services,
  logger: () => ({ debug: mock(() => {}), info: mock(() => {}), warn: warning, error: mock(() => {}) }),
}));
const { activityReaderData } = await import("./activity-reader");

const id = "10000000-0000-4000-8000-000000000001";
const modes = ["list", "batch", "entry", "bases", "shareAccess"] as const;
function read(mode: (typeof modes)[number], budget: ActivityReadBudget) {
  if (mode === "entry") return activityReaderData.byId(id, budget);
  if (mode === "bases") return activityReaderData.activityBases(undefined, 50, budget);
  if (mode === "shareAccess") return activityReaderData.shareAccess({ shareId: id, from: "2030-05-01", to: "2030-05-15" }, { budget });
  return activityReaderData.candidates(
    {
      scope: { admin: false, userId: id, bindingIds: [] },
      batch: mode === "batch" ? { id, anchorId: id } : undefined,
      position: null,
      direction: "desc",
      limit: 50,
    },
    budget,
  );
}
function connectionFor(work: () => Promise<unknown>, close = mock(async () => {})) {
  const released = Promise.withResolvers<void>();
  const release = mock(() => released.resolve());
  const client = Object.assign(new SQL("postgres://localhost/unused_test"), {
    release,
    close,
    [Symbol.dispose]: release,
    savepoint: () => {
      throw new Error("Unexpected savepoint");
    },
  });
  const setup = mock(async (_remainingMs: number) => [{ pid: 12345 }]);
  const connection = new Proxy(client, {
    apply(_target, _receiver, [strings, ...values]) {
      if (strings.join("?").includes("pg_backend_pid")) return setup(values[0]);
      if (strings.join("?").includes("pg_cancel_backend")) expect(values).toEqual([12345]);
      return work();
    },
  });
  spyOn(client, "begin").mockImplementation(async (run) => {
    if (typeof run !== "function") throw new Error("Expected transaction callback");
    return run(connection);
  });
  return { connection, release, close, setup, released: released.promise };
}

test.each(modes)("aborting %s cancels only its reserved backend without waiting for the application pool", async (mode) => {
  const started = Promise.withResolvers<void>();
  const result = Promise.withResolvers<unknown[]>();
  const close = mock(async () => {
    result.reject(new Error("connection closed"));
  });
  const own = connectionFor(() => {
    started.resolve();
    return result.promise;
  }, close);
  const cancelResult = Promise.withResolvers<{ canceled: boolean }[]>();
  const cancel = mock(async () => {
    expect(own.release).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    return cancelResult.promise;
  });
  const control = connectionFor(cancel);
  const createControl = spyOn(Bun, "SQL").mockImplementation(() => control.connection);
  const reserve = spyOn(sql, "reserve").mockResolvedValue(own.connection);
  const sharedClose = spyOn(sql, "close");
  const controller = new AbortController();
  try {
    const pending = withActivityReadBudget(controller.signal, (budget) => read(mode, budget));
    const outcome = pending.catch((error: unknown) => error);
    await started.promise;
    expect(reserve.mock.calls[0]?.[0]?.signal?.aborted).toBe(false);
    const reason = new Error("reader canceled");
    controller.abort(reason);
    expect(await outcome).toBe(reason);
    expect(own.release).not.toHaveBeenCalled();
    cancelResult.resolve([{ canceled: true }]);
    await own.released;
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith({ timeout: 0 });
    expect(own.release).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(control.close).toHaveBeenCalledWith({ timeout: 0 });
    expect(createControl).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(sharedClose).not.toHaveBeenCalled();
  } finally {
    cancelResult.resolve([{ canceled: true }]);
    reserve.mockRestore();
    sharedClose.mockRestore();
    createControl.mockRestore();
  }
});

test.each(["success", "failure"])("a completed SQL %s releases its connection without closing it", async (mode) => {
  const failure = new Error("SQL failed");
  const own = connectionFor(() => (mode === "success" ? Promise.resolve([]) : Promise.reject(failure)));
  const reserve = spyOn(sql, "reserve").mockResolvedValue(own.connection);
  try {
    const outcome = await withActivityReadBudget(undefined, (budget) => read("list", budget)).catch((error: unknown) => error);
    expect(outcome).toEqual(mode === "success" ? [] : failure);
    expect(own.release).toHaveBeenCalledTimes(1);
    expect(own.close).not.toHaveBeenCalled();
  } finally {
    reserve.mockRestore();
  }
});

test("aborting a pool wait passes the budget signal and never starts SQL", async () => {
  const entered = Promise.withResolvers<void>();
  const reserve = spyOn(sql, "reserve").mockImplementation(({ signal } = {}) => {
    if (!signal) throw new Error("Missing pool reservation signal");
    entered.resolve();
    return new Promise<ReservedSQL>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const controller = new AbortController();
  try {
    const outcome = withActivityReadBudget(controller.signal, (budget) => read("list", budget)).catch((error: unknown) => error);
    await entered.promise;
    const reason = new Error("pool wait canceled");
    controller.abort(reason);
    expect(await outcome).toBe(reason);
  } finally {
    reserve.mockRestore();
  }
});

test("an abort immediately after reservation releases the unused connection without executing SQL", async () => {
  const controller = new AbortController();
  const work = mock(async () => []);
  const own = connectionFor(work);
  const reason = new Error("reservation canceled");
  const reserve = spyOn(sql, "reserve").mockImplementation(async () => {
    controller.abort(reason);
    return own.connection;
  });
  try {
    const outcome = await withActivityReadBudget(controller.signal, (budget) => read("list", budget)).catch((error: unknown) => error);
    expect(outcome).toBe(reason);
    expect(work).not.toHaveBeenCalled();
    expect(own.release).toHaveBeenCalledTimes(1);
    expect(own.close).not.toHaveBeenCalled();
  } finally {
    reserve.mockRestore();
  }
});

test("the server timeout uses only the budget remaining after a pool wait", async () => {
  let elapsed = 0;
  const now = spyOn(performance, "now").mockImplementation(() => elapsed);
  const own = connectionFor(async () => []);
  const reserve = spyOn(sql, "reserve").mockImplementation(async () => {
    elapsed = 4000;
    return own.connection;
  });
  try {
    await withActivityReadBudget(undefined, (budget) => read("list", budget));
    expect(own.setup).toHaveBeenCalledWith(6000);
  } finally {
    reserve.mockRestore();
    now.mockRestore();
  }
});

test("cancellation during SQL setup closes the session without starting a data query", async () => {
  const entered = Promise.withResolvers<void>();
  const setupResult = Promise.withResolvers<{ pid: number }[]>();
  const work = mock(async () => []);
  const own = connectionFor(
    work,
    mock(async () => setupResult.reject(new Error("connection closed"))),
  );
  own.setup.mockImplementation(async () => {
    entered.resolve();
    return setupResult.promise;
  });
  const reserve = spyOn(sql, "reserve").mockResolvedValue(own.connection);
  const controller = new AbortController();
  try {
    const outcome = withActivityReadBudget(controller.signal, (budget) => read("list", budget)).catch((error: unknown) => error);
    await entered.promise;
    const reason = new Error("setup canceled");
    controller.abort(reason);
    expect(await outcome).toBe(reason);
    expect(work).not.toHaveBeenCalled();
    expect(own.close).toHaveBeenCalledWith({ timeout: 0 });
    expect(own.release).toHaveBeenCalledTimes(1);
  } finally {
    reserve.mockRestore();
  }
});

test("a settled budget step removes its cancellation callback before handing control back", async () => {
  const controller = new AbortController();
  const cancel = mock(() => {});
  await withActivityReadBudget(controller.signal, async (budget) => {
    await budget.run(() => Promise.resolve("done"), cancel);
    controller.abort(new Error("next step canceled"));
    expect(cancel).not.toHaveBeenCalled();
  });
});

test("a failed cancellation connection is observed before the original query settles", async () => {
  const started = Promise.withResolvers<void>();
  const result = Promise.withResolvers<unknown[]>();
  const own = connectionFor(() => {
    started.resolve();
    return result.promise;
  });
  const control = connectionFor(async () => {
    throw new Error("cancellation connection unavailable");
  });
  const createControl = spyOn(Bun, "SQL").mockImplementation(() => control.connection);
  const reserve = spyOn(sql, "reserve").mockResolvedValue(own.connection);
  const controller = new AbortController();
  try {
    const outcome = withActivityReadBudget(controller.signal, (budget) => read("list", budget)).catch((error: unknown) => error);
    await started.promise;
    const reason = new Error("reader canceled");
    controller.abort(reason);
    expect(await outcome).toBe(reason);
    // A real socket close settles an in-flight transaction on a later I/O
    // turn. An unobserved cleanup rejection must fail this test before that.
    await Bun.sleep(0);
    expect(own.close).toHaveBeenCalledWith({ timeout: 0 });
    expect(control.close).toHaveBeenCalledWith({ timeout: 0 });
    expect(own.release).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith("History SQL cancellation failed", { error: expect.any(Error) });
    result.reject(new Error("socket closed"));
    await own.released;
    expect(own.release).toHaveBeenCalledTimes(1);
  } finally {
    result.reject(new Error("socket closed"));
    reserve.mockRestore();
    createControl.mockRestore();
  }
});
