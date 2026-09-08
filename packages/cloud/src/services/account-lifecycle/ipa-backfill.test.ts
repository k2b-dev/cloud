import { expect, test } from "bun:test";

const fixture = async (scenario: string) => {
  // Isolate module mocks and replace this module's SQL import only.
  // No database or FreeIPA connection is opened.
  const script = `
    import { mock, setSystemTime } from "bun:test";
    import { strict as assert } from "node:assert";
    const dir = ${JSON.stringify(import.meta.dir)};
    const users = new Map(), remoteUsers = new Map(), synced = new Set();
    const calls = [];
    let days = 1, failLocalOnce = false, failReadUid = null, failWriteUid = null;
    let beforeProvider = () => {};
    const config = { enabled: true, configured: true, missingSettings: [], url: "ipa.invalid" };
    const cutoff = "2026-09-07 12:00:00.123456+00";
    const controller = new AbortController(), signal = controller.signal;
    let expectedSignal = signal;
    const id = n => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
    const addUser = (n, extra = {}) => {
      const row = { id: id(n), uid: "user" + n, provider: "ipa", account_expires: null, created_at: "2026-09-06T00:00:00Z", ...extra };
      users.set(row.id, row);
      remoteUsers.set(row.uid, null);
      return { key: row.id, uid: row.uid };
    };
    const sql = async (parts, ...values) => {
      const query = parts.join("?");
      if (query.includes("CURRENT_TIMESTAMP")) return [{ created_before: cutoff }];
      if (query.includes("SELECT id, uid")) {
        assert.match(query, /created_at <=/);
        assert.match(query, /ORDER BY id/);
        assert.match(query, /LIMIT/);
        const [before, cursor, sameCursor, target, limit] = values;
        assert.equal(cursor, sameCursor);
        return [...users.values()].filter(row => row.provider === "ipa"
          && new Date(row.created_at) <= new Date(before)
          && (cursor === null || row.id > cursor)
          && (row.account_expires === null || row.account_expires < new Date(target)))
          .sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit);
      }
      if (query.includes("FOR UPDATE")) {
        const row = users.get(values[0]);
        return row && row.uid === values[1] && row.provider === "ipa" ? [row] : [];
      }
      if (query.includes("UPDATE auth.users")) {
        if (failLocalOnce) { failLocalOnce = false; throw new Error("database unavailable"); }
        users.get(values[1]).account_expires = values[0];
        return [];
      }
      if (query.includes("INSERT INTO auth.user_ipa_data")) { synced.add(values[0]); return []; }
      throw new Error("Unexpected SQL: " + query);
    };
    sql.begin = async callback => {
      const snapshot = structuredClone([...users]);
      try { return await callback(sql); }
      catch (error) { users.clear(); for (const [key, row] of snapshot) users.set(key, row); throw error; }
    };
    globalThis.ipaBackfillSql = sql;
    Bun.plugin({
      name: "ipa-backfill-sql-fixture",
      setup(build) {
        build.onLoad({ filter: /ipa-backfill[.]ts$/ }, async ({ path }) => ({
          contents: (await Bun.file(path).text()).replace('import { sql } from "bun";', 'const sql = globalThis.ipaBackfillSql;'),
          loader: "ts",
        }));
      },
    });
    const generalized = date => date.toISOString().replace(/[-:]/g, "").replace("T", "").replace(/[.]000Z$/, "Z");
    mock.module(dir + "/../../server/services/freeipa/index.ts", () => ({
      freeipa: {
        util: {
          str: value => String(Array.isArray(value) ? value[0] ?? "" : value ?? ""),
          toGeneralizedTime: generalized,
          parseGeneralizedTime: value => {
            const raw = Array.isArray(value) ? value[0] : value;
            if (!raw || !/^[0-9]{14}Z$/.test(raw)) return null;
            return new Date(raw.slice(0, 4) + "-" + raw.slice(4, 6) + "-" + raw.slice(6, 8) + "T" + raw.slice(8, 10) + ":" + raw.slice(10, 12) + ":" + raw.slice(12, 14) + "Z");
          },
        },
        session: { getServiceSession: async options => { assert.equal(options.signal, expectedSignal); return "fixture-session"; } },
        client: { call: async request => {
          assert.equal(request.signal, expectedSignal);
          beforeProvider(request);
          calls.push(request);
          const uid = request.args[0];
          if ((request.method === "user_show" && uid === failReadUid) || (request.method === "user_mod" && uid === failWriteUid)) {
            return { error: { message: "provider unavailable" }, result: null };
          }
          if (request.method === "user_mod") remoteUsers.set(uid, request.options.krbprincipalexpiration);
          return { error: null, result: { result: { uid: [uid], ...(remoteUsers.get(uid) ? { krbprincipalexpiration: [remoteUsers.get(uid)] } : {}) } } };
        } },
      },
    }));
    mock.module(dir + "/../account-model.ts", () => ({ getConfiguredExpiryDays: async () => days }));
    mock.module(dir + "/../freeipa-config.ts", () => ({ getFreeIpaConfig: async () => config }));
    mock.module(dir + "/../logging/index.ts", () => ({ logger: () => ({ info() {} }) }));
    const { prepareIpaBackfill, ipaBackfillConfig, processIpaBackfillAccount, declareIpaBackfill } = await import(dir + "/ipa-backfill.ts");
    const pump = { ...ipaBackfillConfig, dispatch: ({ input, item, signal }) => processIpaBackfillAccount({
      input: { userId: item.key, uid: item.uid, minimumExpiry: input.minimumExpiry }, signal,
    }) };
    setSystemTime(new Date("2026-09-07T12:00:00Z"));
    ${scenario}
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], {
    cwd: new URL("../../../", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/fixture",
      POSTGRES_URL: "postgres://fixture:fixture@127.0.0.1:1/fixture",
    },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "", stderr: "" });
};

test("backfill freezes expiry and pages a finite PostgreSQL identity set", () =>
  fixture(`
  const input = await prepareIpaBackfill("run");
  assert.equal(input.minimumExpiry, "2026-09-14T23:59:59.000Z");
  assert.equal(input.createdBefore, cutoff);
  const a = addUser(1), b = addUser(2);
  addUser(3, { provider: "local" });
  addUser(4, { created_at: "2026-09-08T00:00:00Z" });
  addUser(5, { account_expires: new Date("2027-01-01T00:00:00Z") });
  const first = await pump.pull({ input, cursor: null, limit: 1, signal });
  assert.deepEqual(first, { items: [a], nextCursor: a.key });
  const second = await pump.pull({ input, cursor: first.nextCursor, limit: 2, signal });
  assert.deepEqual(second, { items: [b], nextCursor: null });
  setSystemTime(new Date("2026-09-20T12:00:00Z"));
  days = 365;
  await pump.dispatch({ input, item: a, signal });
  assert.equal(remoteUsers.get(a.uid), "20260914235959Z");
  assert.equal(pump.maxActiveRuns, 1);
  assert.equal(pump.dispatchConcurrency, 1);
`));

test("uncertain sink retries preserve expiry without repeating the directory write", () =>
  fixture(`
  const input = await prepareIpaBackfill("run"), item = addUser(1);
  failLocalOnce = true;
  await assert.rejects(pump.dispatch({ input, item, signal }), /database unavailable/);
  assert.equal(users.get(item.key).account_expires, null);
  assert.equal(remoteUsers.get(item.uid), "20260914235959Z");
  setSystemTime(new Date("2026-10-07T12:00:00Z"));
  await pump.dispatch({ input, item, signal });
  assert.equal(calls.filter(call => call.method === "user_mod").length, 1);
  assert.equal(users.get(item.key).account_expires.toISOString(), input.minimumExpiry);
  assert.equal(synced.has(item.key), true);
  const count = calls.length;
  await pump.dispatch({ input, item, signal });
  assert.equal(calls.length, count);
`));

test("backfill preserves later provider expiry and skips changed PostgreSQL identities", () =>
  fixture(`
  const input = await prepareIpaBackfill("run"), later = addUser(1);
  remoteUsers.set(later.uid, "20270101235959Z");
  await pump.dispatch({ input, item: later, signal });
  assert.equal(calls.filter(call => call.method === "user_mod").length, 0);
  assert.equal(users.get(later.key).account_expires.toISOString(), "2027-01-01T23:59:59.000Z");
  const deleted = addUser(2); users.delete(deleted.key);
  const switched = addUser(3); users.get(switched.key).provider = "local";
  const renamed = addUser(4); users.get(renamed.key).uid = "replacement";
  calls.length = 0;
  for (const item of [deleted, switched, renamed]) await pump.dispatch({ input, item, signal });
  assert.equal(calls.length, 0);
`));

test("provider failures retry and invalid expiry never triggers a write", () =>
  fixture(`
  const input = await prepareIpaBackfill("run"), item = addUser(1);
  failReadUid = item.uid;
  await assert.rejects(pump.dispatch({ input, item, signal }), /read failed/);
  failReadUid = null;
  failWriteUid = item.uid;
  await assert.rejects(pump.dispatch({ input, item, signal }), /IPA backfill failed/);
  failWriteUid = null;
  remoteUsers.set(item.uid, "invalid");
  calls.length = 0;
  await assert.rejects(pump.dispatch({ input, item, signal }), /invalid expiry/);
  assert.equal(calls.some(call => call.method === "user_mod"), false);
  assert.equal(users.get(item.key).account_expires, null);
  assert.equal(synced.size, 0);
`));

test("cancellation and provider disablement fail unfinished work", () =>
  fixture(`
  const input = await prepareIpaBackfill("run"), item = addUser(1);
  config.enabled = false;
  await assert.rejects(pump.dispatch({ input, item, signal }), /enabled, configured/);
  assert.equal(await prepareIpaBackfill("run"), null);
  config.enabled = true;
  beforeProvider = request => { if (request.method === "user_show") controller.abort(); };
  await assert.rejects(pump.dispatch({ input, item, signal }), { name: "AbortError" });
  assert.equal(calls.some(call => call.method === "user_mod"), false);
  assert.equal(synced.size, 0);
  await assert.rejects(pump.pull({ input, cursor: null, limit: 100, signal }), { name: "AbortError" });
`));

test.skipIf(!process.env.SYNC_TEST_SERVERS)(
  "native Pump resumes acceptance checkpoints and account failures do not stop later accounts",
  () =>
    fixture(`
  const input = await prepareIpaBackfill("run");
  addUser(1); addUser(2); addUser(3);
  setSystemTime();
  const { createSync } = await import("@k2b/sync");
  const { connect } = await import("@nats-io/transport-node");
  const { jetstreamManager } = await import(Bun.resolveSync("@nats-io/jetstream", new URL(".", import.meta.resolve("@k2b/sync")).pathname));
  const connection = await connect({ servers: process.env.SYNC_TEST_SERVERS.split(","), timeout: 2000 });
  const namespace = "ipa-backfill-test-" + crypto.randomUUID();
  const attempted = [];
  let failAfterAcceptance = true;
  const makeRun = () => {
    const runtime = createSync({ connection, namespace, application: "ipa-backfill-test" });
    const { pump: handle, accounts } = declareIpaBackfill(runtime);
    const submit = accounts.submit;
    accounts.submit = async input => {
      attempted.push(input.input.uid);
      assert.ok(new TextEncoder().encode(input.key).length <= 96);
      const receipt = await submit(input);
      if (input.input.uid === "user2" && failAfterAcceptance) {
        failAfterAcceptance = false;
        throw new Error("acceptance confirmed before producer checkpoint");
      }
      return receipt;
    };
    return { runtime, handle, accounts };
  };
  const until = async (handle, expected) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const state = await handle.get({ key: "run" });
      if (state?.status === expected) return state;
      if (state?.status === "failed") throw new Error(JSON.stringify(state));
      await Bun.sleep(10);
    }
    throw new Error("Pump did not reach " + expected);
  };
  let current = makeRun();
  try {
    await current.runtime.ready();
    await current.handle.start({ key: "run", input });
    await current.handle.process();
    await until(current.handle, "waiting");
    await current.runtime.drain();
    assert.deepEqual(attempted, ["user1", "user2"]);
    current = makeRun();
    await current.runtime.ready();
    await current.handle.process();
    const completed = await until(current.handle, "completed");
    assert.equal(completed.dispatched, 3);
    assert.deepEqual(attempted, ["user1", "user2", "user2", "user3"]);
    // Pump completion means every account job is accepted, before any effect.
    assert.equal(calls.length, 0);
    failReadUid = "user1";
    await current.accounts.process({ concurrency: 1 }, async context => {
      expectedSignal = context.signal;
      await processIpaBackfillAccount(context);
    });
    const deadline = Date.now() + 10000;
    let failed = [];
    while (Date.now() < deadline) {
      failed = await current.accounts.deadLetters.list();
      if (failed.length === 1 && synced.has(id(2)) && synced.has(id(3))) break;
      await Bun.sleep(20);
    }
    assert.equal(failed.length, 1);
    assert.equal(failed[0].data.input.userId, id(1));
    assert.equal(users.get(id(1)).account_expires, null);
    assert.equal(users.get(id(2)).account_expires.toISOString(), input.minimumExpiry);
    assert.equal(users.get(id(3)).account_expires.toISOString(), input.minimumExpiry);
    assert.equal(calls.filter(call => call.method === "user_mod" && call.args[0] === "user2").length, 1);
  } finally {
    await current.runtime.drain();
    const manager = await jetstreamManager(connection);
    for await (const stream of manager.streams.list()) {
      if (stream.config.metadata?.["sync.namespace"] === namespace) await manager.streams.delete(stream.config.name);
    }
    for await (const stream of manager.streams.list()) assert.notEqual(stream.config.metadata?.["sync.namespace"], namespace);
    await connection.drain();
  }
`),
  20000,
);
