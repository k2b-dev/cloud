import { expect, spyOn, test } from "bun:test";
import { serviceAccountCredentials } from "@k2b/cloud/services";
import { Hono } from "hono";
import { pulseService } from "../service";
import type { IngestFailure } from "../service/ingest-writer";
import ingestRoutes from "./routes/ingest";

const token = "cld_0123456789abcdef01234567_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const accountId = "11111111-1111-4111-8111-111111111111";
const createdAt = "2026-10-17T12:00:00.000Z";
const failures: IngestFailure[] = [
  { code: "PULSE_BASE_THROTTLED", status: 429, message: "Throttled", retryAfter: 17 },
  { code: "PULSE_QUOTA_UNAVAILABLE", status: 503, message: "Quota unavailable", retryAfter: 30 },
  { code: "PULSE_STORE_UNAVAILABLE", status: 503, message: "Store unavailable", retryAfter: 30 },
  { code: "PULSE_STORE_DISK_LOW", status: 503, message: "Disk low", retryAfter: 300 },
];
test.each(failures)("#6/#8 POST /api/pulse/ingest carries Retry-After for $code", async (error) => {
  const auth = spyOn(serviceAccountCredentials, "authenticateApiToken").mockResolvedValue({
    serviceAccount: {
      id: accountId,
      name: "Ingest",
      kind: "resource_bound",
      status: "active",
      delegatedUserId: null,
      appId: "pulse",
      resourceType: "pulse_source",
      resourceId: "Src001",
      createdBy: null,
      createdAt,
    },
    credential: {
      id: accountId,
      serviceAccountId: accountId,
      name: "Ingest",
      kind: "api_token",
      status: "active",
      tokenPrefix: "0123456789abcdef01234567",
      scopes: ["pulse:ingest"],
      expiresAt: null,
      lastUsedAt: null,
      createdBy: null,
      createdAt,
      revokedAt: null,
      revokedBy: null,
    },
    delegatedUser: null,
  });
  const ingest = spyOn(pulseService.ingest, "byApiKey").mockResolvedValue({ ok: false, error });
  try {
    const app = new Hono().route("/api/pulse", ingestRoutes);
    const body = ' { "metrics": [{"name":"ä", "value":1}] } ';
    const response = await app.request("/api/pulse/ingest", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body,
    });
    expect(response.status).toBe(error.status);
    expect(response.headers.get("Retry-After")).toBe(String("retryAfter" in error ? error.retryAfter : 0));
    expect(await response.json()).toEqual({ code: error.code, message: error.message });
    expect(ingest.mock.calls[0]?.[0].requestBytes).toBe(new TextEncoder().encode(body).byteLength);
  } finally {
    auth.mockRestore();
    ingest.mockRestore();
  }
});
