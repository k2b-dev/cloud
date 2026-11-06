import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import * as services from "@k2b/cloud/services";
import * as rail from "@k2b/cloud/services/rail-snapshot";
import { createConfig } from "@k2b/ssr";
import { ok } from "@k2b/stdlib";
import { Hono } from "hono";
import { composeSafetyConfigSchema, type SenderIdentity } from "../contracts";
import * as mailboxes from "../service/mailboxes";
import * as publicResources from "../service/public-resources";
import * as senderIdentities from "../service/sender-identities";

const root = mkdtempSync(join(tmpdir(), "mail-compose-intent-page-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
afterAll(() => rmSync(root, { recursive: true, force: true }));
const { default: composePage } = await import("./compose/page");

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

const mailboxUuid = (index: number) => `2222222${index}-2222-4222-8222-222222222222`;
const identityUuid = (index: number) => `6666666${index}-6666-4666-8666-666666666666`;
const mailbox = (index: number, permission: "read" | "write" | "admin" = "write"): mailboxes.MailboxListItem => ({
  accessScope: "mailbox",
  id: mailboxUuid(index),
  name: `Mailbox ${index}`,
  description: null,
  health: "active",
  healthReason: null,
  syncEnabled: true,
  searchBackend: "postgres",
  automaticReplyManagementPermission: "admin",
  composeSafety: composeSafetyConfigSchema.parse({}),
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  permission,
  receivingAddress: null,
});
const identity = (index: number, status: SenderIdentity["status"] = "verified"): SenderIdentity => ({
  id: identityUuid(index),
  mailboxId: mailboxUuid(1),
  label: `Sender ${index}`,
  displayName: `Sender ${index}`,
  fromAddress: `sender${index}@example.test`,
  replyTo: null,
  defaultCc: [],
  defaultBcc: [],
  defaultFormat: "markdown",
  defaultPriority: "normal",
  defaultDeliveryReceipt: false,
  defaultReadReceipt: false,
  vcard: null,
  envelopeSender: null,
  defaultSignatureTemplateId: null,
  transport: {
    mode: "mailbox",
    host: null,
    port: null,
    tlsMode: null,
    username: null,
    secret: { kind: null, isSet: false },
    revision: 0,
    status: "active",
    capabilities: { dsn: false, size: false, maxMessageBytes: null },
    lastVerifiedAt: null,
    lastError: null,
  },
  authenticationPolicy: { automation: "mailbox" },
  sentFolderId: null,
  draftsFolderId: null,
  isDefault: index === 1,
  status,
  statusReason: null,
  pendingVerificationCommandId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const spies: Array<{ mockRestore(): void }> = [];
let listMailboxes: ReturnType<typeof spyOn<typeof mailboxes, "listMailboxes">>;
let listIdentities: ReturnType<typeof spyOn<typeof senderIdentities, "listSenderIdentities">>;
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});
beforeEach(() => {
  spies.push(spyOn(services.coreSettings, "get").mockResolvedValue("https://cloud.example.test"));
  spies.push(spyOn(services, "get").mockResolvedValue("https://cloud.example.test"));
  spies.push(spyOn(rail, "readRailSnapshot").mockResolvedValue({ revision: 0, visibility: {}, shortcuts: [], managedShortcuts: [] }));
  // Public ids keep the last digit of the internal id, so each test can tell which mailbox or sender reached the page.
  spies.push(
    spyOn(publicResources, "publicIds").mockImplementation(
      async (table, ids) =>
        new Map(ids.flatMap((id) => (id ? [[id, `${table === "mailboxes" ? "Box" : "Snd"}00${id.charAt(7)}`] as const] : []))),
    ),
  );
  listMailboxes = spyOn(mailboxes, "listMailboxes").mockResolvedValue(ok([mailbox(1)]));
  listIdentities = spyOn(senderIdentities, "listSenderIdentities").mockResolvedValue(ok([identity(1)]));
  spies.push(listMailboxes, listIdentities);
});

const render = async (query = "") => {
  const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
  app.use("*", async (c, next) => {
    c.set("actor", { kind: "user", user });
    c.set("user", user);
    c.set("accessSubject", { type: "user", userId: user.id });
    c.set("credentialKind", "oauth");
    c.set("credentialScopes", ["mail:read"]);
    c.set("runtime", { apps: [] });
    await next();
  });
  app.get("/app/mail/compose", ...composePage);
  const response = await app.request(`https://cloud.example.test/app/mail/compose${query}`);
  expect(response.status).toBe(200);
  return response.text();
};

// The page hands the browser a sender only for the direct start, so any sender id in the page is that one.
const directIdentity = (html: string) => html.match(/Snd\d{3}/)?.[0] ?? null;

test("one sending mailbox with one verified sender opens the composer directly, without a chooser first", async () => {
  const html = await render(`?mailto=${encodeURIComponent("mailto:ada@example.test?subject=Hello")}&return=%2Fapp%2Fcontacts`);

  expect(directIdentity(html)).toBe("Snd001");
  expect(listIdentities).toHaveBeenCalledWith(
    expect.objectContaining({ accessSubject: { type: "user", userId: user.id } }),
    mailboxUuid(1),
  );
  expect(html).toContain("Preparing message...");
  expect(html).toMatch(/<section[^>]*class="[^"]*\bhidden\b/);
});

test("the choosers stay when the sender or the mailbox is not the only option", async () => {
  listIdentities.mockResolvedValue(ok([identity(1), identity(2)]));
  expect(directIdentity(await render())).toBeNull();

  listIdentities.mockResolvedValue(ok([identity(1, "unverified")]));
  expect(directIdentity(await render())).toBeNull();

  listIdentities.mockClear();
  listMailboxes.mockResolvedValue(ok([mailbox(1), mailbox(2)]));
  const html = await render();
  expect(directIdentity(html)).toBeNull();
  expect(listIdentities).not.toHaveBeenCalled();
  expect(html).not.toContain("Preparing message...");
});

test("a read-only mailbox counts as no sending mailbox", async () => {
  listMailboxes.mockResolvedValue(ok([mailbox(1, "read")]));
  const html = await render();
  expect(directIdentity(html)).toBeNull();
  expect(listIdentities).not.toHaveBeenCalled();
  expect(html).toContain("No writable mailbox");
});

test("an invalid email link keeps the page so it can explain itself", async () => {
  expect(directIdentity(await render(`?mailto=${encodeURIComponent("https://example.test")}`))).toBeNull();
  expect(listIdentities).not.toHaveBeenCalled();
});

test("a Command link prepares the direct start, which waits in the browser for the Command's recipient", async () => {
  const html = await render("?command=mail.compose");
  expect(directIdentity(html)).toBe("Snd001");
  expect(html).toContain("Preparing message...");
});
