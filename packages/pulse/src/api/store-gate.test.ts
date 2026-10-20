import { afterAll, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { PULSE_NOT_CONFIGURED } from "../store/gate";
import * as service from "../store/service";
import api from ".";

const configured = spyOn(service, "pulseStoreConfigured").mockResolvedValue(false);
afterAll(() => configured.mockRestore());
test("unconfigured Pulse refuses source APIs and ingest without affecting other apps", async () => {
  const router = new Hono().route("/api/pulse", api).get("/api/core/health", (c) => c.json({ ok: true }));
  for (const [method, path] of [
    ["GET", "/api/pulse/bases"],
    ["GET", "/api/pulse/bases/health"],
    ["POST", "/api/pulse/bases"],
    ["GET", "/api/pulse/bases/abc123/sources"],
    ["POST", "/api/pulse/ingest"],
  ]) {
    const response = await router.request(path!, { method });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(PULSE_NOT_CONFIGURED);
  }
  expect((await router.request("/api/core/health")).status).toBe(200);
});
