import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Filegate, FilegateError, type RootClient } from "@k2b/filegate";
import { suiteFor } from "../../../scripts/fixtures/test-infra";

// Disposable Linux roots in a private container: never attach existing application volumes.
const dockerAvailable = (await Bun.$`docker info`.quiet().nothrow()).exitCode === 0;
const suite = dockerAvailable ? suiteFor("filegate") : describe.skip;
const name = `filesv2-execution-${randomUUID()}`;
const volume = `${name}-data`;
const identity = { uid: 12345, gid: 12345, groups: [] };
let directory: string;
let ownsVolume = false;
let client: Filegate;
let cloud: RootClient;
let ipa: RootClient;
let unix: RootClient;

async function docker(...args: string[]) {
  const process = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (code !== 0) throw new Error(`Docker fixture failed: ${stderr}`);
  return stdout.trim();
}
async function external(script: string) {
  await docker(
    "run",
    "--rm",
    "--name",
    `${name}-writer`,
    "--network",
    "none",
    "-v",
    `${volume}:/data`,
    "debian:13-slim",
    "sh",
    "-eu",
    "-c",
    script,
  );
}
async function error(run: () => Promise<unknown>) {
  try {
    await run();
    return null;
  } catch (cause) {
    if (cause instanceof FilegateError) return { status: cause.status, code: cause.code };
    throw cause;
  }
}

suite(
  dockerAvailable
    ? "Filegate 6.1 separate actors and indexed live Unix search"
    : "Filegate 6.1 separate actors and indexed live Unix search (skipped: docker is not available)",
  () => {
    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), "filesv2-execution-"));
      const token = randomUUID();
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
    index: true
    versioning:
      enabled: true
