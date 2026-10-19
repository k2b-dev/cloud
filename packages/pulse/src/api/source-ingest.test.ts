import { expect, spyOn, test } from "bun:test";
import { type AuthContext, err, fail, ok } from "@k2b/cloud/server";
import { Hono } from "hono";
import { pulseService } from "../service";
import type { IngestResult } from "../service/ingest-writer";
import * as resources from "../service/public-resources";
import { adminFixtureIdentity } from "../store/admin-identity.test-fixture";
import sourceRoutes from "./routes/sources";

const baseId = "11111111-1111-4111-8111-111111111111";
const sourceId = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";
const identity = adminFixtureIdentity(userId);
const app = new Hono<AuthContext>()
  .use("*", async (c, next) => {
    c.set("actor", identity.actor);
    c.set("accessSubject", identity.accessSubject);
    await next();
  })
  .route("/api/pulse", sourceRoutes);
const path = "/api/pulse/bases/Base01/sources/Src001/ingest";
const outcomes: IngestResult[] = [
  ok({ metrics: 1, events: 0, states: 0 }),
  fail(err.badInput("Invalid batch")),
  fail(err.notFound("Pulse source")),
  fail(err.conflict("Base is not writable")),
  { ok: false, error: { code: "PULSE_BASE_THROTTLED", status: 429, message: "Throttled", retryAfter: 17 } },
  { ok: false, error: { code: "PULSE_QUOTA_UNAVAILABLE", status: 503, message: "Quota unavailable", retryAfter: 30 } },
  { ok: false, error: { code: "PULSE_STORE_UNAVAILABLE", status: 503, message: "Store unavailable", retryAfter: 30 } },
  { ok: false, error: { code: "PULSE_STORE_DISK_LOW", status: 503, message: "Disk low", retryAfter: 300 } },
];
for (const outcome of outcomes) {
  const status = outcome.ok ? 200 : outcome.error.status;
  test(`CLI source ingest route answers ${status} with the writer's headers and HTTP quota bytes`, async () => {
    const base = spyOn(resources, "resolvePublicId").mockResolvedValue(baseId);
    const source = spyOn(resources, "resolveBasePublicId").mockResolvedValue(sourceId);
    const access = spyOn(pulseService.base.access, "require").mockResolvedValue(ok());
    const ingest = spyOn(pulseService.ingest, "batch").mockResolvedValue(outcome);
    try {
      const body = ' { "metrics": [{"name":"ä", "value":1}] } ';
      const response = await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": "retry-this-batch" },
        body,
      });
      expect(response.status).toBe(status);
      expect(base).toHaveBeenCalledWith("bases", "Base01");
      expect(access).toHaveBeenCalledWith(baseId, { id: userId }, "write");
      expect(source).toHaveBeenCalledWith("sources", baseId, "Src001");
      expect(ingest).toHaveBeenCalledWith({
        baseId,
        sourceId,
        batch: { metrics: [{ name: "ä", value: 1 }] },
        idempotencyKey: "retry-this-batch",
        requestBytes: new TextEncoder().encode(body).byteLength,
        locale: "en",
      });
      expect(await response.json()).toEqual(outcome.ok ? outcome.data : { code: outcome.error.code, message: outcome.error.message });
      expect(response.headers.get("Retry-After")).toBe(
        !outcome.ok && "retryAfter" in outcome.error ? String(outcome.error.retryAfter) : null,
      );
    } finally {
      base.mockRestore();
      source.mockRestore();
      access.mockRestore();
      ingest.mockRestore();
    }
  });
}

test("source ingest refuses missing write access before resolving the source or calling the writer", async () => {
  const base = spyOn(resources, "resolvePublicId").mockResolvedValue(baseId);
  const source = spyOn(resources, "resolveBasePublicId").mockResolvedValue(sourceId);
  const access = spyOn(pulseService.base.access, "require").mockResolvedValue(fail(err.forbidden("Access denied")));
  const ingest = spyOn(pulseService.ingest, "batch");
  try {
    const response = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [{ kind: "refused" }] }),
    });
    expect(response.status).toBe(403);
    expect(source).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
  } finally {
    base.mockRestore();
    source.mockRestore();
    access.mockRestore();
    ingest.mockRestore();
  }
});

test("source ingest parses public IDs and refuses a source outside the base", async () => {
  const base = spyOn(resources, "resolvePublicId").mockResolvedValue(baseId);
  const source = spyOn(resources, "resolveBasePublicId").mockResolvedValue(null);
  const access = spyOn(pulseService.base.access, "require").mockResolvedValue(ok());
  const ingest = spyOn(pulseService.ingest, "batch");
  const request = { method: "POST", headers: { "content-type": "application/json" }, body: '{"events":[{"kind":"refused"}]}' };
  try {
    expect((await app.request(path.replace("Base01", baseId), request)).status).toBe(400);
    expect(base).not.toHaveBeenCalled();
    expect((await app.request(path.replace("Src001", sourceId), request)).status).toBe(400);
    expect(source).not.toHaveBeenCalled();
    expect((await app.request(path, request)).status).toBe(404);
    expect(source).toHaveBeenCalledWith("sources", baseId, "Src001");
    expect(ingest).not.toHaveBeenCalled();
  } finally {
    base.mockRestore();
    source.mockRestore();
    access.mockRestore();
    ingest.mockRestore();
  }
});
