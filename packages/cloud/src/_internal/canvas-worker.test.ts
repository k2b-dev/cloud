import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnCanvasWorker } from "./canvas-worker";

test("canvas CPU budgets allow idle time and keep bounded exit diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-canvas-cpu-"));
  let child: ReturnType<typeof spawnCanvasWorker> | undefined;
  try {
    const worker = join(root, "worker.ts");
    await Bun.write(worker, 'await Bun.sleep(1200); console.error("x".repeat(32 * 1024)); console.log("finished"); process.exitCode = 7;');
    child = spawnCanvasWorker(pathToFileURL(worker), "canvas-cpu-test", "", 1);
    expect(await new Response(child.stdout).text()).toBe("finished\n");
    expect(await child.exited).toBe(7);
    expect(child.signalCode).toBeNull();
    expect((await child.diagnostics).length).toBe(16 * 1024);
  } finally {
    child?.kill("SIGKILL");
    await child?.exited;
    await rm(root, { recursive: true, force: true });
  }
});

test("canvas CPU budgets stop a runaway renderer", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-canvas-cpu-"));
  let child: ReturnType<typeof spawnCanvasWorker> | undefined;
  try {
    const worker = join(root, "worker.ts");
    await Bun.write(worker, "while (true) {}");
    child = spawnCanvasWorker(pathToFileURL(worker), "canvas-cpu-test", "", 1);
    await new Response(child.stdout).text();
    expect(await child.exited).not.toBe(0);
    expect(child.signalCode === "SIGXCPU" || child.signalCode === "SIGKILL").toBe(true);
    await child.diagnostics;
  } finally {
    child?.kill("SIGKILL");
    await child?.exited;
    await rm(root, { recursive: true, force: true });
  }
});
