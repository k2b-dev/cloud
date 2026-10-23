import { describe, expect, test } from "bun:test";
import { networkTransportFixture } from "../../../../scripts/fixtures/network-transport";
import type { resolvePublicEndpoint } from "./connectors/endpoint-policy";
import { __test, matchesRemoteImageSignature, normalizeRemoteContentRule } from "./remote-content";

describe("remote content rules", () => {
  test("normalizes sender and internationalized domain rules", () => {
    expect(normalizeRemoteContentRule({ scope: "sender", value: " Sender@Exämple.de " })).toEqual({
      ok: true,
      data: { scope: "sender", value: "sender@xn--exmple-cua.de" },
    });
    expect(normalizeRemoteContentRule({ scope: "domain", value: "Exämple.de." })).toEqual({
      ok: true,
      data: { scope: "domain", value: "xn--exmple-cua.de" },
    });
  });

  test("rejects malformed rules", () => {
    expect(normalizeRemoteContentRule({ scope: "sender", value: "not-an-address" }).ok).toBeFalse();
    expect(normalizeRemoteContentRule({ scope: "domain", value: "https://example.com" }).ok).toBeFalse();
    expect(normalizeRemoteContentRule({ scope: "domain", value: "localhost" }).ok).toBeTrue();
  });
});

describe("remote image signatures", () => {
  test("accepts supported raster signatures and rejects mismatches", () => {
    expect(matchesRemoteImageSignature("image/jpeg", Uint8Array.from([0xff, 0xd8, 0xff]))).toBeTrue();
    expect(matchesRemoteImageSignature("image/png", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBeTrue();
    expect(matchesRemoteImageSignature("image/gif", new TextEncoder().encode("GIF89a"))).toBeTrue();
    expect(matchesRemoteImageSignature("image/webp", new TextEncoder().encode("RIFF0000WEBP"))).toBeTrue();
    expect(matchesRemoteImageSignature("image/avif", new TextEncoder().encode("0000ftypavif"))).toBeTrue();
    expect(matchesRemoteImageSignature("image/png", new TextEncoder().encode("<svg>"))).toBeFalse();
  });
});

const resolveEndpoint: typeof resolvePublicEndpoint = async (endpoint) => ({ ...endpoint, addresses: [{ address: "1.1.1.1", family: 4 }] });

test("remote images destroy endless redirects and revalidate the next destination", async () => {
  const hosts: string[] = [];
  const fixture = await networkTransportFixture((req, res) => {
    if (req.url === "/start") {
      res.writeHead(302, { location: "https://cdn.example/done" });
      res.write("unused");
    } else res.writeHead(200, { "content-type": "image/gif" }).end("GIF89a");
  });
  try {
    const image = await __test.requestRemoteImage(new URL("https://images.example/start"), {
      resolveEndpoint: async (endpoint) => {
        hosts.push(endpoint.host);
        return resolveEndpoint(endpoint);
      },
      request: fixture.request,
    });
    expect(new TextDecoder().decode(image.bytes)).toBe("GIF89a");
    expect(hosts).toEqual(["images.example", "cdn.example"]);
    expect(fixture.responses.every((response) => response.destroyed)).toBe(true);
    expect(fixture.requests.every((request) => request.destroyed)).toBe(true);
    await fixture.disconnected();
  } finally {
    await fixture.close();
  }
});

for (const status of [403, 500])
  test(`remote image HTTP ${status} closes both sides without draining`, async () => {
    const fixture = await networkTransportFixture((_req, res) => {
      res.writeHead(status);
      res.write("unused");
    });
    try {
      await expect(
        __test.requestRemoteImage(new URL("https://images.example/error"), { resolveEndpoint, request: fixture.request }),
      ).rejects.toThrow("request failed");
      expect(fixture.requests[0]!.destroyed).toBe(true);
      await fixture.disconnected();
      expect(fixture.responses[0]!.destroyed).toBe(true);
    } finally {
      await fixture.close();
    }
  });

for (const mode of ["deadline", "caller"] as const)
  test(`remote image ${mode} covers stalled DNS`, async () => {
    const caller = new AbortController();
    const lookup = Promise.withResolvers<Awaited<ReturnType<typeof resolvePublicEndpoint>>>();
    let sent = false;
    const pending = __test.requestRemoteImage(new URL("https://images.example/file"), {
      signal: caller.signal,
      timeoutMs: mode === "deadline" ? 10 : 10_000,
      resolveEndpoint: () => lookup.promise,
      request: () => {
        sent = true;
        throw new Error("unexpected");
      },
    });
    if (mode === "caller") caller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow(mode === "deadline" ? "timed out" : "cancelled");
    lookup.resolve(await resolveEndpoint({ host: "images.example", port: 443, tlsMode: "implicit" }));
    await Bun.sleep(0);
    expect(sent).toBe(false);
  });

for (const mode of ["deadline", "caller"] as const)
  test(`remote image ${mode} stops an endless body`, async () => {
    const fixture = await networkTransportFixture((_req, res) => {
      res.writeHead(200, { "content-type": "image/gif" });
      res.write("GIF89a");
      const timer = setInterval(() => res.write("x"), 5);
      res.once("close", () => clearInterval(timer));
    });
    const caller = new AbortController();
    try {
      const pending = __test.requestRemoteImage(new URL("https://images.example/file"), {
        signal: caller.signal,
        timeoutMs: mode === "deadline" ? 80 : 10_000,
        resolveEndpoint,
        request: fixture.request,
      });
      await fixture.firstResponse;
      if (mode === "caller") caller.abort(new Error("cancelled"));
      await expect(pending).rejects.toThrow(mode === "deadline" ? "timed out" : "cancelled");
      expect(fixture.requests[0]!.destroyed).toBe(true);
      await fixture.disconnected();
      expect(fixture.responses[0]!.destroyed).toBe(true);
    } finally {
      await fixture.close();
    }
  });
