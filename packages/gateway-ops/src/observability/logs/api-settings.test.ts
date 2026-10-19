import { expect, spyOn, test } from "bun:test";
import * as server from "@k2b/cloud/server";
import * as services from "@k2b/cloud/services";
import { session } from "@k2b/cloud/services/session";
import { buildProjectedUser } from "@k2b/cloud/services/session/user";
import { stubRouterInfrastructure } from "../../../../../scripts/fixtures/no-transform";

test("log retention saves explicitly replace unreadable values", async () => {
  const limit = spyOn(server, "rateLimit").mockReturnValue(async (_c, next) => next());
  // The compression router guard may have imported ./api first, so the real limiter can still run.
  const infrastructure = stubRouterInfrastructure();
  const clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-01-02T03:04:05Z"));
  const user = buildProjectedUser({
    id: "00000000-0000-4000-8000-000000000001",
    provider: "local",
    profile: "user",
    effective_admin: true,
  });
  const authenticate = spyOn(session, "authenticateRequest").mockResolvedValue({
    user,
    data: { userId: user.id, sid: "test", authEpoch: 0, kind: "web", expiresAt: "2026-01-03T03:04:05.000Z" },
  });
  const write = spyOn(services, "set").mockResolvedValue(undefined);
  try {
    const { default: routes } = await import("./api");
    const response = await routes.request("/settings/retention", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: "session_token=test" },
      body: JSON.stringify({ retentionDays: 14 }),
    });
    expect(response.status).toBe(200);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("logs.retention_days", 14, undefined, { replaceUnreadable: true });
  } finally {
    for (const spy of [write, authenticate, clock, limit, ...infrastructure]) spy.mockRestore();
  }
});
