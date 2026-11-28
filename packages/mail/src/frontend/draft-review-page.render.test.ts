import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import * as services from "@k2b/cloud/services";
import * as layoutHelp from "@k2b/cloud/ssr/help";
import { err, fail, ok } from "@k2b/stdlib";
import { Hono } from "hono";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";
import { selectHtml } from "../../../../tests/fixtures/select-html";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import type { MailDraft } from "../contracts";
import { drafts, mailboxes } from "../service";
import * as access from "../service/access";
import * as publicResources from "../service/public-resources";

// The draft a review link points to, on UI v2: why it is shown (read only, or the version under review), and a review
// whose version is gone, said in the page with status 409.
const root = mkdtempSync(join(tmpdir(), "mail-draft-review-tests-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
afterAll(() => rmSync(root, { recursive: true, force: true }));
const { default: handler } = await import("./[mailboxId]/drafts/[draftId]/page");

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
const mailboxId = "22222222-2222-4222-8222-222222222221";
const draftId = "33333333-3333-4333-8333-333333333331";
const draft = {
  id: draftId,
  revision: 3,
  subject: "Angebot Einbauschrank",
  body: "Guten Tag,\n\ngern verlängern wir das Angebot bis Ende Januar.",
  format: "markdown",
  to: [{ name: "Familie Oswald", address: "oswald@example.org" }],
  cc: [],
  bcc: [],
  attachments: [{ filename: "Angebot-4471.pdf" }],
  senderIdentityId: null,
} as unknown as MailDraft;

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});
let canWrite: boolean;
beforeEach(() => {
  canWrite = false;
  spies.push(stubRailSnapshot());
  spies.push(spyOn(layoutHelp, "preloadLayoutHelp").mockResolvedValue(null));
  spies.push(spyOn(services.coreSettings, "get").mockResolvedValue("https://cloud.example.test"));
  spies.push(spyOn(services, "get").mockResolvedValue("https://cloud.example.test"));
  spies.push(
    spyOn(publicResources, "resolveActiveMailboxId").mockResolvedValue(mailboxId),
    spyOn(publicResources, "resolveMailboxPublicId").mockResolvedValue(draftId),
    spyOn(mailboxes, "getMailbox").mockResolvedValue(ok({ id: mailboxId, name: "Kontakt" } as never)),
    spyOn(drafts, "getDraft").mockResolvedValue(ok(draft)),
    spyOn(access, "requireMailboxPermission").mockImplementation(async () =>
      canWrite ? ok(undefined as never) : fail(err.forbidden("Read only")),
    ),
  );
});

const request = (query = "", pilot: string[] = ["*"]) => {
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime; settings: unknown } }>();
  app.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user });
    c.set("user", user);
    c.set("accessSubject", { type: "user", userId: user.id });
    c.set("credentialKind", "session");
    c.set("credentialScopes", []);
    c.set("runtime", { apps: [{ id: "mail", name: "Mail", icon: "ti ti-mail", description: "Fixture", routes: ["/app/mail"] }] });
    c.set("settings", { mail: { ui_v2_pilot: pilot } });
    await next();
  });
  app.get("/app/mail/:mailboxId/drafts/:draftId", ...handler);
  return app.request(`https://cloud.example.test/app/mail/Box001/drafts/Drf001${query}`, { headers: { "accept-language": "de" } });
};

test("a reader without write access sees the draft with the line that it is read only", async () => {
  const response = await request();
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain("Du kannst diesen Entwurf lesen, aber nicht ändern.");
  expect(html).toContain("Familie Oswald");
  expect(html).toContain("gern verlängern wir das Angebot");
  expect(html).toContain("Angebot-4471.pdf");
  expect(await selectHtml(html, '[data-k2-part="Facts"]')).not.toHaveLength(0);
});

test("a writer opening the draft without a review sees no read-only line", async () => {
  canWrite = true;
  const html = await (await request()).text();
  expect(html).not.toContain("Du kannst diesen Entwurf lesen");
});

test("the version under review names itself", async () => {
  const response = await request("?revision=3");
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("So lag der Entwurf zur Prüfung vor (Stand 3).");
});

test("a review whose version is gone says so in the page with 409 and leads to the current draft", async () => {
  const response = await request("?revision=2");
  expect(response.status).toBe(409);
  const html = await response.text();
  expect(await selectHtml(html, '[data-k2-part="Empty"]')).toHaveLength(1);
  expect(html).toContain("Dieser Entwurf hat sich geändert");
  expect(html).toContain('href="/app/mail/Box001/drafts/Drf001"');
  expect(html).not.toContain("gern verlängern wir das Angebot");
});

test("outside the pilot the page keeps its v1 answer to a changed review", async () => {
  const response = await request("?revision=2", []);
  expect(response.status).toBe(409);
  expect(await selectHtml(await response.text(), '[data-k2-part="Empty"]')).toHaveLength(0);
});
