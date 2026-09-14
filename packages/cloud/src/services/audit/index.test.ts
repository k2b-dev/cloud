import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { audit, sanitizeAuditMetadata, sanitizeAuditText } from "./index";

describe("sanitizeAuditMetadata", () => {
  test("redacts sensitive nested metadata keys", () => {
    expect(
      sanitizeAuditMetadata({
        changedFields: ["mail"],
        password: "secret",
        nested: {
          apiToken: "token",
          ipaSession: "cookie",
          safe: "value",
        },
      }),
    ).toEqual({
      changedFields: ["mail"],
      password: "[REDACTED]",
      nested: {
        apiToken: "[REDACTED]",
        ipaSession: "[REDACTED]",
        safe: "value",
      },
    });
  });

  test("truncates large values and arrays", () => {
    const sanitized = sanitizeAuditMetadata({
      text: "x".repeat(510),
      values: Array.from({ length: 52 }, (_, index) => index),
    }) as Record<string, unknown>;

    expect(sanitized.text).toBe(`${"x".repeat(500)}...`);
    expect(sanitized.values).toEqual([...Array.from({ length: 50 }, (_, index) => index), "[2 more]"]);
  });

  test("redacts sensitive reason and error text", () => {
    expect(sanitizeAuditText("IPA session required to update IPA-backed users")).toBe("[REDACTED]");
    expect(sanitizeAuditText("Current password is incorrect.")).toBe("[REDACTED]");
    expect(sanitizeAuditText("Access denied")).toBe("Access denied");
  });

  (process.env.CLOUD_DATABASE_TEST === "1" ? test : test.skip)("lists only safe actor-owned self-service activity", async () => {
    const userId = crypto.randomUUID();
    const otherUserId = crypto.randomUUID();
    const requestId = `self-service-activity-${crypto.randomUUID()}`;

    try {
      await audit.record({
        action: "service_account_credential.create",
        outcome: "allowed",
        actor: { userId, uid: "current-user", provider: "local" },
        target: { type: "service_account_credential", id: crypto.randomUUID(), label: "Test key" },
        requestId,
      });
      await audit.record({
        action: "service_account_credential.create",
        outcome: "allowed",
        actor: { userId: otherUserId, uid: "other-user", provider: "local" },
        target: { type: "service_account_credential", id: crypto.randomUUID(), label: "Other key" },
        requestId,
      });
      await audit.record({
        action: "accounts.user.set_expiry",
        outcome: "allowed",
        actor: { userId: otherUserId, uid: "admin", provider: "local" },
        target: { type: "user", id: userId, label: "current-user" },
        requestId,
      });

      const page = await audit.listSelfServiceActivity({ userId, days: 30, pagination: { page: 1, perPage: 20 } });

      expect(page.total).toBe(1);
      expect(page.items[0]).toMatchObject({
        action: "service_account_credential.create",
        label: "API key created",
        context: "Test key",
      });
    } finally {
      await sql`DELETE FROM audit.events WHERE request_id = ${requestId}`;
    }
  });
});
