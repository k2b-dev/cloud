import { expect, spyOn, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AuthContext } from "../server";
import { type createGeoIpService, GeoIpError, geoIpAdminStatus } from "../services/geoip";
import { session } from "../services/session";
import { buildProjectedUser } from "../services/session/user";
import { createAdminGeoIpRoutes } from "./admin-geoip";

const status = geoIpAdminStatus([], { city: null, asn: null }, 0);
const actor = buildProjectedUser({
  id: "11111111-1111-4111-8111-111111111111",
  uid: "admin",
  display_name: "Admin",
  provider: "local",
  profile: "user",
  effective_admin: true,
});
const authenticate: MiddlewareHandler<AuthContext> = async (c, next) => {
  c.set("user", actor);
  await next();
};
const unused: ReturnType<typeof createGeoIpService> = {
  status: async () => status,
  upload: async (_actor, body) => {
    await new Response(body).arrayBuffer();
    return { ...status, kind: "city" };
  },
  reset: async () => ({ ...status, changed: true }),
};

test("every route requires authentication and denies a non-admin before the service", async () => {
  const denied: MiddlewareHandler<AuthContext> = async (c) => c.json({ code: "FORBIDDEN" }, 403);
  for (const [path, method] of [
    ["/", "GET"],
    ["/", "PUT"],
    ["/city", "DELETE"],
  ]) {
    expect((await createAdminGeoIpRoutes().request(path!, { method })).status).toBe(401);
    expect((await createAdminGeoIpRoutes(denied, unused).request(path!, { method })).status).toBe(403);
  }
});

test("status, raw-body upload and reset expose the typed result and validate the kind", async () => {
  let upload: Uint8Array | undefined;
  let length: number | undefined;
  const app = createAdminGeoIpRoutes(authenticate, {
    ...unused,
    upload: async (_actor, body, config) => {
      upload = new Uint8Array(await new Response(body).arrayBuffer());
      length = config.contentLength;
      return { ...status, kind: "city" };
    },
  });
  expect(await (await app.request("/")).json()).toEqual(status);
  const response = await app.request("/", {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream", "Content-Length": "3" },
    body: new Uint8Array([1, 2, 3]),
  });
  expect(await response.json()).toEqual({ ...status, kind: "city" });
  expect(upload).toEqual(new Uint8Array([1, 2, 3]));
  expect(length).toBe(3);
  expect(await (await app.request("/asn", { method: "DELETE" })).json()).toEqual({ ...status, changed: true });
  expect((await app.request("/country", { method: "DELETE" })).status).toBe(400);
});

test("stable upload errors map to their HTTP status with limits only on 413", async () => {
  for (const [code, expected] of [
    ["geoip_too_large", 413],
    ["geoip_empty", 400],
    ["geoip_invalid", 422],
    ["geoip_unsupported_type", 422],
    ["geoip_upload_busy", 409],
  ] as const) {
    const app = createAdminGeoIpRoutes(authenticate, {
      ...unused,
      upload: async () => {
        throw new GeoIpError(code);
      },
    });
    const response = await app.request("/", { method: "PUT" });
    expect(response.status).toBe(expected);
    expect(await response.json()).toEqual(code === "geoip_too_large" ? { code, maxDatabaseBytes: 201326592 } : { code });
  }
});

test("an aborted upload request forwards its signal and returns 499", async () => {
  const controller = new AbortController();
  controller.abort();
  const app = createAdminGeoIpRoutes(authenticate, {
    ...unused,
    upload: async (_actor, _body, config) => {
      expect(config.signal?.aborted).toBe(true);
      config.signal?.throwIfAborted();
      throw new Error("Expected an aborted signal");
    },
  });
  const response = await app.request("/", { method: "PUT", signal: controller.signal });
  expect(response.status).toBe(499);
  expect(await response.text()).toBe("");
});

test("the upload raises its request timeout and restores it after success or failure", async () => {
  for (const fail of [false, true]) {
    const timeouts: number[] = [];
    const app = createAdminGeoIpRoutes(authenticate, {
      ...unused,
      upload: async () => {
        if (fail) throw new GeoIpError("geoip_invalid");
        return { ...status, kind: "city" };
      },
    });
    await app.request(
      "/",
      { method: "PUT" },
      {
        timeout(_request: Request, seconds: number) {
          timeouts.push(seconds);
        },
      },
    );
    expect(timeouts).toEqual([240, 10]);
  }
});

test("the real admin policy lets an administrator through and answers 403 to a signed-in non-admin", async () => {
  const member = buildProjectedUser({
    id: "22222222-2222-4222-8222-222222222222",
    uid: "member",
    display_name: "Member",
    provider: "local",
    profile: "user",
    effective_admin: false,
  });
  for (const [user, expected] of [
    [actor, 200],
    [member, 403],
  ] as const) {
    const authentication = spyOn(session, "authenticateRequest").mockResolvedValue({
      user,
      data: { userId: user.id, sid: "test", authEpoch: 0, kind: "web", expiresAt: "2030-01-01T00:00:00.000Z" },
    });
    try {
      const app = createAdminGeoIpRoutes(undefined, unused);
      for (const [path, method] of [
        ["/", "GET"],
        ["/", "PUT"],
        ["/city", "DELETE"],
      ])
        expect((await app.request(path!, { method, headers: { Authorization: "Bearer test-session" } })).status).toBe(expected);
    } finally {
      authentication.mockRestore();
    }
  }
});
