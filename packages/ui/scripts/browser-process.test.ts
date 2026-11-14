import { expect, test } from "bun:test";
import { killProcessGroup, processGroupAlive } from "../test/browser";

const signal = (pid: number, name: NodeJS.Signals) => {
  try {
    process.kill(pid, name);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
};

const stat = async (pid: number) => {
  const source = await Bun.file(`/proc/${pid}/stat`).text();
  const fields = source.slice(source.lastIndexOf(")") + 2).split(" ");
  return { state: fields[0], parent: Number(fields[1]), group: Number(fields[2]) };
};

test.skipIf(process.platform !== "linux")("a zombie-only process group is closed before its parent reaps it", async () => {
  // Stop the parent before killing its child, so the kernel retains a real zombie until cleanup resumes it.
  const parent = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `const child = Bun.spawn(["sleep", "30"], { detached: true, stdout: "ignore", stderr: "ignore" });
       console.log(child.pid);
       await Bun.stdin.text();
       child.kill("SIGKILL");
       await child.exited;`,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
  );
  let pid: number | undefined;
  try {
    const reader = parent.stdout.getReader();
    const first = await reader.read();
    reader.releaseLock();
    pid = Number(new TextDecoder().decode(first.value).trim());
    expect(pid).toBeGreaterThan(0);
    signal(parent.pid, "SIGSTOP");
    const stopped = performance.now() + 2000;
    while ((await stat(parent.pid)).state !== "T" && performance.now() < stopped) await Bun.sleep(10);
    expect((await stat(parent.pid)).state).toBe("T");
    signal(pid, "SIGKILL");
    const deadline = performance.now() + 2000;
    while ((await stat(pid)).state !== "Z" && performance.now() < deadline) await Bun.sleep(10);
    expect(await stat(pid)).toEqual({ state: "Z", parent: parent.pid, group: pid });
    // Signal 0 reports this dead group as present, even after SIGKILL.
    expect(() => process.kill(-pid!, 0)).not.toThrow();
    expect(processGroupAlive(pid)).toBe(false);
    await killProcessGroup({ pid, kill: async () => {} }, 0);
    expect((await stat(pid)).state).toBe("Z");
  } finally {
    if (pid !== undefined) signal(pid, "SIGKILL");
    signal(parent.pid, "SIGCONT");
    parent.stdin.end();
    await parent.exited;
  }
});

test.skipIf(process.platform !== "linux")("cleanup kills a living orphan after its process-group leader exits", async () => {
  const leader = Bun.spawn(["sh", "-c", "sleep 30 >/dev/null 2>&1 & echo $!"], {
    detached: true,
    stdout: "pipe",
    stderr: "inherit",
  });
  let pid: number | undefined;
  try {
    pid = Number((await new Response(leader.stdout).text()).trim());
    expect(pid).toBeGreaterThan(0);
    expect(await leader.exited).toBe(0);
    const orphan = await stat(pid);
    expect(orphan.parent).not.toBe(leader.pid);
    expect(orphan.group).toBe(leader.pid);
    expect(orphan.state).not.toBe("Z");
    expect(processGroupAlive(leader.pid)).toBe(true);
    await killProcessGroup({ pid: leader.pid, kill: async () => {} }, 0);
    let alive = false;
    try {
      alive = !["Z", "X"].includes((await stat(pid)).state!);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    expect(alive).toBe(false);
    expect(processGroupAlive(leader.pid)).toBe(false);
  } finally {
    if (pid !== undefined) signal(pid, "SIGKILL");
    leader.kill("SIGKILL");
    await leader.exited;
  }
});
