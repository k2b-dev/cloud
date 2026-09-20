import { beforeAll, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from "jose";
import { invokeCapability, reviewCapabilityAction, transferCapabilityStream } from "../capabilities/server";
import type { RequestActor } from "../server";
import { signInvocationToken, verifyInvocationToken } from "../services/identity/invocation-token";
import type { PreparedIdentitySigner } from "../services/identity/key-ring";
import { createCodeCapabilityRoutes } from "./code-capability-routes";
import { codeCapabilityOperation, codeCapabilityPath, createCodeCapabilityTransport } from "./code-capability-transport";
import type { AiConversation, AiTurn, AiTurnRunConfig } from "./types";

const conversationId = "11111111-1111-4111-8111-111111111111";
const turnId = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";
const issuer = "https://cloud.test";
let signer: PreparedIdentitySigner;
let key: JWTVerifyGetKey;
const actor: Extract<RequestActor, { kind: "user" }> = {
  kind: "user",
  user: {
    id: userId,
    uid: "test",
    provider: "local",
    profile: "user",
    displayName: "Test",
    mail: "test@example.test",
    givenname: "Test",
    sn: "User",
    roles: ["user"],
    accountExpires: null,
    avatarHash: null,
    lastLoginLocal: null,
    memberofGroup: [],
    memberofGroupIds: [],
    manages: [],
    managesGroupIds: [],
    ipa: null,
  },
};
beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  signer = { kid: crypto.randomUUID(), key: pair.privateKey, signUntil: new Date(Date.now() + 3600000) };
  key = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: signer.kid, alg: "RS256", use: "sig" }] });
});
const token = async (overrides: Partial<Parameters<typeof signInvocationToken>[0]> = {}) =>
  (
    await signInvocationToken({
      targetAppId: "core",
      callingAppId: "assistant",
      operation: codeCapabilityOperation(conversationId, turnId),
      schemaHash: null,
      authority: {
        sub: userId,
        principal_type: "user",
        access_subject_type: "user",
        access_subject_id: userId,
        credential_kind: "session",
        scopes: [],
      },
      signer,
      issuer,
      ...overrides,
    })
  ).token;
