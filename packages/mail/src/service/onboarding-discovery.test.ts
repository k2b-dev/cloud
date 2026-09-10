import { describe, expect, test } from "bun:test";
import { discoverMailConfigurations, parseThunderbirdAutoconfig } from "./onboarding-discovery";

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
        authentication: ["password"],
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
