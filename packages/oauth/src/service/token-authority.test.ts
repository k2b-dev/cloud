import { describe, expect, setSystemTime, test } from "bun:test";
import { formatAppKey, importAppPublicKey } from "@k2b/cloud/app-key";
import { env } from "@k2b/cloud/config";
import { decodeJwt, jwtVerify } from "jose";
import { APP_KEY_FIXTURES } from "../../../../scripts/fixtures/app-key-fixtures";
import {
  issueOAuthTokenBatch,
  OAuthAuthorityGrantRejectedError,
  type OAuthTokenRequest,
  probeOAuthTokenAuthority,
  startOAuthDeviceApproval,
} from "./token-authority";

const request: OAuthTokenRequest = {
  kind: "user_access",
  grant: { kind: "authorization_code", code: "opaque-code", nonce: "a5ae9b9c-94f4-49a8-a954-c87839affc3d" },
  expiresIn: 3_600,
};

describe("OAuth Core token authority client", () => {
  test("rejects invalid broker configuration without a network request or credential fallback", async () => {
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return new Response(null, { status: 204 });
    };
    for (const brokerSecret of ["", "cld_old_workload_token", "a".repeat(63), "z".repeat(64)]) {
      const options = { brokerSecret, origin: "http://core.internal:3000", fetch };
      await expect(probeOAuthTokenAuthority(options)).rejects.toThrow("64 hexadecimal characters");
      await expect(issueOAuthTokenBatch([request], options)).rejects.toThrow("64 hexadecimal characters");
    }
    expect(calls).toBe(0);
  });
  test("sends one closed batch with broker authentication", async () => {
    const seen: Request[] = [];
    const tokens = await issueOAuthTokenBatch([request], {
      origin: "http://core.internal:3000",
      brokerSecret: "abababababababababababababababababababababababababababababababab",
      fetch: async (input, init) => {
        seen.push(new Request(input, init));
        return Response.json({ tokens: ["signed.jwt"] });
      },
    });

    expect(tokens).toEqual(["signed.jwt"]);
    expect(seen[0]?.url).toBe("http://core.internal:3000/api/_internal/identity/v1/oauth/token");
    expect(seen[0]?.redirect).toBe("error");
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer abababababababababababababababababababababababababababababababab");
    expect(await seen[0]?.json()).toEqual({ tokens: [request] });
  });

  test("does not retry failed or malformed authority responses", async () => {
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return new Response(null, { status: 503 });
    };
    await expect(
      issueOAuthTokenBatch([request], {
        origin: "http://core.internal:3000",
        brokerSecret: "abababababababababababababababababababababababababababababababab",
        fetch,
      }),
    ).rejects.toThrow("status 503");
    expect(calls).toBe(1);

    await expect(
      issueOAuthTokenBatch([request], {
        origin: "http://core.internal:3000",
        brokerSecret: "abababababababababababababababababababababababababababababababab",
        fetch: async () => Response.json({ tokens: [] }),
      }),
    ).rejects.toThrow("invalid token batch");
  });

  test("probes readiness once and distinguishes a definite grant rejection", async () => {
    const seen: Request[] = [];
    await probeOAuthTokenAuthority({
      origin: "http://core.internal:3000",
      brokerSecret: "abababababababababababababababababababababababababababababababab",
      fetch: async (input, init) => {
        seen.push(new Request(input, init));
        return new Response(null, { status: 204 });
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("http://core.internal:3000/api/_internal/identity/v1/oauth/ready");
    expect(seen[0]?.redirect).toBe("error");

    await expect(
      issueOAuthTokenBatch([request], {
        origin: "http://core.internal:3000",
        brokerSecret: "abababababababababababababababababababababababababababababababab",
        fetch: async () => new Response(null, { status: 403 }),
      }),
    ).rejects.toBeInstanceOf(OAuthAuthorityGrantRejectedError);
  });
});

describe("OAuth Core device approval client", () => {
  const approval = {
    deviceAuthorizationId: "a5ae9b9c-94f4-49a8-a954-c87839affc3d",
    identifier: "alice@example.test",
    clientId: "cloud-cli",
    scopes: ["openid", "offline_access"],
    lifetimeSeconds: 28_800,
  };
  const options = { origin: "http://core.internal:3000", brokerSecret: "ab".repeat(32) };
  const result = { comparison: "012345", expiresAt: "2026-10-17T12:05:00.000Z" };

  test("sends one bounded, broker-authenticated request and parses Core's comparison", async () => {
    const seen: Request[] = [];
    expect(
      await startOAuthDeviceApproval(approval, {
        ...options,
        fetch: async (input, init) => {
          expect(new Request(input, init).signal).toBeInstanceOf(AbortSignal);
          seen.push(new Request(input, init));
          return Response.json(result);
        },
      }),
    ).toEqual(result);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("http://core.internal:3000/api/_internal/identity/v1/oauth/device-approval");
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.redirect).toBe("error");
    expect(seen[0]?.headers.get("authorization")).toBe(`Bearer ${options.brokerSecret}`);
    expect(seen[0]?.headers.get("content-type")).toBe("application/json");
    expect(await seen[0]?.json()).toEqual(approval);
  });

  test("rejects invalid broker configuration before fetching", async () => {
    let calls = 0;
    for (const brokerSecret of ["", "z".repeat(64), "a".repeat(63)]) {
      await expect(
        startOAuthDeviceApproval(approval, {
          ...options,
          brokerSecret,
          fetch: async () => {
            calls += 1;
            return Response.json(result);
          },
        }),
      ).rejects.toThrow("64 hexadecimal characters");
    }
    expect(calls).toBe(0);
  });

  test("rejects every non-200 response without retrying", async () => {
    for (const status of [201, 204, 302, 404, 409, 503]) {
      let calls = 0;
      await expect(
        startOAuthDeviceApproval(approval, {
          ...options,
          fetch: async () => {
            calls += 1;
            return new Response(null, { status });
          },
        }),
      ).rejects.toThrow(`status ${status}`);
      expect(calls).toBe(1);
    }
  });

  test("rejects malformed comparisons, missing expiry, invalid JSON and network failures", async () => {
    for (const body of [
      { ...result, comparison: "12345" },
      { ...result, comparison: "abcdef" },
      { ...result, comparison: 123456 },
      { comparison: "123456" },
      null,
    ]) {
      await expect(startOAuthDeviceApproval(approval, { ...options, fetch: async () => Response.json(body) })).rejects.toThrow();
    }
    await expect(startOAuthDeviceApproval(approval, { ...options, fetch: async () => new Response("not JSON") })).rejects.toThrow();
    for (const error of [new TypeError("Network failure"), new DOMException("Timed out", "TimeoutError")]) {
      let calls = 0;
      await expect(
        startOAuthDeviceApproval(approval, {
          ...options,
          fetch: async () => {
            calls += 1;
            throw error;
          },
        }),
      ).rejects.toBe(error);
      expect(calls).toBe(1);
    }
  });
});

