import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cloud from "@k2b/cloud";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import { stubRailSnapshot } from "../../../../../tests/fixtures/rail-snapshot";
import { notificationsService } from "./service";

const root = mkdtempSync(join(tmpdir(), "notifications-page-render-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: handler } = await import("./page");
const user = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "reader",
  roles: ["user", "admin"],
  provider: "local",
  profile: "user",
  givenname: "Book",
  sn: "Reader",
  displayName: "Book Reader",
  mail: "reader@example.test",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
} satisfies User;

const delivery = (id: string, outgoingMailStatus: "sent" | "bounced" | "queued" | null) => ({
  id,
  eventId: id,
  definitionId: "core.fixture",
  appId: "core",
  kind: "fixture",
  label: "Fixture",
  title: `Fixture ${id}`,
  targetHref: null,
  recipientLabel: "Book Reader",
  recipientReference: "reader@example.test",
  channel: "email",
  destinationLabel: "r***@example.test",
  required: false,
  routePriority: 1,
  status: outgoingMailStatus === "queued" ? ("pending" as const) : ("delivered" as const),
  outgoingMailId: outgoingMailStatus ? `00000000-0000-4000-8000-00000000000${id}` : null,
  outgoingMailStatus,
  attemptCount: 1,
  errorCode: null,
  errorMessage: null,
  createdAt: new Date("2026-09-14T00:00:00Z"),
  updatedAt: new Date("2026-09-14T00:00:00Z"),
  deliveredAt: null,
});
/** A delivered mail that bounced later, a queued mail, and a plain sent mail. */
const deliveries = [delivery("1", "bounced"), delivery("2", "queued"), delivery("3", "sent")];

test("notification delivery page renders charts inside the SSR and request-locale context", async () => {
  const spies = [
    stubRailSnapshot(),
    spyOn(cloud, "listApps").mockResolvedValue([]),
    spyOn(notificationsService, "facets").mockResolvedValue({ appIds: [], channels: [] }),
    spyOn(notificationsService.delivery, "list").mockResolvedValue({ items: deliveries, page: 1, perPage: 100, total: 3, hasNext: false }),
    spyOn(notificationsService.delivery, "summary").mockResolvedValue({ total: 0, active: 0, delivered: 0, suppressed: 0, failed: 0 }),
    spyOn(notificationsService.delivery, "timeseries").mockResolvedValue([
      { at: new Date("2026-09-14T00:00:00Z"), total: 3, active: 0, delivered: 3, suppressed: 0, failed: 0 },
    ]),
    spyOn(notificationsService.registry, "list").mockResolvedValue({ items: [], page: 1, perPage: 100, total: 0, hasNext: false }),
    spyOn(notificationsService.registry, "summary").mockResolvedValue({ total: 0, active: 0, apps: 0, required: 0 }),
    spyOn(notificationsService.notification, "list").mockResolvedValue({ items: [], page: 1, perPage: 100, total: 0, hasNext: false }),
    spyOn(notificationsService.notification, "summary").mockResolvedValue({ sent: 0, pending: 0, error: 0 }),
  ];
  try {
    const server = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
    server.use("*", async (c, next) => {
      c.set("actor", { kind: "user", user });
      c.set("user", user);
      c.set("runtime", { apps: [] });
      await next();
    });
    server.get("/admin/observability/notifications", ...handler);
    for (const locale of ["en", "de"]) {
      const response = await server.request("/admin/observability/notifications", { headers: { "Accept-Language": locale } });
      const html = await response.text();
      expect(response.status, html).toBe(200);
      expect(html).toContain("k2b-chart-explorer");
      expect(html).toContain("k2b-chart__svg");
      expect(html).toContain("<svg");
      expect(html).toContain(locale === "de" ? "Benachrichtigungen" : "Notifications");
      // Mail status appears only where it adds to the delivery status.
      expect(html).toContain(locale === "de" ? "E-Mail: Unzustellbar" : "Mail: Bounced");
      expect(html).toContain(locale === "de" ? "E-Mail: In Warteschlange" : "Mail: Queued");
      expect(html).not.toContain(locale === "de" ? "E-Mail: Gesendet" : "Mail: Sent");
      expect(html).toContain('title="00000000-0000-4000-8000-000000000001"');
      for (const view of ["registry", "legacy"]) {
        const other = await server.request(`/admin/observability/notifications?view=${view}`, { headers: { "Accept-Language": locale } });
        expect(other.status, await other.text()).toBe(200);
      }
    }
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});
