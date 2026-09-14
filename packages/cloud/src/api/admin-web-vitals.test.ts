import { expect, spyOn, test } from "bun:test";
import { session } from "../services/session";
import { buildProjectedUser } from "../services/session/user";
import routes from "./admin-core-settings";

test("Web Vitals settings read and write require an authenticated admin", async () => {
  for (const [path, method] of [
    ["/web-vitals", "GET"],
    ["/", "PUT"],
  ] as const) {
    expect((await routes.request(path, { method, headers: { Accept: "application/json" } })).status).toBe(401);
    const user = buildProjectedUser({ id: crypto.randomUUID(), provider: "local", profile: "user", effective_admin: false });
    const authenticate = spyOn(session, "authenticateRequest").mockResolvedValue({
      user,
      data: { userId: user.id, sid: "test", authEpoch: 0, expiresAt: new Date(Date.now() + 60000).toISOString() },
    });
    try {
      const response = await routes.request(path, { method, headers: { Accept: "application/json", Cookie: "session_token=test" } });
      expect(response.status).toBe(403);
    } finally {
      authenticate.mockRestore();
    }
  }
});

test("admin reads the existing global setting", async () => {
  const settings = await import("../services/settings");
  const user = buildProjectedUser({ id: crypto.randomUUID(), provider: "local", profile: "user", effective_admin: true });
  const authenticate = spyOn(session, "authenticateRequest").mockResolvedValue({
    user,
    data: { userId: user.id, sid: "test", authEpoch: 0, expiresAt: new Date(Date.now() + 60000).toISOString() },
  });
  const get = spyOn(settings, "get").mockResolvedValue(true);
  try {
    const response = await routes.request("/web-vitals", { headers: { Cookie: "session_token=test", Accept: "application/json" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: true });
    expect(get).toHaveBeenCalledWith("observability.web_vitals.enabled");
  } finally {
    authenticate.mockRestore();
    get.mockRestore();
  }
});
