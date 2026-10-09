import { describe, expect, test } from "bun:test";
import { forwardedRequestUrl } from "./verify";

const fallback = "http://proxy-auth:3000/proxy-auth/verify/client";
const original = (uri: string | null, host: string | null = "app.example") => {
  const headers = new Headers({ "X-Forwarded-Proto": "https" });
  if (host) headers.set("X-Forwarded-Host", host);
  if (uri !== null) headers.set("X-Forwarded-Uri", uri);
  return forwardedRequestUrl(headers, fallback);
};

describe("proxy auth return address", () => {
  test("rebuilds the protected request from Traefik's headers", () => {
    expect(original("/reports/q3?tab=a%2Fb")).toBe("https://app.example/reports/q3?tab=a%2Fb");
    expect(original("reports")).toBe("https://app.example/reports");
    expect(original(null)).toBe("https://app.example/");
    expect(original("/x", null)).toBe(fallback);
  });

  test("never returns to another host, whatever the forwarded path looks like", () => {
    for (const uri of ["//evil.example/x", "///evil.example/x", "/\\evil.example/x", "/\t/evil.example/x"]) {
      expect(original(uri)).toBe("https://app.example/");
    }
    for (const uri of ["/.//evil.example/x", "/%2F%2Fevil.example/x"]) {
      expect(new URL(original(uri)).origin).toBe("https://app.example");
    }
  });
});
