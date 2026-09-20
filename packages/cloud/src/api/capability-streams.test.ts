import { expect, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import { sql } from "bun";
import { generateKeyPair } from "jose";
import { z } from "zod";
import { compileCapabilities, invokeCompiledCapability } from "../_internal/capabilities";
import { invokeCapabilityStream } from "../_internal/capability-streams";
import { type CapabilityExecutionContext, type CapabilityStream, defineCapabilities } from "../contracts/capabilities";
import type { CapabilityRegistryEntry } from "../contracts/registry";
import type { RequestAuthority } from "../server";
import type { CapabilityDispatchDependencies } from "./capabilities";
import { dispatchCapabilityStream, sealCapabilityStream } from "./capability-streams";

const authority: RequestAuthority = {
  actor: {
    kind: "service_account",
    credentialId: "22222222-2222-4222-8222-222222222222",
    serviceAccount: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Test",
      kind: "resource_bound",
      status: "active",
      delegatedUserId: null,
      appId: "core",
      resourceType: "cloud.app",
      resourceId: "core",
      createdBy: null,
      createdAt: "2026-09-20T00:00:00Z",
    },
    delegatedUser: null,
    scopes: ["read", "write"],
  },
  accessSubject: { type: "service_account", serviceAccountId: "11111111-1111-4111-8111-111111111111" },
  credentialKind: "api_key",
  scopes: ["read", "write"],
};
const context: CapabilityExecutionContext = {
  actor: authority.actor,
  accessSubject: authority.accessSubject,
  user: null,
  requestId: "test-stream",
  locale: "en",
  origin: "http",
  signal: new AbortController().signal,
};
const payload = new Uint8Array(5 * 1024 * 1024).fill(42);
const expiresAt = () => new Date(Date.now() + 60_000).toISOString();
let writable = true;
const saved = new Map<string, Uint8Array>();
let aborted = false;
const definition = defineCapabilities({
  protocolVersion: 2,
  queries: {
    "invoice.pdf": {
      title: "Read invoice",
      description: "Invoice stream",
      input: z.object({}).strict(),
      data: z.object({}),
      openWorld: false,
      run: () =>
        ok({
          data: {},
          stream: { id: "invoice-1", direction: "read", mediaType: "application/pdf", size: payload.length, expiresAt: expiresAt() },
        }),
      stream: { direction: "read", maxBytes: payload.length, read: async () => new Response(payload) },
    },
    "audio.read": {
      title: "Read audio",
      description: "Audio stream",
      input: z.object({}).strict(),
      data: z.object({}),
      openWorld: false,
      run: () =>
        ok({
          data: {},
          stream: { id: "audio-1", direction: "read", mediaType: "audio/wav", size: payload.length, expiresAt: expiresAt() },
        }),
      stream: { direction: "read", maxBytes: payload.length, read: async () => new Response(payload) },
    },
  },
  actions: {
    "archive.import": {
      title: "Import archive",
      description: "Import bytes",
      input: z.object({}).strict(),
      data: z.object({ id: z.string() }),
      openWorld: false,
      destructive: false,
      idempotency: "required",
      run: () =>
        ok({
          data: { id: "upload-1" },
          stream: { id: "upload-1", direction: "write", mediaType: "application/zip", size: payload.length, expiresAt: expiresAt() },
        }),
      stream: {
        direction: "write",
        maxBytes: payload.length,
        write: async (ref, body) => {
          if (!writable) throw { code: "FORBIDDEN", message: "Revoked", status: 403 };
          const bytes = new Uint8Array(await new Response(body).arrayBuffer());
          saved.set(ref.id, bytes);
          return { data: { id: ref.id } };
        },
        status: async (ref) =>
          saved.has(ref.id) ? { state: "completed", result: { data: { id: ref.id } } } : aborted ? { state: "aborted" } : { state: "open" },
        abort: async () => {
          aborted = true;
        },
      },
    },
  },
});
const compiled = compileCapabilities("independent-provider", definition);
const entry: CapabilityRegistryEntry = {
  appId: compiled.manifest.appId,
  appName: "Independent",
  appIcon: "ti ti-box",
  appDescription: "Test provider",
  endpoint: "http://independent/api/_internal/capabilities/v1",
  manifest: compiled.manifest,
};
const signer = (await generateKeyPair("RS256")).privateKey;
let calls = 0;
const deps: CapabilityDispatchDependencies & { recordStreamExecution: () => Promise<string> } = {
  recordStreamExecution: async () => "recorded",
  getCapability: async () => entry,
  withActiveSigner: async (_, fn) =>
    fn(
      {
        kid: "33333333-3333-4333-8333-333333333333",
        key: signer,
        signUntil: new Date(Date.now() + 60_000),
        issuer: "https://cloud.example",
      },
      sql,
    ),
  fetch: async (url, init) => {
    calls++;
    expect(new Headers(init?.headers).get("cookie")).toBeNull();
    expect(new Headers(init?.headers).get("authorization")).toStartWith("Bearer ey");
    const request = new Request(url, init);
    const parts = new URL(request.url).pathname.split("/");
    return invokeCapabilityStream({
      compiled,
      kind: parts.at(-3) === "queries" ? "queries" : "actions",
      localId: decodeURIComponent(parts.at(-2)!),
      verb: parts.at(-1)!,
      request,
      context,
    });
  },
};
async function open(kind: "query" | "action", localId: string) {
  const operation = (kind === "query" ? compiled.queries : compiled.actions).get(localId)!;
  const invoked = await invokeCompiledCapability({
    compiled,
    kind,
    localId,
    input: {},
    expectedSchemaHash: operation.manifest.schemaHash,
    context: { ...context, ...(kind === "action" ? { idempotencyKey: "test-upload-key" } : {}) },
  });
  if (!invoked.ok || !invoked.data.stream) throw new Error("Missing test offer");
  return sealCapabilityStream(invoked.data.stream, {
    appId: entry.appId,
    kind: kind === "query" ? "queries" : "actions",
    capabilityId: localId,
    schemaHash: operation.manifest.schemaHash,
    authority,
    requestId: context.requestId,
  });
}
const request = (ref: CapabilityStream, body?: BodyInit) =>
  new Request("http://cloud/api/capabilities/v1/streams/read", { method: "POST", headers: { "x-cloud-stream-id": ref.id }, body });

