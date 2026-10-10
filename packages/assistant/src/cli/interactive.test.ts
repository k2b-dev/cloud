import { expect, test } from "bun:test";
import type { CloudCliContext } from "@k2b/cloud/cli";
import { collectCapabilityApproval } from "./interactive";

test("cld describes an HTTP request in the same words as the approval card", async () => {
  const printed: string[] = [];
  const ctx: CloudCliContext = {
    args: [],
    flags: {},
    options: { profile: "test", server: "http://example.test", token: "test", output: "json" },
    getDefault: async () => undefined,
    setDefault: async () => {},
    createApiClient: () => {
      throw new Error("Unused");
    },
    fetch: async () => {
      throw new Error("Unused");
    },
    readJson: (response) => response.json(),
    print: (value = "") => void printed.push(value),
    write: async () => {},
    error: () => {},
    json: () => {},
    jsonLine: () => {},
    table: () => {},
  };
  const reader = { read: async () => "n", close: () => {}, onInterrupt: () => () => {} };
  const ask = async (method: string, headers: Record<string, string>) => {
    printed.length = 0;
    const request = {
      type: "http" as const,
      name: "http.fetch:https://example.com",
      id: crypto.randomUUID(),
      url: "https://example.com/data",
    };
    expect(
      await collectCapabilityApproval(ctx, reader, { ...request, method, headers, bodyBytes: 0, bodyPreview: "", bodyTruncated: false }),
    ).toEqual({ approved: false });
    return printed.join("\n");
  };
  expect(await ask("GET", { accept: "application/json" })).toContain("This request reads data from example.com.");
  for (const [method, headers] of [
    ["GET", { "x-http-method-override": "DELETE" }],
    ["DELETE", {}],
  ] as const)
    expect(await ask(method, headers)).toContain("may change data or incur charges");
});
