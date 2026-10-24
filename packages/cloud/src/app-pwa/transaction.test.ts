import { afterEach, expect, spyOn, test } from "bun:test";
import * as bun from "bun";
import { SQL, type TransactionSQL } from "bun";
import { boundTransaction } from "./authority";
import { withAppPwaTransaction, withAppPwaTransactionLease } from "./transaction";

const NativeSQL = SQL;
afterEach(() => Object.defineProperty(bun, "SQL", { value: NativeSQL }));

const fixture = () => {
  const statements: string[] = [];
  const values: unknown[] = [];
  let cancelled = 0;
  let executed = 0;
  const client = Object.assign(new NativeSQL("postgres://unused:unused@invalid.test/unused_test"), {
    savepoint: (..._args: unknown[]): never => {
      throw new Error("fixture savepoint not used");
    },
  });
  const tx: TransactionSQL = new Proxy(client, {
    apply(_target, _receiver, args) {
      statements.push(Array.isArray(args[0]) ? args[0].join("?") : String(args[0]));
      values.push(...args.slice(1));
      return {
        cancel: () => {
          cancelled++;
        },
        then: (yes: (result: unknown[]) => unknown, no: (error: unknown) => unknown) => {
          executed++;
          return Promise.resolve([]).then(yes, no);
        },
      };
    },
  });
  return { tx, statements, values, cancelled: () => cancelled, executed: () => executed };
};

test("transaction configuration uses only PostgreSQL 15–17 settings and the HTTP request budget", async () => {
  const f = fixture();
  await boundTransaction(f.tx, 173);
  expect(f.statements.join(" ")).not.toContain("'transaction_timeout'");
  for (const setting of ["statement_timeout", "lock_timeout", "idle_in_transaction_session_timeout"])
    expect(f.statements.join(" ")).toContain(`'${setting}'`);
  expect(f.values).toEqual(["173ms", "173ms", "173ms"]);
});

test("a cancelled callback releases its lease and cannot execute late or pre-created lazy SQL", async () => {
  const f = fixture();
  const controller = new AbortController();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let completed = () => {};
  const done = new Promise<void>((resolve) => {
    completed = resolve;
  });
  let entered = () => {};
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const running = withAppPwaTransactionLease(f.tx, controller.signal, async (tx) => {
    await tx`SELECT 1`;
    const lazy = tx`UPDATE domain SET saved = true`;
    entered();
    await gate;
    try {
      await expect(Promise.resolve(lazy)).rejects.toMatchObject({ code: "UNAVAILABLE" });
      expect(() => tx`UPDATE domain SET saved = true`).toThrow("UNAVAILABLE");
    } finally {
      completed();
    }
  });
  await ready;
  controller.abort();
  await expect(running).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(f.cancelled()).toBe(1);
  release();
  await done;
  expect(f.executed()).toBe(1);
});

test("closing an unstarted native query observes its rejection without executing it", async () => {
  const f = fixture();
  const native = Promise.withResolvers<unknown[]>();
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let executions = 0;
  const lazy = Object.assign(native.promise, {
    cancel: () => native.reject(new Error("Connection closed")),
    then: (...args: Parameters<typeof native.promise.then>) => {
      executions++;
      return Promise.prototype.then.apply(native.promise, args);
    },
  });
  const connection = new Proxy(f.tx, { apply: () => lazy });
  const controller = new AbortController();
  const running = withAppPwaTransactionLease(connection, controller.signal, async (tx) => {
    tx`UPDATE domain SET saved=true`;
    entered.resolve();
    await gate.promise;
  });
  await entered.promise;
  controller.abort();
  await expect(running).rejects.toMatchObject({ code: "UNAVAILABLE" });
  gate.resolve();
  await Promise.resolve();
  expect(executions).toBe(0);
});

test("a fulfilled callback also closes captured SQL and forbids connection escape", async () => {
  const f = fixture();
  let captured: TransactionSQL | undefined;
  expect(
    await withAppPwaTransactionLease(f.tx, new AbortController().signal, async (tx) => {
      captured = tx;
      expect(() => tx.reserve()).toThrow("FORBIDDEN");
      return 7;
    }),
  ).toBe(7);
  expect(() => {
    if (captured) captured`SELECT 1`;
  }).toThrow("UNAVAILABLE");
});

