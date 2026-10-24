import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Filegate } from "@k2b/filegate";
import { testInfra } from "../../../scripts/fixtures/test-infra";
import { localFilegateToken } from "./private-database";

/** Explicit local test target, or an isolated daemon in CI; never silently skip storage assertions. */
export async function activityFilegate(): Promise<{ url: string; token: string; stop(): Promise<void> }> {
  if (testInfra.filegate) return { url: testInfra.filegate, token: await localFilegateToken(), stop: async () => {} };
  const name = `filesv2-activity-${randomUUID()}`;
  const volume = `${name}-data`;
  const directory = await mkdtemp(join(tmpdir(), "filesv2-activity-"));
  const token = randomUUID();
  let ownsVolume = false;
  let ownsContainer = false;
  let ownsInitializer = false;
  const startup = AbortSignal.timeout(20_000);
  async function command(args: string[], signal: AbortSignal, allowMissing = false) {
    const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe", signal });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0 && !(allowMissing && /No such (container|volume)/i.test(stderr)))
      throw new Error(`Activity Filegate fixture: ${stderr.trim()}`);
    return stdout.trim();
  }
  const docker = (...args: string[]) => command(args, startup);
  async function stop() {
    try {
      if (ownsInitializer) {
        await command(["rm", "--force", `${name}-init`], AbortSignal.timeout(5_000), true);
        ownsInitializer = false;
      }
      if (ownsContainer) {
        await command(["rm", "--force", name], AbortSignal.timeout(5_000), true);
        ownsContainer = false;
      }
    } finally {
      try {
        if (ownsVolume) {
          await command(["volume", "rm", volume], AbortSignal.timeout(5_000), true);
          ownsVolume = false;
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
  try {
    await Bun.write(join(directory, "token"), token);
    await Bun.write(
      join(directory, "conf.yaml"),
      `server:
  listen: "0.0.0.0:4000"
  public_url: "http://127.0.0.1:4000"
auth:
  token_file: /config/token
state_dir: /data/state
roots:
  - name: cloud
    path: /data/cloud
    managed: true
    index: true
    versioning:
      enabled: true
  - name: freeipa
    path: /data/freeipa
    execution: true
    index: false
`,
    );
    ownsVolume = true;
    await docker("volume", "create", volume);
    ownsInitializer = true;
    await docker(
      "run",
      "--rm",
      "--name",
      `${name}-init`,
      "--network",
      "none",
      "-v",
      `${volume}:/data`,
      "debian:13-slim",
      "sh",
      "-eu",
      "-c",
      "mkdir -p /data/cloud /data/freeipa /data/state; chmod 700 /data/cloud; chmod 755 /data/freeipa",
    );
    ownsInitializer = false;
    // Docker can create the named container before reporting a startup failure.
    ownsContainer = true;
    await docker(
      "run",
      "-d",
      "--name",
      name,
      "--user",
      "0:0",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "CHOWN",
      "--cap-add",
      "DAC_OVERRIDE",
      "--cap-add",
      "FOWNER",
      "--cap-add",
      "FSETID",
      "--cap-add",
      "SETUID",
      "--cap-add",
      "SETGID",
      "--security-opt",
      "no-new-privileges:true",
      "-p",
      "127.0.0.1::4000",
      "-v",
      `${volume}:/data`,
      "-v",
      `${directory}:/config:ro`,
      "ghcr.io/k2b-dev/filegate:7.1.0",
      "serve",
      "--config",
      "/config/conf.yaml",
    );
    const url = `http://${await docker("port", name, "4000/tcp")}`;
    const client = new Filegate({ baseUrl: url, token });
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        const system = await client.system(startup);
        if (system.version !== "7.1.0") throw new Error("Unexpected Filegate fixture version");
        break;
      } catch (error) {
        if (startup.aborted || Date.now() >= deadline) throw error;
        await Bun.sleep(250);
      }
    }
    return { url, token, stop };
  } catch (error) {
    try {
      await stop();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Activity Filegate startup and cleanup failed");
    }
    throw error;
  }
}