test("OAuth signs readiness, each issuance and device approval without a broker secret", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(env, "CLOUD_APP_KEY")!;
  const appKey = {
    installationId: "11111111-1111-4111-8111-111111111111",
    appId: "oauth",
    keyId: "22222222-2222-4222-8222-222222222222",
    seed: APP_KEY_FIXTURES[0].seed,
  };
  Object.defineProperty(env, "CLOUD_APP_KEY", { value: formatAppKey(appKey), configurable: true });
  const proofs: string[] = [];
  const bodies: string[] = [];
  setSystemTime(new Date("2030-01-02T03:04:05Z"));
  try {
    const options = {
      origin: "http://core.test",
      brokerSecret: "",
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const sent = new Request(input, init);
        const proof = sent.headers.get("authorization")!.slice(7);
        const body = await sent.text();
        const { payload } = await jwtVerify(proof, await importAppPublicKey(APP_KEY_FIXTURES[0].publicKey), {
          algorithms: ["EdDSA"],
          typ: "cloud-app+jwt",
          currentDate: new Date("2030-01-02T03:04:05Z"),
        });
        expect(payload).toMatchObject({
          iss: "oauth",
          sub: "oauth",
          aud: `cloud-core:${appKey.installationId}`,
          htm: sent.method,
          htu: new URL(sent.url).pathname,
        });
        const digest = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))).toString("base64url");
        expect(payload.bdh).toBe(digest);
        proofs.push(proof);
        bodies.push(body);
        if (sent.url.endsWith("/ready")) return new Response(null, { status: 204 });
        if (sent.url.endsWith("/device-approval")) return Response.json({ comparison: "012345", expiresAt: "2030-01-02T03:09:05Z" });
        return Response.json({ tokens: ["signed.jwt"] });
      },
    };
    await probeOAuthTokenAuthority(options);
    await issueOAuthTokenBatch([request], options);
    await issueOAuthTokenBatch([{ ...request, expiresIn: 1800 }], options);
    await startOAuthDeviceApproval(
      {
        deviceAuthorizationId: "33333333-3333-4333-8333-333333333333",
        identifier: "alice@example.test",
        clientId: "cloud-cli",
        scopes: ["openid"],
        lifetimeSeconds: 3600,
      },
      options,
    );
    expect(proofs).toHaveLength(4);
    expect(new Set(proofs.map((proof) => decodeJwt(proof).jti)).size).toBe(4);
    expect(bodies[1]).not.toBe(bodies[2]);
  } finally {
    Object.defineProperty(env, "CLOUD_APP_KEY", descriptor);
    setSystemTime();
  }
});