const deferred = <T>() => Promise.withResolvers<T>();
const clock = new Date("2030-01-01T00:00:00.000Z");
const lifecycleFixture = (sslMode = "verify-full") => {
  const statements: string[] = [];
  const cancelled: string[] = [];
  const budgets: unknown[] = [];
  const events: string[] = [];
  let time = clock;
  let onQuery: (statement: string) => Promise<unknown> = async () => [];
  const pending = new Map<string, (error: unknown) => void>();
  const controlEvents: string[] = [];
  const controlSetup: string[] = [];
  const controlCalls: { statement: string; values: unknown[] }[] = [];
  const controlOptions: unknown[] = [];
  const controlNormalized: unknown[] = [];
  let controlPending: ReturnType<typeof deferred<unknown>> | undefined;
  const cancelPending = () => {
    for (const reject of pending.values()) reject(new Error("PostgreSQL 57014"));
  };
  let onServerCancel = async (): Promise<unknown> => {
    cancelPending();
    return [{ cancelled: true }];
  };
  let onClose = async () => {
    for (const reject of pending.values()) reject(new Error("connection closed"));
  };
  const client = new NativeSQL("postgres://unused:unused@invalid.test/unused_test");
  const connection = Object.assign(
    new Proxy(client, {
      get(target, property) {
        if (property === "unsafe")
          return (statement: string, args: unknown[] = []) => Reflect.apply(connection, undefined, [statement, ...args]);
        return Reflect.get(target, property, target);
      },
      apply(_target, _receiver, args) {
        const statement = (typeof args[0] === "string" ? args[0] : args[0].join("?")).trim();
        const result = deferred<unknown>();
        let started = false;
        return new Proxy(client.unsafe(statement), {
          get(target, property) {
            if (property === "cancel")
              return () => {
                cancelled.push(statement);
                // Installed Bun native Query.cancel is a no-op for running SQL.
              };
            if (property === "then")
              return (yes: (value: unknown) => unknown, no: (error: unknown) => unknown) => {
                if (!started) {
                  started = true;
                  statements.push(statement);
                  pending.set(statement, result.reject);
                  if (statement.includes("set_config")) budgets.push(...args.slice(1));
                  const response = statement.includes("clock_timestamp()")
                    ? Promise.resolve([{ time }])
                    : statement.includes("pg_backend_pid()")
                      ? Promise.resolve([{ pid: 321, started: "1893456000.123456" }])
                      : onQuery(statement);
                  void response.then(result.resolve, result.reject);
                  void result.promise.then(
                    () => pending.delete(statement),
                    () => pending.delete(statement),
                  );
                }
                return result.promise.then(yes, no);
              };
            return Reflect.get(target, property, target);
          },
        });
      },
    }),
    {
      release: () => {
        events.push("release");
      },
      close: async () => {
        events.push("close");
        await onClose();
      },
      [Symbol.dispose]: () => {},
    },
  );
  const db = Object.assign(
    new NativeSQL(`postgres://unused:unused@invalid.test/unused_test?sslmode=${sslMode}`, {
      connection: { application_name: "app_pwa_unit", options: "-c search_path=app_pwa_test" },
      connectionTimeout: 3,
      idleTimeout: 4,
      maxLifetime: 5,
    }),
    { reserve: async () => connection },
  );
  const control = Object.assign(
    new Proxy(new NativeSQL("postgres://unused:unused@invalid.test/unused_test"), {
      apply(_target, _receiver, args) {
        const statement = args[0].join("?");
        if (statement === "RESET ROLE") {
          controlSetup.push(statement);
          return Promise.resolve([]);
        }
        controlCalls.push({ statement, values: args.slice(1) });
        const result = deferred<unknown>();
        controlPending = result;
        void onServerCancel().then(result.resolve, result.reject);
        return result.promise;
      },
    }),
    {
      release: () => {},
      close: async () => {
        controlEvents.push("connection close");
        controlPending?.reject(new Error("control connection closed"));
      },
      [Symbol.dispose]: () => {},
    },
  );
  const pool = Object.assign(new NativeSQL("postgres://unused:unused@invalid.test/unused_test"), {
    reserve: async () => control,
    close: async () => {
      controlEvents.push("pool close");
    },
  });
  Object.defineProperty(bun, "SQL", {
    value: new Proxy(NativeSQL, {
      construct(_target, args) {
        controlOptions.push(args);
        // Exercise the real installed constructor; constructing options does not
        // open a socket. The returned pool below still supplies only fake SQL.
        const parsed: unknown = Reflect.construct(NativeSQL, args);
        if (typeof parsed !== "function" || !("options" in parsed)) throw new Error("Expected native SQL options");
        controlNormalized.push(parsed.options);
        return pool;
      },
    }),
  });
  return {
    db,
    statements,
    cancelled,
    controlEvents,
    controlSetup,
    controlCalls,
    controlOptions,
    controlNormalized,
    cancelPending,
    budgets,
    events,
    setTime: (value: Date) => {
      time = value;
    },
    query: (handler: typeof onQuery) => {
      onQuery = handler;
    },
    serverCancel: (handler: typeof onServerCancel) => {
      onServerCancel = handler;
    },
    close: (handler: typeof onClose) => {
      onClose = handler;
    },
  };
};

