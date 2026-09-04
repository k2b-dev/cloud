import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { CloudRuntime, User } from "@valentinkolb/cloud/contracts";
import type { AuthContext } from "@valentinkolb/cloud/server";
import * as services from "@valentinkolb/cloud/services";
import { Hono } from "hono";
import * as integrations from "../service/app-integrations";
import * as publicResources from "../service/public-resources";
import * as workspace from "../service/workspace";

const root = mkdtempSync(join(tmpdir(), "mailbox-page-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
afterAll(() => rmSync(root, { recursive: true, force: true }));
const { default: handler } = await import("./[mailboxId]/page");

const user = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "reader",
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Test",
  sn: "Reader",
  displayName: "Test Reader",
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
const mailboxId = "22222222-2222-4222-8222-222222222222";
const mailboxShortId = "Box001";
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});
beforeEach(() => {
  spies.push(spyOn(services.coreSettings, "get").mockResolvedValue("https://cloud.example.test"));
  spies.push(spyOn(services, "get").mockResolvedValue("https://cloud.example.test"));
});

const request = () => {
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  app.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user });
    c.set("user", user);
    c.set("accessSubject", { type: "user", userId: user.id });
    c.set("runtime", { apps: [] });
    await next();
  });
  app.get("/app/mail/:mailboxId", ...handler);
  return app.request(`https://cloud.example.test/app/mail/${mailboxShortId}`);
};

test("missing or deleted active mailbox renders shared HTML 404 before loading workspace data", async () => {
  const resolve = spyOn(publicResources, "resolveActiveMailboxId").mockResolvedValue(null);
  const load = spyOn(workspace, "loadMailboxPageData").mockRejectedValue(new Error("Unexpected workspace load"));
  const integration = spyOn(integrations, "getSpacesMailIntegrationAvailability").mockRejectedValue(
    new Error("Unexpected integration lookup"),
  );
  spies.push(resolve, load, integration);

  const response = await request();

  expect(resolve).toHaveBeenCalledWith(mailboxShortId);
  expect(load).not.toHaveBeenCalled();
  expect(integration).not.toHaveBeenCalled();
  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("location")).toBeNull();
  const html = await response.text();
  expect(html).toContain("Page not found");
  expect(html).toContain("Go to home page");
  expect(html).not.toContain("MailWorkspace");
});

test("active mailbox denied by workspace preserves 403 in the shared no-store HTML page", async () => {
  const resolve = spyOn(publicResources, "resolveActiveMailboxId").mockResolvedValue(mailboxId);
  const load = spyOn(workspace, "loadMailboxPageData").mockResolvedValue({
    ok: false,
    error: { code: "FORBIDDEN", message: "Internal mailbox permission details", status: 403 },
  });
  const integration = spyOn(integrations, "getSpacesMailIntegrationAvailability").mockResolvedValue({
    invitations: false,
    settings: false,
    composer: false,
    context: false,
  });
  spies.push(resolve, load, integration);

  const response = await request();

  expect(resolve).toHaveBeenCalledWith(mailboxShortId);
  expect(load).toHaveBeenCalledTimes(1);
  expect(load.mock.calls[0]?.[0]).toMatchObject({
    mailboxId,
    context: {
      actor: { kind: "user", user },
      accessSubject: { type: "user", userId: user.id },
    },
  });
  expect(response.status).toBe(403);
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("location")).toBeNull();
  const html = await response.text();
  expect(html).toContain("Access denied");
  expect(html).toContain("Go to home page");
  expect(html).not.toContain("Internal mailbox permission details");
  expect(html).not.toContain(mailboxId);
  expect(html).not.toContain("MailWorkspace");
});
