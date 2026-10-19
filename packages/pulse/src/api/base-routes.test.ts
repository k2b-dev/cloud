import { expect, spyOn, test } from "bun:test";
import { type AuthContext, err, fail } from "@k2b/cloud/server";
import { Hono } from "hono";
import { pulseService } from "../service";
import * as resources from "../service/public-resources";
import { adminFixtureIdentity } from "../store/admin-identity.test-fixture";
import baseRoutes from "./routes/bases";

const identity = adminFixtureIdentity("33333333-3333-4333-8333-333333333333");
const app = new Hono<AuthContext>()
  .use("*", async (c, next) => {
    c.set("actor", identity.actor);
    c.set("accessSubject", identity.accessSubject);
    await next();
  })
  .route("/api/pulse", baseRoutes);

test("a base update raises the idle timeout for its retention preview and restores it", async () => {
  const base = spyOn(resources, "resolvePublicId").mockResolvedValue("11111111-1111-4111-8111-111111111111");
  const update = spyOn(pulseService.base, "update").mockResolvedValue(fail(err.badInput("Invalid retention")));
  const timeouts: number[] = [];
  try {
    const response = await app.request(
      "/api/pulse/bases/Base01",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ rawRetentionDays: 7 }) },
      { timeout: (_request: Request, seconds: number) => timeouts.push(seconds) },
    );
    expect(response.status).toBe(400);
    expect(timeouts[0]).toBe(240);
    expect(timeouts.at(-1)).not.toBe(240);
  } finally {
    base.mockRestore();
    update.mockRestore();
  }
});
