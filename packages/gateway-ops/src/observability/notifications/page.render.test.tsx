import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cloud from "@k2b/cloud";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { Hono } from "hono";
import { stubRailSnapshot } from "../../../../../tests/fixtures/rail-snapshot";
import { registerSsrTestPlugin } from "../../../../ui/test/ssr-test-plugin";
import { notificationsService } from "./service";

const root = mkdtempSync(join(tmpdir(), "notifications-page-render-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
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

const definition = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  appId: "mail",
  kind: "mail.digest",
  label: "Tägliche Zusammenfassung",
  description: "Ungelesene Nachrichten des Tages",
  recipientKind: "user",
  recommendedChannels: ["email", "browser"],
  requiredChannels: ["email"],
  eventCount7d: 12_345,
  failedDeliveryCount7d: 3,
  lastSeenAt: new Date("2026-11-24T08:00:00Z"),
  active: true,
  ...overrides,
});
const earlier = (id: string, status: "sent" | "pending" | "error") => ({
  id,
  status,
  recipient: "reader@example.test",
  subject: `Willkommen ${id}`,
  content: "<p>Hallo</p>",
  sentByName: null,
  createdAt: new Date("2026-09-14T00:00:00Z"),
  error: status === "error" ? "SMTP 550 mailbox unavailable" : null,
});

const server = () => {
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  app.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user });
    c.set("user", user);
    c.set("runtime", { apps: [] });
    await next();
  });
  app.get("/admin/observability/deliveries", ...handler);
  return app;
};

/** The words a person reads in the first HTML. */
const read = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

test("definitions and earlier notifications render on v2 from the address, with their figures, filters and deeds", async () => {
  const list = spyOn(notificationsService.registry, "list").mockResolvedValue({
    items: [definition("a"), definition("b", { label: "Alte Erinnerung", active: false, failedDeliveryCount7d: 0 })],
    page: 1,
    perPage: 100,
    total: 2,
    hasNext: false,
  } as never);
  const legacyList = spyOn(notificationsService.notification, "list").mockResolvedValue({
    items: [earlier("1", "error"), earlier("2", "pending")],
    page: 1,
    perPage: 100,
    total: 2,
    hasNext: false,
  } as never);
  const spies = [
    stubRailSnapshot(),
    spyOn(cloud, "listApps").mockResolvedValue([{ id: "mail", name: "Mail", icon: "ti ti-mail" }] as never),
    list,
    spyOn(notificationsService.registry, "summary").mockResolvedValue({ total: 2, active: 1, apps: 1, required: 1 }),
    legacyList,
    spyOn(notificationsService.notification, "summary").mockResolvedValue({ sent: 4, pending: 1, error: 1 }),
    spyOn(notificationsService.system, "pendingCount").mockResolvedValue(2),
  ];
  try {
    const app = server();
    const registry = await app.request("/admin/observability/deliveries?tab=registry&status=active&app=mail&q=digest", {
      headers: { "Accept-Language": "de" },
    });
    const registryHtml = await registry.text();
    expect(registry.status, registryHtml).toBe(200);
    expect(registryHtml).toContain('data-k2-part="Workspace"');
    const registryText = read(registryHtml);
    expect(registryText).toContain("Tägliche Zusammenfassung");
    expect(registryText).toContain("12.345");
    expect(list.mock.calls[0]![0]).toMatchObject({ filter: { search: "digest", appIds: ["mail"], active: true } });

    const legacy = await app.request("/admin/observability/deliveries?tab=legacy&status=error&page=2", {
      headers: { "Accept-Language": "de" },
    });
    const legacyText = read(await legacy.text());
    expect(legacy.status).toBe(200);
    expect(legacyText).toContain("Willkommen 1");
    expect(legacyList.mock.calls[0]![0]).toMatchObject({
      pagination: { page: 2, perPage: 100, offset: 100 },
      access: { status: "error" },
    });
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});
