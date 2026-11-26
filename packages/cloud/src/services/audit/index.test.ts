import { describe, expect, test } from "bun:test";
import { testFor } from "../../../../../scripts/fixtures/test-infra";
import { sql } from "../../runtime/clients";
import { audit, auditLatestQuery, sanitizeAuditMetadata, sanitizeAuditText } from "./index";

describe("audit.latest", () => {
  testFor("database")("reads a target's newest events exactly: its type and id, the asked actions and outcome", async () => {
    const target = crypto.randomUUID();
    const requestId = `audit-latest-${target}`;
    try {
      for (const [action, metadata, outcome, type] of [
        ["accounts.group.create", null, "allowed", "group"],
        ["accounts.group.update", { provenance: "system", service: "app-workload" }, "allowed", "group"],
        ["accounts.group.member.add", null, "allowed", "group"],
        ["accounts.group.relations", null, "allowed", "group"],
        ["accounts.group.member.remove", null, "denied", "group"],
        ["accounts.group.update", null, "allowed", "group"],
        // the same id under another type, and an event that only names the id in its label
        ["accounts.user.update", null, "allowed", "user"],
      ] as const)
        await audit.record({ action, outcome, requestId, target: { type, id: target }, metadata });
      await audit.record({ action: "accounts.group.update", outcome: "allowed", requestId, target: { type: "group", label: target } });
      const group = { type: "group", id: target };
      // newest first, the automatic one and other types left out, no label match, no more than asked for
      expect((await audit.latest({ target: group, limit: 2 })).map((event) => event.action)).toEqual([
        "accounts.group.update",
        "accounts.group.member.remove",
      ]);
      const actions = ["accounts.group.create", "accounts.group.update", "accounts.group.member.add", "accounts.group.member.remove"];
      expect((await audit.latest({ target: group, actions, outcome: "allowed", limit: 10 })).map((event) => event.action)).toEqual([
        "accounts.group.update",
        "accounts.group.member.add",
        "accounts.group.create",
      ]);
      expect((await audit.latest({ target: { type: "user", id: target }, limit: 10 })).map((event) => event.action)).toEqual([
        "accounts.user.update",
      ]);
    } finally {
      await sql`DELETE FROM audit.events WHERE request_id = ${requestId}`;
    }
  });

  testFor("database")("a record's activity reads idx_audit_events_target, never a scan of the log", async () => {
    const requestId = `audit-latest-plan-${crypto.randomUUID()}`;
    try {
      // a log of some size with many targets, so the planner chooses as on a running server
      await sql`
        INSERT INTO audit.events (action, outcome, target_type, target_id, request_id)
        SELECT 'accounts.user.update', 'allowed', 'user', gen_random_uuid()::text, ${requestId}
        FROM generate_series(1, 5000)`;
      await sql`ANALYZE audit.events`;
      const query = auditLatestQuery({ target: { type: "user", id: crypto.randomUUID() }, actions: ["accounts.user.update"], limit: 5 });
      const plan = (await sql<{ "QUERY PLAN": string }[]>`EXPLAIN ${query}`).map((row) => row["QUERY PLAN"]).join("\n");
      expect(plan).toContain("idx_audit_events_target");
      expect(plan).not.toContain("Seq Scan on events");
    } finally {
      await sql`DELETE FROM audit.events WHERE request_id = ${requestId}`;
    }
  });
});

describe("sanitizeAuditMetadata", () => {
  testFor("database")("stores searchable JSON objects rather than encoded strings", async () => {
    const requestId = `audit-json-${crypto.randomUUID()}`;
    try {
      await audit.record({
        action: "service_account_credential.create",
        outcome: "allowed",
        requestId,
        metadata: { source: "json-regression", nested: { count: 2 }, tags: ["one", "two"] },
      });
      const [row] = await sql`
        SELECT jsonb_typeof(metadata) AS kind,
          metadata->>'source' AS source,
          metadata->'nested'->>'count' AS count,
          jsonb_array_length(metadata->'tags') AS tags
        FROM audit.events WHERE request_id = ${requestId}
      `;
      expect(row).toEqual({ kind: "object", source: "json-regression", count: "2", tags: 2 });
    } finally {
      await sql`DELETE FROM audit.events WHERE request_id = ${requestId}`;
    }
  });

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

  testFor("database")("lists only safe actor-owned self-service activity", async () => {
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
