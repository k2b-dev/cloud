import { afterEach, beforeEach, expect, mock, setSystemTime, test } from "bun:test";
import { createHash } from "node:crypto";
import * as cloudServer from "@k2b/cloud/server";
import { redis } from "bun";
import { Hono, type MiddlewareHandler } from "hono";
import { valkeySuite } from "../../../scripts/fixtures/test-infra";
import { FilesError } from "./service/errors";

const pass: MiddlewareHandler = async (_c, next) => next();
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
    const ip = crypto.randomUUID().replaceAll("-", "").match(/.{4}/g)!.join(":");
    ips.add(ip);
    return { ip, token: crypto.randomUUID() };
  };
  const keys = async () => {
    const found: string[] = [];
    for (const prefix of prefixes) found.push(...((await redis.send("KEYS", [`${prefix}:*`])) as string[]));
    return found;
  };
  const request = (ip: string, path: string, method = "POST", withPrefix = false) => {
    const start = method === "POST" && path.endsWith("/api/uploads");
    return (withPrefix ? mounted : publicApi).request(`${withPrefix ? "/share/filesv2" : ""}${path}`, {
      method,
      headers: {
        "X-Forwarded-For": ` ${ip} , 192.0.2.1`,
        "X-Real-IP": "192.0.2.2",
        ...(start ? { "Content-Type": "application/json" } : {}),
      },
      ...(start ? { body: JSON.stringify({ name: "file.txt", size: 0, idempotencyKey: crypto.randomUUID() }) } : {}),
    });
  };

  beforeEach(() => setSystemTime(new Date("2026-10-15T00:00:00Z")));
  afterEach(async () => {
    try {
      for (const key of await keys()) {
        if ([...ips].some((ip) => key.includes(`:ip:${ip}:`))) await redis.del(key);
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
      expect((await request(ip, uploadPath)).ok).toBe(true);
      expect((await request(ip, `${uploadPath}/upload-id/commit`)).ok).toBe(true);
    }
    for (let i = 30; i < 120; i++) {
      const action = ["lease", "commit", "abort"][i % 3];
      const response = await request(ip, `${uploadPath}/upload-id/${action}`, "POST", i % 2 === 0);
      expect(response.ok).toBe(true);
      expect(response.headers.get("X-RateLimit-Limit")).toBe("120");
      expect(response.headers.get("X-RateLimit-Remaining")).toBe(String(119 - i));
      expect(response.headers.get("X-RateLimit-Reset")).toBe("60");
    }
    const limited = await request(ip, uploadPath, "POST", true);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toMatch(/^[1-9]\d*$/);
    expect(limited.headers.get("X-RateLimit-Limit")).toBe("120");
    expect(limited.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(limited.headers.get("X-RateLimit-Reset")).toBe(limited.headers.get("Retry-After"));
    expect(await limited.json()).toEqual({ message: "Rate limit exceeded" });

    const secondToken = crypto.randomUUID();
    const independent = await request(ip, `/inbox/${secondToken}/api/uploads`);
    expect(independent.ok).toBe(true);
    expect(independent.headers.get("X-RateLimit-Remaining")).toBe("119");
    const secondIp = identity().ip;
    const visitor = await request(secondIp, uploadPath);
    expect(visitor.ok).toBe(true);
    expect(visitor.headers.get("X-RateLimit-Remaining")).toBe("119");

    for (let i = 0; i < 10; i++) {
      const response = await request(ip, `/inbox/${token}/api`, "GET", true);
      expect(response.ok).toBe(true);
      expect(response.headers.get("X-RateLimit-Limit")).toBe("10");
      expect(response.headers.get("X-RateLimit-Remaining")).toBe(String(9 - i));
    }
    expect((await request(ip, `/inbox/${token}/api`, "GET")).status).toBe(429);

    const storedKeys = await keys();
    for (const secret of [token, secondToken]) {
      const hash = createHash("sha256").update(secret).digest("hex");
      expect(storedKeys.some((key) => key.startsWith("filesv2:rate-limit:") && key.includes(`:share:${hash}:ip:${ip}:`))).toBe(true);
      expect(storedKeys.every((key) => !key.includes(secret))).toBe(true);
    }
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
      const response = await request(ip, path, method, true);
      expect(response.headers.get("X-RateLimit-Limit")).toBe("10");
      expect(response.headers.get("X-RateLimit-Remaining")).toBe(String(9 - i));
    }
    expect((await request(ip, `/inbox/${token}/api`, "GET", true)).status).toBe(429);
    // Exhausting the page budget must not prevent starting an upload.
    expect((await request(ip, `/inbox/${token}/api/uploads`, "POST", true)).ok).toBe(true);
  });
});
