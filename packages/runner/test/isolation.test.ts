import { test as bunTest, expect } from "bun:test";
import { chmod, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { WorkerdEngine } from "../src/engine";
import { config, lease, source } from "./fixtures";

// CI runs this file in the runner image with the production capabilities.
const test = bunTest.skipIf(process.getuid?.() !== 0);

test("native probes inside actual workerd groups cannot reach the key, supervisor or sibling", async () => {
  const base = `/tmp/runner-isolation-${process.pid}`;
  const key = process.env.CLOUD_APP_KEY_FILE ?? `${base}.key`;
  const staged = key !== `${base}.key`;
  const engine = new WorkerdEngine(join(import.meta.dir, "isolation-probe"));
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<null>();
  const signal = new AbortController().signal;
  let victim: Promise<unknown> | undefined;
  try {
    // Public test bytes, not an installation credential. Same ownership/mode as production.
    if (!staged) {
      await Bun.write(key, "public-isolation-test-key");
      await chmod(key, 0o400);
    }
    expect((await stat(key)).uid).toBe(process.getuid!());
    await Bun.write(`${base}.targets`, "0");
    // The real entrypoint intentionally leaves umask 0077 after staging a key.
    // Only these public probe coordinates may cross into a workerd UID.
    await chmod(`${base}.targets`, 0o644);
    const first = lease({ runId: "isolation-victim" });
    await engine.load(
      first,
      source,
      config,
      async () => {
        entered.resolve();
        return finish.promise;
      },
      signal,
    );
    victim = engine.run(first, signal);
    await Promise.race([
      entered.promise,
      victim.then(() => {
        throw new Error("victim_exited_before_probe");
      }),
    ]);
    const [pid, path] = (await Bun.file(`${base}.victim`).text()).trim().split(" ");
    if (!pid || !path) throw new Error("missing_native_victim");
    await Bun.write(`${base}.targets`, `${pid} ${key} ${join(dirname(path), "workerd.sock")} ${path}`);
    const attacker = lease({ runId: "isolation-attacker", organizationId: "other-org" });
    await engine.load(attacker, source, config, async () => null, signal);
    expect(await engine.run(attacker, signal)).toBe("succeeded");
    const [attackerPid] = (await Bun.file(`${base}.passed`).text()).trim().split(" ");
    expect(attackerPid).not.toBe(pid);
    // The original PID reported by the probe has now exec'd the real workerd.
    expect(await Bun.file(`/proc/${attackerPid}/comm`).text()).toBe("workerd\n");
    finish.resolve(null);
    expect(await victim).toBe("succeeded");
  } finally {
    finish.resolve(null);
    await engine.close();
    await victim;
    await Promise.all(
      [...(staged ? [] : [key]), `${base}.targets`, `${base}.victim`, `${base}.passed`].map((path) => unlink(path).catch(() => undefined)),
    );
  }
}, 10_000);
