import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudRuntime } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import * as services from "@k2b/cloud/services";
import * as rail from "@k2b/cloud/services/rail-snapshot";
import { buildProjectedUser } from "@k2b/cloud/services/session/user";
import { createConfig } from "@k2b/ssr";
import { err, fail, ok } from "@k2b/stdlib";
import { Hono } from "hono";
import type { MailDraft } from "../contracts";
import * as access from "../service/access";
import * as drafts from "../service/drafts";
import * as publicResources from "../service/public-resources";

const root = mkdtempSync(join(tmpdir(), "mail-draft-read-page-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
afterAll(() => rmSync(root, { recursive: true, force: true }));
// The real Mail page router, so a missing route registration fails here.
const { default: mailPages } = await import("./index");

const userId = "11111111-1111-4111-8111-111111111111";
const mailboxId = "22222222-2222-4222-8222-222222222222";
const draftId = "33333333-3333-4333-8333-333333333333";
const draft: MailDraft = {
  id: draftId,
  mailboxId,
  conversationId: null,
  intent: "new",
  sourceMessageId: null,
  derivedFromMessageId: null,
  derivationKind: null,
  senderIdentityId: "66666666-6666-4666-8666-666666666666",
  to: [{ name: "Ada Customer", address: "customer@example.test" }],
  cc: [{ name: null, address: "copy@example.test" }],
  bcc: [],
  subject: "Quarterly offer",
  body: "Please find **our offer** attached.",
  format: "markdown",
  priority: "normal",
  requestDeliveryReceipt: false,
  requestReadReceipt: false,
  attachments: [],
  createdBy: { kind: "user", userId },
  lastEditedBy: { kind: "user", userId },
  lastEditedByDisplayName: "Test Writer",
  recoveryCopyCount: 0,
  revision: 1,
  state: "draft",
  deliveryClass: "normal",
  signatureTemplateId: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});
beforeEach(() => {
  const user = buildProjectedUser({ id: userId, provider: "local", profile: "user", uid: "reader", display_name: "Test Reader" });
  spies.push(spyOn(services.session, "getToken").mockReturnValue("test-session"));
  spies.push(
    spyOn(services.session, "authenticateRequest").mockResolvedValue({
      user,
      data: { userId, sid: "test", authEpoch: 0, kind: "web", expiresAt: "2099-01-01T00:00:00Z" },
    }),
  );
  spies.push(spyOn(rail, "readRailSnapshot").mockResolvedValue({ revision: 0, visibility: {}, shortcuts: [], managedShortcuts: [] }));
  spies.push(spyOn(publicResources, "resolveActiveMailboxId").mockResolvedValue(mailboxId));
  spies.push(spyOn(publicResources, "resolveMailboxPublicId").mockResolvedValue(draftId));
});

const request = (locale = "en") =>
  new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>()
    .use("*", async (c, next) => {
      c.set("runtime", { apps: [] });
      await next();
    })
    .route("/app/mail", mailPages)
    .request("https://cloud.example.test/app/mail/Box001/drafts/Drf001", { headers: { "accept-language": locale } });

test("a member who may only read opens the draft without the composer", async () => {
  // The read view never asks for write access; a denied writer check must not matter here.
  const required = spyOn(access, "requireMailboxAccess").mockResolvedValue(fail(err.forbidden("Access denied")));
  spies.push(required, spyOn(drafts, "getDraft").mockResolvedValue(ok(draft)));

  const response = await request();

  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain("Quarterly offer");
  expect(html).toContain("Draft</p>");
  expect(html).toContain("Ada Customer &lt;customer@example.test>");
  expect(html).toContain("copy@example.test");
  expect(html).toContain("<strong>our offer</strong>");
  expect(html).not.toContain("MailComposerPage");
  expect(required).not.toHaveBeenCalled();
});

test("the read view answers in the reader's language and names an empty draft", async () => {
  spies.push(spyOn(drafts, "getDraft").mockResolvedValue(ok({ ...draft, subject: "", body: "", to: [], cc: [] })));

  const html = await (await request("de")).text();

  expect(html).toContain("(Kein Betreff)");
  expect(html).toContain("Keine Empfänger");
  expect(html).toContain("Kein Nachrichtentext");
});

test("a draft the caller may not read shows nothing of it", async () => {
  spies.push(spyOn(drafts, "getDraft").mockResolvedValue(fail(err.notFound("Draft"))));

  const response = await request();

  expect(response.status).toBe(404);
  expect(await response.text()).not.toContain("Quarterly offer");
});
