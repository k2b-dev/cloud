import { afterEach, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { formatAppKey, parseAppKey } from "@k2b/cloud/app-key";
import { APP_KEY_FIXTURES, INSTALLATION_ID, KEY_ID } from "../../../scripts/fixtures/app-key-fixtures";
import { bundleFirstPartyModule, installFirstPartyModules } from "../test/fixtures/first-party";

const fixture = APP_KEY_FIXTURES[0];
const tempDirs: string[] = [];
const directory = async () => {
  const dir = await mkdtemp(join(tmpdir(), "cld-app-keys-"));
  tempDirs.push(dir);
  return dir;
};
const seedState = async (outDir: string, appId = "inventory", server = "https://cloud.example.test") => {
  await mkdir(outDir, { recursive: true });
  await writeFile(
    join(outDir, `.${appId}.enrollment.json`),
    JSON.stringify({ version: 1, server, appId, seed: fixture.seed, publicKey: fixture.publicKey }),
    { mode: 0o600 },
  );
};
const registration = {
  installationId: INSTALLATION_ID,
  keyId: KEY_ID,
  fingerprint: fixture.fingerprint,
  status: "active",
  accountStatus: "active",
};
const _privateKey = formatAppKey({ installationId: INSTALLATION_ID, appId: "inventory", keyId: KEY_ID, seed: fixture.seed });
const _input = (outDir: string) => ({
  appId: "inventory",
  server: "https://cloud.example.test",
  outDir,
  format: "file" as const,
  register: async () => registration,
});

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
beforeAll(async () => {
  await bundleFirstPartyModule("admin");
});

test("real cld admin plugin creates, lists and revokes through Core's API without printing secrets", async () => {
  const dir = await directory();
  await installFirstPartyModules(dir, ["admin"]);
  const requests: Array<{ path: string; method: string; body?: unknown }> = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      const body = request.method === "POST" ? await request.json() : undefined;
      requests.push({ path, method: request.method, body });
      if (path === "/cli/plugins") return Response.json({ plugins: [] });
      if (request.method === "POST") return Response.json(registration);
      if (request.method === "DELETE") return Response.json({ ok: true });
      return Response.json({
        installationId: INSTALLATION_ID,
        items: [
          {
            keyId: KEY_ID,
            name: "Deploy",
            fingerprint: fixture.fingerprint,
            publicKey: fixture.publicKey,
            status: "active",
            accountStatus: "active",
          },
        ],
        page: 1,
        perPage: 100,
        total: 1,
        hasNext: false,
      });
    },
  });
  const run = async (args: string[]) => {
    const child = Bun.spawn(
      [
        process.execPath,
        "run",
        resolve(import.meta.dir, "index.ts"),
        "--server",
        server.url.origin,
        "--token",
        "fixture-token",
        "--json",
        "admin",
        "apps",
        "keys",
        ...args,
      ],
      {
        env: {
          ...process.env,
          BUN_OPTIONS: "--no-env-file",
          CLD_CONFIG: join(dir, "config.json"),
          XDG_CONFIG_HOME: dir,
          LANG: "C",
          CLD_LOCALE: "en",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    expect(stdout).not.toContain(fixture.seed);
    expect(stderr).not.toContain(fixture.seed);
    return JSON.parse(stdout);
  };
  try {
    const outDir = join(dir, "secrets");
    await seedState(outDir, "inventory", server.url.origin);
    const result = await run(["create", "inventory", "--out-dir", outDir]);
    expect(result[0]).toMatchObject({ appId: "inventory", keyId: KEY_ID });
    expect(parseAppKey((await readFile(result[0].file, "utf8")).trim()).seed).toBe(fixture.seed);
    expect(requests.find((entry) => entry.method === "POST")).toEqual({
      path: "/api/admin/apps/inventory/keys",
      method: "POST",
      body: { publicKey: fixture.publicKey },
    });
    expect((await run(["list", "inventory"])).items[0].keyId).toBe(KEY_ID);
    await run(["revoke", "inventory", KEY_ID, "--yes"]);
    expect(requests.at(-1)).toMatchObject({ path: `/api/admin/apps/inventory/keys/${KEY_ID}`, method: "DELETE" });
  } finally {
    await server.stop(true);
  }
});
