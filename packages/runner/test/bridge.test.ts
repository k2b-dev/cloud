import { expect, jest, test } from "bun:test";
import { chmod, mkdtemp, rmdir, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppKey } from "@k2b/cloud/app-key";
import { formatAppKey, importAppPublicKey } from "@k2b/cloud/app-key";
import { RUNNER_PATHS, RunnerLeaseLostError } from "@k2b/cloud/code/runner";
import { jwtVerify } from "jose";
import { APP_KEY_FIXTURES, INSTALLATION_ID, KEY_ID } from "../../../scripts/fixtures/app-key-fixtures";
import { CoreBridge, readBytes } from "../src/bridge";
import { runnerEnvironment } from "../src/env";
import { config } from "./fixtures";

const NOW = Date.UTC(2030, 0, 2);
const key: AppKey = { installationId: INSTALLATION_ID, keyId: KEY_ID, appId: "runner", seed: APP_KEY_FIXTURES[0].seed };

test("mock Core receives real app-key signatures over each long-poll body with a fresh nonce", async () => {
  jest.setSystemTime(NOW);
  const nonces = new Set<unknown>();
  const jobProof = { jobId: INSTALLATION_ID, generation: 2, leaseKey: "a".repeat(64) };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const body = await request.text();
      const { payload } = await jwtVerify(
        request.headers.get("Authorization")!.slice(7),
        await importAppPublicKey(APP_KEY_FIXTURES[0].publicKey),
        {
          issuer: "runner",
          audience: `cloud-core:${INSTALLATION_ID}`,
          currentDate: new Date(NOW),
        },
      );
      expect(payload.htm).toBe("POST");
      expect(payload.htu).toBe(new URL(request.url).pathname);
      expect(payload.bdh).toBe(Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))).toString("base64url"));
      expect(nonces.has(payload.jti)).toBe(false);
      nonces.add(payload.jti);
      const path = new URL(request.url).pathname;
      if (path === RUNNER_PATHS.config) return Response.json(config);
      if (path === RUNNER_PATHS.jobInput) {
        expect(JSON.parse(body)).toEqual(jobProof);
        expect(body).not.toContain("token");
        return Response.json({ kind: "check", request: { files: { "code.ts": "fixture" } } });
      }
      if (path === RUNNER_PATHS.heartbeat) {
        expect(JSON.parse(body)).toEqual(jobProof);
        return Response.json({ leaseExpiresAt: NOW + 15000 });
      }
      if (path === RUNNER_PATHS.complete) {
        expect(JSON.parse(body)).toEqual({ ...jobProof, result: { kind: "check", result: { ok: false, diagnostics: [] } } });
        return new Response(null, { status: 409 });
      }
      expect(JSON.parse(body).freeSlots).toBe(2);
      return Response.json({ runs: [] });
    },
  });
  try {
    const bridge = new CoreBridge(key, server.url.origin);
    await bridge.configure(new AbortController().signal);
    for (let i = 0; i < 2; i++) await bridge.fetch({ instanceId: INSTALLATION_ID, freeSlots: 2 }, new AbortController().signal);
    const signal = new AbortController().signal;
    expect(JSON.parse(await bridge.jobInput(jobProof, signal, 1024))).toMatchObject({ kind: "check" });
    expect(await bridge.jobHeartbeat(jobProof, signal)).toEqual({ leaseExpiresAt: NOW + 15000 });
    await expect(
      bridge.jobComplete({ ...jobProof, result: { kind: "check", result: { ok: false, diagnostics: [] } } }, signal),
    ).rejects.toBeInstanceOf(RunnerLeaseLostError);
    expect(nonces.size).toBe(6);
  } finally {
    await server.stop(true);
    jest.useRealTimers();
  }
});

test("response limits count chunked bytes and caller cancellation closes a stalled body", async () => {
  const oversized = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(3));
        controller.close();
      },
    }),
  );
  await expect(readBytes(oversized, 2, new AbortController().signal)).rejects.toThrow("runner_response_too_large");
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
  );
  const controller = new AbortController();
  const pending = readBytes(response, 2, controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(cancelled).toBe(true);
});

test("runner refuses foreign app keys, conflicting key sources and non-origin Core addresses", async () => {
  const priorKey = process.env.CLOUD_APP_KEY;
  const priorFile = process.env.CLOUD_APP_KEY_FILE;
  try {
    process.env.CLOUD_APP_KEY = "x";
    process.env.CLOUD_APP_KEY_FILE = "/never-read";
    await expect(runnerEnvironment()).rejects.toThrow("must not both");
  } finally {
    if (priorKey === undefined) delete process.env.CLOUD_APP_KEY;
    else process.env.CLOUD_APP_KEY = priorKey;
    if (priorFile === undefined) delete process.env.CLOUD_APP_KEY_FILE;
    else process.env.CLOUD_APP_KEY_FILE = priorFile;
  }
  expect(() => new CoreBridge({ ...key, appId: "inventory" }, "http://core")).toThrow("runner app key");
  for (const origin of ["file:///etc", "http://core/path", "http://user:password@core", "http://core?query"])
    expect(() => new CoreBridge(key, origin)).toThrow();
});

test("Core calls use the explicit abort budget rather than Bun's five-minute idle timeout", async () => {
  let timeout: unknown;
  const send: typeof fetch = Object.assign(
    async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      timeout = init && "timeout" in init ? init.timeout : undefined;
      return Response.json(config);
    },
    { preconnect: fetch.preconnect },
  );
  await new CoreBridge(key, "http://core", send).configure(new AbortController().signal);
  expect(timeout).toBe(false);
});

test("mounted runner key requires supervisor ownership, exact 0400 and a regular file", async () => {
  const prior = { key: process.env.CLOUD_APP_KEY, file: process.env.CLOUD_APP_KEY_FILE, origin: process.env.CLOUD_CORE_INTERNAL_ORIGIN };
  const directory = await mkdtemp(join(tmpdir(), "runner-key-test-"));
  const file = join(directory, "key");
  const link = join(directory, "link");
  try {
    delete process.env.CLOUD_APP_KEY;
    process.env.CLOUD_APP_KEY_FILE = file;
    process.env.CLOUD_CORE_INTERNAL_ORIGIN = "http://core";
    await Bun.write(file, formatAppKey(key));
    await chmod(file, 0o600);
    await expect(runnerEnvironment()).rejects.toThrow("runner_key_file_requires_supervisor_owner_and_mode_0400");
    await chmod(file, 0o400);
    expect((await runnerEnvironment()).key.appId).toBe("runner");
    await symlink(file, link);
    process.env.CLOUD_APP_KEY_FILE = link;
    await expect(runnerEnvironment()).rejects.toThrow("runner_key_file_requires_supervisor_owner_and_mode_0400");
  } finally {
    for (const [name, value] of [
      ["CLOUD_APP_KEY", prior.key],
      ["CLOUD_APP_KEY_FILE", prior.file],
      ["CLOUD_CORE_INTERNAL_ORIGIN", prior.origin],
    ]) {
      if (value === undefined) delete process.env[name!];
      else process.env[name!] = value;
    }
    await unlink(link).catch(() => undefined);
    await unlink(file);
    await rmdir(directory);
  }
});
