import { afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { formatAppKey, importAppKeySeed, importAppPublicKey, parseAppKey } from "@k2b/cloud/app-key";
import { APP_KEY_FIXTURES, INSTALLATION_ID, KEY_ID } from "../../cloud/src/app-key.test-fixture";
import { enrollAppKey, renderAppKeyArtifact, resolveAppKeyApps } from "../../cloud/src/cli/admin/app-keys";
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
const privateKey = formatAppKey({ installationId: INSTALLATION_ID, appId: "inventory", keyId: KEY_ID, seed: fixture.seed });
const input = (outDir: string) => ({
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

test("fresh concurrent CLI enrollment publishes a complete provisional fixture before any registration", async () => {
  const outDir = await directory();
  const pair = { privateKey: await importAppKeySeed(fixture.seed), publicKey: await importAppPublicKey(fixture.publicKey) };
  const generate = spyOn(crypto.subtle, "generateKey").mockResolvedValue(pair);
  const registered: string[] = [];
  try {
    const register = async (body: { publicKey: string }) => {
      const state = JSON.parse(await readFile(join(outDir, ".inventory.enrollment.json"), "utf8"));
      expect(state).toMatchObject({ seed: fixture.seed, publicKey: body.publicKey });
      expect((await stat(join(outDir, ".inventory.enrollment.json"))).mode & 0o777).toBe(0o600);
      registered.push(body.publicKey);
      return registration;
    };
    const results = await Promise.all([enrollAppKey({ ...input(outDir), register }), enrollAppKey({ ...input(outDir), register })]);
    expect(results[0]).toEqual(results[1]);
    expect(registered).toEqual([fixture.publicKey, fixture.publicKey]);
    expect(await readFile(results[0]!.file, "utf8")).toBe(privateKey + "\n");
  } finally {
    generate.mockRestore();
  }
});

test("lost registration responses resume the provisional key; final writes and repeats keep the same key with mode 0600", async () => {
  const outDir = await directory();
  await seedState(outDir);
  const publicKeys: string[] = [];
  await expect(
    enrollAppKey({
      ...input(outDir),
      register: async (body) => {
        publicKeys.push(body.publicKey);
        // Core committed the key but the HTTP response was lost.
        throw new Error("Connection closed after commit");
      },
    }),
  ).rejects.toThrow("Connection closed");
  expect(await readdir(outDir)).toEqual([".inventory.enrollment.json"]);
  const result = await enrollAppKey({
    ...input(outDir),
    register: async (body) => {
      publicKeys.push(body.publicKey);
      return registration;
    },
  });
  expect(publicKeys).toEqual([fixture.publicKey, fixture.publicKey]);
  expect(await readFile(result.file, "utf8")).toBe(privateKey + "\n");
  expect((await stat(result.file)).mode & 0o777).toBe(0o600);
  expect((await stat(join(outDir, ".inventory.enrollment.json"))).mode & 0o777).toBe(0o600);
  expect(await enrollAppKey(input(outDir))).toEqual(result);
  expect(JSON.stringify(result)).not.toContain(fixture.seed);
  expect(result.environment).toEqual({ CLOUD_APP_KEY_FILE: result.file });
});

test("a failed final-file write can resume without a new key and concurrent repeats share the provisional artifact", async () => {
  const outDir = await directory();
  await seedState(outDir);
  const path = join(outDir, "inventory.key");
  await mkdir(path);
  const publicKeys: string[] = [];
  const register = async (body: { publicKey: string }) => {
    publicKeys.push(body.publicKey);
    return registration;
  };
  await expect(enrollAppKey({ ...input(outDir), register })).rejects.toThrow();
  await rm(path, { recursive: true });
  const [one, two] = await Promise.all([enrollAppKey({ ...input(outDir), register }), enrollAppKey({ ...input(outDir), register })]);
  expect(one).toEqual(two);
  expect(new Set(publicKeys)).toEqual(new Set([fixture.publicKey]));
  expect((await readdir(outDir)).sort()).toEqual([".inventory.enrollment.json", "inventory.key"]);
});

test("mismatched server, seed/public pair, fingerprint and unsupported ownership fail without losing provisional state", async () => {
  const outDir = await directory();
  await seedState(outDir);
  let calls = 0;
  const register = async () => {
    calls++;
    return registration;
  };
  await expect(enrollAppKey({ ...input(outDir), server: "https://other.example.test", register })).rejects.toThrow("different server");
  expect(calls).toBe(0);
  await writeFile(
    join(outDir, ".inventory.enrollment.json"),
    JSON.stringify({
      version: 1,
      server: "https://cloud.example.test",
      appId: "inventory",
      seed: fixture.seed,
      publicKey: APP_KEY_FIXTURES[1].publicKey,
    }),
  );
  await expect(enrollAppKey({ ...input(outDir), register })).rejects.toThrow("does not match");
  expect(calls).toBe(0);
  await seedState(outDir);
  await expect(
    enrollAppKey({ ...input(outDir), register: async () => ({ ...registration, fingerprint: "0".repeat(32) }) }),
  ).rejects.toThrow("fingerprint");
  const uid = process.getuid?.();
  if (uid !== undefined && uid !== 0)
    await expect(enrollAppKey({ ...input(outDir), uid: uid + 1, register })).rejects.toThrow("--uid requires");
});

test("all four formats preserve the same private key and --all needs an explicit operator inventory", async () => {
  const outDir = await directory();
  await seedState(outDir);
  expect(renderAppKeyArtifact("inventory", privateKey, "file")).toBe(privateKey + "\n");
  expect(renderAppKeyArtifact("inventory", privateKey, "env")).toBe(`CLOUD_APP_KEY=${privateKey}\n`);
  expect(renderAppKeyArtifact("inventory", privateKey, "compose")).toContain(`CLOUD_APP_KEY: "${privateKey}"`);
  expect(renderAppKeyArtifact("inventory", privateKey, "k8s-secret")).toContain(`stringData:\n  CLOUD_APP_KEY: "${privateKey}"`);
  for (const format of ["env", "compose", "k8s-secret"] as const) {
    const result = await enrollAppKey({ ...input(outDir), format });
    expect((await stat(result.file)).mode & 0o777).toBe(0o600);
    expect(await readFile(result.file, "utf8")).toBe(renderAppKeyArtifact("inventory", privateKey, format));
  }
  expect(await resolveAppKeyApps(["inventory", "oauth", "inventory"], false)).toEqual(["inventory", "oauth"]);
  expect(await resolveAppKeyApps([], true, "inventory,oauth")).toEqual(["inventory", "oauth"]);
  const appsFile = join(outDir, "apps.txt");
  await writeFile(appsFile, "inventory\noauth\n");
  expect(await resolveAppKeyApps([], true, appsFile)).toEqual(["inventory", "oauth"]);
  await expect(resolveAppKeyApps([], true)).rejects.toThrow("--apps");
  await expect(resolveAppKeyApps(["inventory"], true, "oauth")).rejects.toThrow();
  await expect(resolveAppKeyApps([], false, "inventory")).rejects.toThrow();
  await expect(resolveAppKeyApps(["core"], false)).rejects.toThrow();
  await expect(resolveAppKeyApps([], true, join(outDir, "missing-file"))).rejects.toThrow();
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

test("existing output without enrollment state is preserved before any registration", async () => {
  const outDir = await directory();
  const existing = join(outDir, "inventory.key");
  await writeFile(existing, "existing private material", { mode: 0o600 });
  let calls = 0;
  await expect(
    enrollAppKey({
      ...input(outDir),
      register: async () => {
        calls++;
        return registration;
      },
    }),
  ).rejects.toThrow("Output already exists");
  expect(await readFile(existing, "utf8")).toBe("existing private material");
  expect(calls).toBe(0);
});

for (const state of [{ status: "revoked" }, { status: "expired" }, { accountStatus: "disabled" }])
  test(`inactive enrollment ${JSON.stringify(state)} never publishes a final key`, async () => {
    const outDir = await directory();
    await seedState(outDir);
    await expect(enrollAppKey({ ...input(outDir), register: async () => ({ ...registration, ...state }) })).rejects.toThrow();
    expect(await readdir(outDir)).toEqual([".inventory.enrollment.json"]);
  });
