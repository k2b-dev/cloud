import { expect, test } from "bun:test";

const start = new URL("../start.ts", import.meta.url).pathname;
const clients = new URL("./clients.ts", import.meta.url).pathname;
const state = new URL("./connections.ts", import.meta.url).pathname;
const run = async (source: string, env: Record<string, string> = {}) => {
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", source], {
    env: { DATABASE_URL: "postgres://127.0.0.1:1/unused_test", REDIS_URL: "redis://127.0.0.1:1", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 10_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    return JSON.parse(stdout);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) {
      child.kill();
      await child.exited;
    }
  }
};

test("every handle access before start fails clearly, including calls and setters", async () => {
  const errors = await run(`
    import { sql, redis, createSql, createRedis } from ${JSON.stringify(clients)};
    import { connections } from ${JSON.stringify(state)};
    const failures = [() => sql.unsafe, () => sql\`SELECT 1\`, () => {redis.onconnect = () => {}}, () => connections(), () => createSql(), () => createRedis()];
    console.log(JSON.stringify(failures.map(fn => {try {fn()} catch (error) {return error.message}})));
  `);
  expect(errors).toEqual([
    "sql used before platform start",
    "sql used before platform start",
    "redis used before platform start",
    "connections() used before platform start; use @k2b/cloud/start, the Cloud build entry or development preload",
    "connections() used before platform start; use @k2b/cloud/start, the Cloud build entry or development preload",
    "connections() used before platform start; use @k2b/cloud/start, the Cloud build entry or development preload",
  ]);
});

test("start loads only after native instances exist and never rewrites environment values", async () => {
  const result = await run(`
    import { SQL, RedisClient } from "bun";
    import { startPlatform } from ${JSON.stringify(start)};
    import { sql, redis, createSql, createRedis, closePlatformClients } from ${JSON.stringify(clients)};
    const before = { ...process.env };
    const module = await startPlatform({appId: "core", load: async () => {
      const pool = createSql({ max: 2 }); const cache = createRedis({ enableOfflineQueue: false });
      const nativeSql = new SQL({ url: process.env.DATABASE_URL });
      const onconnect = () => {};
      redis.onconnect = onconnect;
      const result = {
        native: Object.getPrototypeOf(sql) === Object.getPrototypeOf(nativeSql) && Object.getPrototypeOf(pool) === Object.getPrototypeOf(nativeSql) && redis instanceof RedisClient && cache instanceof RedisClient,
        methods: ["begin", "reserve", "unsafe", "array", "file", "listen"].every(name => typeof sql[name] === "function"),
        setter: redis.onconnect === onconnect,
        poolMax: pool.options.max,
        optionsMax: sql.options.max,
        environment: JSON.stringify(before) === JSON.stringify(process.env),
      };
      await pool.close(); await nativeSql.close(); cache.close(); return { default: result };
    }});
    await closePlatformClients(); console.log(JSON.stringify(module.default));
  `);
  expect(result).toMatchObject({
    native: true,
    methods: true,
    setter: true,
    poolMax: 2,
    optionsMax: 10,
    environment: true,
  });
});

test("startup applies the process pool maximum without changing owned pools or the URL", async () => {
  const result = await run(
    `
    import { startPlatform } from ${JSON.stringify(start)};
    import { sql, createSql, closePlatformClients } from ${JSON.stringify(clients)};
    const before = process.env.DATABASE_URL;
    const result = await startPlatform({ appId: "core", load: async () => {
      const owned = createSql();
      const explicit = createSql({ max: 3 });
      try { return { global: sql.options.max, owned: owned.options.max, explicit: explicit.options.max, unchanged: process.env.DATABASE_URL === before }; }
      finally { await owned.close(); await explicit.close(); }
    }});
    await closePlatformClients(); console.log(JSON.stringify(result));
  `,
    { CLOUD_DATABASE_POOL_MAX: "2" },
  );
  expect(result).toEqual({ global: 2, owned: 10, explicit: 3, unchanged: true });
});

test("invalid process pool limits fail before loading application code and clear the startup binding", async () => {
  for (const max of ["0", "1.5", "2147483648", "invalid"]) {
    const result = await run(
      `
      import { startPlatform } from ${JSON.stringify(start)};
      import { hasConnections } from ${JSON.stringify(state)};
      let loaded = false, message;
      try { await startPlatform({ appId: "core", load: async () => { loaded = true } }); }
      catch (error) { message = error.message; }
      console.log(JSON.stringify({ loaded, bound: hasConnections(), message }));
    `,
      { CLOUD_DATABASE_POOL_MAX: max },
    );
    expect(result).toMatchObject({ loaded: false, bound: false });
    expect(result.message).toContain("CLOUD_DATABASE_POOL_MAX");
  }
});

