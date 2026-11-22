import { expect, spyOn, test } from "bun:test";
import { type AuthContext, err, fail, ok } from "@k2b/cloud/server";
import { Hono } from "hono";
import type { PulseBase } from "../contracts";
import { pulseService } from "../service";
import * as attention from "../service/base-attention";
import * as resources from "../service/public-resources";
import type { RetentionConfirmationRequired } from "../store/admin-contracts";
import { adminFixtureIdentity } from "../store/admin-identity.test-fixture";
import baseRoutes from "./routes/bases";
import { BaseReadSchema } from "./schemas";

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

test("the base read carries the live store outage, and a base being deleted reports none", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const base = spyOn(resources, "resolvePublicId").mockResolvedValue(id);
  const project = spyOn(resources, "projectBases").mockImplementation(async (items) => items.map((item) => ({ ...item, id: "Base01" })));
  const stored: PulseBase = {
    id,
    shortId: "Base01",
    name: "Shop",
    description: null,
    icon: "ti ti-chart-line",
    color: "blue",
    timezone: "UTC",
    memberCount: 1,
    store: {
      state: "active",
      operation: null,
      errorCode: null,
      errorAt: null,
      writeBlockReason: null,
      profile: "normal",
      limits: {
        queriesPerHour: 600,
        valuesPerMinute: 2000,
        bytesPerMinute: 5242880,
        storageBytes: 5000000000,
        maxSeries: 50000,
        maxEventKinds: 2000,
        maxStateKeys: 2000,
      },
      usage: null,
    },
    rawRetentionDays: 30,
    rollupRetentionDays: 365,
    sensitiveRetentionHours: 24,
    createdBy: null,
    deletionStartedAt: null,
    deletionFailedAt: null,
    deletionError: null,
    dataClearStartedAt: null,
    dataClearCompletedAt: null,
    dataClearFailedAt: null,
    dataClearError: null,
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
  };
  const get = spyOn(pulseService.base, "get").mockResolvedValue(ok(stored));
  const outage = spyOn(attention, "readStoreOutage").mockResolvedValue({
    readAt: "2026-11-22T10:00:00.000Z",
    store: { unavailable: true, since: "2026-11-22T09:40:00.000Z" },
  });
  try {
    const response = await app.request("/api/pulse/bases/Base01");
    expect(response.status).toBe(200);
    const body = BaseReadSchema.parse(await response.json());
    expect(body).toMatchObject({ id: "Base01", name: "Shop", outage: { unavailable: true, since: "2026-11-22T09:40:00.000Z" } });
    expect(outage).toHaveBeenCalledWith(id);

    outage.mockResolvedValue(null);
    expect(await (await app.request("/api/pulse/bases/Base01")).json()).toMatchObject({ outage: { unavailable: false, since: null } });

    // Access stays the base read's: a refusal answers before the store is read.
    outage.mockClear();
    get.mockResolvedValue(fail(err.forbidden("Read access required")));
    expect((await app.request("/api/pulse/bases/Base01")).status).toBe(403);
    expect(outage).not.toHaveBeenCalled();
  } finally {
    base.mockRestore();
    project.mockRestore();
    get.mockRestore();
    outage.mockRestore();
  }
});
