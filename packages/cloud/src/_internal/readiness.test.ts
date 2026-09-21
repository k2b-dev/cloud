import { describe, expect, test } from "bun:test";
import { APP_READINESS_PATH, appReadinessResponse } from "./readiness";

describe("application readiness", () => {
  test("uses one reserved framework path", () => {
    expect(APP_READINESS_PATH).toBe("/_cloud/ready");
  });

  test("returns a small app-specific ready response", async () => {
    const response = appReadinessResponse("inventory");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready", appId: "inventory", version: "0.0.0-local", release: "development" });
  });
});