`,
      );
      await docker("volume", "create", volume);
      ownsVolume = true;
      await external("mkdir -p /data/cloud /data/freeipa /data/state; chmod 700 /data/cloud; chmod 755 /data/freeipa");
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
        "ghcr.io/k2b-dev/filegate:6.1.0",
        "serve",
        "--config",
        "/config/conf.yaml",
      );
      const address = await docker("port", name, "4000/tcp");
      const baseUrl = `http://${address}`;
      client = new Filegate({ baseUrl, transferBaseUrl: baseUrl, token });
      const readyUntil = Date.now() + 30_000;
      for (;;) {
        try {
          expect((await client.system()).version).toBe("6.1.0");
          break;
        } catch {
          if (Date.now() >= readyUntil) throw new Error(`Filegate fixture did not start: ${await docker("logs", name)}`);
          await Bun.sleep(250);
        }
      }
      cloud = client.root("cloud");
      ipa = client.root("freeipa");
      unix = ipa.as(identity);
      expect((await cloud.info()).execution).toBe(false);
      expect((await ipa.info()).index.enabled).toBe(true);
      expect((await ipa.info()).managed).toBe(false);
      await ipa.mkdir("home", { ownership: { uid: identity.uid, gid: identity.gid, dirMode: "0700" } });
    }, 120_000);
    afterAll(async () => {
      await docker("rm", "-f", `${name}-writer`).catch(() => {});
      await docker("rm", "-f", name).catch(() => {});
      if (ownsVolume) await docker("volume", "rm", volume);
      if (directory) await rm(directory, { recursive: true, force: true });
    }, 60_000);

    test("copies both directions without applying source credentials or ownership to the target", async () => {
      await cloud.put("cloud.txt", new Blob(["cloud data"]), { ownership: { mode: "0600" } });
      await unix.put("home/ipa.txt", new Blob(["ipa data"]), { ownership: { mode: "0600" } });
      const toIpa = await cloud.transfer("cloud.txt", "freeipa", "home/from-cloud.txt", {
        targetExecution: { mode: "unix", identity },
        ownership: { uid: identity.uid, gid: identity.gid, mode: "0600" },
      });
      expect(toIpa).toMatchObject({ state: "completed", node: { uid: identity.uid, gid: identity.gid } });
      const toCloud = await unix.transfer("home/ipa.txt", "cloud", "from-ipa.txt", {
        targetExecution: { mode: "service" },
        ownership: { mode: "0600" },
      });
      expect(toCloud).toMatchObject({ state: "completed", node: { uid: 0, gid: 0 } });
      expect(await (await unix.contentRaw("home/from-cloud.txt")).text()).toBe("cloud data");
      expect(await (await cloud.contentRaw("from-ipa.txt")).text()).toBe("ipa data");
      await ipa.put("home/denied.txt", new Blob(["secret"]), { ownership: { uid: 23456, gid: 23456, mode: "0600" } });
      expect(
        (await error(() => unix.transfer("home/denied.txt", "cloud", "must-not-exist.txt", { targetExecution: { mode: "service" } })))
          ?.status,
      ).toBe(403);
      expect((await error(() => cloud.stat("must-not-exist.txt")))?.status).toBe(404);
      await ipa.mkdir("locked", { ownership: { uid: 23456, gid: 23456, dirMode: "0700" } });
      expect(
        (await error(() => cloud.transfer("cloud.txt", "freeipa", "locked/denied.txt", { targetExecution: { mode: "unix", identity } })))
          ?.status,
      ).toBe(403);
      expect((await error(() => ipa.stat("locked/denied.txt")))?.status).toBe(404);
    });

    test("historical copies use independent actors and preserve current source content", async () => {
      await cloud.put("history.txt", new Blob(["cloud old"]));
      const cloudVersion = await cloud.snapshot("history.txt");
      await cloud.put("history.txt", new Blob(["cloud now"]), { onConflict: "overwrite" });
      const cloudBefore = await cloud.stat("history.txt");
      await cloud.copyVersion("history.txt", cloudVersion.id, "freeipa", "home/cloud-history.txt", {
        targetExecution: { mode: "unix", identity },
        ownership: { uid: identity.uid, gid: identity.gid, mode: "0600" },
      });
      await unix.put("home/history.txt", new Blob(["ipa old"]));
      const ipaVersion = await unix.snapshot("home/history.txt");
      await unix.put("home/history.txt", new Blob(["ipa now"]), { onConflict: "overwrite" });
      const ipaBefore = await unix.stat("home/history.txt");
      await unix.copyVersion("home/history.txt", ipaVersion.id, "cloud", "ipa-history.txt", { targetExecution: { mode: "service" } });
      expect(await cloud.stat("history.txt")).toEqual(cloudBefore);
      expect(await unix.stat("home/history.txt")).toEqual(ipaBefore);
      expect(await (await unix.contentRaw("home/cloud-history.txt")).text()).toBe("cloud old");
      expect(await (await cloud.contentRaw("ipa-history.txt")).text()).toBe("ipa old");
      expect(await (await cloud.contentRaw("history.txt")).text()).toBe("cloud now");
      expect(await (await unix.contentRaw("home/history.txt")).text()).toBe("ipa now");
      await ipa.setOwnership("home/history.txt", { uid: 23456, gid: 23456, mode: "0600" });
      expect(
        (
          await error(() =>
            unix.copyVersion("home/history.txt", ipaVersion.id, "cloud", "denied-history.txt", { targetExecution: { mode: "service" } }),
          )
        )?.status,
      ).toBe(403);
      expect((await error(() => cloud.stat("denied-history.txt")))?.status).toBe(404);
    });

    test("indexed Unix search observes external additions without rebuilding and rejects unreadable subtrees", async () => {
      await external(
        "mkdir /data/freeipa/home/search; echo outside > /data/freeipa/home/search/external.txt; chown -R 12345:12345 /data/freeipa/home/search; chmod 700 /data/freeipa/home/search; chmod 600 /data/freeipa/home/search/external.txt",
      );
      expect((await unix.search("external", { path: "home/search" })).items.map((item) => item.path)).toEqual(["home/search/external.txt"]);
      await external("mkdir /data/freeipa/home/search/hidden; chmod 700 /data/freeipa/home/search/hidden");
      expect((await error(() => unix.search("external", { path: "home/search" })))?.status).toBe(403);
    }, 60_000);

    test("continuations fail on deleted entries and revoked traversal instead of yielding a partial page", async () => {
      await unix.mkdir("home/pages");
      for (const name of ["a.txt", "b.txt", "c.txt"]) await unix.put(`home/pages/${name}`, new Blob([name]));
      const first = await unix.search(".txt", { path: "home/pages", sort: "name", limit: 1 });
      expect(first.next).toBeDefined();
      await external("rm /data/freeipa/home/pages/b.txt");
      expect((await error(() => unix.search(".txt", { path: "home/pages", sort: "name", limit: 1, after: first.next })))?.status).toBe(404);
      expect((await unix.search(".txt", { path: "home/pages", sort: "name" })).items.map((item) => item.path)).toEqual([
        "home/pages/a.txt",
        "home/pages/c.txt",
      ]);
      const listing = await unix.list("home/pages", { sort: "name", limit: 1 });
      expect(listing.next).toBeDefined();
      const search = await unix.search(".txt", { path: "home/pages", sort: "name", limit: 1 });
      await external("chmod 000 /data/freeipa/home/pages");
      expect((await error(() => unix.list("home/pages", { sort: "name", limit: 1, after: listing.next })))?.status).toBe(403);
      expect((await error(() => unix.search(".txt", { path: "home/pages", sort: "name", limit: 1, after: search.next })))?.status).toBe(
        403,
      );
    }, 60_000);
  },
);
