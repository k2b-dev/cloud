import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import * as services from "@k2b/cloud/services";
import * as rail from "@k2b/cloud/services/rail-snapshot";
import { createConfig } from "@k2b/ssr";
import { err, fail, ok } from "@k2b/stdlib";
import { Hono } from "hono";
import { composeSafetyConfigSchema, type Mailbox, type MailDraft } from "../contracts";
import * as access from "../service/access";
import * as integrations from "../service/app-integrations";
import * as draftUploads from "../service/draft-uploads";
import * as drafts from "../service/drafts";
import * as mailboxes from "../service/mailboxes";
import * as publicResources from "../service/public-resources";
import * as senderIdentities from "../service/sender-identities";

const root = mkdtempSync(join(tmpdir(), "mail-compose-page-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
afterAll(() => rmSync(root, { recursive: true, force: true }));
const { default: seedPage } = await import("./[mailboxId]/compose/local/[seedId]/page");
const { default: draftPage } = await import("./[mailboxId]/compose/[draftId]/page");

const user = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "writer",
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Test",
  sn: "Writer",
  displayName: "Test Writer",
  mail: "writer@example.test",
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
const mailbox: Mailbox = {
  accessScope: "assigned",
  id: mailboxId,
  name: "Support",
  description: null,
  health: "active",
  healthReason: null,
  syncEnabled: true,
  searchBackend: "postgres",
  automaticReplyManagementPermission: "admin",
  composeSafety: composeSafetyConfigSchema.parse({}),
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};
const draftId = "33333333-3333-4333-8333-333333333333";
const draft: MailDraft = {
  id: draftId,
  mailboxId,
  conversationId: "44444444-4444-4444-8444-444444444444",
  intent: "reply",
  sourceMessageId: "55555555-5555-4555-8555-555555555555",
  derivedFromMessageId: null,
  derivationKind: null,
  senderIdentityId: "66666666-6666-4666-8666-666666666666",
  to: [{ name: null, address: "customer@example.test" }],
  cc: [],
  bcc: [],
  subject: "Re: Order",
  body: "Thanks.",
  format: "markdown",
  priority: "normal",
  requestDeliveryReceipt: false,
  requestReadReceipt: false,
  attachments: [],
  createdBy: { kind: "user", userId: user.id },
  lastEditedBy: { kind: "user", userId: user.id },
  lastEditedByDisplayName: "Test Writer",
  recoveryCopyCount: 0,
  revision: 1,
  state: "draft",
  deliveryClass: "normal",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});
beforeEach(() => {
  spies.push(spyOn(services.coreSettings, "get").mockResolvedValue("https://cloud.example.test"));
  spies.push(spyOn(services, "get").mockResolvedValue("https://cloud.example.test"));
  spies.push(spyOn(rail, "readRailSnapshot").mockResolvedValue({ revision: 0, visibility: {}, shortcuts: [], managedShortcuts: [] }));
  spies.push(spyOn(publicResources, "resolveActiveMailboxId").mockResolvedValue(mailboxId));
  spies.push(
    spyOn(publicResources, "publicIds").mockImplementation(
      async (_table, ids) => new Map(ids.flatMap((id) => (id ? [[id, mailboxShortId] as const] : []))),
    ),
  );
  spies.push(spyOn(mailboxes, "getMailbox").mockResolvedValue(ok(mailbox)));
  spies.push(spyOn(senderIdentities, "listSenderIdentities").mockResolvedValue(ok([])));
  spies.push(spyOn(publicResources, "resolveMailboxPublicId").mockResolvedValue(draftId));
  spies.push(spyOn(drafts, "getDraft").mockResolvedValue(ok(draft)));
  spies.push(spyOn(draftUploads, "listUnfinishedDraftAttachmentUploads").mockResolvedValue(ok([])));
  spies.push(
    spyOn(integrations, "getSpacesMailIntegrationAvailability").mockResolvedValue({
      invitations: false,
      settings: false,
      composer: false,
      context: false,
    }),
  );
});

const request = (path: string) => {
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  app.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user });
    c.set("user", user);
    c.set("accessSubject", { type: "user", userId: user.id });
    c.set("runtime", { apps: [] });
    await next();
  });
  app.get("/app/mail/:mailboxId/compose/local/:seedId", ...seedPage);
  app.get("/app/mail/:mailboxId/compose/:draftId", ...draftPage);
  return app.request(`https://cloud.example.test/app/mail/${mailboxShortId}/compose/${path}`);
};
const pages = [
  { path: "local/seed-1", island: "MailDraftSeedComposerPage" },
  { path: "Drf001", island: "MailComposerPage" },
];

for (const page of pages) {
  test(`a writer of assigned conversations opens ${page.island}`, async () => {
    const required = spyOn(access, "requireMailboxAccess").mockResolvedValue(
      ok({ scope: "assigned", permission: "write", userId: user.id }),
    );
    spies.push(required);

    const response = await request(page.path);

    expect(required).toHaveBeenCalledWith(
      expect.objectContaining({ accessSubject: { type: "user", userId: user.id } }),
      mailboxId,
      "write",
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(page.island);
  });

  test(`a reader without write access gets the shared 403 page instead of ${page.island}`, async () => {
    spies.push(spyOn(access, "requireMailboxAccess").mockResolvedValue(fail(err.forbidden("Access denied"))));

    const response = await request(page.path);

    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(page.island);
  });
}