test.each(["SET CONSTRAINTS ALL IMMEDIATE", "COMMIT"])(
  "cancellation during %s stays guarded and awaits recovery before release",
  async (blocked) => {
    const f = lifecycleFixture();
    const entered = deferred<void>();
    const rollbackEntered = deferred<void>();
    const rollback = deferred<unknown>();
    const blockedQuery = deferred<unknown>();
    const cancelEntered = deferred<void>();
    const cancelDone = deferred<unknown>();
    const closeEntered = deferred<void>();
    const closed = deferred<void>();
    f.serverCancel(async () => {
      cancelEntered.resolve();
      return cancelDone.promise;
    });
    f.close(async () => {
      closeEntered.resolve();
      await closed.promise;
    });
    f.query(async (statement) => {
      if (statement === blocked) {
        entered.resolve();
        return blockedQuery.promise;
      }
      if (statement === "ROLLBACK") {
        rollbackEntered.resolve();
        return rollback.promise;
      }
      return [];
    });
    const controller = new AbortController();
    let captured: TransactionSQL | undefined;
    const running = withAppPwaTransaction(f.db, controller.signal, async (tx) => {
      captured = tx;
      return 7;
    });
    const settled = Promise.allSettled([running]);
    await entered.promise;
    expect(() => captured?.unsafe("UPDATE domain SET saved=true")).toThrow("UNAVAILABLE");
    controller.abort();
    await cancelEntered.promise;
    // Query.cancel is a no-op. The independently controlled server signal rejects SQL.
    expect(f.statements).not.toContain("ROLLBACK");
    f.cancelPending();
    await Promise.resolve();
    expect(f.statements).not.toContain("ROLLBACK");
    expect(f.events).toEqual([]);
    cancelDone.resolve([{ cancelled: true }]);
    await rollbackEntered.promise;
    expect(f.cancelled).toEqual([]);
    expect(f.controlCalls).toHaveLength(1);
    expect(f.controlSetup).toEqual(["RESET ROLE"]);
    expect(f.events).toEqual([]);
    expect(f.controlCalls[0]?.values).toEqual([321, "1893456000.123456"]);
    expect(f.controlCalls[0]?.statement).toContain("datname=current_database() AND usename=session_user");
    expect(f.controlCalls[0]?.statement).toContain("extract(epoch FROM backend_start)::text");
    expect(f.controlOptions).toMatchObject([
      [
        "postgres://localhost?sslmode=verify-full",
        {
          adapter: "postgres",
          hostname: "invalid.test",
          database: "unused_test",
          username: "unused",
          max: 1,
          connectionTimeout: 10,
          idleTimeout: 10,
          maxLifetime: 10,
          connection: { application_name: "app_pwa_unit", options: "-c search_path=app_pwa_test", statement_timeout: 10000 },
        },
      ],
    ]);
    expect(f.controlEvents).toEqual(["connection close", "pool close"]);
    rollback.resolve([]);
    await closeEntered.promise;
    expect(f.events).toEqual(["close"]);
    closed.resolve();
    expect(await settled).toMatchObject([{ status: "rejected", reason: { code: "UNAVAILABLE" } }]);
    expect(f.events).toEqual(["close"]);
    expect(f.statements.at(-1)).toBe("ROLLBACK");
    expect(f.statements.filter((statement) => statement === "COMMIT")).toHaveLength(blocked === "COMMIT" ? 1 : 0);
  },
);