test("same generic transport reads PDF and audio from an independent provider above JSON limits", async () => {
  for (const localId of ["invoice.pdf", "audio.read"]) {
    const ref = await open("query", localId);
    expect(ref.id).not.toBe(localId);
    const response = await dispatchCapabilityStream(request(ref), authority, "read", deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(ref.mediaType);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(payload);
  }
});
test("binary upload publishes only after complete input and exposes a receipt", async () => {
  const ref = await open("action", "archive.import");
  saved.clear();
  aborted = false;
  expect(await (await dispatchCapabilityStream(request(ref), authority, "status", deps)).json()).toEqual({ state: "open" });
  const short = await dispatchCapabilityStream(request(ref, payload.slice(0, 100)), authority, "write", deps);
  expect(short.status).toBe(409);
  expect(saved.size).toBe(0);
  const excess = await dispatchCapabilityStream(request(ref, new Uint8Array(payload.length + 1)), authority, "write", deps);
  expect(excess.status).toBe(409);
  expect(saved.size).toBe(0);
  expect((await dispatchCapabilityStream(request(ref, payload), authority, "write", deps)).status).toBe(200);
  expect(saved.get("upload-1")).toEqual(payload);
  expect(await (await dispatchCapabilityStream(request(ref), authority, "status", deps)).json()).toEqual({
    state: "completed",
    result: { data: { id: "upload-1" } },
  });
});
test("forged, expired, wrong-direction and differently scoped grants never reach the provider", async () => {
  const ref = await open("query", "invoice.pdf");
  const before = calls;
  expect((await dispatchCapabilityStream(request({ ...ref, id: ref.id + "x" }), authority, "read", deps)).status).toBe(403);
  expect((await dispatchCapabilityStream(request(ref), { ...authority, scopes: ["read"] }, "read", deps)).status).toBe(403);
  expect((await dispatchCapabilityStream(request(ref), authority, "write", deps)).status).toBe(403);
  const expired = await sealCapabilityStream(
    { ...ref, id: "invoice-1", expiresAt: new Date(0).toISOString() },
    {
      appId: entry.appId,
      kind: "queries",
      capabilityId: "invoice.pdf",
      schemaHash: compiled.manifest.queries[0]!.schemaHash,
      authority,
      requestId: "expired",
    },
  );
  expect((await dispatchCapabilityStream(request(expired), authority, "read", deps)).status).toBe(410);
  expect(calls).toBe(before);
});
test("provider rechecks revoked permissions and abort is observable", async () => {
  saved.clear();
  const ref = await open("action", "archive.import");
  writable = false;
  try {
    expect((await dispatchCapabilityStream(request(ref, payload), authority, "write", deps)).status).toBe(403);
    expect(saved.size).toBe(0);
  } finally {
    writable = true;
  }
  expect((await dispatchCapabilityStream(request(ref), authority, "abort", deps)).status).toBe(200);
  expect(await (await dispatchCapabilityStream(request(ref), authority, "status", deps)).json()).toEqual({ state: "aborted" });
});

test("changed live contracts invalidate existing stream grants", async () => {
  const ref = await open("query", "invoice.pdf");
  const before = calls;
  const changed = structuredClone(entry);
  changed.manifest.queries.find((q) => q.localId === "invoice.pdf")!.schemaHash = "changed";
  expect((await dispatchCapabilityStream(request(ref), authority, "read", { ...deps, getCapability: async () => changed })).status).toBe(
    409,
  );
  expect(calls).toBe(before);
});

test("canceling a read cancels the upstream stream instead of draining it", async () => {
  const ref = await open("query", "invoice.pdf");
  let canceled = false;
  const response = await dispatchCapabilityStream(request(ref), authority, "read", {
    ...deps,
    fetch: async () =>
      new Response(
        new ReadableStream({
          pull(c) {
            c.enqueue(new Uint8Array(1024));
          },
          cancel() {
            canceled = true;
          },
        }),
      ),
  });
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  await Bun.sleep(0);
  expect(canceled).toBe(true);
});

test("real HTTP upload failures are bounded errors; provider 401 never requests an auth replay", async () => {
  const ref = await open("action", "archive.import");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => invokeCapabilityStream({ compiled, kind: "actions", localId: "archive.import", verb: "write", request, context }),
  });
  try {
    const response = await dispatchCapabilityStream(request(ref, new Uint8Array(10)), authority, "write", {
      ...deps,
      fetch,
      getCapability: async () => ({ ...entry, endpoint: server.url.origin }),
    });
    expect([409, 502]).toContain(response.status);
    expect(await response.json()).toHaveProperty("code");
  } finally {
    await server.stop(true);
  }
  const denied = await dispatchCapabilityStream(request(ref), authority, "status", {
    ...deps,
    fetch: async () => Response.json({ message: "JWT rejected" }, { status: 401 }),
  });
  expect(denied.status).toBe(502);
});

test("Core binds turn streams to their continuation and rechecks operation policy before provider access", async () => {
  const ref = await sealCapabilityStream({ id: "invoice-1", direction: "read", mediaType: "application/pdf", size: payload.length, expiresAt: expiresAt() }, {
    appId: entry.appId, kind: "queries", capabilityId: "invoice.pdf", schemaHash: compiled.queries.get("invoice.pdf")!.manifest.schemaHash,
    authority, requestId: "bound-turn", continuation: "turn:A", origin: "assistant",
  });
  const request = () => new Request("http://core/api/capabilities/v1/streams/read", { method: "POST", headers: { "x-cloud-stream-id": ref.id } });
  const before = calls;
  for (const options of [{}, { continuation: "turn:B" }, { continuation: "turn:A", allow: async () => false }]) {
    expect((await dispatchCapabilityStream(request(), authority, "read", { ...deps, ...options })).status).toBe(403);
  }
  expect(calls).toBe(before);
  const response = await dispatchCapabilityStream(request(), authority, "read", { ...deps, continuation: "turn:A", allow: async operation => operation.capabilityId === "invoice.pdf" });
  expect(response.status).toBe(200);
  expect((await response.arrayBuffer()).byteLength).toBe(payload.length);
});
