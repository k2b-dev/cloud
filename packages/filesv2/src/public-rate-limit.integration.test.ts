import { afterEach, beforeEach, expect, mock, setSystemTime, test } from "bun:test";
import * as cloudServer from "@k2b/cloud/server";
import { redis } from "bun";
import { Hono, type MiddlewareHandler } from "hono";
import { valkeySuite } from "../../../scripts/fixtures/test-infra";
import { publicUploadClientBucket } from "./public-upload-rate-limit";
import { FilesError } from "./service/errors";

let authCalls = 0;
const pass: MiddlewareHandler = async (_c, next) => {
  authCalls++;
  await next();
};
mock.module("@k2b/cloud/server", () => ({
  ...cloudServer,
  auth: { ...cloudServer.auth, requireRole: () => pass },
}));
mock.module("./service", () => ({
  FilesError,
  filesService: {
    publicInboxUpload: async () => ({ id: "upload-id" }),
    publicInboxCommit: async () => ({ name: "file.txt" }),
    publicInboxLease: async () => ({ url: "https://files.test/lease" }),
    publicInboxAbort: async () => {},
    publicShare: async () => ({ kind: "inbox", uploadedNames: [] }),
  },
}));

const { publicApi } = await import("./public");
const mounted = new Hono().route("/share/filesv2", publicApi);
const prefixes = ["filesv2:rate-limit", "cloud:rate-limit"];
const suite = valkeySuite();

