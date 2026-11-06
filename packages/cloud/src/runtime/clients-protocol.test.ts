import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createSql } from "./clients";
import { bindConnections, connections, hasConnections } from "./connections";

const packet = (tag: string, body: Buffer): Buffer => {
  const header = Buffer.alloc(5);
  header.write(tag);
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
};
type WireState = { buffer: Buffer; started: boolean; transaction: boolean };

for (const operator of ["default", "url", "connection"] as const) {
  test(`SQL sends its ${operator} application name at startup, with zero SETs over 20 transactions`, async () => {
    const startups: string[][] = [];
    const queries: string[] = [];
    const errors: Error[] = [];
    const listener = Bun.listen<WireState>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(socket) {
          socket.data = { buffer: Buffer.alloc(0), started: false, transaction: false };
        },
        data(socket, chunk) {
          socket.data.buffer = Buffer.concat([socket.data.buffer, chunk]);
          for (;;) {
            const data = socket.data.buffer;
            if (!socket.data.started) {
              if (data.length < 4 || data.length < data.readInt32BE(0)) return;
              const length = data.readInt32BE(0);
              startups.push(data.subarray(8, length).toString().split("\0"));
              socket.data.buffer = data.subarray(length);
              socket.data.started = true;
              socket.write(
                Buffer.concat([
                  packet("R", Buffer.alloc(4)),
                  packet("S", Buffer.from("server_version\0" + "18.4\0")),
                  packet("Z", Buffer.from("I")),
                ]),
              );
              continue;
            }
            if (data.length < 5 || data.length < 1 + data.readInt32BE(1)) return;
            const length = 1 + data.readInt32BE(1);
            const tag = data.toString("utf8", 0, 1);
            const query = data.subarray(5, length - 1).toString();
            socket.data.buffer = data.subarray(length);
            if (tag === "Q") {
              queries.push(query);
              if (query === "BEGIN") socket.data.transaction = true;
              if (query === "COMMIT" || query === "ROLLBACK") socket.data.transaction = false;
              const command = query.startsWith("SELECT") ? "SELECT 0" : query;
              socket.write(
                Buffer.concat([packet("C", Buffer.from(`${command}\0`)), packet("Z", Buffer.from(socket.data.transaction ? "T" : "I"))]),
              );
            } else if (tag === "X") socket.end();
            else if (tag !== "H") throw new Error(`Unexpected Postgres message ${tag}`);
          }
        },
        error(_socket, error) {
          errors.push(error);
        },
      },
    });
    const previous = hasConnections() ? connections() : undefined;
    const url = new URL(`postgres://fixture:fixture@127.0.0.1:${listener.port}/wire_test`);
    if (operator === "url") url.searchParams.set("application_name", "operator-owned");
    bindConnections({
      appId: "wire-test",
      database: { url: url.toString() },
      valkey: { url: "redis://127.0.0.1:1" },
      nats: { servers: [], namespace: "", replicas: 1, ignoreClusterUpdates: true },
      appSecret: { current: "fixture" },
      sources: {
        database: { url: "env" },
        valkey: { url: "env" },
        nats: { servers: "env", namespace: "env", replicas: "env", ignoreClusterUpdates: "env" },
        appSecret: { current: "env" },
      },
    });
    const client = createSql({
      max: 1,
      tls: false,
      ...(operator === "connection" ? { connection: { application_name: "operator-owned" } } : {}),
    });
    try {
      for (let index = 0; index < 20; index++)
        await client.begin(async (tx) => {
          await tx.unsafe("SELECT 1").simple();
        });
      expect(startups).toHaveLength(1);
      const startup = startups[0]!;
      expect(startup.filter((value) => value === "application_name")).toHaveLength(1);
      expect(startup[startup.indexOf("application_name") + 1]).toBe(operator === "default" ? "cloud:wire-test" : "operator-owned");
      expect(queries).toEqual(Array.from({ length: 20 }, () => ["BEGIN", "SELECT 1", "COMMIT"]).flat());
      expect(queries.filter((query) => /^SET\b/i.test(query))).toHaveLength(0);
      expect(errors).toEqual([]);
    } finally {
      await client.close();
      listener.stop(true);
      bindConnections(previous);
    }
  });
}
