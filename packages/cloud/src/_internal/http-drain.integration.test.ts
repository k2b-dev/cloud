// biome-ignore assist/source/organizeImports: Resolve test targets before runtime imports.
import { requireDatabaseUrl, requireInfraUrl, suiteFor, testSyncNamespace } from "../../../../scripts/fixtures/test-infra";
import { expect, test } from "bun:test";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";

suiteFor(
  "database",
  "nats",
  "valkey",
)("application HTTP shutdown on SIGTERM", () => {
  for (const mode of ["request", "stream"])
    test(`${mode}: drains HTTP before lifecycle and Sync`, async () => {
      const child = Bun.spawn({
        cmd: [process.execPath, "--no-env-file", new URL("./http-drain.test-fixture.ts", import.meta.url).pathname, mode],
        env: {
          ...process.env,
          NODE_ENV: "production",
          DATABASE_URL: requireDatabaseUrl(),
          REDIS_URL: requireInfraUrl("valkey"),
          NATS_SERVERS: requireInfraUrl("nats"),
          SYNC_NAMESPACE: testSyncNamespace(`http-drain-${mode}`),
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      type Event = { event: string; url?: string; readiness?: number };
      const events: Event[] = [];
      const output = (async () => {
        for await (const line of createInterface({ input: Readable.from(child.stdout) })) {
          if (line.startsWith('{"event":')) events.push(JSON.parse(line));
        }
      })();
      const errors = new Response(child.stderr).arrayBuffer();
      let exitTimer: ReturnType<typeof setTimeout> | undefined;
      let exited = false;
      void child.exited.then(() => {
        exited = true;
      });
      const until = async (name: string) => {
        const deadline = Date.now() + 20_000;
        while (!events.some((event) => event.event === name)) {
          if (exited || Date.now() >= deadline) throw new Error(`Drain probe did not reach ${name}`);
          await Bun.sleep(10);
        }
        return events.find((event) => event.event === name)!;
      };
      try {
        const { url } = await until("listening");
        if (!url) throw new Error("Missing probe URL");
        // A real HTTP probe captures Bun's server before the signal.
        expect((await fetch(`${url}_cloud/ready`)).status).toBe(200);
        const pending = fetch(url);
        await until("in-flight");
        let remaining: Promise<unknown> | undefined;
        if (mode === "stream") {
          const reader = (await pending).body!.getReader();
          await reader.read();
          remaining = reader.read().catch(() => undefined);
        }
        child.kill("SIGTERM");
        expect((await until("stopping")).readiness).toBe(503);
        expect(events.some((event) => event.event === "stop-hook")).toBe(false);
        if (mode === "request") {
          child.stdin.write("finish\n");
          child.stdin.flush();
          expect(await (await pending).text()).toBe("completed-with-sync");
        }
        const exit = await Promise.race([
          child.exited,
          new Promise<never>((_, reject) => {
            exitTimer = setTimeout(() => reject(new Error("HTTP shutdown exceeded drain and cleanup budget")), 40_000);
          }),
        ]);
        await remaining;
        expect(exit).toBe(0);
        await output;
        expect(events.find((event) => event.event === "stop-hook")?.readiness).toBe(503);
        if (mode === "stream") {
          expect(events.some((event) => event.event === "request-aborted")).toBe(true);
          expect(events.findIndex((event) => event.event === "request-aborted")).toBeLessThan(
            events.findIndex((event) => event.event === "stop-hook"),
          );
        }
      } finally {
        clearTimeout(exitTimer);
        if (!exited) child.kill("SIGKILL");
        await child.exited;
        await Promise.all([output, errors]);
      }
    }, 65_000);
});
