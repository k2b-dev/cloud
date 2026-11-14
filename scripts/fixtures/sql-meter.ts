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
 * characters of SQL text, never its parameters. It rebinds the platform's
 * `sql` handle through itself and back on `close()`; pools created earlier
 * keep their direct connection and are not counted.
 *
 * `during()` counts every statement of the process while `run` is pending,
 * including background work such as timers that fire in that window. That is
 * the real cost of the path; keep the window to the event under test.
 */
import { connect, createServer, type Socket } from "node:net";
import { initializeTestPlatform } from "./test-infra";

export type SqlMeter = {
  /** The statements this process executed while `run` was pending. */
  during(run: () => Promise<unknown>): Promise<string[]>;
  /** Stops counting and binds the platform's `sql` handle to the database directly again. */
  close(): Promise<void>;
};

const frameLimit = 64 * 1024 * 1024;
const sslRequest = 80877103;

const statementText = (sql: string) => sql.replace(/\s+/g, " ").trim().slice(0, 120);

export const meterSql = async (): Promise<SqlMeter> => {
  const direct = process.env.DATABASE_URL;
  if (!direct) throw new Error("meterSql() needs the test database (testFor('database'))");
  const target = new URL(direct);
  let recording: string[] | null = null;
  const record = (sql: string) => recording?.push(statementText(sql));
  const sockets = new Set<Socket>();

  const proxy = createServer((client) => {
    const upstream = connect(Number(target.port || 5432), target.hostname);
    sockets.add(client).add(upstream);
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
    client.on("close", () => {
      sockets.delete(client);
      upstream.destroy();
    });
    upstream.on("close", () => {
      sockets.delete(upstream);
      client.destroy();
    });
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("meterSql() could not listen on loopback");
  const metered = new URL(direct);
  metered.hostname = "127.0.0.1";
  metered.port = String(address.port);
  process.env.DATABASE_URL = metered.href;
  await initializeTestPlatform();

  return {
    async during(run) {
      if (recording) throw new Error("meterSql() measures one window at a time");
      recording = [];
      try {
        await run();
        return recording;
      } finally {
        recording = null;
      }
    },
    async close() {
      process.env.DATABASE_URL = direct;
      await initializeTestPlatform();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    },
  };
};
