import { expect, test } from "bun:test";
import type { CloudCliContext } from "@k2b/cloud/cli";
import { runCloudSpeedtest } from "./speedtest-cli";

function context(overrides: Partial<CloudCliContext> = {}) {
  const lines: string[] = [];
  const output: unknown[] = [];
  const ctx: CloudCliContext = {
    args: [],
    flags: {},
    options: { server: "https://cloud.example", token: "cloud-only-token", profile: "test", output: "json", locale: "de" },
    getDefault: async () => undefined,
    setDefault: async () => {},
    createApiClient: () => {
      throw new Error("Unexpected authenticated API client");
    },
    fetch: async () => {
      throw new Error("Unexpected Cloud request");
    },
    readJson: async (response) => response.json(),
    print: (value) => output.push(value),
    write: async () => {},
    error: (value) => lines.push(value),
    json: (value) => output.push(value),
    jsonLine: (value) => output.push(value),
    table: () => {},
    ...overrides,
  };
  return { ctx, lines, output };
}

test("operator disable is enforced before measurement and localized", async () => {
  const { ctx, output } = context({
    fetch: async (path) => {
      expect(path).toBe("/tools/api/speedtest/config");
      return Response.json({ server: "https://speedtest.example", enabled: false });
    },
  });
  await expect(runCloudSpeedtest(ctx)).rejects.toThrow("deaktiviert");
  expect(output).toEqual([]);
});

test("invalid mode fails before configuration or external traffic", async () => {
  await expect(runCloudSpeedtest(context({ flags: { mode: "forever" } }).ctx)).rejects.toThrow("--mode");
});

test("explicit target never receives Cloud credentials and 429 retains recovery time", async () => {
  const requests: Request[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push(request);
      return new URL(request.url).pathname === "/ping"
        ? new Response(null, { status: 204 })
        : new Response(null, { status: 429, headers: { "Retry-After": "30" } });
    },
  });
  const { ctx, lines, output } = context({ flags: { server: server.url.origin } });
  const listeners = process.listenerCount("SIGINT");
  try {
    await expect(runCloudSpeedtest(ctx)).rejects.toThrow("30 s");
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual(["/session"]);
    for (const request of requests) {
      expect(request.headers.get("authorization")).toBeNull();
      expect(request.headers.get("cookie")).toBeNull();
      expect(request.url).not.toContain("tools/api");
    }
    expect(output).toEqual([]);
    expect(lines.some((line) => line.includes("Messserver"))).toBe(true);
    expect(process.listenerCount("SIGINT")).toBe(listeners);
  } finally {
    await server.stop(true);
  }
});

test("configured target is read only from Cloud and malformed configuration fails visibly", async () => {
  await expect(runCloudSpeedtest(context({ fetch: async () => Response.json({ server: "https://example.org" }) }).ctx)).rejects.toThrow(
    "settings response",
  );
});
