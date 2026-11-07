import { expect, test } from "bun:test";
import { aiMapRoutes } from "./map-routes";

test("native map reads, exports and actions require authentication", async () => {
  const path = "/abc123/maps/cb03d253-b2d7-46e1-8a7a-1389c7354d35";
  for (const [url, method] of [
    [path, "GET"],
    [`${path}/export`, "GET"],
    [`${path}/action`, "POST"],
  ] as const) {
    const response = await aiMapRoutes.request(url, { method });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ message: "Authentication required" });
  }
});
