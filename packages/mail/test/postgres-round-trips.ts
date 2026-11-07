import { connect, createServer, type Socket } from "node:net";

/** Counts executed PostgreSQL commands, including transaction/savepoint commands, without recording their payloads. */
export const countPostgresRoundTrips = async (databaseUrl: string) => {
  const target = new URL(databaseUrl);
  if (!target.pathname.endsWith("_test")) throw new Error("A round-trip measurement requires a disposable test database");
  const destination = { host: target.hostname, port: Number(target.port || 5432) };
  let commands = 0;
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = connect(destination);
    sockets.add(client);
    sockets.add(upstream);
    client.on("close", () => {
      sockets.delete(client);
      upstream.destroy();
    });
    upstream.on("close", () => {
      sockets.delete(upstream);
      client.destroy();
    });
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    let pending = Buffer.alloc(0);
    let startup = true;
    client.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= (startup ? 4 : 5)) {
        const length = pending.readUInt32BE(startup ? 0 : 1) + (startup ? 0 : 1);
        if (pending.length < length) break;
        if (!startup && (pending[0] === 69 || pending[0] === 81)) commands += 1; // Execute or Query
        pending = pending.subarray(length);
        startup = false;
      }
    });
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing measurement listener");
  target.hostname = "127.0.0.1";
  target.port = String(address.port);
  target.searchParams.set("sslmode", "disable");
  return {
    url: target.toString(),
    count: () => commands,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
};
