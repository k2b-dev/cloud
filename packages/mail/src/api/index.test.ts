import { describe, expect, test } from "bun:test";
import api from "./index";

describe("Mail API composition", () => {
  test("scopes the platform-admin guard to admin routes", () => {
    const adminGuard = api.routes.find((route) => route.method === "ALL" && route.path === "/admin/*");
    const mailboxRoute = api.routes.find((route) => route.method === "GET" && route.path === "/mailboxes");

    expect(adminGuard).toBeDefined();
    expect(mailboxRoute).toBeDefined();
  });

  test("reaches bulk assignment before the conversation id resolver can claim `assign`", () => {
    const assign = api.routes.findIndex((route) => route.method === "POST" && route.path === "/mailboxes/:mailboxId/conversations/assign");
    const conversationResolver = api.routes.findIndex(
      (route) => route.method === "ALL" && route.path === "/mailboxes/:mailboxId/conversations/:conversationId",
    );
    expect(assign).toBeGreaterThanOrEqual(0);
    expect(conversationResolver).toBeGreaterThan(assign);
  });

  test("reaches every static path segment before an ID resolver can claim it as an ID", () => {
    // A resolver middleware runs for every later route its pattern matches; a static segment in its ID
    // position (`/mailboxes/deleted`) would be looked up as an ID and answered with 404.
    // The sender identity resolver passes `default` through to `default/setup` on its own.
    const passedThrough = new Set(["/mailboxes/:mailboxId/sender-identities/:senderIdentityId/* default"]);
    const segments = (path: string) => path.split("/").filter(Boolean);
    const claimedSegment = (resolverPath: string, routePath: string): string | null => {
      const pattern = segments(resolverPath);
      const route = segments(routePath);
      const open = pattern.at(-1) === "*";
      const fixed = open ? pattern.slice(0, -1) : pattern;
      if (open ? route.length < fixed.length : route.length !== fixed.length) return null;
      let claimed: string | null = null;
      for (const [index, part] of fixed.entries()) {
        const segment = route[index] ?? "";
        if (!part.startsWith(":")) {
          if (part !== segment) return null;
        } else if (!segment.startsWith(":")) claimed ??= segment;
      }
      return claimed;
    };
    const shadowed = api.routes.flatMap((route, index) =>
      route.method === "ALL"
        ? []
        : api.routes.slice(0, index).flatMap((resolver) => {
            if (resolver.method !== "ALL" || !resolver.path.includes("/:")) return [];
            const segment = claimedSegment(resolver.path, route.path);
            return segment === null || passedThrough.has(`${resolver.path} ${segment}`)
              ? []
              : [`${route.method} ${route.path} <- ${resolver.path}`];
          }),
    );
    expect([...new Set(shadowed)]).toEqual([]);
  });

  test("exposes explicit platform-admin mailbox recovery routes", () => {
    expect(api.routes.some((route) => route.method === "GET" && route.path === "/admin/mailboxes/:mailboxId/operations")).toBe(true);
    expect(api.routes.some((route) => route.method === "GET" && route.path === "/admin/mailboxes/:mailboxId/access")).toBe(true);
    expect(api.routes.some((route) => route.method === "POST" && route.path === "/admin/mailboxes/:mailboxId/access")).toBe(true);
    expect(api.routes.some((route) => route.method === "PATCH" && route.path === "/admin/mailboxes/:mailboxId/access/:accessId")).toBe(
      true,
    );
    expect(api.routes.some((route) => route.method === "DELETE" && route.path === "/admin/mailboxes/:mailboxId/access/:accessId")).toBe(
      true,
    );
  });

  test("exposes mailbox-scoped subscription routes", () => {
    expect(api.routes.some((route) => route.method === "GET" && route.path === "/mailboxes/:mailboxId/subscriptions")).toBe(true);
    expect(api.routes.some((route) => route.method === "POST" && route.path === "/mailboxes/:mailboxId/subscriptions/unsubscribe")).toBe(
      true,
    );
    expect(api.routes.some((route) => route.method === "POST" && route.path === "/mailboxes/:mailboxId/subscriptions/disposition")).toBe(
      true,
    );
  });

  test("exposes unified incoming automation and durable deterministic backfill routes", () => {
    expect(
      api.routes.some((route) => route.method === "GET" && route.path === "/mailboxes/:mailboxId/incoming-automations/:automationId"),
    ).toBe(true);
    expect(api.routes.some((route) => route.method === "GET" && route.path === "/mailboxes/:mailboxId/incoming-automations/catalog")).toBe(
      true,
    );
    for (const path of [
      "/mailboxes/:mailboxId/incoming-automations/preview",
      "/mailboxes/:mailboxId/incoming-automations/:automationId/backfills",
    ]) {
      expect(api.routes.some((route) => route.method === "POST" && route.path === path)).toBe(true);
    }
    expect(
      api.routes.some((route) => route.method === "POST" && route.path === "/mailboxes/:mailboxId/incoming-automations/mark-read"),
    ).toBe(false);
    for (const method of ["GET", "DELETE"]) {
      expect(
        api.routes.some(
          (route) =>
            route.method === method && route.path === "/mailboxes/:mailboxId/incoming-automations/:automationId/backfills/:operationId",
        ),
      ).toBe(true);
    }
  });

  test("exposes the editable conversation summary boundary", () => {
    const path = "/mailboxes/:mailboxId/conversations/:conversationId/summary";
    expect(api.routes.some((route) => route.method === "GET" && route.path === path)).toBe(true);
    expect(api.routes.some((route) => route.method === "PUT" && route.path === path)).toBe(true);
  });

  test("exposes an explicit mailbox-scoped provider limit refresh", () => {
    expect(
      api.routes.some(
        (route) => route.method === "POST" && route.path === "/mailboxes/:mailboxId/connections/:connectionId/limits/refresh",
      ),
    ).toBe(true);
  });

  test("exposes a delivery-scoped recovery draft route", () => {
    expect(
      api.routes.some(
        (route) => route.method === "POST" && route.path === "/mailboxes/:mailboxId/scheduled-sends/:scheduledSendId/recovery-draft",
      ),
    ).toBe(true);
  });

  test("exposes the bounded composer calendar facade", () => {
    expect(api.routes.some((route) => route.method === "GET" && route.path === "/mailboxes/:mailboxId/calendar-events")).toBe(true);
    expect(api.routes.some((route) => route.method === "POST" && route.path === "/mailboxes/:mailboxId/calendar-events")).toBe(true);
    expect(
      api.routes.some((route) => route.method === "POST" && route.path === "/mailboxes/:mailboxId/drafts/:draftId/calendar-invitation"),
    ).toBe(true);
  });

  test("exposes user reporting and platform-admin Mail security operations", () => {
    expect(
      api.routes.some((route) => route.method === "POST" && route.path === "/mailboxes/:mailboxId/messages/:messageId/security-report"),
    ).toBe(true);
    for (const [method, path] of [
      ["GET", "/admin/security/reports"],
      ["PATCH", "/admin/security/reports/:reportId"],
      ["GET", "/admin/security/policies"],
      ["POST", "/admin/security/policies"],
      ["PATCH", "/admin/security/policies/:policyId"],
      ["DELETE", "/admin/security/policies/:policyId"],
      ["GET", "/admin/security/protected-identities"],
      ["POST", "/admin/security/protected-identities"],
      ["DELETE", "/admin/security/protected-identities/:identityId"],
      ["GET", "/admin/security/settings"],
      ["PATCH", "/admin/security/settings"],
    ] as const) {
      expect(api.routes.some((route) => route.method === method && route.path === path)).toBe(true);
    }
  });
});
