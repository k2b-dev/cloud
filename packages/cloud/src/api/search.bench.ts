import { ok } from "@k2b/stdlib";
import { sql } from "bun";
import type { MiddlewareHandler } from "hono";
import { generateKeyPair, jwtVerify, SignJWT } from "jose";
import { compileCapabilities } from "../_internal/capabilities";
import { defineCapabilities, UniversalSearchDataSchema, UniversalSearchInputSchema } from "../contracts/capabilities";
import type { CapabilityRegistryEntry } from "../contracts/registry";
import type { AuthContext } from "../server";
import type { signInvocationToken } from "../services/identity/invocation-token";
import type { withActiveIdentitySigner } from "../services/identity/key-ring";
import { createSearchRoutes } from "./search";

const ITERATIONS = 30;
const WARMUP_ITERATIONS = 5;
const PROVIDER_LATENCY_MS = 5;
const ISSUER = "https://cloud.test";

const capabilities = defineCapabilities({
  protocolVersion: 1,
  types: { item: { title: "Item", description: "A benchmark item." } },
  queries: {
    search: {
      title: "Search items",
      description: "Find benchmark items.",
      input: UniversalSearchInputSchema,
      data: UniversalSearchDataSchema,
      openWorld: false,
      universalSearch: { tags: [{ tag: "item", title: "Items", description: "Show benchmark items." }] },
      run: async () => ok({ data: [] }),
    },
  },
});

const authenticate: MiddlewareHandler<AuthContext> = async (c, next) => {
  const user = { id: "11111111-1111-4111-8111-111111111111", roles: ["user"] } as AuthContext["Variables"]["user"];
  c.set("actor", { kind: "user", user });
  c.set("accessSubject", { type: "user", userId: user.id });
  c.set("user", user);
  c.set("credentialKind", "session");
  c.set("credentialScopes", []);
  await next();
};

const providers = (count: number): CapabilityRegistryEntry[] =>
  Array.from({ length: count }, (_, index) => {
    const appId = `bench-${String(index).padStart(2, "0")}`;
    return {
      appId,
      appName: `Bench ${index}`,
      appIcon: "ti ti-box",
      appDescription: "",
      endpoint: `http://${appId}:3000/api/_internal/capabilities/v1`,
      manifest: compileCapabilities(appId, capabilities).manifest,
    };
  });

const { privateKey, publicKey } = await generateKeyPair("RS256");
const withActiveSigner: typeof withActiveIdentitySigner = async (_purpose, callback) =>
  callback(
    {
      kid: "22222222-2222-4222-8222-222222222222",
      key: privateKey,
      issuer: ISSUER,
      signUntil: new Date(Date.now() + 60_000),
    },
    sql,
  );

const signInvocation: typeof signInvocationToken = async (params) => {
  const issuedAt = Math.floor(Date.now() / 1_000);
  const claims = {
    ...params.authority,
    iss: ISSUER,
    aud: `app:${params.targetAppId}`,
    token_use: "invocation" as const,
    act: { sub: `app:${params.callingAppId}` },
    op: params.operation,
    schema_hash: params.schemaHash,
    ver: 1 as const,
    ...(params.requestId ? { request_id: params.requestId } : {}),
    jti: crypto.randomUUID(),
    iat: issuedAt,
    nbf: issuedAt,
    exp: issuedAt + 30,
  };
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", typ: "cloud-invocation+jwt", kid: "22222222-2222-4222-8222-222222222222" })
    .sign(privateKey);
  return {
    token,
    kid: "22222222-2222-4222-8222-222222222222",
    claims,
  };
};

const request = new Request("http://cloud.test/search?q=needle", { headers: { cookie: "session_token=benchmark" } });
const p95 = (samples: number[]): number => [...samples].sort((left, right) => left - right)[Math.ceil(samples.length * 0.95) - 1] ?? 0;

const microSamples = async (run: () => Promise<void>): Promise<{ meanMs: number; p95Ms: number }> => {
  const samples: number[] = [];
  for (let index = 0; index < 100; index += 1) {
    const startedAt = performance.now();
    await run();
    samples.push(performance.now() - startedAt);
  }
  return {
    meanMs: Number((samples.reduce((total, value) => total + value, 0) / samples.length).toFixed(4)),
    p95Ms: Number(p95(samples).toFixed(4)),
  };
};

let microToken = "";
const signing = await microSamples(async () => {
  microToken = (
    await signInvocation({
      targetAppId: "bench-00",
      callingAppId: "core",
      operation: "search.query",
      schemaHash: "a".repeat(64),
      authority: {
        sub: "11111111-1111-4111-8111-111111111111",
        principal_type: "user",
        access_subject_type: "user",
        access_subject_id: "11111111-1111-4111-8111-111111111111",
        credential_kind: "session",
        scopes: [],
      },
    })
  ).token;
});
const verification = await microSamples(async () => {
  await jwtVerify(microToken, publicKey, { algorithms: ["RS256"], issuer: ISSUER, audience: "app:bench-00" });
});
console.log(JSON.stringify({ benchmark: "invocation-jwt", signing, verification }));

const summary = (samples: number[]): { meanMs: number; p95Ms: number } => ({
  meanMs: Number((samples.reduce((total, value) => total + value, 0) / samples.length).toFixed(4)),
  p95Ms: Number(p95(samples).toFixed(4)),
});

for (const providerCount of [1, 8, 30]) {
  for (const includeTargetVerification of [false, true]) {
    const routes = createSearchRoutes({
      authenticate,
      listCapabilities: async () => providers(providerCount),
      withActiveSigner,
      signInvocation,
      fetch: async (input, init) => {
        const target = input instanceof Request ? input : new Request(input, init);
        const authorization = target.headers.get("authorization");
        if (includeTargetVerification && authorization?.startsWith("Bearer ")) {
          const targetAppId = new URL(target.url).hostname;
          await jwtVerify(authorization.slice(7), publicKey, {
            algorithms: ["RS256"],
            issuer: ISSUER,
            audience: `app:${targetAppId}`,
          });
        }
        await Bun.sleep(PROVIDER_LATENCY_MS);
        return Response.json({ data: [] });
      },
    });

    for (let index = 0; index < WARMUP_ITERATIONS; index += 1) await routes.request(request.clone());
    const samples: number[] = [];
    for (let index = 0; index < ITERATIONS; index += 1) {
      const startedAt = performance.now();
      const response = await routes.request(request.clone());
      if (!response.ok) throw new Error(`Search benchmark failed with ${response.status}`);
      samples.push(performance.now() - startedAt);
    }
    const jwt = summary(samples);
    console.log(
      JSON.stringify({
        benchmark: "search-fanout",
        phase: includeTargetVerification ? "end-to-end" : "dispatcher",
        providers: providerCount,
        iterations: ITERATIONS,
        controlledProviderLatencyMs: PROVIDER_LATENCY_MS,
        jwt,
        latencyGate: "descriptive JWT-only measurement; no legacy comparison",
      }),
    );
  }
}
