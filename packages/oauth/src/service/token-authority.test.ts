import { afterEach, describe, expect, test } from "bun:test";
import {
  issueOAuthTokenBatch,
  OAuthAuthorityGrantRejectedError,
  type OAuthTokenRequest,
  oauthIssuanceMode,
  probeOAuthTokenAuthority,
} from "./token-authority";

const originalMode = process.env.CLOUD_OAUTH_ISSUANCE_MODE;

afterEach(() => {
  if (originalMode === undefined) delete process.env.CLOUD_OAUTH_ISSUANCE_MODE;
  else process.env.CLOUD_OAUTH_ISSUANCE_MODE = originalMode;
});

const request: OAuthTokenRequest = {
  kind: "user_access",
  grant: { kind: "authorization_code", code: "opaque-code", nonce: "a5ae9b9c-94f4-49a8-a954-c87839affc3d" },
  expiresIn: 3_600,
};

describe("OAuth Core token authority client", () => {
  test("keeps legacy issuance as the rolling-upgrade default and rejects invalid modes", () => {
    delete process.env.CLOUD_OAUTH_ISSUANCE_MODE;
    expect(oauthIssuanceMode()).toBe("legacy");
    process.env.CLOUD_OAUTH_ISSUANCE_MODE = "core";
    expect(oauthIssuanceMode()).toBe("core");
    process.env.CLOUD_OAUTH_ISSUANCE_MODE = "both";
    expect(oauthIssuanceMode).toThrow("must be legacy or core");
  });

  test("sends one closed batch with workload authentication", async () => {
    const seen: Request[] = [];
    const tokens = await issueOAuthTokenBatch([request], {
      origin: "http://core.internal:3000",
      credential: "cld_test",
      fetch: async (input, init) => {
        seen.push(new Request(input, init));
        return Response.json({ tokens: ["signed.jwt"] });
      },
    });

    expect(tokens).toEqual(["signed.jwt"]);
    expect(seen[0]?.url).toBe("http://core.internal:3000/api/_internal/identity/v1/oauth/token");
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer cld_test");
    expect(await seen[0]?.json()).toEqual({ tokens: [request] });
  });

  test("does not retry failed or malformed authority responses", async () => {
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return new Response(null, { status: 503 });
    };
    await expect(issueOAuthTokenBatch([request], { origin: "http://core.internal:3000", credential: "cld_test", fetch })).rejects.toThrow(
      "status 503",
    );
    expect(calls).toBe(1);

    await expect(
      issueOAuthTokenBatch([request], {
        origin: "http://core.internal:3000",
        credential: "cld_test",
        fetch: async () => Response.json({ tokens: [] }),
      }),
    ).rejects.toThrow("invalid token batch");
  });

  test("probes readiness once and distinguishes a definite grant rejection", async () => {
    const seen: Request[] = [];
    await probeOAuthTokenAuthority({
      origin: "http://core.internal:3000",
      credential: "cld_test",
      fetch: async (input, init) => {
        seen.push(new Request(input, init));
        return new Response(null, { status: 204 });
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("http://core.internal:3000/api/_internal/identity/v1/oauth/ready");

    await expect(
      issueOAuthTokenBatch([request], {
        origin: "http://core.internal:3000",
        credential: "cld_test",
        fetch: async () => new Response(null, { status: 403 }),
      }),
    ).rejects.toBeInstanceOf(OAuthAuthorityGrantRejectedError);
  });
});
