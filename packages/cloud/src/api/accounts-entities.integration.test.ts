import { expect, setSystemTime, spyOn, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import type { AuthContext } from "../server";
import * as settings from "../services/settings";
import { createAccountsEntitiesRoutes } from "./accounts-entities";

suiteFor("valkey")("Code identifier lookup budget", () => {
  test("real Valkey budget is shared by route instances and targets before directory reads", async () => {
    setSystemTime(new Date("2026-11-04T12:00:00Z"));
    const userId = crypto.randomUUID();
    const authenticate: MiddlewareHandler<AuthContext> = async (c, next) => {
      const user = {
        id: userId,
        uid: "lookup-fixture",
        roles: ["user"],
        provider: "local",
        profile: "user",
      } as AuthContext["Variables"]["user"];
      c.set("actor", { kind: "user", user });
      c.set("accessSubject", { type: "user", userId });
      c.set("user", user);
      c.set("credentialKind", "session");
      await next();
    };
    const setting = spyOn(settings, "get").mockResolvedValue(3);
    let reads = 0;
    let targets = 0;
    const dependencies = {
      authenticate,
      managesTarget: async () => {
        targets++;
        return true;
      },
      listEntities: async () => {
        reads++;
        return { items: [], total: 0, page: 1, perPage: 20, hasNext: false };
      },
    };
    const first = createAccountsEntitiesRoutes(dependencies);
    const second = createAccountsEntitiesRoutes(dependencies);
    try {
      for (let n = 0; n < 3; n++) {
        const response = await first.request(`/entities?search=code-7k2q9m4xwt&target_type=example.item&target_id=${n}`);
        expect(response.status).toBe(200);
      }
      const denied = await second.request("/entities?search=code-0000000000&target_type=example.item&target_id=other");
      expect(denied.status).toBe(429);
      expect(await denied.json()).toMatchObject({ code: "RATE_LIMITED" });
      expect(reads).toBe(3);
      expect(targets).toBe(3);
      expect(setting.mock.calls.every(([key]) => key === "security.rate_limit_per_second")).toBe(true);
    } finally {
      setting.mockRestore();
      setSystemTime();
    }
  });
});