test("startup rejects URL pool options before loading application code without disclosing credentials", async () => {
  const result = await run(
    `
    import { startPlatform } from ${JSON.stringify(start)};
    import { hasConnections } from ${JSON.stringify(state)};
    let loaded = false, message;
    try { await startPlatform({ appId: "core", load: async () => { loaded = true } }); }
    catch (error) { message = error.message; }
    console.log(JSON.stringify({ loaded, bound: hasConnections(), message }));
  `,
    { DATABASE_URL: "postgres://fixture:private-password@127.0.0.1:1/unused_test?max=private-option-value" },
  );
  expect(result).toMatchObject({ loaded: false, bound: false });
  expect(result.message).toContain("keep client options outside its query string");
  expect(result.message).toContain("CLOUD_DATABASE_POOL_MAX");
  expect(result.message).not.toContain("private-password");
  expect(result.message).not.toContain("private-option-value");
});

test("invalid keys never fall back to env; Core and Gateway refuse keys", async () => {
  const invalid = await run(
    `
    import { initializePlatform } from ${JSON.stringify(start)};
    let error; try { await initializePlatform({appId: "inventory"}) } catch (e) { error = e.message }
    console.log(JSON.stringify(error));
  `,
    { CLOUD_APP_KEY: "not-a-real-key" },
  );
  expect(invalid).toContain("Expected cloud-app-key-v1");
  for (const appId of ["core", "gateway"]) {
    expect(
      await run(
        `
      import { initializePlatform } from ${JSON.stringify(start)};
      let error; try { await initializePlatform({appId: ${JSON.stringify(appId)}}) } catch (e) { error = e.message }
      console.log(JSON.stringify(error));
    `,
        { CLOUD_APP_KEY: "not-a-real-key" },
      ),
    ).toContain("App keys are forbidden");
  }
});

test("initialization rejects invalid identity, duplicate starts and native client failures without loading app code", async () => {
  const identity = await run(`
    import { initializePlatform } from ${JSON.stringify(start)};
    import { closePlatformClients } from ${JSON.stringify(clients)};
    const errors = [];
    try { await initializePlatform({ appId: "Invalid" }) } catch (error) { errors.push(error.message) }
    await initializePlatform({ appId: "inventory", source: "env" });
    try { await initializePlatform({ appId: "inventory" }) } catch (error) { errors.push(error.message) }
    await closePlatformClients(); console.log(JSON.stringify(errors));
  `);
  expect(identity).toEqual(["Platform start requires a valid appId", "Platform has already started"]);
  for (const key of ["DATABASE_URL", "REDIS_URL"]) {
    const failure = await run(
      `
      import { startPlatform } from ${JSON.stringify(start)};
      let loaded = false, message;
      try { await startPlatform({ appId: "core", load: async () => { loaded = true } }) }
      catch (error) { message = error.message }
      console.log(JSON.stringify({loaded, message}));
    `,
      { [key]: "unsupported://user:do-not-print@127.0.0.1:1" },
    );
    expect(failure.loaded).toBe(false);
    expect(failure.message).toContain(
      key === "DATABASE_URL" ? "Postgres client configuration is invalid" : "Valkey client configuration is invalid",
    );
    expect(failure.message).not.toContain("do-not-print");
  }
});

test("key appId mismatch fails before requesting Core even with complete infrastructure env", async () => {
  const error = await run(
    `
    import { initializePlatform } from ${JSON.stringify(start)};
    let error; try { await initializePlatform({appId: "inventory"}) } catch (e) { error = e.message }
    console.log(JSON.stringify(error));
  `,
    {
      CLOUD_APP_KEY:
        "cloud-app-key-v1.11111111-1111-4111-8111-111111111111.other.22222222-2222-4222-8222-222222222222.nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A",
    },
  );
  expect(error).toBe("App-key appId does not match the declared application");
});

