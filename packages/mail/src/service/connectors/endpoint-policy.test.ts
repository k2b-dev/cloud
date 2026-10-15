import { describe, expect, test } from "bun:test";
import { pinnedNetworkLookup } from "@k2b/cloud/services/network-security";
import { EndpointPolicyError, resolvePublicEndpoint } from "./endpoint-policy";

describe("mail endpoint policy", () => {
  test("rejects local hostnames before DNS", async () => {
    for (const host of ["localhost", "mail.local", "metadata.google.internal", "server.internal", "x.home.arpa"]) {
      await expect(resolvePublicEndpoint({ host, port: 993, tlsMode: "implicit" })).rejects.toBeInstanceOf(EndpointPolicyError);
    }
  });

  test("preserves endpoint normalization and public literal resolution", async () => {
    await expect(resolvePublicEndpoint({ host: " 8.8.8.8. ", port: 993, tlsMode: "implicit" })).resolves.toEqual({
      host: "8.8.8.8",
      port: 993,
      tlsMode: "implicit",
      addresses: [{ address: "8.8.8.8", family: 4 }],
    });
    await expect(resolvePublicEndpoint({ host: "[64:ff9b::808:808]", port: 465, tlsMode: "implicit" })).resolves.toMatchObject({
      host: "64:ff9b::808:808",
      addresses: [{ address: "64:ff9b::808:808", family: 6 }],
    });
  });

  test("keeps endpoint policy codes and host syntax validation", async () => {
    for (const host of ["[::ffff:7f00:1]", "127.1", "mail.example/path", "mail.example:993", "mail..example", "-mail.example"]) {
      await expect(resolvePublicEndpoint({ host, port: 993, tlsMode: "implicit" })).rejects.toMatchObject({ code: "ENDPOINT_BLOCKED" });
    }
  });

  test("pins socket lookup to previously validated addresses", () => {
    const lookup = pinnedNetworkLookup([
      { address: "1.1.1.1", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);

    const selected = new Promise<{ address: string; family: number | undefined }>((resolve, reject) => {
      lookup("mail.example.com", { family: 4 }, (error, address, family) => {
        if (error) reject(error);
        else resolve({ address: address as string, family });
      });
    });
    return expect(selected).resolves.toEqual({ address: "1.1.1.1", family: 4 });
  });
});