test("deferred constraints drain before the final fresh authority check and an expired visit cannot commit", async () => {
  const f = lifecycleFixture();
  const expiry = new Date(clock.getTime() + 2000);
  f.query(async (statement) => {
    if (statement === "SET CONSTRAINTS ALL IMMEDIATE") f.setTime(expiry);
    return [];
  });
  const checks: Date[] = [];
  await expect(
    withAppPwaTransaction(
      f.db,
      undefined,
      async () => 7,
      (time) => {
        checks.push(time);
        if (time >= expiry) throw new Error("authority expired");
        return expiry;
      },
    ),
  ).rejects.toThrow("authority expired");
  expect(checks).toEqual([clock, expiry]);
  expect(f.statements).not.toContain("COMMIT");
  expect(f.statements.at(-1)).toBe("ROLLBACK");
  expect(f.events).toEqual(["release"]);
});

test("SQL and COMMIT receive decreasing request and authority budgets on PostgreSQL 15–17", async () => {
  const f = lifecycleFixture();
  let now = 100;
  const monotonic = spyOn(performance, "now").mockImplementation(() => now);
  try {
    await withAppPwaTransaction(
      f.db,
      undefined,
      async (tx) => {
        now += 7000;
        await tx`UPDATE domain SET saved=true`;
        now += 1000;
        await tx`UPDATE domain SET saved=true`;
      },
      () => new Date(clock.getTime() + 500),
    );
    expect(f.budgets.slice(0, 6)).toEqual(["3000ms", "3000ms", "3000ms", "2000ms", "2000ms", "2000ms"]);
    expect(f.budgets.slice(-3)).toEqual(["499ms", "499ms", "499ms"]);
    expect(f.statements.join(" ")).not.toContain("transaction_timeout");
    expect(f.statements.at(-1)).toBe("COMMIT");
    expect(f.events).toEqual(["release"]);
  } finally {
    monotonic.mockRestore();
  }
});

test("a failed rollback discards the connection before release", async () => {
  const f = lifecycleFixture();
  f.query(async (statement) => {
    if (statement === "ROLLBACK") throw new Error("connection lost");
    return [];
  });
  await expect(
    withAppPwaTransaction(f.db, undefined, async () => {
      throw new Error("handler failed");
    }),
  ).rejects.toThrow("handler failed");
  expect(f.events).toEqual(["close"]);
});

test("an abort racing a durable acknowledged COMMIT does not promise rollback", async () => {
  const f = lifecycleFixture();
  const entered = deferred<void>();
  const commit = deferred<unknown>();
  f.query(async (statement) => {
    if (statement === "COMMIT") {
      entered.resolve();
      return commit.promise;
    }
    return [];
  });
  const signalled = deferred<void>();
  const cancelDone = deferred<unknown>();
  f.serverCancel(async () => {
    commit.resolve([]);
    signalled.resolve();
    return cancelDone.promise;
  });
  const controller = new AbortController();
  const running = withAppPwaTransaction(f.db, controller.signal, async () => ({ state: "committed", completed: true }));
  await entered.promise;
  controller.abort();
  await signalled.promise;
  await Promise.resolve();
  expect(f.events).toEqual([]);
  cancelDone.resolve([{ cancelled: true }]);
  expect(await running).toEqual({ state: "committed", completed: true });
  expect(f.cancelled).toEqual([]);
  expect(f.controlCalls).toHaveLength(1);
  expect(f.statements).not.toContain("ROLLBACK");
  expect(f.events).toEqual(["close"]);
});

test("savepoints stay on the guarded connection and cannot execute cleanup from a late callback", async () => {
  const f = lifecycleFixture();
  const entered = deferred<void>();
  const gate = deferred<void>();
  const done = deferred<void>();
  const controller = new AbortController();
  const running = withAppPwaTransaction(f.db, controller.signal, async (tx) => {
    try {
      await tx.savepoint("domain", async (nested) => {
        const lazy = nested`UPDATE domain SET saved=true`;
        entered.resolve();
        await gate.promise;
        await expect(Promise.resolve(lazy)).rejects.toMatchObject({ code: "UNAVAILABLE" });
        throw new Error("late callback failed");
      });
    } finally {
      done.resolve();
    }
  });
  const settled = Promise.allSettled([running]);
  await entered.promise;
  controller.abort();
  expect(await settled).toMatchObject([{ status: "rejected", reason: { code: "UNAVAILABLE" } }]);
  const atRelease = [...f.statements];
  gate.resolve();
  await done.promise;
  expect(f.statements).toEqual(atRelease);
  expect(f.statements).toContain("SAVEPOINT app_pwa_0");
  expect(f.statements).not.toContain("ROLLBACK TO SAVEPOINT app_pwa_0");
  expect(f.statements.at(-1)).toBe("ROLLBACK");
});

