import { expect, test } from "bun:test";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";

test("SIGTERM closes live and app-access sockets with 1012 before HTTP drain and cleanup", async () => {
  const child = Bun.spawn({
    cmd: [process.execPath, "--no-env-file", new URL("./define-app.live-shutdown.test-fixture.ts", import.meta.url).pathname],
    env: { ...process.env, NODE_ENV: "production" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const events: { event: string; url?: string; status?: number }[] = [];
  const output = (async () => {
    for await (const line of createInterface({ input: Readable.from(child.stdout) })) {
      if (line.startsWith('{"event":')) events.push(JSON.parse(line));
    }
  })();
  const errors = new Response(child.stderr).text();
  const deadline = AbortSignal.timeout(5_000);
  const until = async (name: string) => {
    while (!events.some((event) => event.event === name)) {
      if (child.exitCode !== null) throw new Error(`Shutdown probe did not reach ${name}: ${await errors}`);
      if (deadline.aborted) throw new Error(`Shutdown probe did not reach ${name}`);
      await Bun.sleep(5);
    }
    return events.find((event) => event.event === name)!;
  };
  const sockets: WebSocket[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<Response> | undefined;
  try {
    const { url } = await until("listening");
    if (!url) throw new Error("Missing shutdown probe URL");
    const closes: Array<Promise<CloseEvent>> = [];
    for (const path of ["live", "custom"]) {
      const socket = new WebSocket(`${url.replace("http:", "ws:")}api/live-shutdown/${path}`);
      sockets.push(socket);
      closes.push(new Promise((resolve) => socket.addEventListener("close", resolve, { once: true })));
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("Socket upgrade failed")), { once: true });
        deadline.addEventListener("abort", () => reject(new Error("Socket did not open")), { once: true });
      });
    }
    pending = fetch(`${url}api/live-shutdown/held`);
    void pending.catch(() => {});
    await until("in-flight");
    const started = performance.now();
    child.kill("SIGTERM");
    const closed = await Promise.race([
      Promise.all(closes),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Open live sockets blocked shutdown")), 2_000);
      }),
    ]);
    clearTimeout(timer);
    expect(closed.map(({ code }) => code)).toEqual([1012, 1012]);
    expect(closed.every(({ reason }) => reason.length > 0)).toBe(true);
    expect((await until("stopping")).status).toBe(503);
    // Keep an accepted HTTP producer alive until both sockets have closed.
    expect(events.some(({ event }) => event === "stop-outbox" || event === "stop-lifecycle")).toBe(false);
    expect(child.exitCode).toBeNull();
    child.stdin.write("finish\n");
    child.stdin.flush();
    expect(await (await pending).text()).toBe("finished");
    const exit = await Promise.race([
      child.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Shutdown cleanup did not finish")), 2_000);
      }),
    ]);
    expect({ exit, stderr: exit === 0 ? "" : await errors }).toEqual({ exit: 0, stderr: "" });
    expect(performance.now() - started).toBeLessThan(5_000);
    await output;
    const ordered = [
      "finish-http",
      "stop-links",
      "stop-outbox",
      "stop-lifecycle",
      "stop-credential",
      "stop-notifications",
      "stop-watcher",
      "leave-membership",
      "stop-heartbeat",
      "stop-sync",
    ];
    expect(events.map(({ event }) => event).filter((event) => ordered.includes(event))).toEqual(ordered);
    expect(events.some(({ event }) => event === "stop-follower")).toBe(true);
    expect(events.filter(({ event }) => event === "stop-access-watch")).toHaveLength(1);
  } finally {
    clearTimeout(timer);
    for (const socket of sockets) socket.close();
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await pending?.catch(() => {});
    await output;
    await errors;
  }
}, 10_000);
