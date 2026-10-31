import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_KEY_FIXTURES, INSTALLATION_ID, KEY_ID } from "../../../../../scripts/fixtures/app-key-fixtures";
import { formatAppKey, importAppKeySeed, importAppPublicKey } from "../../app-key";
import { defineCliCommands } from "../commands";
import type { CloudCliContext, CloudCliFlags } from "../index";
import { appKeyCommands, enrollAppKey, renderAppKeyArtifact, resolveAppKeyApps } from "./app-keys";

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

test("create accepts explicit issuance or no grants, defaults to none, and rejects contradictory or unknown flags", async () => {
  const outDir = await directory();
  await seedState(outDir);
  const requests: unknown[] = [];
  const module = defineCliCommands({ name: "admin", summary: "App keys", commands: appKeyCommands });
  const invoke = async (flags: CloudCliFlags) => {
    const ctx: CloudCliContext = {
      args: ["apps", "keys", "create", "inventory"],
      flags: { "out-dir": outDir, ...flags },
      options: { profile: "test", server: "https://cloud.example.test", token: "fixture", output: "json" },
      getDefault: async () => undefined,
      setDefault: async () => {},
      createApiClient: () => {
        throw new Error("Unused");
      },
      fetch: async (_path, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return Response.json(registration);
      },
      readJson: async (response) => response.json(),
      print: () => {},
      write: async () => {},
      error: () => {},
      json: () => {},
      jsonLine: () => {},
      table: () => {},
    };
    await module.run(ctx);
  };
  await invoke({ grant: "oauth:issue" });
  expect(requests.at(-1)).toEqual({ publicKey: fixture.publicKey, grants: ["oauth:issue"] });
  await invoke({ "no-grant": true });
  expect(requests.at(-1)).toEqual({ publicKey: fixture.publicKey, grants: [] });
  await invoke({});
  expect(requests.at(-1)).toEqual({ publicKey: fixture.publicKey });
  const before = requests.length;
  await expect(invoke({ grant: "oauth:issue", "no-grant": true })).rejects.toThrow("Choose either");
  await expect(invoke({ grant: "unknown" })).rejects.toThrow();
  expect(requests.length).toBe(before);
});