test("savepoint query arrays settle their lazy SQL before release", async () => {
  const f = lifecycleFixture();
  f.query(async (statement) => (statement.startsWith("UPDATE") ? [{ saved: true }] : []));
  const result = await withAppPwaTransaction(f.db, undefined, async (tx) =>
    tx.savepoint((nested) => [nested`UPDATE first`, nested`UPDATE second`]),
  );
  expect(result).toEqual([[{ saved: true }], [{ saved: true }]]);
  const release = f.statements.indexOf("RELEASE SAVEPOINT app_pwa_0");
  expect(f.statements.indexOf("UPDATE first")).toBeLessThan(release);
  expect(f.statements.indexOf("UPDATE second")).toBeLessThan(release);
});

test("a successful savepoint and its writes share the guarded transaction", async () => {
  const f = lifecycleFixture();
  expect(
    await withAppPwaTransaction(f.db, undefined, async (tx) =>
      tx.savepoint(async (nested) => {
        await nested`UPDATE domain SET saved=true`;
        return 9;
      }),
    ),
  ).toBe(9);
  const commands = f.statements.filter(
    (statement) => !statement.includes("set_config") && !statement.includes("clock_timestamp") && !statement.includes("pg_backend_pid"),
  );
  expect(commands).toEqual([
    "BEGIN",
    "SAVEPOINT app_pwa_0",
    "UPDATE domain SET saved=true",
    "RELEASE SAVEPOINT app_pwa_0",
    "SET CONSTRAINTS ALL IMMEDIATE",
    "COMMIT",
  ]);
});

test.each(["SET CONSTRAINTS ALL IMMEDIATE", "COMMIT"])("authority expiry cancels in-flight %s without a client abort", async (blocked) => {
  const f = lifecycleFixture();
  const query = deferred<unknown>();
  const monotonic = spyOn(performance, "now").mockReturnValue(0);
  f.query(async (statement) => (statement === blocked ? query.promise : []));
  try {
    // A fixed database date and monotonic clock keep fixture behavior independent
    // of today's date; only the actual abort timer advances.
    await expect(
      withAppPwaTransaction(
        f.db,
        undefined,
        async () => 7,
        () => new Date(clock.getTime() + 20),
      ),
    ).rejects.toMatchObject({ code: "EXPIRED" });
    expect(f.cancelled).toEqual([]);
    expect(f.controlCalls).toHaveLength(1);
    expect(f.statements.at(-1)).toBe("ROLLBACK");
    expect(f.events).toEqual(["close"]);
  } finally {
    monotonic.mockRestore();
  }
});

test.each(["denied", "missing-backend"])("%s cancellation discards and settles the blocked connection", async (mode) => {
  const f = lifecycleFixture();
  const entered = deferred<void>();
  const blocked = deferred<unknown>();
  f.query(async (statement) => {
    if (statement === "COMMIT") {
      entered.resolve();
      return blocked.promise;
    }
    return [];
  });
  f.serverCancel(async () => {
    if (mode === "denied") throw new Error("PostgreSQL 42501");
    return [];
  });
  const controller = new AbortController();
  const running = withAppPwaTransaction(f.db, controller.signal, async () => 7);
  const settled = Promise.allSettled([running]);
  await entered.promise;
  controller.abort();
  expect(await settled).toMatchObject([{ status: "rejected", reason: { code: "UNAVAILABLE" } }]);
  expect(f.cancelled).toEqual([]);
  expect(f.controlCalls).toHaveLength(1);
  expect(f.events).toEqual(["close"]);
  expect(f.controlEvents).toEqual(["connection close", "pool close"]);
});

