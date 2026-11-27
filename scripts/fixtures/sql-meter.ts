/**
 * Counts the statements this test process sends to PostgreSQL, so a test can
 * hold a hot path to a budget: an edit, a live delivery or an ordinary request
 * should cost a known, small number of statements, usually none.
 *
 *   const meter = await meterSql();
 *   try {
 *     const statements = await meter.during(() => handleOneEdit());
 *     expect(statements).toEqual([]);
 *   } finally {
 *     await meter.close();
 *   }
 *
 * The meter is a loopback proxy in front of the test database. It reads the
 * frontend protocol and records each executed statement (simple `Query` or
 * extended `Execute`, including `BEGIN` and `COMMIT`) as its first 120
 * characters of SQL text, never its parameters. The first open meter rebinds
 * the platform's `sql` handle through the proxy, and the last `close()` binds
 * it to the database directly again; pools created while no meter is open keep
 * their direct connection and are not counted.
 *
 * The proxy stays for the whole process, so any number of meters can open and
 * close in one file, also overlapping ones (#4494). A pool that a module
 * creates lazily while a meter is open keeps the proxy address after `close()`
 * and still reaches the database; its statements count in later windows too.
 *
 * Rebinding closes the earlier pool: background work in flight at that moment
 * loses its connection between two statements. Stop such work around
 * `meterSql()` and `close()`, such as a live outbox, whose cut pass keeps its
 * rows claimed and holds every later row of the same key behind them (#3941).
 *
 * `during()` counts every statement of the process while `run` is pending,
 * including background work such as timers that fire in that window. That is
 * the real cost of the path; keep the window to the event under test.
 */
import { connect, createServer } from "node:net";
import { initializeTestPlatform } from "./test-infra";

export type SqlMeter = {
  /** The statements this process executed while `run` was pending. */
  during(run: () => Promise<unknown>): Promise<string[]>;
  /** Stops counting; the last open meter binds the platform's `sql` handle to the database directly again. */
  close(): Promise<void>;
};

const frameLimit = 64 * 1024 * 1024;
const sslRequest = 80877103;

const statementText = (sql: string) => sql.replace(/\s+/g, " ").trim().slice(0, 120);

// The open `during()` windows of every meter; each records every statement.
const windows = new Set<string[]>();
const record = (sql: string) => {
  for (const statements of windows) statements.push(statementText(sql));
};

const listen = (host: string, port: number): Promise<number> => {
  const proxy = createServer((client) => {
    const upstream = connect(port, host);
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    let pending = Buffer.alloc(0);
    let startup = true;
    const statements = new Map<string, string>();
    const portals = new Map<string, string>();
    // Registered before `pipe()`: a statement is recorded before the server can answer it.
    client.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= (startup ? 4 : 5)) {
        const header = startup ? 0 : 1;
        const length = pending.readInt32BE(header);
        if (length < 4 || length > frameLimit) throw new Error("meterSql() read an unexpected PostgreSQL frame");
        if (pending.length < header + length) break;
        const type = startup ? "startup" : String.fromCharCode(pending[0]!);
        const body = pending.subarray(header + 4, header + length);
        pending = pending.subarray(header + length);
        const cString = (from = 0) => body.toString("utf8", from, body.indexOf(0, from));
        if (startup) {
          if (body.readInt32BE(0) === sslRequest) throw new Error("meterSql() supports plaintext test databases only");
          startup = false;
        } else if (type === "P") {
          const name = cString();
          statements.set(name, cString(name.length + 1));
        } else if (type === "B") {
          const portal = cString();
          portals.set(portal, statements.get(cString(portal.length + 1)) ?? "<unknown statement>");
        } else if (type === "E") {
          record(portals.get(cString()) ?? "<unknown portal>");
        } else if (type === "Q") {
          record(cString());
        }
      }
    });
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  });
  // The proxy must not keep the test process alive after its last test.
  proxy.unref();
  return new Promise((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", () => {
      const address = proxy.address();
      if (!address || typeof address === "string") reject(new Error("meterSql() could not listen on loopback"));
      else resolve(address.port);
    });
  });
};

// One proxy per database server for the process, never closed: a pool may hold its address (#4494).
const proxies = new Map<string, Promise<number>>();
let open = 0;
// The direct URL while any meter is open; a meter opened meanwhile must not take the proxy URL for it.
let direct = "";

export const meterSql = async (): Promise<SqlMeter> => {
  const current = process.env.DATABASE_URL;
  if (!current) throw new Error("meterSql() needs the test database (testFor('database'))");
  const base = open > 0 ? direct : current;
  const target = new URL(base);
  const server = `${target.hostname}:${target.port || 5432}`;
  let port = proxies.get(server);
  if (!port) {
    port = listen(target.hostname, Number(target.port || 5432));
    proxies.set(server, port);
  }
  const metered = new URL(base);
  metered.hostname = "127.0.0.1";
  metered.port = String(await port);
  if (open === 0) direct = current;
  open += 1;
  if (process.env.DATABASE_URL !== metered.href) {
    process.env.DATABASE_URL = metered.href;
    try {
      await initializeTestPlatform();
    } catch (error) {
      open -= 1;
      process.env.DATABASE_URL = current;
      throw error;
    }
  }

  let recording: string[] | null = null;
  let closed = false;
  return {
    async during(run) {
      if (recording) throw new Error("meterSql() measures one window at a time");
      const statements: string[] = [];
      recording = statements;
      windows.add(statements);
      try {
        await run();
        return statements;
      } finally {
        windows.delete(statements);
        recording = null;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      open -= 1;
      if (open > 0) return;
      process.env.DATABASE_URL = direct;
      await initializeTestPlatform();
    },
  };
};
