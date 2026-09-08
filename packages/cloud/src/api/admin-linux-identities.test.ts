import { describe, expect, test } from "bun:test";
import { createAdminLinuxIdentityRoutes } from "./admin-linux-identities";

describe("Linux identity HTTP authorization", () => {
  test("requires authentication for every read and mutation", async () => {
    const routes = createAdminLinuxIdentityRoutes();
    const id = "11111111-1111-4111-8111-111111111111";
    for (const [path, method] of [
      ["/", "GET"],
      ["/configuration", "PUT"],
      [`/users/${id}`, "GET"],
      [`/users/${id}`, "POST"],
      [`/users/${id}`, "PATCH"],
      [`/groups/${id}`, "POST"],
    ]) {
      expect((await routes.request(path!, { method })).status).toBe(401);
    }
  });
});