test("CLOUD_APP_KEY_FILE reads the mounted key; conflicting sources stop startup", async () => {
  const result = await run(`
    import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    const directory = mkdtempSync(join(tmpdir(), "cloud-key-file-"));
    const keyPath = join(directory, "key");
    writeFileSync(keyPath, "cloud-app-key-v1.11111111-1111-4111-8111-111111111111.other.22222222-2222-4222-8222-222222222222.nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A\\n");
    process.env.CLOUD_APP_KEY_FILE = keyPath;
    let mounted, conflict;
    try {
      const { initializePlatform } = await import(${JSON.stringify(start)});
      try { await initializePlatform({appId: "inventory"}) } catch (e) { mounted = e.message }
      process.env.CLOUD_APP_KEY = "PRIVATE";
      try { await initializePlatform({appId: "inventory"}) } catch (e) { conflict = e.message }
      console.log(JSON.stringify({ mounted, conflict }));
    } finally { rmSync(directory, {recursive: true, force: true}); }
  `);
  expect(result).toEqual({
    mounted: "App-key appId does not match the declared application",
    conflict: "CLOUD_APP_KEY and CLOUD_APP_KEY_FILE must not both be set",
  });
});

test("a second concurrent start is rejected while key bootstrap is still pending", async () => {
  const result = await run(
    `
    import { initializePlatform } from ${JSON.stringify(start)};
    import { closePlatformClients } from ${JSON.stringify(clients)};
    let requests = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
      requests++;
      return Response.json({
        identity: { installationId: "11111111-1111-4111-8111-111111111111", appId: "inventory", keyId: "22222222-2222-4222-8222-222222222222" },
        connections: {
          database: { url: process.env.DATABASE_URL }, valkey: { url: process.env.REDIS_URL },
          nats: { servers: ["nats://127.0.0.1:1"], namespace: "test", replicas: 1, ignoreClusterUpdates: false },
          appSecret: { current: "test-secret" },
        },
      });
    }});
    process.env.CLOUD_CORE_INTERNAL_ORIGIN = "http://127.0.0.1:" + server.port;
    try {
      const results = await Promise.allSettled([initializePlatform({appId: "inventory"}), initializePlatform({appId: "inventory"})]);
      console.log(JSON.stringify({ requests, statuses: results.map(r => r.status), errors: results.filter(r => r.status === "rejected").map(r => r.reason.message) }));
    } finally { await closePlatformClients(); await server.stop(true); }
  `,
    {
      CLOUD_APP_KEY:
        "cloud-app-key-v1.11111111-1111-4111-8111-111111111111.inventory.22222222-2222-4222-8222-222222222222.nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A",
    },
  );
  expect(result).toEqual({ requests: 1, statuses: ["fulfilled", "rejected"], errors: ["Platform has already started"] });
});

test("serving apps require a key before loading application code, including forced env mode", async () => {
  for (const source of [undefined, "env"]) {
    const result = await run(`
      import { startPlatform } from ${JSON.stringify(start)};
      let loaded = false, message;
      try { await startPlatform({ appId: "inventory", source: ${JSON.stringify(source)}, load: async () => { loaded = true; } }); }
      catch (error) { message = error.message; }
      console.log(JSON.stringify({ loaded, message }));
    `);
    expect(result.loaded).toBe(false);
    expect(result.message).toContain("CLOUD_APP_KEY_FILE");
    expect(result.message).toContain("/operations/app-keys");
  }
});

test("Core and Gateway start without an app key", async () => {
  for (const appId of ["core", "gateway"]) {
    expect(
      await run(`
      import { startPlatform } from ${JSON.stringify(start)};
      import { closePlatformClients } from ${JSON.stringify(clients)};
      const loaded = await startPlatform({ appId: ${JSON.stringify(appId)}, load: async () => true });
      await closePlatformClients(); console.log(JSON.stringify(loaded));
    `),
    ).toBe(true);
  }
});

test("keyless data scripts initialize explicit connections without fetching Core or rewriting Bun globals", async () => {
  const result = await run(
    `
    import { initializePlatform } from ${JSON.stringify(start)};
    import { connections } from ${JSON.stringify(state)};
    import { closePlatformClients } from ${JSON.stringify(clients)};
    const before = { ...process.env };
    globalThis.fetch = () => { throw new Error("Data initialization must not contact Core"); };
    await initializePlatform({ appId: "inventory", source: "env" });
    const { appId, database, valkey, bootstrap } = connections();
    await closePlatformClients();
    console.log(JSON.stringify({
      appId, mode: bootstrap.mode,
      database: database.url === process.env.DATABASE_URL,
      valkey: valkey.url === process.env.REDIS_URL,
      environment: JSON.stringify(before) === JSON.stringify(process.env),
    }));
  `,
    { CLOUD_CORE_INTERNAL_ORIGIN: "http://127.0.0.1:1" },
  );
  expect(result).toEqual({ appId: "inventory", mode: "env", database: true, valkey: true, environment: true });
});
