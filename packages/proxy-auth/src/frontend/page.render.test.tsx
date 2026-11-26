import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import * as services from "@k2b/cloud/services";
import { Hono } from "hono";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import { proxyAuthService } from "../service";

const root = mkdtempSync(join(tmpdir(), "proxy-auth-page-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: handler } = await import("./page");

const user = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "admin",
  roles: ["user", "admin"],
  provider: "local",
  profile: "user",
  givenname: "Ada",
  sn: "Admin",
  displayName: "Ada Admin",
  mail: "admin@example.test",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
} satisfies User;

const read = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

test("the clients render on v2 with their figures, one open beside the list, and the setup with this Cloud's address", async () => {
  const spies = [
    stubRailSnapshot(),
    spyOn(services, "get").mockResolvedValue("cloud.example.test" as never),
    spyOn(proxyAuthService.client, "list").mockResolvedValue({
      items: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          clientId: "pa_grafana",
          name: "Grafana",
          description: "Dashboards",
          allowedGroups: [{ id: "00000000-0000-4000-8000-0000000000a1", name: "ops", provider: "local" }],
          createdAt: "2026-11-10T00:00:00.000Z",
        },
        {
          id: "00000000-0000-4000-8000-000000000002",
          clientId: "pa_kuma",
          name: "Uptime Kuma",
          description: null,
          allowedGroups: [],
          createdAt: "2026-11-11T00:00:00.000Z",
        },
      ],
    } as never),
  ];
  try {
    const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
    app.use("*", async (c, next) => {
      c.set("actor", { kind: "user", user });
      c.set("user", user);
      c.set("runtime", { apps: [] });
      await next();
    });
    app.get("/admin/proxy-auth", ...handler);
    const response = await app.request("/admin/proxy-auth?client=00000000-0000-4000-8000-000000000001", {
      headers: { "Accept-Language": "de" },
    });
    const html = await response.text();
    expect(response.status, html).toBe(200);
    expect(html).toContain('data-k2-part="Workspace"');
    const text = read(html);
    // the first row says what matters with its number; the list's count is a quiet fact beside it
    // the hero: how many let nobody through, with the blocked one by name (the tab counts all clients)
    expect(text).toContain("Gesperrte Clients 1 Uptime Kuma");
    // one line per client, the blocked ones first: its name, its state right after it, its groups as words
    expect(text).toContain("Client Zulässige Gruppen Uptime Kuma ● Gesperrt Ohne Gruppen Grafana Ops");
    // the open client names its verify address with this Cloud's public address
    expect(text).toContain("https://cloud.example.test/proxy-auth/verify/pa_grafana");
    const setup = read(await (await app.request("/admin/proxy-auth?tab=setup", { headers: { "Accept-Language": "de" } })).text());
    expect(setup).toContain("https://cloud.example.test/proxy-auth/verify/&lt;client-id");
    expect(setup).toContain("X-Forwarded-Groups");
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});
