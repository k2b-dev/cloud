import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Bun 1.4.2 segfaulted in `bun test --isolate` when a finished file's Redis or SQL client dialed again from its
// close handler: the swap freed the new socket and its connection timeout closed it later (oven-sh/bun#44327).
// The unit and integration shards crashed this way with no failing test (#2369, #1795).
let dir: string;
let server: Server;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "bun-isolate-redial-"));
  server = createServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", () => socket.write("+OK\r\n"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the fake Valkey server has no port");
  writeFileSync(
    join(dir, "a-redial.test.ts"),
    `import { test } from "bun:test";
test("leaves a client that dials again when it is closed", async () => {
  const dial = (options = {}) => new Bun.RedisClient("redis://127.0.0.1:${address.port}", { autoReconnect: false, ...options });
  const first = dial();
  first.onclose = () => void dial({ connectionTimeout: 200 }).connect().catch(() => {});
  await first.connect();
});
`,
  );
  writeFileSync(
    join(dir, "b-wait.test.ts"),
    `import { expect, test } from "bun:test";
test("outlives the connection timeout of the previous file's client", async () => {
  const junk = Array.from({ length: 1 << 14 }, (_, i) => Buffer.alloc(80, String(i)).toString());
  await Bun.sleep(200);
  expect(junk).toHaveLength(1 << 14);
});
`,
  );
});

afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

test("bun test --isolate survives a client that a finished file left dialing", async () => {
  const child = Bun.spawn(["bun", "--no-env-file", "test", "--isolate", "./a-redial.test.ts", "./b-wait.test.ts"], {
    cwd: dir,
    stdout: "ignore",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([child.stderr.text(), child.exited]);
  expect(stderr).toContain("2 pass");
  expect(exitCode).toBe(0);
}, 30_000);
