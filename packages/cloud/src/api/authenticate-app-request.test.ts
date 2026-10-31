import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { z } from "zod";
import { APP_KEY_FIXTURES } from "../../../../scripts/fixtures/app-key-fixtures";
import type { AppKey } from "../app-key";
import { readCapabilityResponse } from "../capabilities/response";
import { CAPABILITY_MAX_REQUEST_BYTES } from "../contracts/capabilities";
import { BOOTSTRAP_PROOF_SECONDS, signAppProof } from "../runtime/bootstrap-protocol";
import { REQUEST_IDLE_TIMEOUT_SECONDS } from "../server/request-timeout";
import * as proofs from "../services/app-bootstrap";
import { authenticateSignedAppRequest } from "./authenticate-app-request";

const NOW = Date.UTC(2030, 0, 2, 3, 4, 5);
const key: AppKey = {
  appId: "mail",
  installationId: "11111111-1111-4111-8111-111111111111",
  keyId: "22222222-2222-4222-8222-222222222222",
  seed: APP_KEY_FIXTURES[0].seed,
};
let proof: string;
beforeEach(async () => {
  setSystemTime(NOW);
  proof = await signAppProof(key, { method: "POST", path: "/invoke", body: new TextEncoder().encode("{}") });
});
afterEach(() => setSystemTime());
const admitted = async () => ({ limited: false, remaining: 1, resetIn: 1000 });
const request = (body: BodyInit, headers?: HeadersInit) =>
  new Request("http://core.test/invoke", {
    method: "POST",
    headers: new Headers([["authorization", `Bearer ${proof}`], ...new Headers(headers)]),
    body,
  });
const routes = (dependencies: NonNullable<Parameters<typeof authenticateSignedAppRequest>[2]> = { ingress: admitted }) =>
  new Hono().post("/invoke", async (c) => {
    const result = await authenticateSignedAppRequest(c, "identity:invoke", dependencies);
    return result instanceof Response ? result : c.json({ unexpected: true });
  });

test("signed ingress bounds streamed bytes before verification, including forged content length", async () => {
  for (const headers of [
    new Headers(),
    new Headers({ "content-length": "1" }),
    new Headers({ "content-length": String(CAPABILITY_MAX_REQUEST_BYTES + 1) }),
  ]) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.enqueue(new Uint8Array(CAPABILITY_MAX_REQUEST_BYTES + 1));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const response = await routes().request(request(body, headers));
    expect(response.status).toBe(413);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(cancelled).toBe(true);
  }
});

test("signed ingress rejects malformed or expired proofs without pulling the body", async () => {
  const [header, claims, signature] = proof.split(".");
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  for (const invalid of [
    "invalid.proof",
    `${header}.${claims}.`,
    `${encode({ alg: "HS256", typ: "cloud-app+jwt", kid: key.keyId })}.${claims}.${signature}`,
    `${encode({ alg: "EdDSA", typ: "cloud-app+jwt", kid: "invalid" })}.${claims}.${signature}`,
    await signAppProof(key, { method: "POST", path: "/invoke", body: new Uint8Array() }, NOW - BOOTSTRAP_PROOF_SECONDS * 1000),
  ]) {
    let reads = 0;
    const body = new ReadableStream(
      {
        pull() {
          reads++;
          throw new Error("Unexpected body read");
        },
      },
      { highWaterMark: 0 },
    );
    const response = await routes().request(request(body, { authorization: `Bearer ${invalid}` }));
    expect(response.status).toBe(401);
    expect(await readCapabilityResponse(response, z.unknown())).toMatchObject({ ok: false, error: { code: "invalid_proof", status: 401 } });
    expect(reads).toBe(0);
  }
});

test("an absolute request budget cancels both body branches even while data keeps arriving", async () => {
  const originalTimeout = AbortSignal.timeout;
  const timeout = spyOn(AbortSignal, "timeout").mockImplementation(() => originalTimeout(25));
  try {
    for (const trickle of [false, true]) {
      let cancelled = false;
      let interval: ReturnType<typeof setInterval> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (trickle) interval = setInterval(() => controller.enqueue(new Uint8Array([32])), 2);
        },
        cancel() {
          cancelled = true;
          clearInterval(interval);
          // A slow cancellation hook must not hold the response open.
          return new Promise<void>(() => {});
        },
      });
      try {
        const response = await routes().request(request(body));
        expect(response.status).toBe(504);
        expect(await readCapabilityResponse(response, z.unknown())).toMatchObject({
          ok: false,
          error: { code: "DEADLINE_EXCEEDED", status: 504 },
        });
        expect(cancelled).toBe(true);
      } finally {
        clearInterval(interval);
      }
    }
    expect(timeout).toHaveBeenCalledWith(REQUEST_IDLE_TIMEOUT_SECONDS * 1000);
  } finally {
    timeout.mockRestore();
  }
});

test("caller cancellation cancels both branches without waiting for the deadline", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull() {
        controller.abort();
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const response = await routes().request(
    new Request("http://core.test/invoke", {
      method: "POST",
      headers: { authorization: `Bearer ${proof}` },
      body,
      signal: controller.signal,
    }),
  );
  expect(response.status).toBe(499);
  expect(cancelled).toBe(true);
});

test("signed admission errors retain their envelope and Retry-After through the capability reader", async () => {
  for (const stage of ["ingress", "key"] as const) {
    const authenticate = spyOn(proofs, "authenticateAppProof").mockResolvedValue({
      identity: key,
      key: {
        appId: key.appId,
        keyId: key.keyId,
        serviceAccountId: "account",
        kind: "app_key",
        name: "Fixture",
        publicKey: APP_KEY_FIXTURES[0].publicKey,
        grants: [],
        fingerprint: "fixture",
        status: "active",
        accountStatus: "active",
        createdAt: new Date(NOW).toISOString(),
        createdBy: null,
        expiresAt: null,
        revokedAt: null,
        revokedBy: null,
        lastUsedAt: null,
        connectionsAllowed: false,
        oauthIssueAllowed: false,
      },
      jti: "nonce",
      exp: NOW / 1000 + 30,
    });
    try {
      for (const state of ["limited", "unavailable"] as const) {
        const limit = async () => {
          if (state === "unavailable") throw new Error("Valkey unavailable");
          return { limited: true, remaining: 0, resetIn: 1500 };
        };
        const response = await routes({ ingress: stage === "ingress" ? limit : admitted, admit: limit }).request(request("{}"));
        expect(response.status).toBe(state === "limited" ? 429 : 503);
        expect(await readCapabilityResponse(response, z.unknown())).toMatchObject({
          ok: false,
          error: { code: state === "limited" ? "RATE_LIMITED" : "app_proof_unavailable", retryAfterMs: state === "limited" ? 2000 : 1000 },
        });
      }
    } finally {
      authenticate.mockRestore();
    }
  }
});

test("a completed body deadline does not relabel later permanent proof refusals", async () => {
  const controller = new AbortController();
  const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  const authenticate = spyOn(proofs, "authenticateAppProof").mockImplementation(async () => {
    controller.abort(new DOMException("Body deadline", "TimeoutError"));
    throw new proofs.BootstrapProofError("invalid_proof");
  });
  try {
    const response = await routes().request(request("{}"));
    expect(await readCapabilityResponse(response, z.unknown())).toMatchObject({
      ok: false,
      error: { code: "invalid_proof", status: 401 },
    });
  } finally {
    authenticate.mockRestore();
    timeout.mockRestore();
  }
});
