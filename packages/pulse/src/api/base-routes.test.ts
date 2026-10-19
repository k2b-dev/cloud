import { expect, spyOn, test } from "bun:test";
import { type AuthContext, err, fail } from "@k2b/cloud/server";
import { Hono } from "hono";
import { pulseService } from "../service";
import * as resources from "../service/public-resources";
import type { RetentionConfirmationRequired } from "../store/admin-contracts";
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

test("retention confirmation returns its baseline and accepts it on the confirmed update", async () => {
  const base = spyOn(resources, "resolvePublicId").mockResolvedValue("11111111-1111-4111-8111-111111111111");
  const previewedFrom = { rawRetentionDays: 30, rollupRetentionDays: 365, sensitiveRetentionHours: 24 };
  const refusal: RetentionConfirmationRequired & { status: 409 } = {
    code: "PULSE_RETENTION_CONFIRMATION_REQUIRED",
    status: 409,
    message: "Confirm the preview.",
    preview: [{ kind: "raw", retention: 7, cutoff: "2026-10-10T12:00:00.000Z", rows: 1200, bytes: 48000 }],
    previewedFrom,
  };
  const update = spyOn(pulseService.base, "update").mockResolvedValue(fail(refusal));
  const request = (body: unknown) =>
    app.request("/api/pulse/bases/Base01", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const response = await request({ rawRetentionDays: 7 });
    expect(response.status).toBe(409);
    const { status: _status, ...body } = refusal;
    expect(await response.json()).toEqual(body);
    const confirmed = { rawRetentionDays: 7, confirmShorterRetention: true, expectedRetention: previewedFrom };
    update.mockResolvedValue(fail({ code: "PULSE_BASE_CHANGED", status: 409, message: "Review the preview again." }));
    const changed = await request(confirmed);
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining(confirmed));
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ code: "PULSE_BASE_CHANGED", message: "Review the preview again." });
    update.mockClear();
    expect((await request({ ...confirmed, expectedRetention: { rawRetentionDays: 30 } })).status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  } finally {
    base.mockRestore();
    update.mockRestore();
  }
});
