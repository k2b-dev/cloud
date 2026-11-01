/** Image-only probe executed as the credential-free job namespace init. */
import { readdir, readlink, stat } from "node:fs/promises";

let network = false;
try {
  await fetch("http://192.0.2.1/", { signal: AbortSignal.timeout(500) });
  network = true;
} catch {
  /* New network namespace has no routes. */
}
console.log(
  JSON.stringify({
    pid: process.pid,
    parent: process.ppid,
    tmpOwner: (await stat("/tmp")).uid,
    shm: await readdir("/dev/shm"),
    queues: await readdir("/dev/mqueue"),
    ipc: await readlink("/proc/self/ns/ipc"),
    environment: Object.keys(process.env),
    processes: (await readdir("/proc")).filter((p) => /^\d+$/.test(p)),
    network,
  }),
);

if (Bun.argv.includes("--hold")) await Bun.sleep(60000);
