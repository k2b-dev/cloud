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
    const module = await startPlatform({appId: "inventory", load: async () => {
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

test("keys fail visibly until Core bootstrap is implemented; forced env mode ignores keys", async () => {
  for (const key of ["CLOUD_APP_KEY", "CLOUD_APP_KEY_FILE"]) {
    expect(
      await run(
        `
      import { initializePlatform } from ${JSON.stringify(start)};
      import { bindConnections } from ${JSON.stringify(state)};
      import { closePlatformClients } from ${JSON.stringify(clients)};
      let error; try { await initializePlatform({appId: "inventory"}) } catch (e) { error = e.message }
      await initializePlatform({appId: "core"});
      await closePlatformClients(); bindConnections(undefined);
      await initializePlatform({appId: "gateway"});
      await closePlatformClients(); console.log(JSON.stringify(error));
    `,
        { [key]: "not-a-real-key" },
      ),
    ).toBe("Core connection bootstrap is not available yet");
  }
});

test("initialization rejects invalid identity, duplicate starts and native client failures without loading app code", async () => {
  const identity = await run(`
    import { initializePlatform } from ${JSON.stringify(start)};
    import { closePlatformClients } from ${JSON.stringify(clients)};
    const errors = [];
    try { await initializePlatform({ appId: "Invalid" }) } catch (error) { errors.push(error.message) }
    await initializePlatform({ appId: "inventory" });
    try { await initializePlatform({ appId: "inventory" }) } catch (error) { errors.push(error.message) }
    await closePlatformClients(); console.log(JSON.stringify(errors));
  `);
  expect(identity).toEqual(["Platform start requires a valid appId", "Platform has already started"]);
  for (const key of ["DATABASE_URL", "REDIS_URL"]) {
    const failure = await run(
      `
      import { startPlatform } from ${JSON.stringify(start)};
      let loaded = false, message;
      try { await startPlatform({ appId: "inventory", load: async () => { loaded = true } }) }
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