function fixture() {
  let archived = false,
    owner = userId,
    activeTurn = turnId,
    status = "running",
    current = true;
  let config: AiTurnRunConfig | null = { input: "Analyze" };
  let allowedTools: string[] | null = null;
  const dispatch = mock(async (_input: Parameters<typeof import("../api/capabilities").dispatchCapability>[0]) =>
    Response.json(_input.review ? { message: "Write file?" } : { data: { found: true } }),
  );
  const stream = mock(async (_request: Request, _authority: unknown, _verb: string) => new Response("csv"));
  const routes = createCodeCapabilityRoutes({
    invocation: {
      verify: (value, expected, options) => verifyInvocationToken(value, expected, { ...options, issuer, key }),
      resolve: async (claims) =>
        current
          ? {
              actor: {
                ...actor,
                delegation: {
                  kind: "invocation",
                  callingAppId: claims.act.sub.slice(4),
                  credentialKind: claims.credential_kind,
                  invocationId: claims.jti,
                  requestId: null,
                },
              },
              accessSubject: { type: "user", userId },
              credentialKind: "invocation",
              scopes: [],
            }
          : null,
    },
    store: {
      getConversation: async () =>
        ({
          id: conversationId,
          createdByUserId: owner,
          archivedAt: archived ? new Date().toISOString() : null,
          allowedTools,
        }) as AiConversation,
      getActiveTurn: async () => ({ turn: { id: activeTurn, status } as AiTurn, liveBlocks: [], liveSeq: 0 }),
      getTurnRunConfig: async () => config,
    },
    dispatch,
    stream,
  });
  return {
    app: new Hono().route("/api/_internal/ai/code", routes),
    dispatch,
    stream,
    set: (value: {
      archived?: boolean;
      owner?: string;
      activeTurn?: string;
      status?: string;
      current?: boolean;
      config?: AiTurnRunConfig | null;
      allowedTools?: string[];
    }) => {
      archived = value.archived ?? archived;
      owner = value.owner ?? owner;
      activeTurn = value.activeTurn ?? activeTurn;
      status = value.status ?? status;
      current = value.current ?? current;
      if ("config" in value) config = value.config!;
      if (value.allowedTools) allowedTools = value.allowedTools;
    },
  };
}
const request = (jwt: string, path = "queries/demo/read", body = '{"input":{}}') =>
  new Request(`http://core.test${codeCapabilityPath(conversationId, turnId)}/capabilities/v1/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
    body,
  });

test("Core callback binds cryptographically to target, operation, conversation, turn and lifetime", async () => {
  const f = fixture();
  for (const overrides of [
    { targetAppId: "assistant" },
    { operation: codeCapabilityOperation(crypto.randomUUID(), turnId) },
    { operation: codeCapabilityOperation(conversationId, crypto.randomUUID()) },
    { operation: "tool:code_run" },
    { issuedAt: new Date(Date.now() - 60000) },
    { callingAppId: "mail" },
  ]) {
    expect((await f.app.fetch(request(await token(overrides)))).status).toBeGreaterThanOrEqual(400);
  }
  expect(f.dispatch).not.toHaveBeenCalled();
  expect((await f.app.fetch(request(await token()))).status).toBe(200);
  expect(f.dispatch.mock.calls[0]?.[0]).toMatchObject({
    origin: "assistant",
    authority: { credentialKind: "session", accessSubject: { type: "user", userId } },
  });
});

test("every callback checks account, owner, archive, current foreground turn and allowed tools", async () => {
  const jwt = await token();
  for (const change of [
    { current: false },
    { owner: crypto.randomUUID() },
    { archived: true },
    { activeTurn: crypto.randomUUID() },
    { status: "completed" },
    { config: null },
    { config: { input: "Run", mandate: { id: crypto.randomUUID(), revision: 1 } } },
    { allowedTools: ["demo.other"] },
  ]) {
    const f = fixture();
    f.set(change);
    expect((await f.app.fetch(request(jwt))).status).toBeGreaterThanOrEqual(400);
    expect(f.dispatch).not.toHaveBeenCalled();
  }
  const f = fixture();
  f.set({ status: "cancelled" });
  expect((await f.app.fetch(request(jwt, "streams/read"))).status).toBe(403);
  expect(f.stream).not.toHaveBeenCalled();
});

test("remote host routes invocation, review and binary continuations to Core with refreshed credentials", async () => {
  const f = fixture();
  let observedBytes = "";
  f.stream.mockImplementation(async (req) => {
    observedBytes = await req.text();
    return new Response("ok");
  });
  const server = Bun.serve({ port: 0, fetch: f.app.fetch });
  const previous = process.env.CLOUD_CORE_INTERNAL_ORIGIN;
  process.env.CLOUD_CORE_INTERNAL_ORIGIN = server.url.origin;
  let jwt = await token();
  const caller = { transport: createCodeCapabilityTransport(() => ({ conversationId, turnId, token: jwt })), locale: "de" };
  try {
    expect(await invokeCapability({ appId: "demo", capabilityId: "read", kind: "query", input: { id: 1 } }, caller)).toMatchObject({
      ok: true,
      data: { data: { found: true } },
    });
    expect(await reviewCapabilityAction({ appId: "demo", capabilityId: "write", input: { id: 1 } }, caller)).toMatchObject({
      ok: true,
      data: { message: "Write file?" },
    });
    const payload = "a,b\n1,2\n".repeat(40000);
    const offer = {
      id: "opaque",
      direction: "write" as const,
      size: payload.length,
      mediaType: "text/csv",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    };
    expect((await transferCapabilityStream(offer, "write", caller, new Blob([payload]).stream())).status).toBe(200);
    expect(observedBytes).toBe(payload);
    jwt = await token({ issuedAt: new Date(Date.now() - 60000) });
    expect((await transferCapabilityStream(offer, "status", caller)).status).toBe(401);
    jwt = await token();
    expect((await transferCapabilityStream(offer, "status", caller)).status).toBe(200);
    f.set({ status: "completed" });
    expect((await transferCapabilityStream(offer, "abort", caller)).status).toBe(403);
    expect(f.dispatch).toHaveBeenCalledTimes(2);
  } finally {
    server.stop(true);
    if (previous === undefined) delete process.env.CLOUD_CORE_INTERNAL_ORIGIN;
    else process.env.CLOUD_CORE_INTERNAL_ORIGIN = previous;
  }
});
