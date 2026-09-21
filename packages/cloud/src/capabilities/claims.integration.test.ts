import { beforeAll, expect, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import { sql } from "bun";
import { generateKeyPair } from "jose";
import { z } from "zod";
import { databaseSuite, testInfra } from "../../../../scripts/fixtures/test-infra";
import { compileCapabilities } from "../_internal/capabilities";
import { dispatchCapability } from "../api/capabilities";
import { defineCapabilities } from "../contracts/capabilities";
import type { CapabilityRegistryEntry } from "../contracts/registry";
import type { RequestAuthority } from "../server";
import type { withActiveIdentitySigner } from "../services/identity/key-ring";
import {
  CAPABILITY_CLAIM_RETENTION_HOURS,
  capabilityRequestHash,
  claimCapabilityIdempotency,
  completeCapabilityClaim,
  pruneCapabilityIdempotencyClaims,
} from "./claims";
import { listCapabilityExecutions, migrateCloudCapabilities } from "./executions";

const suite = databaseSuite();
beforeAll(async () => {
  if (!testInfra.database) return;
  await migrateCloudCapabilities();
});

const compiled = compileCapabilities(
  "demo",
  defineCapabilities({
    protocolVersion: 2,
    types: { item: { title: "Item", description: "One demo item." } },
    queries: {
      get: {
        title: "Get item",
        description: "Return one demo item.",
        input: z.object({ id: z.string().describe("Stable item id.") }).strict(),
        data: z.object({ id: z.string() }).strict(),
        openWorld: false,
        run: async ({ id }) => ok({ data: { id } }),
      },
    },
    actions: {
      add: {
        title: "Add item",
        description: "Add one demo item exactly once.",
        input: z.object({ name: z.string().describe("New item name.") }).strict(),
        data: z.object({ id: z.string(), name: z.string() }).strict(),
        destructive: false,
        openWorld: false,
        idempotency: "required",
        run: async ({ name }) => ok({ data: { id: "item-1", name } }),
      },
    },
  }),
);

const registryEntry: CapabilityRegistryEntry = {
  appId: "demo",
  appName: "demo",
  appIcon: "ti ti-box",
  appDescription: "demo app",
  endpoint: "http://demo:3000/api/_internal/capabilities/v1",
  manifest: compiled.manifest,
};

let signerKey: CryptoKey | undefined;
const withActiveSigner: typeof withActiveIdentitySigner = async (_purpose, callback) => {
  signerKey ??= (await generateKeyPair("RS256")).privateKey;
  return callback(
    {
      kid: "33333333-3333-4333-8333-333333333333",
      key: signerKey,
      signUntil: new Date(Date.now() + 60_000),
      issuer: "https://cloud.example.test",
    },
    sql,
  );
};

const serviceAccountId = "11111111-1111-4111-8111-111111111111";
const authority: RequestAuthority = {
  actor: {
    kind: "service_account",
    serviceAccount: {
      id: serviceAccountId,
      name: "Caller",
      kind: "resource_bound",
      status: "active",
      delegatedUserId: null,
      appId: "core",
      resourceType: "cloud.app",
      resourceId: "core",
      createdBy: null,
      createdAt: "2026-09-02T00:00:00.000Z",
    },
    delegatedUser: null,
    scopes: ["write"],
    credentialId: "22222222-2222-4222-8222-222222222222",
  },
  accessSubject: { type: "service_account", serviceAccountId },
  credentialKind: "api_key",
  scopes: ["write"],
};

type UpstreamFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const invoke = async (options: {
  key: string;
  input?: unknown;
  fetch: UpstreamFetch;
  actionTimeoutMs?: number;
}): Promise<{ status: number; body: unknown }> => {
  const response = await dispatchCapability({
    request: new Request("http://cloud.test/capabilities/v1/actions/demo/add", {
      method: "POST",
      headers: { "idempotency-key": options.key },
    }),
    kind: "actions",
    origin: "http",
    appId: "demo",
    capabilityId: "add",
    input: options.input ?? { name: "first" },
    authority,
    dependencies: {
      getCapability: async () => registryEntry,
      fetch: options.fetch,
      withActiveSigner,
      ...(options.actionTimeoutMs === undefined ? {} : { actionTimeoutMs: options.actionTimeoutMs }),
    },
  });
  return { status: response.status, body: await response.json() };
};

const succeeds: UpstreamFetch = async () => Response.json({ data: { id: "item-1", name: "first" } }, { status: 200 });
const rejects =
  (status: number, code: string): UpstreamFetch =>
  async () =>
    Response.json({ code, message: "rejected" }, { status });
const claimState = async (keyHash?: string) =>
  await sql<{ state: string; response_status: number | null }[]>`
    SELECT state, response_status FROM capabilities.idempotency_claims
    WHERE app_id = 'demo' AND capability = 'demo.add' ${keyHash ? sql`AND key_hash = ${keyHash}` : sql``}
  `;

suite("platform capability idempotency claims", () => {
  test.each([
    { body: { data: { id: "item-1" } }, jsonType: "object" },
    { body: [1, "two", null], jsonType: "array" },
    { body: "plain text", jsonType: "string" },
    { body: '{"data":1}', jsonType: "string" },
    { body: "42", jsonType: "string" },
    { body: "null", jsonType: "string" },
    { body: "", jsonType: "string" },
    { body: " ", jsonType: "string" },
    { body: 42, jsonType: "number" },
    { body: false, jsonType: "boolean" },
    { body: null, jsonType: "null" },
  ])("stores and replays the original JSON value ($jsonType)", async ({ body, jsonType }) => {
    const scope = { appId: "demo", capability: "demo.add", principal: "anonymous", keyHash: crypto.randomUUID() };
    const hash = capabilityRequestHash({ input: "unchanged" });
    expect(await claimCapabilityIdempotency(scope, hash)).toEqual({ state: "claimed" });
    await completeCapabilityClaim(scope, 200, body);
    const [stored] = await sql<{ json_type: string; response_body: unknown }[]>`
      SELECT jsonb_typeof(response_body) AS json_type, response_body
      FROM capabilities.idempotency_claims
      WHERE app_id = ${scope.appId} AND capability = ${scope.capability}
        AND principal = ${scope.principal} AND key_hash = ${scope.keyHash}
    `;
    expect(stored?.json_type).toBe(jsonType);
    expect(stored?.response_body).toEqual(body);
    expect(await claimCapabilityIdempotency(scope, hash)).toEqual({ state: "replay", status: 200, body });
  });

  test("replays a stored success without forwarding again", async () => {
    const key = `replay-${crypto.randomUUID()}`;
    let forwarded = 0;
    const counting: UpstreamFetch = async (...args) => {
      forwarded += 1;
      return succeeds(...args);
    };
    const first = await invoke({ key, fetch: counting });
    expect(first).toEqual({ status: 200, body: { data: { id: "item-1", name: "first" } } });

    const replay = await invoke({ key, fetch: counting });
    expect(replay).toEqual(first);
    expect(forwarded).toBe(1);

    const executions = await listCapabilityExecutions({ capability: "demo.add" });
    const rows = executions.items.filter((item) => item.idempotencyKey === key);
    expect(rows).toHaveLength(2);
    expect(rows.filter((item) => item.replayed)).toHaveLength(1);
  });

  test("rejects the same key with different input", async () => {
    const key = `conflict-${crypto.randomUUID()}`;
    await invoke({ key, fetch: succeeds });
    const conflict = await invoke({ key, input: { name: "second" }, fetch: succeeds });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  test("hashes input independently of key order", async () => {
    expect(capabilityRequestHash({ a: 1, b: [{ x: 1, y: 2 }] })).toBe(capabilityRequestHash({ b: [{ y: 2, x: 1 }], a: 1 }));
    expect(capabilityRequestHash({ a: 1 })).not.toBe(capabilityRequestHash({ a: 2 }));
  });

  test("rejects a concurrent attempt while the first is still in flight", async () => {
    const key = `inflight-${crypto.randomUUID()}`;
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: UpstreamFetch = async (...args) => {
      await held;
      return succeeds(...args);
    };
    const first = invoke({ key, fetch: slow });
    // The claim is written before the request is forwarded, so a second call
    // observing `in_flight` proves the ordering.
    await Bun.sleep(50);
    const concurrent = await invoke({ key, fetch: succeeds });
    expect(concurrent.status).toBe(409);
    expect(concurrent.body).toMatchObject({ code: "IDEMPOTENCY_IN_PROGRESS" });
    release?.();
    expect((await first).status).toBe(200);
  });

  test("freezes the claim as uncertain when the request times out", async () => {
    const key = `timeout-${crypto.randomUUID()}`;
    const stalls: UpstreamFetch = async (_input, init) => {
      await new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
      throw new Error("unreachable");
    };
    const timedOut = await invoke({ key, fetch: stalls, actionTimeoutMs: 25 });
    expect(timedOut.status).toBe(504);

    const retry = await invoke({ key, fetch: succeeds });
    expect(retry.status).toBe(409);
    expect(retry.body).toMatchObject({ code: "IDEMPOTENCY_UNCERTAIN" });
  });

  test("releases the claim when the app proves nothing happened", async () => {
    const key = `rejected-${crypto.randomUUID()}`;
    const denied = await invoke({ key, fetch: rejects(409, "SCHEMA_MISMATCH") });
    expect(denied.status).toBe(409);
    expect(denied.body).toMatchObject({ code: "SCHEMA_MISMATCH" });

    let forwarded = 0;
    const corrected = await invoke({
      key,
      fetch: async (...args) => {
        forwarded += 1;
        return succeeds(...args);
      },
    });
    expect(corrected.status).toBe(200);
    expect(forwarded).toBe(1);
  });

  test("keeps the claim when the app fails with a 5xx", async () => {
    const key = `server-error-${crypto.randomUUID()}`;
    const failed = await invoke({ key, fetch: rejects(500, "INTERNAL") });
    expect(failed.status).toBe(500);
    const retry = await invoke({ key, fetch: succeeds });
    expect(retry.body).toMatchObject({ code: "IDEMPOTENCY_UNCERTAIN" });
  });

  test("prunes claims past the retention window", async () => {
    const key = `prune-${crypto.randomUUID()}`;
    await invoke({ key, fetch: succeeds });
    await sql`UPDATE capabilities.idempotency_claims SET created_at = now() - interval '48 hours'`;
    const removed = await pruneCapabilityIdempotencyClaims(new Date(Date.now() - CAPABILITY_CLAIM_RETENTION_HOURS * 3_600_000));
    expect(removed).toBeGreaterThan(0);
    expect(await claimState()).toHaveLength(0);
  });
});
