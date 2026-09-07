import { describe, expect, test } from "bun:test";
import {
  issueOAuthTokenBatch,
  OAuthAuthorityGrantRejectedError,
  type OAuthTokenRequest,
  probeOAuthTokenAuthority,
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