test("in-flight application SQL is cancelled by PostgreSQL and drains before rollback", async () => {
  const f = lifecycleFixture();
  const entered = deferred<void>();
  const query = deferred<unknown>();
  f.query(async (statement) => {
    if (statement === "UPDATE domain SET saved=true") {
      entered.resolve();
      return query.promise;
    }
    return [];
  });
  const controller = new AbortController();
  const running = withAppPwaTransaction(f.db, controller.signal, async (tx) => {
    await tx`UPDATE domain SET saved=true`;
  });
  const settled = Promise.allSettled([running]);
  await entered.promise;
  controller.abort();
  expect(await settled).toMatchObject([{ status: "rejected", reason: { code: "UNAVAILABLE" } }]);
  expect(f.cancelled).toEqual(["UPDATE domain SET saved=true"]);
  expect(f.controlCalls).toHaveLength(1);
  expect(f.statements).not.toContain("COMMIT");
  expect(f.statements.at(-1)).toBe("ROLLBACK");
  expect(f.events).toEqual(["close"]);
});

test("an SQL constraint error rolls back its savepoint before configuring more SQL", async () => {
  const f = lifecycleFixture();
  const violation = Object.assign(new Error("duplicate key"), { code: "23505" });
  let aborted = false;
  f.query(async (statement) => {
    if (statement === "ROLLBACK TO SAVEPOINT app_pwa_0") {
      aborted = false;
      return [];
    }
    if (aborted) throw Object.assign(new Error("subtransaction aborted"), { code: "25P02" });
    if (statement === "INSERT duplicate") {
      aborted = true;
      throw violation;
    }
    return [];
  });
  await withAppPwaTransaction(f.db, undefined, async (tx) => {
    await expect(
      tx.savepoint(async (nested) => {
        await nested.unsafe("INSERT duplicate");
      }),
    ).rejects.toBe(violation);
    await tx`UPDATE domain SET saved=true`;
  });
  const failed = f.statements.indexOf("INSERT duplicate");
  expect(f.statements[failed + 1]).toBe("ROLLBACK TO SAVEPOINT app_pwa_0");
  expect(f.statements.at(-1)).toBe("COMMIT");
  expect(f.events).toEqual(["release"]);
});

test("cleanup deadline closes a stalled control query and original SQL before release", async () => {
  const f = lifecycleFixture();
  const entered = deferred<void>();
  const cancelling = deferred<void>();
  const blocked = deferred<unknown>();
  const control = deferred<unknown>();
  f.query(async (statement) => {
    if (statement === "COMMIT") {
      entered.resolve();
      return blocked.promise;
    }
    return [];
  });
  f.serverCancel(async () => {
    cancelling.resolve();
    return control.promise;
  });
  const nativeSetTimeout = globalThis.setTimeout;
  const deadlines: (() => void)[] = [];
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(
    new Proxy(nativeSetTimeout, {
      apply(target, receiver, args) {
        const [callback, milliseconds, ...values] = args;
        if (milliseconds === 10000 && typeof callback === "function") deadlines.push(() => Reflect.apply(callback, undefined, values));
        return Reflect.apply(target, receiver, args);
      },
    }),
  );
  try {
    const controller = new AbortController();
    const running = withAppPwaTransaction(f.db, controller.signal, async () => 7);
    const settled = Promise.allSettled([running]);
    await entered.promise;
    controller.abort();
    await cancelling.promise;
    expect(f.events).toEqual([]);
    expect(deadlines).toHaveLength(1);
    deadlines[0]!();
    expect(await settled).toMatchObject([{ status: "rejected", reason: { code: "UNAVAILABLE" } }]);
    expect(f.events).toEqual(["close"]);
    expect(f.controlEvents).toEqual(["connection close", "connection close", "pool close"]);
    expect(f.cancelled).toEqual([]);
  } finally {
    timer.mockRestore();
    control.resolve([]);
    blocked.resolve([]);
  }
});

test.each(["disable", "prefer", "require", "verify-ca", "verify-full"])(
  "the control connection preserves native TLS mode %s without opening a socket",
  async (mode) => {
    const f = lifecycleFixture(mode);
    const controller = new AbortController();
    await expect(
      withAppPwaTransaction(f.db, controller.signal, async () => {
        controller.abort();
        return await new Promise<never>(() => {});
      }),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(f.controlNormalized).toHaveLength(1);
    expect(f.controlNormalized).toMatchObject([
      {
        hostname: f.db.options.hostname,
        port: f.db.options.port,
        database: f.db.options.database,
        username: f.db.options.username,
        sslMode: Reflect.get(f.db.options, "sslMode"),
        tls: f.db.options.tls,
        query: Reflect.get(f.db.options, "query") + "statement_timeout\0" + "10000\0",
      },
    ]);
  },
);
