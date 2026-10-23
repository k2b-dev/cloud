import { describe, expect, test } from "bun:test";
import { networkTransportFixture } from "../../../../scripts/fixtures/network-transport";
import type { resolvePublicEndpoint } from "./connectors/endpoint-policy";
import { __test, discoverMailConfigurations, parseThunderbirdAutoconfig } from "./onboarding-discovery";

const XML = `<?xml version="1.0"?>
<clientConfig version="1.1">
  <emailProvider id="example.com">
    <incomingServer type="imap">
      <hostname>imap.example.com</hostname><port>993</port><socketType>SSL</socketType><username>%EMAILADDRESS%</username>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>smtp.example.com</hostname><port>587</port><socketType>STARTTLS</socketType><username>%EMAILLOCALPART%</username>
    </outgoingServer>
  </emailProvider>
</clientConfig>`;

describe("Mail onboarding discovery", () => {
  test("parses secure Thunderbird autoconfiguration without credentials", () => {
    expect(parseThunderbirdAutoconfig({ xml: XML, email: "User@Example.com", source: "provider_autoconfig" })).toEqual([
      {
        source: "provider_autoconfig",
        email: "user@example.com",
        username: "user@example.com",
        imap: { host: "imap.example.com", port: 993, tlsMode: "implicit" },
        smtp: { host: "smtp.example.com", port: 587, tlsMode: "starttls" },
      },
    ]);
  });

  test("rejects plaintext endpoints from autoconfiguration", () => {
    const xml = XML.replace("<socketType>SSL</socketType>", "<socketType>plain</socketType>");
    expect(parseThunderbirdAutoconfig({ xml, email: "user@example.com", source: "provider_autoconfig" })).toEqual([]);
  });

  test("merges provider autoconfiguration and RFC SRV records deterministically", async () => {
    const fetched: string[] = [];
    const configurations = await discoverMailConfigurations("user@example.com", {
      dependencies: {
        fetchXml: async (url) => {
          fetched.push(url.toString());
          return url.hostname === "autoconfig.example.com" ? XML : null;
        },
        resolveSrv: async (name) => {
          if (name === "_imaps._tcp.example.com") return [{ name: "mail.example.com.", port: 993, priority: 0, weight: 1 }];
          if (name === "_submission._tcp.example.com") return [{ name: "smtp.example.com.", port: 587, priority: 0, weight: 1 }];
          return [];
        },
      },
    });
    expect(configurations.map((item) => item.source)).toEqual(["provider_autoconfig", "srv"]);
    expect(fetched).toEqual([
      "https://autoconfig.example.com/mail/config-v1.1.xml?emailaddress=user%40example.com",
      "https://example.com/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=user%40example.com",
      "https://autoconfig.thunderbird.net/v1.1/example.com",
    ]);
  });

  test("returns maintained presets before network candidates", async () => {
    const configurations = await discoverMailConfigurations("user@gmail.com", {
      dependencies: { fetchXml: async () => null, resolveSrv: async () => [] },
    });
    expect(configurations[0]).toMatchObject({
      source: "preset",
      imap: { host: "imap.gmail.com", port: 993, tlsMode: "implicit" },
      smtp: { host: "smtp.gmail.com", port: 587, tlsMode: "starttls" },
    });
  });
});

const resolveEndpoint: typeof resolvePublicEndpoint = async (endpoint) => ({ ...endpoint, addresses: [{ address: "1.1.1.1", family: 4 }] });
for (const [status, contentType] of [
  [404, "text/xml"],
  [302, "text/xml"],
  [500, "text/xml"],
  [200, "text/plain"],
] as const) {
  test(`autoconfig discards an endless ${status} ${contentType} response immediately`, async () => {
    const fixture = await networkTransportFixture((_req, res) => {
      res.writeHead(status, { "content-type": contentType });
      res.write("unused");
    });
    try {
      const result = __test.readPinnedHttps(new URL("https://autoconfig.example/config"), 5000, new AbortController().signal, {
        resolveEndpoint,
        request: fixture.request,
      });
      if (status === 404) expect(await result).toBeNull();
      else await expect(result).rejects.toThrow();
      expect(fixture.requests[0]!.destroyed).toBe(true);
      await fixture.disconnected();
      expect(fixture.responses[0]!.destroyed).toBe(true);
    } finally {
      await fixture.close();
    }
  });
}

test("autoconfig cancels an active XML body when the caller leaves", async () => {
  const fixture = await networkTransportFixture((_req, res) => {
    res.writeHead(200, { "content-type": "text/xml" });
    res.write("<xml>");
  });
  const caller = new AbortController();
  try {
    const pending = __test.readPinnedHttps(new URL("https://autoconfig.example/config"), 5000, caller.signal, {
      resolveEndpoint,
      request: fixture.request,
    });
    await fixture.firstResponse;
    caller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
    expect(fixture.requests[0]!.destroyed).toBe(true);
    await fixture.disconnected();
    expect(fixture.responses[0]!.destroyed).toBe(true);
  } finally {
    await fixture.close();
  }
});

test("discovery uses one deadline for XML DNS, headers and a slow body, preserving manual setup", async () => {
  const fixture = await networkTransportFixture((_req, res) => {
    res.writeHead(200, { "content-type": "text/xml" });
    res.write("<xml>");
    const timer = setInterval(() => res.write("x"), 5);
    res.once("close", () => clearInterval(timer));
  });
  let probes = 0;
  try {
    const result = await discoverMailConfigurations("user@example.com", {
      timeoutMs: 250,
      dependencies: {
        fetchXml: async (url, remaining, signal) => {
          probes++;
          return __test.readPinnedHttps(url, remaining, signal, { resolveEndpoint, request: fixture.request });
        },
        resolveSrv: async () => {
          throw new Error("Must not start after expiry");
        },
      },
    });
    expect(result).toEqual([]);
    expect(probes).toBe(1);
    expect(fixture.requests[0]!.destroyed).toBe(true);
    await fixture.disconnected();
    expect(fixture.responses[0]!.destroyed).toBe(true);
  } finally {
    await fixture.close();
  }
});

for (const phase of ["xml", "srv"] as const)
  test(`discovery deadline covers a never-settling ${phase} lookup`, async () => {
    const lookup = Promise.withResolvers<string | null>();
    let probes = 0;
    const result = await discoverMailConfigurations("user@gmail.com", {
      timeoutMs: 250,
      dependencies: {
        fetchXml: () => {
          probes++;
          return phase === "xml" ? lookup.promise : Promise.resolve(null);
        },
        resolveSrv: () => new Promise(() => {}),
      },
    });
    expect(result[0]?.source).toBe("preset");
    expect(probes).toBe(phase === "xml" ? 1 : 3);
    lookup.resolve(XML);
    await Bun.sleep(0);
    expect(result).toHaveLength(1);
  });

test("caller cancellation stops discovery during DNS without starting another probe", async () => {
  const caller = new AbortController();
  const started = Promise.withResolvers<void>();
  let probes = 0;
  const pending = discoverMailConfigurations("user@example.com", {
    signal: caller.signal,
    dependencies: {
      fetchXml: () => {
        probes++;
        started.resolve();
        return new Promise(() => {});
      },
      resolveSrv: async () => [],
    },
  });
  await started.promise;
  caller.abort(new Error("cancelled"));
  await expect(pending).rejects.toThrow("cancelled");
  expect(probes).toBe(1);
});