suite("public inbox upload rate limits", () => {
  const ips = new Set<string>();
  const identity = () => {
    // Random addresses stay inside 2001:db8::/32 so none lands in a NAT64, Teredo or 6to4 range that maps to IPv4.
    const ip = `2001:db8:${crypto.randomUUID().replaceAll("-", "").slice(0, 24).match(/.{4}/g)!.join(":")}`;
    ips.add(ip);
    return { ip, token: crypto.randomUUID() };
  };
  const keys = async () => {
    const found: string[] = [];
    for (const prefix of prefixes) found.push(...((await redis.send("KEYS", [`${prefix}:*`])) as string[]));
    return found;
  };
  const request = (ip: string, path: string, method = "POST") => {
    const start = method === "POST" && path.endsWith("/api/uploads");
    return mounted.request(`/share/filesv2${path}`, {
      method,
      headers: {
        "X-Forwarded-For": ` ${ip} , 192.0.2.1`,
        "X-Real-IP": "192.0.2.2",
        ...(start ? { "Content-Type": "application/json" } : {}),
      },
      ...(start ? { body: JSON.stringify({ name: "file.txt", size: 0, idempotencyKey: crypto.randomUUID() }) } : {}),
    });
  };
  const expectUpload = (response: Response, remaining: number) => {
    expect(response.ok).toBe(true);
    expect(response.headers.get("X-RateLimit-Limit")).toBe("120");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe(String(remaining));
    expect(response.headers.get("X-RateLimit-Reset")).toBe("60");
  };

  beforeEach(() => {
    authCalls = 0;
    setSystemTime(new Date("2026-10-15T00:00:00Z"));
  });
  afterEach(async () => {
    try {
      for (const key of await keys()) {
        if ([...ips].some((ip) => key.includes(`:ip:${ip}:`) || key.includes(`:${publicUploadClientBucket(ip)}:`))) await redis.del(key);
      }
    } finally {
      ips.clear();
      setSystemTime();
    }
  });

  test("15 files succeed, all four upload routes share 120 checks, and page requests retain their own budget", async () => {
    const { ip, token } = identity();
    const uploadPath = `/inbox/${token}/api/uploads`;
    for (let i = 0; i < 15; i++) {
      expectUpload(await request(ip, uploadPath), 119 - i * 2);
      expectUpload(await request(ip, `${uploadPath}/upload-id/commit`), 118 - i * 2);
    }
    for (let i = 30; i < 120; i++) {
      const action = ["lease", "commit", "abort"][i % 3];
      expectUpload(await request(ip, `${uploadPath}/upload-id/${action}`), 119 - i);
    }
    expect(authCalls).toBe(120);
    const callsBeforeLimited = authCalls;
    const limited = await request(ip, uploadPath);
    expect(authCalls).toBe(callsBeforeLimited);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toMatch(/^[1-9]\d*$/);
    expect(limited.headers.get("X-RateLimit-Limit")).toBe("120");
    expect(limited.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(limited.headers.get("X-RateLimit-Reset")).toBe(limited.headers.get("Retry-After"));
    expect(await limited.json()).toEqual({ message: "Rate limit exceeded" });

    const secondToken = crypto.randomUUID();
    const sameClient = await request(ip, `/inbox/${secondToken}/api/uploads`);
    expect(sameClient.status).toBe(429);
    expect(sameClient.headers.get("Retry-After")).toMatch(/^[1-9]\d*$/);
    expect(sameClient.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(authCalls).toBe(callsBeforeLimited);
    const secondIp = identity().ip;
    const visitor = await request(secondIp, uploadPath);
    expect(visitor.ok).toBe(true);
    expect(visitor.headers.get("X-RateLimit-Remaining")).toBe("119");

    for (let i = 0; i < 10; i++) {
      const response = await request(ip, `/inbox/${token}/api`, "GET");
      expect(response.ok).toBe(true);
      expect(response.headers.get("X-RateLimit-Limit")).toBe("10");
      expect(response.headers.get("X-RateLimit-Remaining")).toBe(String(9 - i));
    }
    expect((await request(ip, `/inbox/${token}/api`, "GET")).status).toBe(429);

    const storedKeys = await keys();
    expect(storedKeys.some((key) => key.startsWith(`filesv2:rate-limit:filesv2-public-upload:${publicUploadClientBucket(ip)}:`))).toBe(
      true,
    );
    for (const secret of [token, secondToken]) {
      expect(storedKeys.every((key) => !key.includes(secret))).toBe(true);
    }
  });

  test("spraying new tokens spends one client budget while a second client and page requests stay independent", async () => {
    const ip = crypto.getRandomValues(new Uint8Array(4)).join(".");
    ips.add(ip);
    const tokens = Array.from({ length: 121 }, () => crypto.randomUUID());
    for (const [i, token] of tokens.slice(0, 120).entries()) {
      expectUpload(await request(ip, `/inbox/${token}/api/uploads`), 119 - i);
    }
    expect(authCalls).toBe(120);
    const limited = await request(ip, `/inbox/${tokens[120]}/api/uploads`);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toMatch(/^[1-9]\d*$/);
    expect(limited.headers.get("X-RateLimit-Reset")).toBe(limited.headers.get("Retry-After"));
    expect(limited.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(authCalls).toBe(120);

    expectUpload(await request(identity().ip, `/inbox/${tokens[120]}/api/uploads`), 119);
    for (let i = 0; i < 10; i++) {
      const response = await request(ip, `/inbox/${tokens[0]}/api`, "GET");
      expect(response.ok).toBe(true);
      expect(response.headers.get("X-RateLimit-Limit")).toBe("10");
      expect(response.headers.get("X-RateLimit-Remaining")).toBe(String(9 - i));
    }
    expect((await request(ip, `/inbox/${tokens[0]}/api`, "GET")).status).toBe(429);
    const storedKeys = await keys();
    expect(storedKeys.every((key) => tokens.every((token) => !key.includes(token)))).toBe(true);
  });

  test("IPv6 addresses in one /64 share the upload budget across textual forms and links", async () => {
    const [high = 0, low = 0] = crypto.getRandomValues(new Uint16Array(2));
    const subnet = low & 0xfffe;
    const prefix = `2001:db8:${high.toString(16)}`;
    const firstIp = `${prefix}:${subnet.toString(16)}::1`;
    const sameNetworkIp =
      `2001:0DB8:${high.toString(16).padStart(4, "0")}:${subnet.toString(16).padStart(4, "0")}:FFFF:0000:0000:0009`.toUpperCase();
    const otherNetworkIp = `${prefix}:${(subnet + 1).toString(16)}::1`;
    for (const ip of [firstIp, sameNetworkIp, otherNetworkIp]) ips.add(ip);
    const token = crypto.randomUUID();
    const path = `/inbox/${token}/api/uploads`;
    for (let i = 0; i < 120; i++) {
      expectUpload(await request(i % 2 === 0 ? firstIp : sameNetworkIp, path), 119 - i);
    }
    const callsBeforeLimited = authCalls;
    for (const ip of [firstIp, sameNetworkIp]) {
      const limited = await request(ip, `/inbox/${crypto.randomUUID()}/api/uploads`);
      expect(limited.status).toBe(429);
      expect(limited.headers.get("Retry-After")).toMatch(/^[1-9]\d*$/);
      expect(limited.headers.get("X-RateLimit-Remaining")).toBe("0");
    }
    expect(authCalls).toBe(callsBeforeLimited);
    expectUpload(await request(otherNetworkIp, path), 119);
    const storedKeys = await keys();
    const bucket = `${prefix}:${subnet.toString(16)}::/64`;
    expect(storedKeys.some((key) => key.startsWith(`filesv2:rate-limit:filesv2-public-upload:ip6:${bucket}:`))).toBe(true);
    expect(storedKeys.every((key) => !key.includes(token))).toBe(true);
  });

  test("similar paths, other methods and trailing slashes consume the public 10-request budget", async () => {
    const { ip, token } = identity();
    const shapes = [
      ["POST", `/inbox/${token}/api/uploads/`],
      ["GET", `/inbox/${token}/api/uploads`],
      ["POST", `/s/${token}/api/uploads`],
      ["POST", `/other/${token}/api/uploads/upload-id/commit`],
      ["POST", `/inbox/${token}/api/uploads/upload-id/lease/`],
      ["POST", `/inbox/${token}/api/uploads/upload-id/commit/`],
      ["POST", `/inbox/${token}/api/uploads/upload-id/abort/`],
      ["GET", `/inbox/${token}/api/uploads/upload-id/lease`],
      ["POST", `/s/${token}/api/uploads/upload-id/abort`],
      ["POST", `/inbox/${token}/api/uploads/upload-id/other`],
    ] as const;
    for (const [i, [method, path]] of shapes.entries()) {
      const response = await request(ip, path, method);
      expect(response.headers.get("X-RateLimit-Limit")).toBe("10");
      expect(response.headers.get("X-RateLimit-Remaining")).toBe(String(9 - i));
    }
    expect((await request(ip, `/inbox/${token}/api`, "GET")).status).toBe(429);
    // Exhausting the page budget must not prevent starting an upload.
    expect((await request(ip, `/inbox/${token}/api/uploads`)).ok).toBe(true);
  });

  test("an extra path prefix consumes the public 10-request budget", async () => {
    const { ip, token } = identity();
    const path = `/extra/inbox/${token}/api/uploads`;
    for (let i = 0; i < 10; i++) {
      const response = await request(ip, path);
      expect(response.status).toBe(404);
      expect(response.headers.get("X-RateLimit-Limit")).toBe("10");
      expect(response.headers.get("X-RateLimit-Remaining")).toBe(String(9 - i));
    }
    expect((await request(ip, path)).status).toBe(429);
  });

  test("unmounted uploads consume the public 10-request budget", async () => {
    const { ip, token } = identity();
    const upload = () =>
      publicApi.request(`/inbox/${token}/api/uploads`, {
        method: "POST",
        headers: { "X-Forwarded-For": ip, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "file.txt", size: 0, idempotencyKey: crypto.randomUUID() }),
      });
    for (let i = 0; i < 10; i++) {
      const response = await upload();
      expect(response.ok).toBe(true);
      expect(response.headers.get("X-RateLimit-Limit")).toBe("10");
      expect(response.headers.get("X-RateLimit-Remaining")).toBe(String(9 - i));
    }
    expect((await upload()).status).toBe(429);
  });

  test.each(["encoded", "malformed"] as const)("%s token segments spend the upload budget", async (encoding) => {
    const { ip, token } = identity();
    const routeToken = `${token}${encoding === "encoded" ? "/suffix" : "%invalid"}`;
    const segment = encoding === "encoded" ? encodeURIComponent(routeToken) : routeToken;
    const response = await request(ip, `/inbox/${segment}/api/uploads`);
    expect(response.ok).toBe(true);
    expect(response.headers.get("X-RateLimit-Limit")).toBe("120");
    const storedKeys = await keys();
    expect(storedKeys.every((key) => !key.includes(token))).toBe(true);
  });
});
